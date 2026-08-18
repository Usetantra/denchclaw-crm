'use strict';
// ─── CP-I: the unified Inbox HTTP surface ────────────────────────────────────
// Mounted at /api/crm/inbox. A NEW router rather than more routes inside
// conversations.js, deliberately: CP-M has just hand-resolved that file (main's
// composer + the branch's CP1 mode gate and B2 enrollment hook all live in one
// success path there), and piling a second feature into it would put the next
// reconciliation right back on top of the most delicate merge surface in the
// repo. Nothing here changes conversations.js's behaviour; it reuses the same
// libraries so the two paths cannot drift.
//
// Everything is company-scoped, and a cross-tenant id is a 404 — never a 403 and
// never an empty 200, both of which confirm existence.
const express = require('express');
const router = express.Router();
const { query } = require('../db/index');
const inboxDb = require('../db/models/inbox');
const contactDb = require('../db/models/contacts');
const limitsDb = require('../db/models/limits');
const resendEmail = require('../lib/email-resend');
const aiDraft = require('../lib/ai-draft');
const templatesDb = require('../db/models/templates');
const { getPipelineConfig, getPipelineTransitions } = require('../db/pipeline');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const tantraClient = require('../lib/tantra-client');
const tantraExecutor = require('../lib/tantra-executor');

router.use(requireAuth);

const FILTERS = ['all', 'unread', 'mine', 'theirs', 'starred'];

// The connected sending identity for a channel — the same table the composer's
// From selector is built from, resolved from crm.js rather than re-parsed here
// so the two can never disagree. A user never free-types a From.
function pickSender(table, channel) {
  const senders = (table && table[channel]) || [];
  const chosen = senders.find(s => s && s.default) || senders[0];
  return chosen ? chosen.identity : null;
}

// Only email actually delivers today (server/routes/conversations.js gates on
// `channel === 'email' && resendEmail.isConfigured()`). Every other channel
// records a row and sends nothing, and CP-I must say so on screen rather than
// implying a WhatsApp message left the building (D5).
//
// A configured provider with NO connected sender is also "cannot deliver", not
// an error: resendEmail.sendEmail() throws `no connected sender (from)` without
// one, and turning that into a 502 would make every inbox reply fail on a
// deployment that has RESEND_API_KEY but no sending identity yet. Recording it
// honestly is the correct outcome, and it is exactly what D5 asks for.
function canDeliver(channel, table) {
  return channel === 'email' && resendEmail.isConfigured() && !!pickSender(table, channel);
}
function deliveryNote(channel) {
  if (channel !== 'email') return `Logged — not delivered (no ${channel} provider configured)`;
  if (!resendEmail.isConfigured()) return 'Logged — not delivered (email provider not configured)';
  return 'Logged — not delivered (no connected sending address for email)';
}

// Tenant-scoped contact fetch; the shared 404 for "missing OR another tenant's".
async function ownedContact(companyId, contactId) {
  try {
    return await contactDb.getById(contactId, companyId);
  } catch (err) {
    // A malformed uuid is genuinely "not found". Anything else (a pool failure,
    // a DB outage) must NOT be laundered into 404 — that would report a broken
    // database as "this contact does not exist" on all eight endpoints.
    if (err && err.code === '22P02') return null;
    throw err;
  }
}

