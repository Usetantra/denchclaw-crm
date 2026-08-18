'use strict';
// ─── Tantra → CRM translation boundary ───────────────────────────────────────
// PURE. No HTTP, no DB, no `req`. Same shape as webinargeek-sync-engine.js,
// which is this repo's established pattern for exactly this job, and the reason
// both are cheap to test.
//
// THE PROBLEM THIS FILE EXISTS TO CONTAIN
//
// tantra.md §2.2's loudest warning: Tantra's read DTO is EMAIL-SHAPED ON EVERY
// CHANNEL. A WhatsApp message still arrives carrying `gmailMessageId`, and
// `mailboxEmail` may hold a phone number or a LinkedIn handle. Tantra did that
// deliberately, to keep its own frontend working unchanged across channels — it
// is not a bug there. It would be a disaster HERE: a CRM whose domain model
// calls a WhatsApp id `gmailMessageId` has inherited a lie that never washes out.
//
// So: `gmailMessageId` and `mailboxEmail` MUST NOT appear in any other file.
// A static test asserts that, and it is the single most valuable test in the
// suite for this integration.
//
// EVERY FIELD NAME BELOW IS A READ, NOT A FACT. tantra.md states its shapes come
// from source and were never exercised against a live tenant. Each accessor is
// therefore written as an ordered list of candidates ending in a safe default,
// so an envelope that differs degrades to "we could not read that field" rather
// than throwing mid-sweep and stalling the mirror. Phase 0 (capture real
// payloads) is what turns these reads into facts; until then the fallbacks are
// load-bearing, not defensive clutter.

// Tantra's live channels (tantra.md §1). `sms` is deliberately absent: it exists
// in that backend only as a 2FA delivery option during account connect, and its
// channel unions are hardcoded to these three across schemas, DTOs, the webhook
// trigger catalogue and the channel/action matrix. SMS stays wholly CRM-side.
const TANTRA_CHANNELS = ['email', 'linkedin', 'whatsapp', 'telegram'];

function firstOf(obj, keys, fallback = null) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

