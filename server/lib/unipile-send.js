'use strict';
// ─── CP-C2: Unipile provider (LinkedIn) ──────────────────────────────────────
//
// Unlike Twilio, this one really is a WRAP. `automation_core/integrations/
// unipile.py` builds its base URL from `UNIPILE_DSN`:
//     f"https://{settings.unipile_dsn}/api/v1"
// which means the host is already configurable — the seam CP-C had to invent for
// Twilio exists here by construction. `UNIPILE_API_BASE` is added on top so a
// test can point at a plain http stub (the DSN form forces https), and it is the
// ONLY thing this file adds to upstream's transport.
//
// BORROWED VERBATIM from channels/linkedin.py + integrations/unipile.py:
//   * the three endpoints and their exact bodies —
//       invite : POST /users/invite  { account_id, provider_id|public_identifier, message }
//       message: POST /chats         { account_id, attendees_ids, text, api:'classic' }
//       inmail : POST /chats         { …, subject, inmail:true }
//   * `X-API-KEY` auth (not Bearer — Unipile is unusual here),
//   * the 300-character cap on an invite note, which is LinkedIn's own limit and
//     silently truncates server-side if you exceed it,
//   * provider-id extraction order: invitation_id → chat_id → id,
//   * the `linkedin.com/in/<slug>` public-identifier parse.
//
// NOT BORROWED — the same call as CP-C, for the same reason. Upstream returns
// `{ok:false}` for a 400, a 429 and a timeout alike (unipile.py:52-54) and its
// adapter then records event_type="error" for all three. On LinkedIn that is
// worse than on SMS: a timed-out invite that actually landed, retried, is a
// second connection request to the same person — visible to them, and exactly
// the behaviour that gets an account flagged. So failures are classified, and an
// unknown outcome is never retried.
const TIMEOUT_MS = parseInt(process.env.UNIPILE_TIMEOUT_MS, 10) || 30000;

// Explicit base wins; otherwise upstream's DSN form, unchanged.
const API_BASE = () => {
  if (process.env.UNIPILE_API_BASE) return String(process.env.UNIPILE_API_BASE).replace(/\/+$/, '');
  return process.env.UNIPILE_DSN ? `https://${process.env.UNIPILE_DSN}/api/v1` : '';
};

function isConfigured() {
  return !!(process.env.UNIPILE_API_KEY && (process.env.UNIPILE_DSN || process.env.UNIPILE_API_BASE));
}

// The connected identity is a DB fact (linkedin_accounts), not an env var — the
// account's caps, window and timezone all hang off that row, so an env-var
// account id would be an identity with no limits attached. The executor resolves
// it and passes it down; `UNIPILE_ACCOUNT_ID` is honoured only as upstream's
// single-account fallback.
function senderFor() {
  return process.env.UNIPILE_ACCOUNT_ID || null;
}

function publicIdentifier(contact) {
  const md = (contact && contact.metadata) || {};
  if (md.linkedin_provider_id) return { provider_id: md.linkedin_provider_id };
  const url = (contact && contact.linkedin_url) || md.linkedin_url || '';
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(String(url));
  return m ? { public_identifier: m[1] } : null;
}

/**
 * Sends one LinkedIn action. Throws with the SAME classification contract every
 * other provider in this codebase uses, because the shared executor branches on
 * it and nothing else:
 *   err.configError    — ours. Aborts the tick without consuming a retry.
 *   err.definitive     — Unipile positively rejected THIS action; nothing was
 *                        sent, so a retry is legitimate.
 *   err.transient      — rate limited; will work later, must not cost a life.
 *   err.outcomeUnknown — timeout / 5xx. It MAY have landed, so it is never
 *                        retried; the caller quarantines instead.
 *   err.ineligible     — LinkedIn says this action is ILLEGAL for this person
 *                        (inviting an existing connection, messaging a stranger).
 *                        Terminal: retrying a doomed illegal action is the
 *                        account-restriction path.
 */
async function sendAction({ accountId, action = 'message', target, body, subject = null }) {
  const preflight = (m) => { const e = new Error(m); e.definitive = true; e.configError = true; throw e; };
  if (!isConfigured()) preflight('Unipile is not configured (UNIPILE_API_KEY + UNIPILE_DSN)');
  if (!accountId) preflight('no connected LinkedIn account for this tenant');
  if (!target) preflight('contact has no resolvable LinkedIn identifier');
  if (!body || !String(body).trim()) preflight('message body is empty');

  let path, payload;
  const attendee = target.provider_id || target.public_identifier;
  if (action === 'invite') {
    path = '/users/invite';
    // 300 chars is LinkedIn's invite-note limit, borrowed from upstream.
    payload = { account_id: accountId, ...target, message: String(body).slice(0, 300) };
  } else if (action === 'inmail') {
    path = '/chats';
    payload = { account_id: accountId, attendees_ids: [attendee], text: String(body),
      subject: subject || '', inmail: true, api: 'classic' };
  } else {
    path = '/chats';
    payload = { account_id: accountId, attendees_ids: [attendee], text: String(body), api: 'classic' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`${API_BASE()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json',
        'X-API-KEY': process.env.UNIPILE_API_KEY },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(err.name === 'AbortError'
      ? `Unipile: no response within ${TIMEOUT_MS}ms — the action may or may not have been performed`
      : `Unipile: network fault (${err.message}) — the action may or may not have been performed`);
    e.outcomeUnknown = true;
    clearTimeout(timer);
    throw e;
  }

  let j = {};
  try { j = await r.json(); } catch { /* non-json body */ }
  finally { clearTimeout(timer); }

  if (!r.ok) {
    const detail = j.message || j.detail || j.title || j.type || `HTTP ${r.status}`;
    const e = new Error(`Unipile: ${detail}`);
    e.status = r.status;
    e.providerCode = j.type || j.code || null;
    const t = String(j.type || j.title || detail).toLowerCase();
    if (r.status === 401 || r.status === 403) { e.configError = true; e.definitive = true; }
    else if (r.status === 429) { e.transient = true; }
    else if (r.status === 422 || /already.*(connect|invit)|cannot_resend|not.*allowed|invalid_recipient|no.*inmail/.test(t)) {
      // A 422 from Unipile is "this action is not permitted for this
      // relationship" — already connected, invite already pending, InMail not
      // available. Nothing is wrong with our config and nothing will change by
      // trying again; only the relationship changing would, and that is a
      // webhook's job to notice. Terminal.
      e.ineligible = true; e.definitive = true;
    } else if (r.status >= 400 && r.status < 500) e.definitive = true;
    else e.outcomeUnknown = true;
    throw e;
  }

  const d = j.data || j || {};
  return { id: d.invitation_id || d.chat_id || d.id || null, providerStatus: d.status || null };
}

module.exports = { isConfigured, senderFor, sendAction, publicIdentifier, API_BASE, TIMEOUT_MS };