// Stage-chip payload for a deal (D11): the chip itself plus the ONLY legal
// targets, each annotated with its own mode. The menu is built from this, so an
// illegal target is absent rather than greyed out — a visible control that 409s
// on click is worse than no control. The chip creates no new transition path:
// the client posts the chosen target to the existing /advance authority.
// `advanceable` is the guard against a wrong-object write. The chip is rendered
// PER DEAL, but POST /contacts/:id/advance selects its own target — the newest
// non-terminal deal on that pipeline — and CP-I may not invent a second
// transition path by teaching it to accept a deal_id. So when a contact holds
// more than one open deal on the same pipeline, clicking the OLDER deal's chip
// would silently advance the NEWER one. Those chips are therefore rendered
// inert, with the reason attached, and only the deal /advance would actually
// act on is interactive.
async function stageChipFor(companyId, deal, { siblings = null } = {}) {
  if (!deal || !deal.pipeline_key) return null;
  const cfg = await getPipelineConfig(companyId, deal.pipeline_key);
  if (!cfg) return null;
  const stages = cfg.stages || [];
  const idx = stages.findIndex(s => s && s.key === deal.stage);
  const cur = idx >= 0 ? stages[idx] : null;
  const targets = getPipelineTransitions(cfg, deal.stage) || [];
  // /advance picks `ORDER BY created_at DESC LIMIT 1` among this pipeline's
  // non-terminal deals, so only that one deal's chip may be interactive.
  const samePipeline = (siblings || []).filter(d => d.pipeline_key === deal.pipeline_key);
  const wouldTarget = samePipeline.length
    ? samePipeline.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    : deal;
  const advanceable = String(wouldTarget.id) === String(deal.id);
  return {
    advanceable,
    not_advanceable_reason: advanceable ? null
      : `This contact has another, newer open ${cfg.name || deal.pipeline_key} deal, and the stage authority acts on that one — move this deal from its own record.`,
    pipeline_key: deal.pipeline_key,
    pipeline_name: cfg.name || deal.pipeline_key,
    funnel_type: cfg.funnel_type || null,
    // `label` verbatim — never through nice(), which lowercases (CP1 F4).
    key: deal.stage,
    label: cur?.label || deal.stage,
    mode: cur?.mode || null,
    terminal: cur?.terminal === true,
    index: idx,
    stage_count: stages.length,
    transitions: targets.map(k => {
      const s = stages.find(x => x && x.key === k);
      return { key: k, label: s?.label || k, mode: s?.mode || null, terminal: s?.terminal === true };
    }),
  };
}

// ── GET /api/crm/inbox ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const filter = req.query.filter || 'mine'; // D3: "Your turn" is the default landing view
    if (!FILTERS.includes(filter)) return res.status(400).json({ error: `filter must be one of ${FILTERS.join(', ')}` });
    const channel = req.query.channel || null;
    if (channel && !inboxDb.CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `unknown channel '${channel}'` });
    }
    const assignee = req.query.assignee || null;
    if (assignee && !inboxDb.ASSIGNEES.includes(assignee)) {
      return res.status(400).json({ error: `assignee must be one of ${inboxDb.ASSIGNEES.join(', ')}` });
    }
    const cursor = req.query.cursor || null;
    if (cursor && !/^[^|]+\|[0-9a-fA-F-]{36}$/.test(cursor)) {
      return res.status(400).json({ error: 'cursor must be the next_cursor value from a previous page' });
    }
    const rows = await inboxDb.listInbox(companyId, {
      filter, channel, assignee, q: req.query.q || null,
      limit: req.query.limit, cursor,
    });
    // Stage chip per row so the list is stage-aware without opening a thread.
    // Read-only there — the client renders list chips inert.
    // F18: one deals query for the whole page instead of one per row.
    const dealsByContact = await inboxDb.listOpenDealsForContacts(companyId, rows.map(r => r.contact_id));
    const out = [];
    for (const r of rows) {
      const deals = dealsByContact.get(r.contact_id) || [];
      out.push({
        ...r,
        open_deal_count: deals.length,
        stage: deals[0] ? await stageChipFor(companyId, deals[0], { siblings: deals }) : null,
      });
    }
    const last = out[out.length - 1];
    res.json({
      total: out.length,
      filter,
      // Composite keyset cursor: "<timestamp>|<contact id>". The id half is what
      // makes contacts tied on last_message_at reachable instead of skipped.
      next_cursor: out.length
        ? `${last.last_message_at ? new Date(last.last_message_at).toISOString() : '-infinity'}|${last.contact_id}`
        : null,
      contacts: out,
    });
  } catch (err) {
    console.error('[CRM] GET /inbox error:', err.message);
    res.status(500).json({ error: 'failed to load inbox' });
  }
});