function str(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

// ─── channel ─────────────────────────────────────────────────────────────────
// Resolution order matters. An explicit `channel` field wins; otherwise the
// `s_` id prefix marks a SOCIAL thread (tantra.md §1: email threads and social
// chats live in separate collections and are merged at read time, with social
// ids carrying that prefix).
//
// We NEVER infer the channel from whether `mailboxEmail` looks like an address.
// That field holds a phone number on WhatsApp and a handle on LinkedIn, so the
// inference is wrong exactly when it matters.
function detectChannel(raw, hint = null) {
  const explicit = str(firstOf(raw, ['channel', 'channelType', 'provider', 'source']));
  if (explicit) {
    const c = explicit.toLowerCase();
    if (TANTRA_CHANNELS.includes(c)) return c;
  }
  if (hint && TANTRA_CHANNELS.includes(hint)) return hint;
  const id = str(firstOf(raw, ['id', 'threadId', '_id']));
  if (id && id.startsWith('s_')) return null; // social, but which one is unknowable here
  return 'email';
}

// ─── direction ───────────────────────────────────────────────────────────────
// Tantra marks its own sends variously. Anything we cannot read confidently is
// treated as INBOUND, because the cost is asymmetric: a misfiled inbound shows a
// rep an extra message to answer, while a misfiled outbound silently flips whose
// turn it is and can make an unanswered person look handled.
function detectDirection(raw) {
  const d = str(firstOf(raw, ['direction']));
  if (d) {
    const v = d.toLowerCase();
    if (v === 'outbound' || v === 'out' || v === 'sent') return 'outbound';
    if (v === 'inbound' || v === 'in' || v === 'received') return 'inbound';
  }
  const flag = firstOf(raw, ['isOutbound', 'fromMe', 'isFromMe', 'outgoing']);
  if (flag === true) return 'outbound';
  if (flag === false) return 'inbound';
  return 'inbound';
}

function toIso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── identity normalisation ──────────────────────────────────────────────────
function normalizeEmail(v) {
  const s = str(v);
  return s ? s.trim().toLowerCase() : null;
}

// E.164-ish: digits only, keep a leading +. We do NOT implement Tantra's
// last-10-digit suffix fallback. That is a defensible call for outreach and a
// liability at CRM scale — it will eventually merge two different people — so
// where we use it at all it is recorded as `confidence:'heuristic'` by the sync
// engine, never applied silently here.
function normalizePhone(v) {
  const s = str(v);
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return null;
  return `+${digits}`;
}

function normalizeLinkedIn(v) {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Which identity kind a given channel's participant address represents.
function identityKindFor(channel) {
  if (channel === 'email') return 'email';
  if (channel === 'whatsapp') return 'whatsapp';
  if (channel === 'linkedin') return 'linkedin';
  if (channel === 'telegram') return 'telegram';
  return null;
}

function normalizeIdentityValue(channel, v) {
  if (channel === 'email') return normalizeEmail(v);
  if (channel === 'whatsapp') return normalizePhone(v);
  if (channel === 'linkedin') return normalizeLinkedIn(v);
  const s = str(v);
  return s ? s.trim().toLowerCase() : null;
}

// ─── the two exported translators ────────────────────────────────────────────

// A Tantra thread → the CRM's view of a conversation.
//
// `accountRef` is the Tantra-side account the thread belongs to. It becomes
// `conversations.channel_account` (migration 040), which is what lets one
// contact hold BOTH Tantra's outreach WhatsApp thread and the CRM's own
// reminder thread without colliding on the partial unique index.
function normalizeThread(raw, { channelHint = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const externalThreadId = str(firstOf(raw, ['id', 'threadId', '_id']));
  if (!externalThreadId) return null;

  const channel = detectChannel(raw, channelHint);

  // `mailboxEmail` is read HERE and nowhere else in the CRM. On email it is an
  // address; on WhatsApp a phone number; on LinkedIn a handle. It identifies the
  // ACCOUNT, not the person — which is precisely what channel_account wants.
  const accountRef = str(firstOf(raw, ['mailboxEmail', 'accountId', 'accountRef', 'mailbox'])) || '';

  const counterparty = firstOf(raw, ['participant', 'contact', 'person', 'attendee'], null);
  const counterpartyAddress = str(firstOf(raw, ['participantEmail', 'contactEmail', 'fromEmail', 'from'])) ||
    (counterparty ? str(firstOf(counterparty, ['email', 'phone', 'handle', 'identifier'])) : null);

  return {
    externalSystem: 'tantra',
    externalThreadId,
    channel,                       // null when social-but-unknown; caller supplies the hint
    accountRef,
    subject: str(firstOf(raw, ['subject', 'title'])),
    lastMessageAt: toIso(firstOf(raw, ['lastMessageAt', 'updatedAt', 'lastActivityAt', 'date'])),
    unreadCount: Number(firstOf(raw, ['unreadCount'], 0)) || 0,
    // A HINT. Never a join key — see normalizePhone above.
    tantraContactId: str(firstOf(raw, ['contactId', 'personId'])),
    counterparty: {
      name: str(firstOf(raw, ['participantName', 'contactName', 'name'])) ||
            (counterparty ? str(firstOf(counterparty, ['name', 'fullName'])) : null),
      address: counterpartyAddress,
      kind: identityKindFor(channel),
      value: normalizeIdentityValue(channel, counterpartyAddress),
    },
  };
}

// A Tantra message → one CRM `messages` row.
//
// `providerMessageId` is the mirror's IDEMPOTENCY KEY. It lands in
// `messages.provider_message_id`, which carries a partial unique index
// (`uq_messages_provider_id`, migration 004), so a replayed webhook and an
// overlapping sweep page cannot double-write. `gmailMessageId` is read here —
// and, despite the name, is the id on EVERY channel including WhatsApp.
function normalizeMessage(raw, { channel = null, accountRef = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const providerMessageId = str(firstOf(raw, ['gmailMessageId', 'messageId', 'id', '_id']));
  if (!providerMessageId) return null;

  const resolvedChannel = detectChannel(raw, channel) || channel || 'email';

  return {
    providerMessageId: `tantra:${providerMessageId}`,   // namespaced: a Tantra id must never
                                                        // collide with a Twilio/Resend id in the
                                                        // tenant-wide unique index
    externalMessageId: providerMessageId,
    direction: detectDirection(raw),
    channel: resolvedChannel,
    accountRef: str(firstOf(raw, ['mailboxEmail', 'accountId', 'accountRef'])) || accountRef || '',
    body: str(firstOf(raw, ['bodyText', 'text', 'body', 'snippet', 'content'])) || '',
    bodyHtml: str(firstOf(raw, ['bodyHtml', 'html'])),
    subject: str(firstOf(raw, ['subject'])),
    sentAt: toIso(firstOf(raw, ['sentAt', 'date', 'createdAt', 'timestamp'])),
    from: str(firstOf(raw, ['fromEmail', 'from', 'sender'])),
    to: str(firstOf(raw, ['toEmail', 'to', 'recipient'])),
  };
}

// A page of threads → normalised threads, dropping only what is unreadable.
// A thread we cannot identify is skipped rather than throwing: one malformed
// row must not stall the whole sweep and freeze the watermark.
function normalizeThreadPage(page, { channelHint = null } = {}) {
  const rows = Array.isArray(page) ? page
    : (page && (page.threads || page.data || page.items || page.results)) || [];
  const out = [];
  for (const r of rows) {
    const t = normalizeThread(r, { channelHint });
    if (t) out.push(t);
  }
  return out;
}

function normalizeMessageList(payload, opts = {}) {
  const rows = Array.isArray(payload) ? payload
    : (payload && (payload.messages || payload.data || payload.items || payload.results)) || [];
  const out = [];
  for (const r of rows) {
    const m = normalizeMessage(r, opts);
    if (m) out.push(m);
  }
  return out;
}

module.exports = {
  TANTRA_CHANNELS,
  detectChannel,
  detectDirection,
  normalizeEmail,
  normalizePhone,
  normalizeLinkedIn,
  identityKindFor,
  normalizeIdentityValue,
  normalizeThread,
  normalizeMessage,
  normalizeThreadPage,
  normalizeMessageList,
};
