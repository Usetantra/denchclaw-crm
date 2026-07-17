'use strict';
// ─── Inbound webhooks (provider → CRM) ────────────────────────────────────────
// A provider (Resend inbound / Cloudflare Email Routing / etc.) POSTs a received
// email here. We resolve the contact and record it as an inbound message by
// calling the CRM's OWN API over loopback — reusing find-or-create, webhook
// dedupe, the engaged→responded stage advance and lead-scoring with zero
// duplicated logic. Mounted OUTSIDE requireAuth (the provider has no internal
// key); protected instead by a shared secret.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const contactDb = require('../db/models/contacts');

const PORT = process.env.PORT || 3100;
const SELF = `http://127.0.0.1:${PORT}`;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const DEFAULT_COMPANY = process.env.DEFAULT_COMPANY_ID || 'tantra';
// ─── Webhook auth (the ONLY guard on this route) ──────────────────────────────
// This endpoint is mounted outside requireAuth (providers have no internal key)
// and it WRITES: it creates contacts, advances marketing stages and scores leads.
// So it fails CLOSED — with no secret configured the route is disabled (503)
// rather than silently accepting anonymous writes from the internet.
const SECRET = process.env.INBOUND_WEBHOOK_SECRET || '';
if (!SECRET) {
  console.warn('[Webhooks] INBOUND_WEBHOOK_SECRET is not set — the inbound email webhook is DISABLED (503). Set it to enable inbound email.');
}

// Constant-time compare so the secret can't be recovered by response timing.
function secretOk(provided) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Tenant routing (gate 4 for inbound) ──────────────────────────────────────
// The RECEIVING address is the tenant key: mail to crm@acme.com belongs to acme.
// INBOUND_ROUTING (JSON) maps a receiving address — or a bare domain — to a
// company id, e.g. {"crm@growthclub.org":"tantra","@acme.com":"acme"}.
//
//   unset ⇒ single-tenant (today's model: migration 011 folds everything to the
//           canonical tenant) ⇒ everything resolves to DEFAULT_COMPANY_ID.
//   set   ⇒ multi-tenant: an unmapped recipient is REJECTED, never silently
//           dumped into the default tenant (fail closed, like the key→company gate).
const INBOUND_ROUTING = (() => {
  const raw = process.env.INBOUND_ROUTING;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [String(k).toLowerCase(), v]));
  } catch (e) {
    console.error('[Webhooks] INBOUND_ROUTING is not valid JSON — refusing to start:', e.message);
    throw new Error('INBOUND_ROUTING must be valid JSON');
  }
})();

// Resolve the tenant from the recipient address. Returns null when routing is
// configured and the recipient maps to nothing (caller rejects the delivery).
function resolveCompany(to) {
  if (!INBOUND_ROUTING) return DEFAULT_COMPANY; // single-tenant
  const addr = String(to || '').toLowerCase().trim();
  if (!addr) return null;
  if (INBOUND_ROUTING[addr]) return INBOUND_ROUTING[addr];        // exact: crm@acme.com
  const at = addr.lastIndexOf('@');
  if (at >= 0) {
    const domain = addr.slice(at);                                // "@acme.com"
    if (INBOUND_ROUTING[domain]) return INBOUND_ROUTING[domain];
    if (INBOUND_ROUTING[domain.slice(1)]) return INBOUND_ROUTING[domain.slice(1)]; // "acme.com"
  }
  return null;
}

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
      text: d.text || d.html || '', messageId: d.message_id || d.email_id || null,
      inReplyTo: d.in_reply_to || null, references: d.references || null };
  }
  // Generic full-payload shape (Cloudflare Email Routing worker, SendGrid, tests).
  const from = extractEmail(body.from || '');
  const to = extractEmail(Array.isArray(body.to) ? body.to[0] : (body.to || ''));
  return { from, to, subject: body.subject || '', text: body.text || body.html || '',
    messageId: body.message_id || body.messageId || null,
    inReplyTo: body.in_reply_to || body.inReplyTo || null,
    references: body.references || null };
}

async function api(method, path, payload, company) {
  const r = await fetch(SELF + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'x-company-id': company },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let json = null; try { json = await r.json(); } catch (_e) {}
  return { status: r.status, json };
}

// POST /webhooks/email/inbound
router.post('/email/inbound', async (req, res) => {
  try {
    // Fail closed: unconfigured ⇒ disabled, never open.
    if (!SECRET) {
      console.error('[Webhooks] inbound rejected — INBOUND_WEBHOOK_SECRET is not configured');
      return res.status(503).json({ error: 'inbound webhook not configured' });
    }
    if (!secretOk(req.get('x-webhook-secret'))) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
    const { from, to, subject, text, messageId, inReplyTo, references } = normalize(req.body || {});
    if (!from) return res.status(400).json({ error: 'no sender address' });

    // Which tenant owns this delivery? Derived from the recipient address, not a
    // hardcoded default — so multi-tenant routing can never cross-file a contact.
    const company = resolveCompany(to);
    if (!company) {
      console.warn('[Webhooks] no tenant mapped for recipient:', to || '(none)');
      return res.status(422).json({ error: `no tenant mapped for recipient ${to || '(none)'}` });
    }

    // Resolve the contact by sender email; create one if this is a new person.
    let contact = await contactDb.getByEmail(from, company);
    if (!contact) {
      const created = await api('POST', '/api/crm/contacts',
        { email: from, name: from.split('@')[0], source: 'inbound_email' }, company);
      contact = created.json;
    }
    if (!contact || !contact.id) return res.status(502).json({ error: 'could not resolve contact' });

    // Find-or-create the email conversation, then record the inbound message.
    // The messages endpoint dedupes on provider_message_id, advances the marketing
    // stage (engaged→responded) and scores the reply — all reused here.
    const conv = await api('POST', '/api/crm/conversations', { contact_id: contact.id, channel: 'email' }, company);
    if (!conv.json || !conv.json.id) return res.status(502).json({ error: 'could not open conversation' });

    const msg = await api('POST', `/api/crm/conversations/${conv.json.id}/messages`, {
      direction: 'inbound', channel: 'email',
      body: text || subject || '(no content)',
      provider_message_id: messageId || undefined,
      metadata: { subject, from, to, in_reply_to: inReplyTo || null, references: references || null },
    }, company);

    return res.status(msg.status === 201 ? 200 : 502).json({
      ok: msg.status === 201, company_id: company, contact_id: contact.id, conversation_id: conv.json.id,
    });
  } catch (err) {
    console.error('[Webhooks] inbound email error:', err.message);
    return res.status(500).json({ error: 'inbound processing failed' });
  }
});

module.exports = router;
