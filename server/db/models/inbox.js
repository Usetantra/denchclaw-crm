'use strict';
// ─── CP-I: the unified Inbox data layer ──────────────────────────────────────
// One Inbox where every to-and-fro with a person appears in a single thread.
//
// Three schema facts drive everything in this file, and none of them are
// negotiable design choices — they are what the tables already are:
//
//   1. A unified thread is a CONTACT, not a conversation. `conversations` holds
//      one row PER CHANNEL per contact, so someone you have emailed AND DM'd has
//      two. The inbox merges every conversation belonging to a contact at query
//      time; there is deliberately no "unified conversation" table.
//
//   2. `uq_conversations_contact_channel` is a PARTIAL unique index
//      (`(contact_id, channel) WHERE status <> 'closed'`, migrations/004), so a
//      contact can hold many CLOSED conversations on one channel plus one open
//      one. Every query here therefore spans ALL of a contact's conversations,
//      closed included — filtering them out would silently drop their messages
//      from the thread and corrupt the unread maths.
//
//   3. CP2's sequence sends NEVER write a `messages` row. The only
//      `INSERT INTO messages` in the repo is in routes/conversations.js;
//      `ackJob(status='sent')` writes an UPDATE to scheduled_actions plus a
//      `contact_activity` row of type '<channel>_sent' carrying
//      `data.scheduled_action_id`. So a thread built from `messages` alone is
//      blind to exactly the messages this feature exists to surface. getThread()
//      returns a UNION of both, normalised to one shape. CP2's ack path is NOT
//      changed — it is banked, and rewriting it would need its own verification.
//
// Tenancy: every query is company_id-scoped, and every join carries company_id
// on BOTH sides rather than relying on the parent being scoped. CP-I fans out
// across contacts → conversations → messages → deals → contact_activity, and a
// transitively-safe join is one refactor away from being a leak.
const { query } = require('../index');
const { getPipelineConfig } = require('../pipeline');

const CHANNELS = ['email', 'sms', 'whatsapp', 'linkedin', 'ai_call', 'call'];

