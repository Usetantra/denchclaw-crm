'use strict';
// ─── Tantra mirror: resolution + write logic ─────────────────────────────────
// No HTTP. Everything here takes ALREADY-NORMALISED input (tantra-normalize.js)
// and a company id, and writes through the CRM's own tables. Kept separate from
// the executor so the hard parts — contact resolution, idempotency, the B3
// two-account grain — are testable without a network stub.
//
// IDEMPOTENCY IS STRUCTURAL, NOT CHECKED
//
// The mirror never asks "have I seen this message?". It writes with
// `provider_message_id` set and lets `uq_messages_provider_id` (migration 004,
// partial unique on (company_id, provider_message_id)) decide. That matters
// because the two write paths OVERLAP by design: a webhook nudge and the
// periodic sweep will both re-read a hot thread, and pages shift under a
// newest-first sort while we page through them. A checked-then-written design
// would race; ON CONFLICT DO NOTHING cannot.
//
// Ids are namespaced `tantra:<id>` by the normaliser because that unique index
// is TENANT-wide, not per-channel: an unnamespaced Tantra id could collide with
// a Twilio or Resend id and silently drop a real message.

const { query } = require('../db/index');
const tantraSync = require('../db/models/tantra-sync');
const contactDb = require('../db/models/contacts');
const normalize = require('./tantra-normalize');

// ─── contact resolution ──────────────────────────────────────────────────────
// Order is deliberate, strongest evidence first:
//
//   1. An external identity we recorded ourselves (exact)
//   2. The channel handle as an external identity (exact)
//   3. contacts.email, case-insensitive
//   4. contacts.phone, exact on normalised digits
//   5. create
//
// Tantra's own `contactId` is stored as a HINT and is never step 1's key on its
// own, because Tantra resolves WhatsApp by the LAST 10 DIGITS of a free-form
// phone. That is a defensible call for outreach and a liability at CRM scale —
// it will eventually merge two different people. Inheriting its contactId as a
// join key would import that mistake wholesale and make it un-auditable here.
async function resolveContact(companyId, thread, { allowCreate = true } = {}) {
  const cp = thread.counterparty || {};
  const kind = cp.kind;
  const value = cp.value;

  // 1 + 2 — an identity we already linked.
  if (kind && value) {
    const hit = await tantraSync.findIdentity(companyId, kind, value);
    if (hit) {
      const contact = await contactDb.getById(hit.contact_id, companyId);
      if (contact) return { contact, created: false, matchedBy: `identity:${kind}` };
    }
  }

  // 3 — email is the authoritative dedupe key everywhere else in this repo
  // (routes/crm.js findOrCreateContact), and this must not disagree with it.
  if (kind === 'email' && value) {
    const contact = await contactDb.getByEmail(value, companyId);
    if (contact) return { contact, created: false, matchedBy: 'email' };
  }

  // 4 — exact normalised phone. NOT the last-10-digit suffix: a suffix match is
  // recorded by the caller as confidence:'heuristic' for review, never used to
  // silently attach a conversation to an existing person.
  if (kind === 'whatsapp' && value) {
    const digits = value.replace(/\D/g, '');
    const r = await query(
      `SELECT * FROM contacts
        WHERE company_id=$1 AND deleted_at IS NULL
          AND phone IS NOT NULL
          AND regexp_replace(phone, '[^0-9]', '', 'g') = $2
        LIMIT 2`,
      [companyId, digits]
    );
    if (r.rows.length === 1) return { contact: r.rows[0], created: false, matchedBy: 'phone' };
    // Two contacts share this number — refuse to guess. Creating a third would
    // be worse; the thread is left unattached and surfaces as a heuristic
    // review item instead.
    if (r.rows.length > 1) return { contact: null, created: false, matchedBy: 'ambiguous' };
  }

  if (kind === 'linkedin' && value) {
    const r = await query(
      `SELECT * FROM contacts
        WHERE company_id=$1 AND deleted_at IS NULL AND linkedin_url IS NOT NULL
          AND lower(linkedin_url) LIKE '%' || $2 || '%'
        LIMIT 2`,
      [companyId, value]
    );
    if (r.rows.length === 1) return { contact: r.rows[0], created: false, matchedBy: 'linkedin' };
    if (r.rows.length > 1) return { contact: null, created: false, matchedBy: 'ambiguous' };
  }

  if (!allowCreate) return { contact: null, created: false, matchedBy: 'none' };

  const contact = await contactDb.create({
    company_id: companyId,
    name: cp.name || (kind === 'email' && value ? value.split('@')[0] : null) || 'Unknown',
    email: kind === 'email' ? value : null,
    phone: kind === 'whatsapp' ? value : null,
    linkedin_url: kind === 'linkedin' && value ? `https://linkedin.com/in/${value}` : null,
    source: 'tantra',
  });

  return { contact, created: true, matchedBy: 'created' };
}

