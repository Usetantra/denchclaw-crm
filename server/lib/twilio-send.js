'use strict';
// ─── CP-C: Twilio provider (SMS + WhatsApp Business API) ─────────────────────
//
// WHY THIS EXISTS RATHER THAN WRAPPING automation_core's twilio_send.
// The rule for CP-C is "wrap, do not rebuild", and I checked before writing:
// `automation_core/integrations/twilio.py:34` builds its URL as
//   f"https://api.twilio.com/2010-04-01/Accounts/{sid}"
// with NO override — that hardcoded host is the only `api.twilio.com` occurrence
// in any of the three repos. So the standing rule "never point an executor at a
// real provider key in testing" is UNSATISFIABLE by reuse: a wrapped
// `twilio_send` cannot be tested at all, only fired at Twilio for real.
//
// So this is a thin client with a `TWILIO_API_BASE` seam, exactly as
// `RESEND_API_BASE` did for email. Everything else IS borrowed from upstream:
//   * auth precedence — API-key SID/secret first, account SID/token as fallback
//     (integrations/twilio.py:18-23),
//   * form-encoded body against /Messages.json,
//   * the `whatsapp:` prefix on both From and To (channels/whatsapp.py),
//   * ContentSid + positional ContentVariables for approved templates
//     (channels/whatsapp.py:56-69) — real, hard-won Twilio-template knowledge.
//
// WHAT IS DELIBERATELY NOT BORROWED: upstream's error handling. It returns a
// bare `{ok:false}` for a 400, a 429 and a timeout alike (twilio.py:57-61), and
// captures Twilio's `code`/`message` without ever reading them. Downstream that
// is a live duplicate-send bug — a timeout records `event_type="error"`, which
// `channel_send_state` does not count, so the dispatcher re-sends the same step
// on every tick, forever, and Twilio has no idempotency key to save you. The
// classification below is the same three-way split the email executor relies on,
// so the CRM's send-reserve (`send_started_at`) can do its job.
const TIMEOUT_MS = parseInt(process.env.TWILIO_TIMEOUT_MS, 10) || 15000;

// Overridable base so the send path can be exercised against a LOCAL STUB.
// Defaults to the real API, so a stub is always a deliberate, explicit opt-in.
// Trailing slashes are stripped. The URL below appends an absolute path, so a
// base of `http://127.0.0.1:3141/` yields `//2010-04-01/...` — which most stubs
// still route and some do not, and the failure looks like a broken executor
// rather than a typo in an env var. `UNIPILE_API_BASE` does the same.
const API_BASE = () =>
  String(process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, '');

function accountSid() { return process.env.TWILIO_ACCOUNT_SID || ''; }

// Borrowed precedence: a restricted API key is preferred over the account token,
// because the account token can do anything to the account.
function credentials() {
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (keySid && keySecret) return { user: keySid, pass: keySecret };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (sid && token) return { user: sid, pass: token };
  return null;
}

function isConfigured() {
  return !!(accountSid() && credentials());
}

// The sender identity per channel. SMS uses TWILIO_PHONE; WhatsApp prefers
// TWILIO_WHATSAPP and falls back to the SMS number with the required prefix.
// NOTE, and it is a real limitation worth stating: upstream has NO per-tenant
// Twilio credential table — `linkedin_accounts` is the only per-tenant sender
// store that exists anywhere. So these are process-global today. A multi-tenant
// deployment sending as one number is a deliberate, recorded limitation, not an
// oversight (see DECISIONS_PENDING.md).
function senderFor(channel) {
  if (channel === 'sms') return process.env.TWILIO_PHONE || null;
  if (channel === 'whatsapp') {
    const wa = process.env.TWILIO_WHATSAPP;
    if (wa) return wa.startsWith('whatsapp:') ? wa : `whatsapp:${wa}`;
    const phone = process.env.TWILIO_PHONE;
    return phone ? `whatsapp:${phone}` : null;
  }
  return null;
}

const withPrefix = (channel, addr) =>
  channel === 'whatsapp' && !String(addr).startsWith('whatsapp:') ? `whatsapp:${addr}` : String(addr);

/**
 * Sends one message. Throws on failure, with the SAME classification contract
 * the email path established, because the executor branches on it:
 *   err.configError    — our misconfiguration. Must never consume a delivery
 *                        retry; three of those dead-letter the job and a
 *                        dead-letter exits the enrollment TERMINALLY.
 *   err.definitive     — Twilio positively rejected THIS message. Nothing was
 *                        sent, so a retry is safe and legitimate.
 *   err.transient      — rate limited. Nothing sent, will work later, must not
 *                        cost the message one of its three lives.
 *   err.outcomeUnknown — timeout / 5xx / network fault. It MAY already have been
 *                        delivered, so it is never retried; the caller
 *                        quarantines instead.
 */
async function sendMessage({ channel, from, to, body, contentSid = null, contentVariables = null }) {
  const preflight = (m) => { const e = new Error(m); e.definitive = true; e.configError = true; throw e; };
  const creds = credentials();
  if (!accountSid()) preflight('TWILIO_ACCOUNT_SID not configured');
  if (!creds) preflight('no Twilio credentials (TWILIO_API_KEY_SID/SECRET or TWILIO_ACCOUNT_SID/AUTH_TOKEN)');
  if (!from) preflight(`no connected sender for ${channel}`);
  if (!to) preflight('recipient (to) is required');
  // A body-less message is the blank-send hazard CP4a-0 exists to prevent, and
  // a template send substitutes its own copy — so exactly one must be present.
  if (!contentSid && (!body || !String(body).trim())) preflight('message body is empty');

  const form = new URLSearchParams();
  form.set('From', withPrefix(channel, from));
  form.set('To', withPrefix(channel, to));
  if (contentSid) {
    form.set('ContentSid', contentSid);
    if (contentVariables) form.set('ContentVariables', JSON.stringify(contentVariables));
  } else {
    form.set('Body', String(body));
  }

  const auth = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`${API_BASE()}/2010-04-01/Accounts/${accountSid()}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(
      err.name === 'AbortError'
        ? `Twilio: no response within ${TIMEOUT_MS}ms — the message may or may not have been sent`
        : `Twilio: network fault (${err.message}) — the message may or may not have been sent`
    );
    e.outcomeUnknown = true;
    clearTimeout(timer);
    throw e;
  }

  let j = {};
  try { j = await r.json(); } catch (_e) { /* non-json body */ }
  finally { clearTimeout(timer); }

  if (!r.ok) {
    const msg = j.message || j.error_message || `HTTP ${r.status}`;
    const e = new Error(`Twilio: ${msg}${j.code ? ` (code ${j.code})` : ''}`);
    // Twilio DOES return a machine-readable `code` on 4xx — upstream captures it
    // and never reads it. Reading it is the difference between "this number is
    // unreachable, stop trying" and "we are misconfigured, do not burn retries".
    if (r.status === 401 || r.status === 403) { e.configError = true; e.definitive = true; }
    else if (r.status === 429 || j.code === 20429) { e.transient = true; }
    else if (r.status >= 400 && r.status < 500) e.definitive = true;
    else e.outcomeUnknown = true;
    e.status = r.status; e.providerCode = j.code || null;
    throw e;
  }
  // `sid` is Twilio's message id; `status` is queued/sending/sent/failed.
  return { id: j.sid || null, providerStatus: j.status || null };
}

module.exports = { isConfigured, senderFor, sendMessage, TIMEOUT_MS, API_BASE };