// ─── list ────────────────────────────────────────────────────────────────────
// Contact-grouped rows for the list pane.
//
// `turn` is DERIVED from the newest message's direction and is never stored:
// last message inbound ⇒ 'mine' (they are waiting on me), outbound ⇒ 'theirs'.
// A contact with zero messages has turn = null — real, because the inbound
// webhook creates the conversation and the message in two separate calls, so a
// conversation with no messages exists in between. Such a contact appears under
// `all` and under neither `mine` nor `theirs`.
//
// `unread` is INBOUND-ONLY: max(created_at) FILTER (direction='inbound') vs
// last_read_at. routes/conversations.js stamps `last_message_at = now()` on
// EVERY insert including outbound, so any predicate built on last_message_at
// would re-flag a contact unread from the operator's own reply.
async function listInbox(companyId, { filter = 'mine', channel = null, q = null, limit = 50, cursor = null, assignee = null } = {}) {
  if (!companyId) throw new Error('inbox.listInbox requires companyId');
  if (channel && !CHANNELS.includes(channel)) throw new Error(`inbox.listInbox: unknown channel '${channel}'`);
  if (assignee && !ASSIGNEES.includes(assignee)) throw new Error(`inbox.listInbox: unknown assignee '${assignee}'`);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const params = [companyId];
  const p = (v) => { params.push(v); return `$${params.length}`; };

  // Ordering/cursor key is the TUPLE (last_message_at, contact id), descending,
  // with NULL folded to -infinity so message-less contacts sort last but remain
  // reachable. Both halves matter:
  //   * a cursor on the timestamp ALONE skips every contact tied at the page
  //     boundary (bulk imports and batch acks tie constantly), and
  //   * an `IS NOT NULL` guard makes message-less contacts unreachable from
  //     page 2 onward.
  // Row-value comparison gives the strict "everything after this exact row"
  // semantics a keyset cursor needs, with no gap and no repeat.
  let cursorClause = '';
  if (cursor) {
    const [cts, cid] = String(cursor).split('|');
    if (cts && cid) {
      cursorClause = `AND (COALESCE(agg.last_message_at, '-infinity'::timestamptz), ct.id)
                        < (${p(cts)}::timestamptz, ${p(cid)}::uuid)`;
    }
  }

  const filterClause = {
    all: '',
    unread: 'AND agg.is_unread',
    mine: `AND agg.last_direction = 'inbound'`,
    theirs: `AND agg.last_direction = 'outbound'`,
    starred: 'AND agg.starred',
  }[filter];
  if (filterClause === undefined) throw new Error(`inbox.listInbox: unknown filter '${filter}'`);

  const channelClause = channel ? `AND ${p(channel)} = ANY(agg.channels)` : '';
  const assigneeClause = assignee ? `AND ${p(assignee)} = ANY(agg.assignees)` : '';
  const searchClause = q
    ? `AND (ct.name ILIKE ${p('%' + q + '%')} OR ct.email ILIKE ${p('%' + q + '%')}
           OR EXISTS (SELECT 1 FROM conversations cvq
                        JOIN messages mq ON mq.conversation_id = cvq.id AND mq.company_id = cvq.company_id
                       WHERE cvq.company_id = ct.company_id AND cvq.contact_id = ct.id
                         AND mq.body ILIKE ${p('%' + q + '%')}))`
    : '';

  const sql = `
    WITH conv AS (
      SELECT cv.id, cv.contact_id, cv.channel, cv.starred, cv.last_read_at, cv.assignee
        FROM conversations cv
       WHERE cv.company_id = $1
    ),
    per_conv AS (
      SELECT cv.id AS conversation_id, cv.contact_id, cv.channel, cv.starred, cv.last_read_at,
             (SELECT max(m.created_at) FROM messages m
               WHERE m.conversation_id = cv.id AND m.company_id = $1
                 AND m.direction = 'inbound') AS last_inbound_at
        FROM conv cv
    ),
    -- The list's "latest communication" must span the SAME two sources the
    -- thread does, or the two disagree: a contact whose only contact from us was
    -- a CP2 sequence send would show an empty snippet and no turn in the list
    -- while their thread clearly shows that send. Sequence sends never write a
    -- messages row (see header note 3), so they are unioned in here too. They
    -- are outbound by definition, which is why unread — inbound-only — is
    -- computed from the messages table alone above and is unaffected by this.
    evt AS (
      SELECT c2.contact_id, m.direction, m.channel, m.body, m.created_at, m.id,
             'message'::text AS source
        FROM messages m
        JOIN conv c2 ON c2.id = m.conversation_id
       WHERE m.company_id = $1
      UNION ALL
      SELECT ca.contact_id, 'outbound'::text, ca.channel, ca.message, ca.created_at, ca.id,
             'sequence'::text AS source
        FROM contact_activity ca
       WHERE ca.company_id = $1
         AND ca.type LIKE '%\\_sent'
         AND ca.type <> 'message_sent'
         AND ca.data ? 'scheduled_action_id'
    ),
    -- The contact set is the union of "has a conversation" and "has a sequence
    -- send". A CP2 send does NOT create a conversation row, so keying the list
    -- off conversations alone would hide exactly the contacts this feature
    -- exists for: someone the CRM has messaged autonomously and no human has
    -- ever opened a thread with.
    ids AS (
      SELECT contact_id FROM conv
      UNION
      SELECT contact_id FROM evt
    ),
    agg AS (
      SELECT i.contact_id,
             COALESCE((SELECT bool_or(pc.last_inbound_at IS NOT NULL
                                      AND pc.last_inbound_at > COALESCE(pc.last_read_at, '-infinity'::timestamptz))
                         FROM per_conv pc WHERE pc.contact_id = i.contact_id), false) AS is_unread,
             COALESCE((SELECT bool_or(pc.starred) FROM per_conv pc WHERE pc.contact_id = i.contact_id), false) AS starred,
             COALESCE((SELECT array_agg(DISTINCT pc.channel) FROM per_conv pc WHERE pc.contact_id = i.contact_id),
                      ARRAY[]::text[]) AS channels,
             COALESCE((SELECT array_agg(DISTINCT cv3.assignee) FROM conv cv3 WHERE cv3.contact_id = i.contact_id),
                      ARRAY[]::text[]) AS assignees,
             -- Ordered by (created_at, id) so two communications sharing a
             -- timestamp — plausible across two channels — resolve
             -- deterministically instead of flapping between page loads.
             (SELECT e.direction FROM evt e WHERE e.contact_id = i.contact_id
               ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_event_direction,
             -- TURN is deliberately computed WITHOUT autonomous sequence sends.
             -- "Your turn" means a human owes this person a reply, and a robot
             -- firing the next ladder step does not discharge that obligation.
             -- Counting sends here would drop an unanswered customer off the
             -- DEFAULT landing view the moment their next sequence step went
             -- out — the exact contact the inbox exists to surface. The snippet
             -- above still shows the send, so the list stays truthful about what
             -- happened last.
             (SELECT e.direction FROM evt e
               WHERE e.contact_id = i.contact_id AND e.source <> 'sequence'
               ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_direction,
             (SELECT e.channel FROM evt e WHERE e.contact_id = i.contact_id
               ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_channel,
             (SELECT left(coalesce(e.body, ''), 180) FROM evt e WHERE e.contact_id = i.contact_id
               ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_body,
             (SELECT e.created_at FROM evt e WHERE e.contact_id = i.contact_id
               ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_message_at
        FROM ids i
    )
    SELECT ct.id AS contact_id, ct.name, ct.email, ct.company_name, ct.tags,
           ct.lead_score, ct.lead_score_numeric, ct.marketing_stage, ct.deal_stage,
           agg.is_unread, agg.starred, agg.channels, agg.assignees,
           agg.last_direction, agg.last_channel, agg.last_body, agg.last_message_at,
           CASE agg.last_direction WHEN 'inbound' THEN 'mine' WHEN 'outbound' THEN 'theirs' ELSE NULL END AS turn
      FROM agg
      JOIN contacts ct ON ct.id = agg.contact_id AND ct.company_id = $1
     WHERE ct.deleted_at IS NULL
       ${filterClause} ${channelClause} ${assigneeClause} ${searchClause} ${cursorClause}
     ORDER BY COALESCE(agg.last_message_at, '-infinity'::timestamptz) DESC, ct.id DESC
     LIMIT ${p(lim)}`;

  const result = await query(sql, params);
  return result.rows;
}

