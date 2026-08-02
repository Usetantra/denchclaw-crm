'use strict';
// ─── Resend email send adapter ────────────────────────────────────────────────
// Delivers outbound email from the CRM inbox via Resend. Configured with
// RESEND_API_KEY (secret — set in .env, never committed). If the key is unset the
// CRM records the message but does not deliver it (isConfigured() === false), so
// local/demo use is unaffected until a real account is connected.

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

const TIMEOUT_MS = parseInt(process.env.RESEND_TIMEOUT_MS, 10) || 15000;

// Overridable base so the send path can be exercised against a LOCAL STUB.
// Without this the endpoint was hardcoded, which meant the only way to test a
// real pending → sent flip was to point at api.resend.com with a live key — i.e.
// to email real people from a test run. Defaults to the real API, so production
// behaviour is unchanged and a stub is always a deliberate, explicit opt-in.
const API_BASE = () => process.env.RESEND_API_BASE || 'https://api.resend.com';

// Sends one email. Throws on any failure (caller maps to a 502). Returns { id }
// where id is Resend's provider message id (stored as provider_message_id).
async function sendEmail({ from, to, cc, bcc, subject, text, replyTo, idempotencyKey = null }) {
  const key = process.env.RESEND_API_KEY;
  // Pre-flight failures are DEFINITIVE by construction: no request has been
  // made, so nothing can have been delivered. They are also CONFIG-shaped, and
  // the caller must not let them consume a delivery retry — see the executor's
  // boot gate.
  const preflight = (m) => { const e = new Error(m); e.definitive = true; e.configError = true; throw e; };
  if (!key) preflight('RESEND_API_KEY not configured');
  if (!from) preflight('no connected sender (from) for this channel');
  if (!to) preflight('recipient (to) is required');

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject: subject || '(no subject)',
    text: text || '',
  };
  if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
  if (bcc) payload.bcc = Array.isArray(bcc) ? bcc : [bcc];
  // Reply-To routes replies to the inbound address (e.g. a Cloudflare-routed
  // handle) so they come back into the CRM inbox instead of the From mailbox.
  if (replyTo) payload.reply_to = replyTo;
  // Stamp a stable Message-ID so an inbound reply's In-Reply-To can be matched
  // back to this exact message ("in reply to …" in the thread). Best-effort —
  // the UI falls back to the nearest preceding outbound if the header doesn't line up.
  const domain = (String(from).match(/@([^>\s]+)/) || [])[1] || 'crm.local';
  const messageId = `<crm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${domain}>`;
  payload.headers = { 'Message-ID': messageId };

  // CP4a HIGH-1: a bare fetch with no timeout is how "outcome unknown" became
  // "up to 3 duplicate physical sends". If the connection drops AFTER Resend
  // accepted the message, the mail is already out but the caller sees an error;
  // treating that as a failure requeues it and the next tick sends it again.
  //
  // So the two cases are now distinguishable BY TYPE, not by string-matching a
  // message:
  //   err.definitive === true  → the provider positively rejected it (4xx, or a
  //                              pre-flight validation error). Nothing was sent.
  //                              Safe to consume a retry.
  //   err.outcomeUnknown === true → timeout/abort/network fault. The request may
  //                              already have been delivered. NEVER retry on
  //                              this; the caller quarantines instead.
  // A 5xx is deliberately `outcomeUnknown`, not definitive: an upstream error
  // after acceptance looks identical to one before it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`${API_BASE()}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // If the provider honours it, a retried request with the same key
        // collapses instead of sending twice. Belt and braces alongside the
        // quarantine — we do not depend on it.
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(
      err.name === 'AbortError'
        ? `Resend: no response within ${TIMEOUT_MS}ms — the message may or may not have been sent`
        : `Resend: network fault (${err.message}) — the message may or may not have been sent`
    );
    e.outcomeUnknown = true;
    throw e;
  }

  // The timer stays armed across the BODY read too: a server that returns
  // headers and then stalls the body would otherwise hold the tick open
  // indefinitely, widening the window in which a reclaim can double-send.
  let j = {};
  try { j = await r.json(); } catch (_e) { /* non-json error body */ }
  finally { clearTimeout(timer); }
  if (!r.ok) {
    const msg = j.message || j.error || `HTTP ${r.status}`;
    const e = new Error(`Resend: ${msg}`);
    // Classification matters more than the status class, because "definitive"
    // is licence to consume a retry, and three consumed retries dead-letter the
    // job — which exits the enrollment TERMINALLY.
    //   401/403 — our credentials or sending domain are wrong. That is OUR
    //             misconfiguration, identical for every job, and burning
    //             retries on it would shred every active ladder in three ticks.
    //   429     — rate limited. Nothing was sent and it will succeed later, so
    //             it must not cost the message one of its three lives.
    //   other 4xx — the provider genuinely rejected THIS message.
    //   5xx     — may have been accepted before failing; outcome unknown.
    if (r.status === 401 || r.status === 403) { e.configError = true; e.definitive = true; }
    else if (r.status === 429) { e.transient = true; }
    else if (r.status >= 400 && r.status < 500) e.definitive = true;
    else e.outcomeUnknown = true;
    e.status = r.status;
    throw e;
  }
  return { id: j.id || null, messageId };
}

module.exports = { isConfigured, sendEmail, TIMEOUT_MS, API_BASE };