// ─── conversation resolution ─────────────────────────────────────────────────
// The B3 grain. `channel_account` (migration 040) is Tantra's account ref, so a
// contact reached on Tantra's outreach WhatsApp number and on the CRM's own
// reminder number holds TWO open conversations rather than colliding on the
// partial unique index. The inbox groups by CONTACT, so both still render as one
// thread — which is the entire point of the split.
async function upsertConversation(companyId, contactId, thread) {
  // syncThread refuses a thread with no channel, so this is never null here.
  const channel = thread.channel;
  const channelAccount = thread.accountRef || '';

  const r = await query(
    `INSERT INTO conversations
       (company_id, contact_id, channel, channel_account, status, assignee, metadata,
        external_system, external_thread_id, last_message_at)
     VALUES ($1,$2,$3,$4,'open','human',$5,'tantra',$6,$7)
     ON CONFLICT (contact_id, channel, channel_account) WHERE status != 'closed'
     DO UPDATE SET
       updated_at = now(),
       external_system = 'tantra',
       external_thread_id = COALESCE(conversations.external_thread_id, EXCLUDED.external_thread_id),
       last_message_at = GREATEST(COALESCE(conversations.last_message_at, 'epoch'::timestamptz),
                                  COALESCE(EXCLUDED.last_message_at, 'epoch'::timestamptz))
     RETURNING *`,
    [
      companyId, contactId, channel, channelAccount,
      JSON.stringify({ source: 'tantra', tantra_thread_id: thread.externalThreadId, subject: thread.subject || null }),
      thread.externalThreadId,
      thread.lastMessageAt,
    ]
  );
  return r.rows[0];
}

// ─── message write ───────────────────────────────────────────────────────────
// Deliberately a direct INSERT rather than a self-call to
// POST /api/crm/conversations/:id/messages. That route runs the SEND path — it
// can deliver, it advances stages, it fires enrollment hooks. Mirroring history
// must do none of those: replaying a year of backfill through it would re-send
// mail and re-trigger sequences. So the mirror writes the row and nothing else,
// and the ON CONFLICT below is the same protection that route relies on.
async function writeMessage(companyId, conversationId, msg) {
  const r = await query(
    `INSERT INTO messages
       (conversation_id, company_id, direction, channel, body, ai_generated,
        provider_message_id, metadata, created_at)
     VALUES ($1,$2,$3,$4,$5,false,$6,$7, COALESCE($8::timestamptz, now()))
     ON CONFLICT (company_id, provider_message_id) WHERE provider_message_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      conversationId, companyId, msg.direction, msg.channel, msg.body || '',
      msg.providerMessageId,
      JSON.stringify({
        source: 'tantra',
        tantra_message_id: msg.externalMessageId,
        channel_account: msg.accountRef || '',
        subject: msg.subject || null,
        mirrored: true,
      }),
      msg.sentAt,
    ]
  );
  return { message: r.rows[0] || null, created: !!r.rows[0] };
}

// ─── one thread, end to end ──────────────────────────────────────────────────
// Returns a report rather than throwing on a soft failure: a single unreadable
// thread must not stall a sweep and freeze the watermark behind it.
async function syncThread(companyId, thread, messages, { allowCreate = true } = {}) {
  const report = {
    threadId: thread.externalThreadId,
    channel: thread.channel,
    contactId: null,
    contactCreated: false,
    matchedBy: null,
    messagesSeen: messages.length,
    messagesWritten: 0,
    skipped: null,
  };

  // A thread we cannot classify must NOT be filed as email. `detectChannel`
  // returns null for a social thread (`s_` id prefix) that carries no explicit
  // channel field, and the conversation upsert used to fall back to 'email' —
  // so a WhatsApp chat would land in the wrong channel, with a null counterparty
  // kind that also skips identity linking. Since Phase 0 has never run against a
  // live tenant, whether Tantra sends that field is unverified, which makes this
  // the difference between "the mirror is empty" (obvious) and "every social
  // thread is silently mis-channelled" (invisible until someone replies on the
  // wrong medium). Skip loudly instead.
  if (!thread.channel) {
    report.skipped = 'channel could not be determined for this thread — not filed, to avoid mis-channelling it';
    report.retryable = false;   // a payload-shape problem; retrying changes nothing
    return report;
  }

  const { contact, created, matchedBy } = await resolveContact(companyId, thread, { allowCreate });
  report.matchedBy = matchedBy;
  if (!contact) {
    // 'ambiguous' means two CRM contacts share the identity. Guessing here is
    // exactly the mis-merge this integration is supposed to avoid.
    report.skipped = matchedBy === 'ambiguous'
      ? 'ambiguous identity — two contacts match, refusing to guess'
      : 'no contact and creation not allowed';
    // A DECIDED skip, not a transient one: re-reading this thread next tick
    // produces the same refusal, so it must not hold the sweep's watermark back
    // forever. It needs an operator to merge or separate the two contacts.
    report.retryable = false;
    return report;
  }
  report.contactId = contact.id;
  report.contactCreated = created;

  const cp = thread.counterparty || {};
  if (cp.kind && cp.value) {
    await tantraSync.linkIdentity(companyId, contact.id, {
      kind: cp.kind, value: cp.value,
      confidence: 'exact', linkedBy: 'sync',
      metadata: { thread_id: thread.externalThreadId },
    });
  }
  if (thread.tantraContactId) {
    // Stored as a hint so a later thread from the same person resolves in one
    // hop. Never the sole basis for a merge — see resolveContact's header.
    await tantraSync.linkIdentity(companyId, contact.id, {
      kind: 'contact', value: thread.tantraContactId,
      confidence: 'exact', linkedBy: 'sync',
    });
  }

  const conv = await upsertConversation(companyId, contact.id, thread);
  if (!conv) { report.skipped = 'conversation upsert returned nothing'; return report; }

  for (const m of messages) {
    const { created: wrote } = await writeMessage(companyId, conv.id, {
      ...m,
      channel: m.channel || thread.channel || 'email',
      accountRef: m.accountRef || thread.accountRef || '',
    });
    if (wrote) report.messagesWritten += 1;
  }

  return report;
}

module.exports = { resolveContact, upsertConversation, writeMessage, syncThread, normalize };
