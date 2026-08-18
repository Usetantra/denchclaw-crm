'use strict';
// ─── Tantra API v1 client (the read seam) ────────────────────────────────────
// Thin wrapper around tantra-backend-v2's HTTP API. Endpoint shapes are taken
// from `server/db/models/tantra.md`, which was read from that backend's SOURCE
// and — its own caveat — never exercised against a live tenant. So every field
// name a RESPONSE carries is a strong read that still deserves one smoke test;
// nothing in this file assumes a response shape (that is tantra-normalize.js's
// job, deliberately isolated so one file has to change when reality differs).
//
// This is the ONLY file in the CRM permitted to talk to Tantra. One place to add
// retry, backoff and timeouts; one place to audit what we send.
//
// THREE THINGS THIS FILE MUST OWN — each one costs a day if it leaks elsewhere:
//
//   1. The global `/api/v1` prefix. `GET /health` is the documented exception
//      and sits OUTSIDE it, which is why ping() builds its URL differently.
//
//   2. `forbidNonWhitelisted`. Tantra's global ValidationPipe sets `whitelist`,
//      `transform` AND `forbidNonWhitelisted`, so ONE unknown key fails the
//      whole request with a 400 that reads like a schema mismatch and is not
//      one. Request bodies here are therefore built key-by-key and never spread
//      from a caller's object.
//
//   3. Auth is `X-API-Key`, not Bearer. Keys are `tk_live_…`. Per tantra.md §2.1
//      a ScopesGuard exists in Tantra but is registered NOWHERE, so any valid
//      key reaches every non-public route — contacts, campaigns, settings,
//      billing. The key we are handed is effectively root, which is why it is
//      stored encrypted (channel_connections) and never returned to a client.
//
// TANTRA_API_BASE is overridable so the suite can point at a plain-http stub and
// never make a real outbound call — the same seam UNIPILE_API_BASE and
// RESEND_API_BASE already established in this repo.

function base() {
  return (process.env.TANTRA_API_BASE || 'https://api.usetantra.com').replace(/\/+$/, '');
}

const DEFAULT_TIMEOUT_MS = Number(process.env.TANTRA_API_TIMEOUT_MS || 15000);

async function call(apiKey, path, { method = 'GET', body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!apiKey) {
    const err = new Error('Tantra is not connected — no API key');
    err.status = 401;
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetch(`${base()}${path}`, {
      method,
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    // A timeout and a DNS failure are both "Tantra is unreachable" to the
    // caller. Distinguishing them matters only in the log line.
    const err = new Error(e.name === 'AbortError'
      ? `Tantra API timed out after ${timeoutMs}ms`
      : `Tantra API unreachable: ${e.message}`);
    err.status = 503;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json = null;
  try { json = await r.json(); } catch (_e) {}
  if (!r.ok) {
    // Tantra's ValidationPipe returns { message: string|string[] } on a 400.
    const raw = json && json.message;
    const msg = Array.isArray(raw) ? raw.join('; ') : (raw || `Tantra API error (HTTP ${r.status})`);
    const err = new Error(msg);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ─── health ──────────────────────────────────────────────────────────────────
// GET /health sits OUTSIDE the /api/v1 prefix (tantra.md §2.2). Unauthenticated,
// so it proves reachability but NOT that a key is valid — use verifyKey() for
// that.
async function ping() {
  const r = await fetch(`${base()}/health`, { headers: { Accept: 'application/json' } });
  return { ok: r.ok, status: r.status };
}

// The cheapest authenticated call that proves a key works. Deliberately asks for
// one thread rather than a dedicated whoami route — tantra.md documents no such
// route, and inventing one would be a guess.
async function verifyKey(apiKey) {
  const body = await call(apiKey, `/api/v1/email/threads${qs({ page: 1, limit: 1 })}`);
  return { ok: true, sample: body };
}

// ─── reading conversations ───────────────────────────────────────────────────
// `channels` is a comma-joined subset of Tantra's live channels. Filters are
// optional and AND-combined (tantra.md §2.2).
async function listThreads(apiKey, { channels, page = 1, limit = 25, search, mailboxEmail, emailCampaignId, unreadOnly } = {}) {
  const path = `/api/v1/email/threads${qs({
    channels: Array.isArray(channels) ? channels.join(',') : channels,
    page,
    limit,
    search,
    mailboxEmail,
    emailCampaignId,
    unreadOnly: unreadOnly ? 'true' : undefined,
  })}`;
  return call(apiKey, path);
}

async function getThread(apiKey, threadId) {
  return call(apiKey, `/api/v1/email/threads/${encodeURIComponent(threadId)}`);
}

async function getMessages(apiKey, threadId) {
  return call(apiKey, `/api/v1/email/threads/${encodeURIComponent(threadId)}/messages`);
}

// The cross-channel person view — "everything we said to this person". Its
// `contactId` is a HINT only: Tantra resolves WhatsApp by the last 10 digits of
// a free-form phone, which will eventually match two different people.
async function getThreadPerson(apiKey, threadId) {
  return call(apiKey, `/api/v1/email/threads/${encodeURIComponent(threadId)}/person`);
}

async function getUnreadCount(apiKey) {
  return call(apiKey, `/api/v1/email/threads/unread-count`);
}

// ─── sending ─────────────────────────────────────────────────────────────────
// ONE route replies on every channel, and the social path returns the same
// envelope keys as the email path deliberately (tantra.md §2.4).
//
// NOTE THE LIMIT, it shapes the whole design: this REPLIES to a thread that
// already exists. There is no cold-start send. A webinar reminder to someone who
// has never messaged us has no thread to reply into, which is why the CRM keeps
// its own WhatsApp number rather than routing reminders through Tantra.
//
// The body is built key-by-key on purpose — see `forbidNonWhitelisted` above.
async function reply(apiKey, threadId, { bodyText, bodyHtml } = {}) {
  const payload = {};
  if (bodyText) payload.bodyText = bodyText;
  if (bodyHtml) payload.bodyHtml = bodyHtml;
  if (!payload.bodyText && !payload.bodyHtml) {
    const err = new Error('reply requires bodyText or bodyHtml');
    err.status = 400;
    throw err;
  }
  return call(apiKey, `/api/v1/email/threads/${encodeURIComponent(threadId)}/messages/reply`, {
    method: 'POST',
    body: payload,
  });
}

module.exports = {
  base,
  ping,
  verifyKey,
  listThreads,
  getThread,
  getMessages,
  getThreadPerson,
  getUnreadCount,
  reply,
};