// ── GET /api/crm/inbox/:contactId/thread ─────────────────────────────────────
// Returns the unified thread PLUS everything the right rail needs, so opening a
// contact is one round trip.
//
// It deliberately does NOT stamp read state. `read_through` is the newest
// created_at among the messages actually returned; the client posts exactly that
// value back to POST /read. Stamping here (or stamping now()) would mark an
// inbound message read that arrived after this query and was never rendered —
// a customer message lost from the operator's view.
router.get('/:contactId/thread', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const thread = await inboxDb.getThread(companyId, contact.id, { limit: req.query.limit });
    const ctx = await inboxDb.getContactContext(companyId, contact.id);
    const senderTable = await require('./crm').getChannelSenders(companyId);
    const deals = [];
    for (const d of ctx.deals) deals.push({ ...d, stage_chip: await stageChipFor(companyId, d, { siblings: ctx.deals }) });

    // D9: surface A5's rules rather than duplicating them. The server enforces
    // them again on submit; this is what lets the UI disable Send with a reason.
    const supp = await query(
      `SELECT channel, reason FROM suppressions WHERE company_id = $1 AND contact_id = $2`,
      [companyId, contact.id]
    );
    const suppressions = supp.rows;
    const globalSuppression = suppressions.find(s => s.channel === null) || null;

    // The EXACT (microsecond) timestamp of the newest message actually returned.
    // The client must post this back to /read; the millisecond-rounded
    // `read_through` is kept only for display/debugging.
    const readThrough = thread.length ? thread[thread.length - 1].created_at : null;
    const readThroughExact = thread.length ? thread[thread.length - 1].created_at_exact : null;
    res.json({
      contact: ctx.contact,
      deals,
      activity: ctx.activity,
      conversations: ctx.conversations,
      thread,
      read_through: readThrough,
      read_through_exact: readThroughExact,
      suppressions,
      suppressed_globally: !!globalSuppression,
      suppressed_reason: globalSuppression ? globalSuppression.reason : null,
      suppressed_channels: suppressions.filter(s => s.channel).map(s => s.channel),
      deliverable_channels: inboxDb.CHANNELS.filter(ch => canDeliver(ch, senderTable)),
    });
  } catch (err) {
    console.error('[CRM] GET /inbox/:contactId/thread error:', err.message);
    res.status(500).json({ error: 'failed to load thread' });
  }
});

// ── POST /api/crm/inbox/:contactId/read ──────────────────────────────────────
// `through` must be the `read_through` the thread response handed out. It is
// clamped to the newest message that actually exists, so a stale or replayed
// call can never stamp into the future.
router.post('/:contactId/read', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    // `through` is REQUIRED and must be a value the thread endpoint handed out.
    // It used to default to "the newest message that exists right now", which is
    // the now()-equivalent stamp this design exists to forbid: it covers
    // everything that arrived between the operator's thread fetch and this call,
    // marking messages read that were never rendered.
    const raw = req.body && req.body.through;
    if (!raw) return res.status(400).json({ error: 'through is required — pass the read_through value from GET /thread' });
    const through = new Date(raw);
    if (isNaN(through.getTime())) return res.status(400).json({ error: 'through must be a timestamp' });

    // Clamp to the newest message that actually exists, so a stale, replayed or
    // hostile call can never stamp into the future. When the contact has NO
    // messages at all there is nothing that can have been read, so the clamp
    // must REFUSE rather than fall through — otherwise any caller could stamp
    // last_read_at years ahead during the (real) window where a conversation
    // exists but its first message has not landed yet, and every later inbound
    // would be born read.
    const newest = await query(
      `SELECT max(m.created_at)::text AS newest
         FROM messages m
         JOIN conversations cv ON cv.id = m.conversation_id AND cv.company_id = m.company_id
        WHERE cv.company_id = $1 AND cv.contact_id = $2`,
      [companyId, contact.id]
    );
    const ceiling = newest.rows[0]?.newest || null;
    if (!ceiling) return res.json({ ok: true, conversations_stamped: 0, read_through: null });
    const effective = through > new Date(ceiling) ? ceiling : raw;

    const stamped = await inboxDb.markRead(companyId, contact.id, effective);
    res.json({ ok: true, conversations_stamped: stamped, read_through: effective });
  } catch (err) {
    console.error('[CRM] POST /inbox/:contactId/read error:', err.message);
    res.status(500).json({ error: 'failed to mark read' });
  }
});

// ── PATCH /api/crm/inbox/:contactId/star ─────────────────────────────────────
router.patch('/:contactId/star', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const starred = !!(req.body && req.body.starred);
    const n = await inboxDb.setStarred(companyId, contact.id, starred);
    if (!n) return res.status(409).json({ error: 'contact has no conversation to star yet' });
    res.json({ ok: true, starred, conversations_updated: n });
  } catch (err) {
    console.error('[CRM] PATCH /inbox/:contactId/star error:', err.message);
    res.status(500).json({ error: 'failed to star' });
  }
});

