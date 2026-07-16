'use strict';
// ─── Inbound webhooks (provider → CRM) ────────────────────────────────────────
// A provider (Resend inbound / Cloudflare Email Routing / etc.) POSTs a received
// email here. We resolve the contact and record it as an inbound message by
// calling the CRM's OWN API over loopback — reusing find-or-create, webhook
// dedupe, the engaged→responded stage advance and lead-scoring with zero
// duplicated logic. Mounted OUTSIDE requireAuth (the provider has no internal
// key); protected instead by a shared secret.
const express = require('express');
const router = express.Router();
const contactDb = require('../db/models/contacts');

const PORT = process.env.PORT || 3100;
const SELF = `http://127.0.0.1:${PORT}`;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const COMPANY = process.env.DEFAULT_COMPANY_ID || 'tantra';
const SECRET = process.env.INBOUND_WEBHOOK_SECRET || '';

function extractEmail(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

// Normalize the provider payload → { from, to, subject, text, messageId }.
function normalize(body) {
  if (body && body.type === 'email.received' && body.data) {
    // Resend inbound event (metadata-only: body may be absent — see note in route).
    const d = body.data;
    const from = typeof d.from === 'string' ? d.from : (d.from && d.from.address) || '';
    const to = Array.isArray(d.to) ? d.to[0] : (d.to || d.received_for || '');
    return { from: extractEmail(from), to: extractEmail(to), subject: d.subject || '',
      text: d.text || d.html || '', messageId: d.message_id || d.email_id || null };
  }
  // Generic full-payload shape (Cloudflare Email Routing worker, SendGrid, tests).
  const from = extractEmail(body.from || '');
  const to = extractEmail(Array.isArray(body.to) ? body.to[0] : (body.to || ''));
  return { from, to, subject: body.subject || '', text: body.text || body.html || '',
    messageId: body.message_id || body.messageId || null };
}

async function api(method, path, payload) {
  const r = await fetch(SELF + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'x-company-id': COMPANY },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let json = null; try { json = await r.json(); } catch (_e) {}
  return { status: r.status, json };
}

// POST /webhooks/email/inbound
router.post('/email/inbound', async (req, res) => {
  try {
    if (SECRET && req.get('x-webhook-secret') !== SECRET) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
    const { from, subject, text, messageId } = normalize(req.body || {});
    if (!from) return res.status(400).json({ error: 'no sender address' });

    // Resolve the contact by sender email; create one if this is a new person.
    let contact = await contactDb.getByEmail(from, COMPANY);
    if (!contact) {
      const created = await api('POST', '/api/crm/contacts',
        { email: from, name: from.split('@')[0], source: 'inbound_email' });
      contact = created.json;
    }
    if (!contact || !contact.id) return res.status(502).json({ error: 'could not resolve contact' });

    // Find-or-create the email conversation, then record the inbound message.
    // The messages endpoint dedupes on provider_message_id, advances the marketing
    // stage (engaged→responded) and scores the reply — all reused here.
    const conv = await api('POST', '/api/crm/conversations', { contact_id: contact.id, channel: 'email' });
    if (!conv.json || !conv.json.id) return res.status(502).json({ error: 'could not open conversation' });

    const msg = await api('POST', `/api/crm/conversations/${conv.json.id}/messages`, {
      direction: 'inbound', channel: 'email',
      body: text || subject || '(no content)',
      provider_message_id: messageId || undefined,
      metadata: { subject, from },
    });

    return res.status(msg.status === 201 ? 200 : 502).json({
      ok: msg.status === 201, contact_id: contact.id, conversation_id: conv.json.id,
    });
  } catch (err) {
    console.error('[Webhooks] inbound email error:', err.message);
    return res.status(500).json({ error: 'inbound processing failed' });
  }
});

module.exports = router;
