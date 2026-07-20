'use strict';
// ─── Resend email send adapter ────────────────────────────────────────────────
// Delivers outbound email from the CRM inbox via Resend. Configured with
// RESEND_API_KEY (secret — set in .env, never committed). If the key is unset the
// CRM records the message but does not deliver it (isConfigured() === false), so
// local/demo use is unaffected until a real account is connected.

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Sends one email. Throws on any failure (caller maps to a 502). Returns { id }
// where id is Resend's provider message id (stored as provider_message_id).
async function sendEmail({ from, to, cc, bcc, subject, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not configured');
  if (!from) throw new Error('no connected sender (from) for this channel');
  if (!to) throw new Error('recipient (to) is required');

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

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let j = {};
  try { j = await r.json(); } catch (_e) { /* non-json error body */ }
  if (!r.ok) {
    const msg = j.message || j.error || `HTTP ${r.status}`;
    throw new Error(`Resend: ${msg}`);
  }
  return { id: j.id || null, messageId };
}

module.exports = { isConfigured, sendEmail };