// ── PATCH /api/crm/inbox/:contactId/assignee ─────────────────────────────────
// Mirrors PATCH /star exactly (see setAssignee's comment for why this reassigns
// every one of the contact's conversations rather than a contact-level column).
router.patch('/:contactId/assignee', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const assignee = req.body && req.body.assignee;
    if (!inboxDb.ASSIGNEES.includes(assignee)) {
      return res.status(400).json({ error: `assignee must be one of ${inboxDb.ASSIGNEES.join(', ')}` });
    }
    const n = await inboxDb.setAssignee(companyId, contact.id, assignee);
    if (!n) return res.status(409).json({ error: 'contact has no conversation to assign yet' });
    res.json({ ok: true, assignee, conversations_updated: n });
  } catch (err) {
    console.error('[CRM] PATCH /inbox/:contactId/assignee error:', err.message);
    res.status(500).json({ error: 'failed to assign' });
  }
});

// Find-or-create the open conversation for (contact, channel, account). Mirrors
// conversations.js's own upsert, including the partial unique index's
// `WHERE status != 'closed'` predicate.
//
// `channelAccount` (migration 040) is the B3 grain: one contact can hold two
// open WhatsApp conversations — Tantra's outreach number and the CRM's own —
// and '' means "the CRM's own account", which is every pre-040 row. The
// inference list must match `uq_conversations_contact_channel_account` exactly
// or this INSERT is a 500, not a fallback, so it is not defaulted away.
async function openConversation(companyId, contactId, channel, channelAccount = '') {
  const r = await query(
    `INSERT INTO conversations (company_id, contact_id, channel, channel_account, status, assignee, metadata)
     VALUES ($1,$2,$3,$4,'open','human','{}'::jsonb)
     ON CONFLICT (contact_id, channel, channel_account) WHERE status != 'closed'
     DO UPDATE SET updated_at = now()
     RETURNING *`,
    [companyId, contactId, channel, channelAccount || '']
  );
  return r.rows[0];
}