// ─── thread ──────────────────────────────────────────────────────────────────
// Every message across every conversation this contact owns, time-ordered, as a
// UNION of `messages` and CP2's `contact_activity` send events (see header note
// 3). Normalised to one shape so the UI renders a single list.
//
// `source` distinguishes the two facts the ticket is careful to separate:
//   'sequence'  — origin is a scheduled_actions row: the CRM sent this
//                 autonomously, with no human in the loop.
//   'message'   — a row in `messages`; `ai_generated` then says whether a human
//                 accepted an AI draft before clicking Send.
// These are different claims and must not be conflated.
async function getThread(companyId, contactId, { limit = 500 } = {}) {
  if (!companyId) throw new Error('inbox.getThread requires companyId');
  const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
  const result = await query(
    `WITH conv AS (
       SELECT cv.id FROM conversations cv
        WHERE cv.company_id = $1 AND cv.contact_id = $2
     ),
     evts AS (
       SELECT m.id,
              'message'::text        AS source,
              m.direction,
              m.channel,
              m.body,
              m.created_at,
              COALESCE(m.ai_generated, false) AS ai_generated,
              m.provider_message_id,
              m.metadata,
              NULL::text             AS activity_type
         FROM messages m
         JOIN conv ON conv.id = m.conversation_id
        WHERE m.company_id = $1

       UNION ALL

       -- CP2 sequence sends. They never write a messages row, so without this
       -- half the thread is blind to exactly what the CRM said on the
       -- operator's behalf.
       SELECT ca.id,
              'sequence'::text       AS source,
              'outbound'::text       AS direction,
              ca.channel,
              ca.message             AS body,
              ca.created_at,
              false                  AS ai_generated,
              ca.data->>'provider_message_id' AS provider_message_id,
              ca.data                AS metadata,
              ca.type                AS activity_type
         FROM contact_activity ca
        WHERE ca.company_id = $1
          AND ca.contact_id = $2
          AND ca.type LIKE '%\\_sent'
          -- 'message_sent' is the audit row EVERY outbound reply writes; it also
          -- ends in _sent, and including it would render every reply twice. It
          -- is excluded by name rather than relying on the fact that
          -- contacts.addActivity happens to nest its payload one level deeper,
          -- which is one refactor away from silently duplicating the thread.
          AND ca.type <> 'message_sent'
          AND ca.data ? 'scheduled_action_id'
     )
     -- NEWEST-N, then re-sorted for display. Ordering ASC and applying LIMIT
     -- returns the OLDEST n — so on any thread longer than the limit the
     -- operator would never see the newest inbound, which is precisely the
     -- message they opened the thread to answer, and read_through would freeze
     -- below it so the contact could never be marked read either.
     SELECT * FROM (
       SELECT *, created_at::text AS created_at_exact
         FROM evts
        ORDER BY created_at DESC, id DESC
        LIMIT $3
     ) newest
      ORDER BY newest.created_at ASC, newest.id ASC`,
    [companyId, contactId, lim]
  );
  return result.rows.map(normalizeThreadRow);
}

// Delivery honesty (D5). Only email actually delivers today; every other channel
// records a row and sends nothing. CP-I's reply path stamps this explicitly into
// metadata so the thread never has to guess. Rows written before CP-I (and CP2's
// sequence sends, which really did go to an executor) fall back to
// provider_message_id, which is only set when a provider accepted the message.
function normalizeThreadRow(r) {
  const meta = (typeof r.metadata === 'string' ? safeParse(r.metadata) : r.metadata) || {};
  const explicit = typeof meta.cpi_delivered === 'boolean' ? meta.cpi_delivered : null;
  // Three states, not two. `false` is a CLAIM that the message did not go out,
  // and we may only make it when we actually know — i.e. when CP-I's own reply
  // path stamped it. A row written before CP-I (or by another surface) with no
  // provider id tells us nothing either way, so it is `null` = unknown and gets
  // NO note. Rendering "Logged — not delivered" over those would be the mirror
  // image of D5's sin: instead of implying a send that never happened, it would
  // deny a send that may well have.
  const delivered = r.direction === 'inbound'
    ? null
    : (explicit !== null ? explicit : (r.provider_message_id ? true : null));
  return {
    id: r.id,
    source: r.source,
    direction: r.direction,
    channel: r.channel,
    body: r.body,
    created_at: r.created_at,
    // The EXACT stored timestamp as text. `created_at` has been through pg's
    // Date parser and JSON, both millisecond-precision, while Postgres stores
    // microseconds — so the JSON value is rounded DOWN and is unusable as a read
    // watermark: stamping it leaves last_read_at fractionally behind the very
    // message it was meant to cover, and the contact never clears.
    created_at_exact: r.created_at_exact || null,
    ai_generated: r.ai_generated,
    automated: r.source === 'sequence',
    delivered,
    delivery_note: r.direction === 'outbound' && delivered === false
      ? (meta.cpi_delivery_note || `Logged — not delivered (no ${r.channel} provider configured)`)
      : null,
    provider_message_id: r.provider_message_id || null,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ─── read state ──────────────────────────────────────────────────────────────
// Stamp how far the operator has read. `upTo` MUST be the newest created_at
// among the messages actually returned to them — never now().
//
// Stamping now() races an inbound message that arrives after the thread fetch
// but before the stamp: it would be marked read having never been rendered,
// which in a CRM that sends autonomously means a customer message the operator
// never sees. GREATEST() also stops a stale/replayed call moving the mark
// backwards.
//
// Applies to EVERY conversation of the contact, closed ones included — a closed
// email conversation still holds messages, and leaving it unstamped would keep
// the contact permanently unread.
// `upTo` MUST be a `created_at_exact` value handed out by getThread — the exact
// microsecond-precision timestamp of the newest message the operator was
// actually shown, as text. Because it is exact there is no rounding to
// compensate for and no tolerance window: we stamp precisely that instant.
//
// That exactness is what makes the invariant hold. A tolerance window (say
// "+1ms") would snap the watermark PAST a message that committed inside the
// window and was never rendered — silently marking an unseen customer message
// read, which is the failure this whole design exists to prevent. GREATEST also
// stops a stale or replayed call moving the mark backwards.
//
// Applies to EVERY conversation of the contact, closed ones included — a closed
// conversation still holds messages, and leaving it unstamped keeps the contact
// permanently unread.
async function markRead(companyId, contactId, upTo) {
  if (!companyId) throw new Error('inbox.markRead requires companyId');
  if (!upTo) return 0; // nothing was shown, so nothing has been read
  const result = await query(
    `UPDATE conversations cv
        SET last_read_at = GREATEST(COALESCE(cv.last_read_at, '-infinity'::timestamptz), $3::timestamptz),
            updated_at = now()
      WHERE cv.company_id = $1 AND cv.contact_id = $2`,
    [companyId, contactId, upTo]
  );
  return result.rowCount;
}

async function setStarred(companyId, contactId, starred) {
  if (!companyId) throw new Error('inbox.setStarred requires companyId');
  const result = await query(
    `UPDATE conversations SET starred = $3, updated_at = now()
      WHERE company_id = $1 AND contact_id = $2`,
    [companyId, contactId, !!starred]
  );
  return result.rowCount;
}

// Mirrors setStarred exactly: a contact's unified thread can span several
// conversations (one per channel, per the header note), so "assign this
// contact to me" reassigns every one of them rather than inventing a
// contact-level assignee column that would drift from the per-conversation
// truth conversations.js already reads and writes.
const ASSIGNEES = ['ai', 'human'];
async function setAssignee(companyId, contactId, assignee) {
  if (!companyId) throw new Error('inbox.setAssignee requires companyId');
  if (!ASSIGNEES.includes(assignee)) throw new Error(`inbox.setAssignee: assignee must be one of ${ASSIGNEES.join(', ')}`);
  const result = await query(
    `UPDATE conversations SET assignee = $3, updated_at = now()
      WHERE company_id = $1 AND contact_id = $2`,
    [companyId, contactId, assignee]
  );
  return result.rowCount;
}

// ─── deal scope (D6) ─────────────────────────────────────────────────────────
// "Open" has exactly one definition in this codebase: the deal's stage is NOT
// one of its pipeline's terminal stages. That is what the dispatcher's stage
// write-back uses (db/models/dispatch.js), and using `closed_at IS NULL` instead
// would disagree with it — the dispatcher never consults that column.
//
// A deal whose pipeline_key is NULL or names a config this tenant does not have
// is AMBIGUOUS: we cannot know its terminal set, so it is returned flagged and
// the caller must never auto-select it as context. Guessing which deal a message
// belongs to would corrupt deal history.
async function listOpenDeals(companyId, contactId) {
  if (!companyId) throw new Error('inbox.listOpenDeals requires companyId');
  const deals = await query(
    `SELECT d.id, d.title, d.stage, d.pipeline_key, d.value, d.currency, d.created_at
       FROM deals d
      WHERE d.company_id = $1 AND d.contact_id = $2
      ORDER BY d.created_at DESC`,
    [companyId, contactId]
  );
  const configs = new Map();
  const out = [];
  for (const d of deals.rows) {
    if (!d.pipeline_key) { out.push({ ...d, open: true, ambiguous: true, pipeline_name: null }); continue; }
    if (!configs.has(d.pipeline_key)) configs.set(d.pipeline_key, await getPipelineConfig(companyId, d.pipeline_key));
    const cfg = configs.get(d.pipeline_key);
    if (!cfg) { out.push({ ...d, open: true, ambiguous: true, pipeline_name: null }); continue; }
    const terminals = (cfg.stages || []).filter(s => s && s.terminal === true).map(s => s.key);
    if (terminals.includes(d.stage)) continue; // closed — not offered as context
    out.push({
      ...d, open: true, ambiguous: false,
      pipeline_name: cfg.name || d.pipeline_key,
      funnel_type: cfg.funnel_type || null,
      stage_label: (cfg.stages || []).find(s => s && s.key === d.stage)?.label || d.stage,
      stage_mode: (cfg.stages || []).find(s => s && s.key === d.stage)?.mode || null,
    });
  }
  return out;
}

// Server-side re-validation for every submit that names a deal (D6). A deal can
// close between the moment the composer rendered and the moment Send is clicked,
// so the client's view is never trusted: the deal must exist, belong to THIS
// contact and THIS tenant, and still be open.
async function validateDealScope(companyId, contactId, dealId) {
  if (!dealId) return { ok: true, deal: null };
  const open = await listOpenDeals(companyId, contactId);
  const deal = open.find(d => d.id === dealId);
  if (!deal) return { ok: false, error: 'deal_id is not an open deal belonging to this contact' };
  if (deal.ambiguous) return { ok: false, error: 'deal_id names a deal whose pipeline is unknown — cannot scope to it' };
  return { ok: true, deal };
}

// The right rail (D1): identity, tags, score, stages, open deals, recent activity.
async function getContactContext(companyId, contactId) {
  if (!companyId) throw new Error('inbox.getContactContext requires companyId');
  const c = await query(
    `SELECT id, name, email, phone, company_name, title, linkedin_url, tags,
            lead_score, lead_score_numeric, marketing_stage, deal_stage, source, created_at
       FROM contacts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [contactId, companyId]
  );
  const contact = c.rows[0];
  if (!contact) return null;

  const deals = await listOpenDeals(companyId, contactId);
  const activity = await query(
    `SELECT id, type, message, agent, channel, data, created_at
       FROM contact_activity
      WHERE contact_id = $1 AND company_id = $2
      ORDER BY created_at DESC LIMIT 25`,
    [contactId, companyId]
  );
  const convs = await query(
    `SELECT id, channel, status, starred, assignee, last_read_at, last_message_at
       FROM conversations WHERE contact_id = $1 AND company_id = $2
      ORDER BY last_message_at DESC NULLS LAST`,
    [contactId, companyId]
  );
  return { contact, deals, activity: activity.rows, conversations: convs.rows };
}

module.exports = {
  CHANNELS, ASSIGNEES,
  listInbox, getThread, markRead, setStarred, setAssignee,
  listOpenDeals, validateDealScope, getContactContext,
};