// ── POST /api/crm/inbox/:contactId/reply ─────────────────────────────────────
router.post('/:contactId/reply', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const { channel, body, deal_id = null, ai_generated = false, subject = null, channel_account = '' } = req.body || {};
    if (!inboxDb.CHANNELS.includes(channel)) return res.status(400).json({ error: `channel must be one of ${inboxDb.CHANNELS.join(', ')}` });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });

    // D9 — A5 is not bypassable just because a human is typing. Enforced here on
    // the server even if the UI's disabled Send is circumvented.
    if (await limitsDb.isSuppressed(companyId, contact.id, channel)) {
      return res.status(403).json({
        error: 'contact is suppressed on this channel — send refused',
        contact_id: contact.id, channel,
      });
    }

    // D6 — a deal can close between render and submit, so the client's view is
    // never trusted.
    const scope = await inboxDb.validateDealScope(companyId, contact.id, deal_id);
    if (!scope.ok) return res.status(400).json({ error: scope.error });

    // `channel_account` (migration 040) selects WHICH account to reply on when a
    // contact has two open conversations on one channel — the B3 split, e.g.
    // Tantra's cold-outreach WhatsApp number vs the CRM's own reminder number.
    // Omitted means '', the CRM's own account, which is what every pre-040
    // caller meant, so existing behaviour is unchanged.
    // A NAMED account must already exist; only the CRM's own ('') is created on
    // demand. Without this, openConversation would happily mint a brand-new
    // CRM-owned conversation carrying someone else's account string — so passing
    // Tantra's number for a contact it has never messaged produced a row with
    // external_system NULL, which reads as "not Tantra-owned" and sends through
    // the CRM's provider on a number labelled as Tantra's. That is precisely the
    // bypass the ownership check below exists to prevent, reachable in exactly
    // the case that matters: before the mirror has seen that thread.
    let conv;
    if (channel_account) {
      const found = await query(
        `SELECT * FROM conversations
          WHERE company_id=$1 AND contact_id=$2 AND channel=$3 AND channel_account=$4
            AND status <> 'closed' LIMIT 1`,
        [companyId, contact.id, channel, channel_account]
      );
      conv = found.rows[0];
      if (!conv) {
        return res.status(404).json({
          error: `no open ${channel} conversation on account '${channel_account}' for this contact. ` +
                 `Omit channel_account to reply from the CRM's own account.`,
        });
      }
    } else {
      conv = await openConversation(companyId, contact.id, channel, '');
    }

    // ── Channel ownership (tantra.md §2.4's hardest rule) ───────────────────
    // "Anything Tantra owns must send through Tantra." Suppression, one-click
    // unsubscribe, warmup pacing, per-account quota reservation, domain health
    // and human-looking send pacing all live on the Tantra side. A second system
    // sending on a Tantra-owned account bypasses every one of them — that is
    // burned sending domains and mail to unsubscribed contacts, which is legal
    // exposure rather than a bug.
    //
    // So a Tantra-owned conversation routes to Tantra's reply endpoint, and if
    // Tantra is not reachable we REFUSE. Falling through to the CRM's own
    // provider would be precisely the forbidden thing, and it would look like a
    // success to the rep.
    const tantraOwned = conv.external_system === 'tantra' && !!conv.external_thread_id;

    // D5 — deliver only where a provider genuinely exists; otherwise record and
    // SAY SO. The outcome is stamped into metadata so the thread never guesses.
    let providerMessageId = null;
    let delivered = false;
    let note = null;
    const senderTable = await require('./crm').getChannelSenders(companyId);
    if (tantraOwned) {
      const apiKey = await tantraExecutor.getApiKey(companyId);
      if (!apiKey) {
        return res.status(409).json({
          error: 'This conversation belongs to a Tantra-owned account and Tantra is not connected. ' +
                 'Sending it from the CRM would bypass Tantra\'s suppression and pacing — refused. ' +
                 'Connect Tantra, or reply on the CRM\'s own account instead.',
          channel, channel_account: conv.channel_account,
        });
      }
      try {
        const sent = await tantraClient.reply(apiKey, conv.external_thread_id, { bodyText: String(body) });
        // The social path returns the same envelope keys as the email path
        // deliberately, so one read covers every channel.
        providerMessageId = sent && (sent.gmailMessageId || sent.messageIdHeader)
          ? `tantra:${sent.gmailMessageId || sent.messageIdHeader}` : null;
        delivered = true;
      } catch (e) {
        console.error('[CRM][inbox] Tantra reply failed:', e.message);
        return res.status(502).json({ error: `Tantra delivery failed — ${e.message}` });
      }
    } else if (canDeliver(channel, senderTable)) {
      try {
        const sent = await resendEmail.sendEmail({
          from: pickSender(senderTable, channel),
          to: contact.email, subject: subject || 'Re: our conversation', text: String(body),
          replyTo: process.env.INBOUND_REPLY_TO || undefined,
        });
        providerMessageId = sent.id || null;
        delivered = true;
        if (sent.messageId) note = null;
      } catch (e) {
        console.error('[CRM][inbox] delivery failed:', e.message);
        return res.status(502).json({ error: `Email delivery failed — ${e.message}` });
      }
    } else {
      note = deliveryNote(channel);
    }

    const metadata = {
      subject: subject || null,
      cpi_delivered: delivered,
      cpi_delivery_note: note,
      deal_id: scope.deal ? scope.deal.id : null,
      source: 'inbox',
    };
    const msg = await query(
      `INSERT INTO messages (conversation_id, company_id, direction, channel, body, ai_generated, provider_message_id, metadata)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7) RETURNING *`,
      [conv.id, companyId, channel, String(body), !!ai_generated, providerMessageId, JSON.stringify(metadata)]
    );
    await query(
      `UPDATE conversations SET last_message_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2`,
      [conv.id, companyId]
    );

    // Same audit row conversations.js writes for an outbound send, so the
    // contact's activity feed reads identically whichever surface sent it.
    await contactDb.addActivity(contact.id, {
      type: 'message_sent',
      message: `Sent ${channel} message${subject ? ` — "${subject}"` : ''}: ${String(body).slice(0, 140)}`
        + (ai_generated ? ' (AI-assisted)' : '') + (delivered ? '' : ' [not delivered]'),
      channel,
      data: {
        conversation_id: conv.id, ai_generated: !!ai_generated, delivered,
        delivery_note: note, deal_id: scope.deal ? scope.deal.id : null, source: 'inbox',
      },
    }, companyId);

    res.status(201).json({
      message: msg.rows[0], delivered, delivery_note: note,
      deal_id: scope.deal ? scope.deal.id : null,
    });
  } catch (err) {
    console.error('[CRM] POST /inbox/:contactId/reply error:', err.message);
    res.status(500).json({ error: 'failed to send reply' });
  }
});

// ── POST /api/crm/inbox/:contactId/note ──────────────────────────────────────
// A note is not a message. It NEVER sends and never writes a `messages` row —
// it lands on the record, and on the deal when one is explicitly in scope.
router.post('/:contactId/note', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const { body, deal_id = null } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });
    const scope = await inboxDb.validateDealScope(companyId, contact.id, deal_id);
    if (!scope.ok) return res.status(400).json({ error: scope.error });

    await contactDb.addActivity(contact.id, {
      type: 'note',
      message: String(body),
      channel: null,
      data: { deal_id: scope.deal ? scope.deal.id : null, source: 'inbox' },
    }, companyId);

    res.status(201).json({ ok: true, deal_id: scope.deal ? scope.deal.id : null, sent: false });
  } catch (err) {
    console.error('[CRM] POST /inbox/:contactId/note error:', err.message);
    res.status(500).json({ error: 'failed to save note' });
  }
});

// ── POST /api/crm/inbox/:contactId/draft ─────────────────────────────────────
// Returns TEXT. It writes nothing, sends nothing, and its output is never parsed
// for actions — see server/lib/ai-draft.js for why that is the security control
// and not merely a style choice.
router.post('/:contactId/draft', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const { channel = 'email', deal_id = null } = req.body || {};
    if (!inboxDb.CHANNELS.includes(channel)) return res.status(400).json({ error: `unknown channel '${channel}'` });
    const scope = await inboxDb.validateDealScope(companyId, contact.id, deal_id);
    if (!scope.ok) return res.status(400).json({ error: scope.error });

    const thread = await inboxDb.getThread(companyId, contact.id, { limit: 50 });
    const draft = await aiDraft.draftReply({
      contact, channel, thread,
      dealTitle: scope.deal ? scope.deal.title : null,
      stageLabel: scope.deal ? scope.deal.stage_label : null,
    });
    res.json({
      draft: draft.text,
      source: draft.source,
      sent: false,
      messages_created: 0,
      note: 'This is a suggestion. It has not been sent and nothing in it has been executed.',
    });
  } catch (err) {
    console.error('[CRM] POST /inbox/:contactId/draft error:', err.message);
    res.status(500).json({ error: 'failed to draft' });
  }
});

// ── GET /api/crm/inbox/:contactId/templates ──────────────────────────────────
// Real message content with {first_name}/{company}/{stage} resolved against this
// contact. CP4a-0 replaced the placeholder here: there IS a content store now
// (message_templates + inline step content), so this returns the actual words a
// prospect would receive instead of the bare `template_ref` label, which is all
// the schema could offer before.
router.get('/:contactId/templates', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contact = await ownedContact(companyId, req.params.contactId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const deals = await inboxDb.listOpenDeals(companyId, contact.id);
    const stageLabel = deals[0]?.stage_label || null;
    const steps = await query(
      `SELECT ss.id, ss.step_order, ss.channel, ss.template_ref, ss.subject, ss.body,
              s.name AS sequence_name
         FROM sequence_steps ss
         JOIN sequences s ON s.id = ss.sequence_id AND s.company_id = ss.company_id
        WHERE ss.company_id = $1 AND (ss.template_ref IS NOT NULL OR ss.body IS NOT NULL)
        ORDER BY s.name ASC, ss.step_order ASC
        LIMIT 100`,
      [companyId]
    );
    const out = [];
    for (const t of steps.rows) {
      const resolved = await templatesDb.resolveStepContent(companyId, t, contact, { stageLabel });
      // A step whose content does not resolve is still listed, flagged — the
      // operator needs to see that a rung of their ladder has no copy, not have
      // it quietly disappear from the picker.
      out.push({
        id: t.id, step_order: t.step_order, channel: t.channel, template_ref: t.template_ref,
        sequence_name: t.sequence_name,
        subject: resolved.subject,
        body: resolved.body,
        resolved: resolved.resolved,
        reason: resolved.reason,
      });
    }
    // Standalone templates the operator authored that no step references yet.
    const standalone = await templatesDb.listTemplates(companyId);
    for (const tpl of standalone) {
      if (out.some(o => o.template_ref === tpl.ref)) continue;
      const resolved = await templatesDb.resolveStepContent(
        companyId, { channel: tpl.channel || 'email', template_ref: tpl.ref }, contact, { stageLabel });
      out.push({
        id: tpl.id, step_order: null, channel: tpl.channel, template_ref: tpl.ref,
        sequence_name: '(standalone template)',
        subject: resolved.subject, body: resolved.body,
        resolved: resolved.resolved, reason: resolved.reason,
      });
    }
    res.json({ total: out.length, templates: out });
  } catch (err) {
    console.error('[CRM] GET /inbox/:contactId/templates error:', err.message);
    res.status(500).json({ error: 'failed to load templates' });
  }
});

module.exports = router;
