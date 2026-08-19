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
const tenantDb = require('../db/models/tenants');
const suppression = require('../db/models/suppression');
const channelsModel = require('../db/models/channels');
const { query } = require('../db/index');
// CP-B: an interested reply to a cold email invite is auto-registrant path 2.
const { ingestMarketingEvent } = require('../lib/marketing-events');
const { createLimiter } = require('../lib/rate-limit');
const crmRouter = require('./crm');
const marketingDeps = {
  recordActivity: crmRouter.addContactActivity,
  findOrCreateContact: crmRouter.findOrCreateContact,
};

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

// ─── Rate limits ─────────────────────────────────────────────────────────────
// These endpoints are mounted OUTSIDE requireAuth because a provider has no
// internal key, so the only thing standing between the internet and them is a
// shared secret, a URL token, or — for /capture/:tool — nothing at all by
// design. Each of those fails closed, but failing closed at speed is still a
// free way to burn database connections from a box with a 200-connection budget.
//
// Limits are per-IP-per-minute and generous enough that no real provider will
// notice: Twilio and Resend fan out from a handful of addresses but nowhere
// near these rates for one tenant.
const providerLimiter = createLimiter({
  name: 'provider-webhook',
  max: () => process.env.WEBHOOK_RATE_LIMIT || 300,
});
// Tighter, because these two are the guessable ones: a lead token is the entire
// credential, and /capture/:tool has no credential at all.
const tokenLimiter = createLimiter({
  name: 'token-webhook',
  max: () => process.env.WEBHOOK_TOKEN_RATE_LIMIT || 60,
});
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

// ─── CP-M / D7 (GT-2): prove the API honoured the RECIPIENT-DERIVED tenant ────
// This file self-calls the CRM with `x-internal-key: INTERNAL_API_KEY` and an
// `x-company-id` derived from the receiving address. The merge put that call
// behind the consolidation branch's A3 auth, which resolves a DB-backed
// `tenant_api_keys` key FIRST and — deliberately, and asserted by
// `test/unit-a3-api-key-auth.mjs:74` — IGNORES `X-Company-Id` when it hits,
// because a DB-issued key belongs to exactly one tenant. That is the right rule
// for A3 and must not be weakened here.
//
// The consequence for THIS caller is what mattered: if `INTERNAL_API_KEY` were
// ever also issued as a DB key, every inbound email would be filed under that
// key's tenant and main's recipient→tenant property (commit b8488d7) would die
// with NO error at all. So the webhook now VERIFIES rather than assumes: every
// self-call's response carries the `company_id` the auth layer actually assigned,
// and a disagreement is a loud, specific refusal instead of a silent cross-file.
//
// OPERATIONAL RULE (also recorded in the CP-M receipt): `INTERNAL_API_KEY` must
// be an ENV-configured key (`INTERNAL_API_KEYS`) bound to `*` or to every tenant
// named in `INBOUND_ROUTING`. It must NOT be a DB-issued tenant_api_keys value.
function tenantMismatch(res, wanted, what) {
  const got = res?.json?.company_id;
  if (!got || got === wanted) return null;
  console.error(
    `[Webhooks] SECURITY: inbound delivery resolved to tenant '${wanted}' from the recipient address, ` +
    `but the CRM filed the ${what} under '${got}'. INTERNAL_API_KEY is almost certainly a DB-issued ` +
    `tenant_api_keys key, which binds to its own tenant and ignores X-Company-Id. ` +
    `Rotate it to an env-bound key (INTERNAL_API_KEYS) covering every INBOUND_ROUTING tenant.`
  );
  return { error: 'inbound tenant mismatch — refusing to file this delivery under the wrong tenant', expected: wanted, actual: got };
}

// POST /webhooks/email/inbound
router.post('/email/inbound', providerLimiter.middleware, async (req, res) => {
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
    let company = resolveCompany(to);
    if (!company) {
      console.warn('[Webhooks] no tenant mapped for recipient:', to || '(none)');
      return res.status(422).json({ error: `no tenant mapped for recipient ${to || '(none)'}` });
    }
    // Fold the routing value to its CANONICAL tenant id before using it.
    // INBOUND_ROUTING may legitimately name an alias (migration 012 seeds
    // `tantra` with aliases ['growthclub','dev_company']), and the auth layer
    // canonicalizes X-Company-Id on the way in — so the raw value and the id the
    // API actually files under can differ by design. Without this fold, the
    // tenantMismatch guard below would 502 a configuration that worked fine on
    // main, and the direct `contactDb.getByEmail(from, company)` call just below
    // would query an alias id that owns no rows. An unresolvable value is left
    // as-is on purpose, so an unprovisioned tenant still fails loudly (M16)
    // instead of being silently rewritten.
    try {
      const canonical = await tenantDb.resolve(company);
      if (canonical && canonical.id) company = canonical.id;
    } catch (err) {
      console.error('[Webhooks] tenant canonicalization failed, using the routing value as-is:', err.message);
    }

    // Resolve the contact by sender email; create one if this is a new person.
    let contact = await contactDb.getByEmail(from, company);
    if (!contact) {
      const created = await api('POST', '/api/crm/contacts',
        { email: from, name: from.split('@')[0], source: 'inbound_email' }, company);
      const mism = tenantMismatch(created, company, 'contact');
      if (mism) return res.status(502).json(mism);
      contact = created.json;
      if (!contact || !contact.id) {
        // M16: a recipient mapped by INBOUND_ROUTING to a tenant that is not
        // provisioned in `tenants` trips migration 013's FK, which surfaces here.
        // Report it loudly WITH the upstream status/error — never fall through to
        // the default tenant, and never leave the operator guessing.
        console.error(
          `[Webhooks] could not create contact for tenant '${company}' (upstream ${created.status}):`,
          JSON.stringify(created.json)
        );
        return res.status(502).json({
          error: 'could not resolve contact',
          company_id: company,
          upstream_status: created.status,
          upstream_error: created.json?.error || null,
          hint: 'every INBOUND_ROUTING value must be a provisioned tenant (see migrations/013_tenant_fk.sql)',
        });
      }
    }
    if (!contact || !contact.id) return res.status(502).json({ error: 'could not resolve contact' });

    // Find-or-create the email conversation, then record the inbound message.
    // The messages endpoint dedupes on provider_message_id, advances the marketing
    // stage (engaged→responded) and scores the reply — all reused here.
    const conv = await api('POST', '/api/crm/conversations', { contact_id: contact.id, channel: 'email' }, company);
    // The choke point for D7: this response's company_id IS whatever the auth
    // layer assigned to the self-call, so agreeing with `company` proves the
    // recipient-derived tenant survived end to end.
    const convMism = tenantMismatch(conv, company, 'conversation');
    if (convMism) return res.status(502).json(convMism);
    if (!conv.json || !conv.json.id) return res.status(502).json({ error: 'could not open conversation' });

    const msg = await api('POST', `/api/crm/conversations/${conv.json.id}/messages`, {
      direction: 'inbound', channel: 'email',
      body: text || subject || '(no content)',
      provider_message_id: messageId || undefined,
      metadata: { subject, from, to, in_reply_to: inReplyTo || null, references: references || null },
    }, company);

    // ─── CP-B, auto-registrant path 2 ────────────────────────────────────────
    // "Invitees that REPLY AND EXPRESS INTEREST in joining the webinar for cold
    // EMAIL outreach." This is the natural home for it: the inbound reply
    // already lands here, already resolves the contact, and already dedupes.
    //
    // Attribution comes from the invite the reply is answering — the contact's
    // most recent EMAIL invite link names the webinar. No invite link means
    // this person was never emailed an invite, so their reply is not an
    // auto-registration signal for any webinar and we do not guess one.
    //
    // Wrapped so it can NEVER fail the inbound delivery. Recording the customer's
    // email is the contract of this endpoint; the funnel move is a consequence.
    let marketing = null;
    try {
      const linkRes = await query(
        `SELECT webinar_id FROM crm_invite_links
          WHERE company_id=$1 AND contact_id=$2 AND channel='email'
          ORDER BY created_at DESC LIMIT 1`,
        [company, contact.id]
      );
      if (linkRes.rows[0]) {
        marketing = await ingestMarketingEvent(company, {
          event_type: 'email_reply', channel: 'email',
          contact_id: contact.id, webinar_id: linkRes.rows[0].webinar_id,
          body: text || subject || '',
          provider: 'inbound_email',
          provider_event_id: messageId || undefined,
          source: 'inbound_email',
        }, marketingDeps);
      }
    } catch (e) {
      console.error('[Webhooks] marketing email_reply ingest failed (inbound still recorded):', e.message);
    }

    return res.status(msg.status === 201 ? 200 : 502).json({
      ok: msg.status === 201, company_id: company, contact_id: contact.id, conversation_id: conv.json.id,
      ...(marketing ? { marketing: {
        event_type: marketing.event_type, outcome: marketing.outcome,
        from_stage: marketing.from_stage, to_stage: marketing.to_stage, detail: marketing.detail,
      } } : {}),
    });
  } catch (err) {
    console.error('[Webhooks] inbound email error:', err.message);
    return res.status(500).json({ error: 'inbound processing failed' });
  }
});

// ── Twilio (WhatsApp + SMS) — CP-M2, ported from origin/aquila-working-branch ──
// Twilio POSTs form-encoded events. Real Twilio traffic is authenticated by the
// X-Twilio-Signature (validated against the tenant's auth token + the public URL
// set in TWILIO_WEBHOOK_BASE_URL). Local simulation is authenticated by our shared
// INBOUND_WEBHOOK_SECRET header instead. One of the two must pass — fail closed.
const STOP_RE = /^(STOP|UNSUBSCRIBE|END|QUIT|CANCEL|STOPALL|REVOKE|OPTOUT)$/i;
const START_RE = /^(START|UNSTOP|YES)$/i;

function twilioSignatureValid(req, authToken) {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!baseUrl || !authToken) return false;
  const url = baseUrl.replace(/\/$/, '') + req.originalUrl;
  const params = req.body || {};
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  const got = req.get('X-Twilio-Signature') || '';
  try { return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); }
  catch (_e) { return false; }
}

// Resolve the owning company from the business number (the Twilio To).
async function companyForBusinessNumber(channel, to) {
  const bare = String(to || '').replace(/^whatsapp:/i, '');
  const r = await query(
    `SELECT company_id FROM channel_senders WHERE channel=$1 AND (identifier=$2 OR identifier=$3) LIMIT 1`,
    [channel, to, bare]
  );
  return r.rows[0] ? r.rows[0].company_id : DEFAULT_COMPANY;
}

// POST /webhooks/twilio/inbound — inbound WhatsApp/SMS + STOP/START/HELP.
router.post('/twilio/inbound', providerLimiter.middleware, async (req, res) => {
  const twiml = (x) => res.type('text/xml').send(x || '<Response></Response>');
  try {
    const b = req.body || {};
    const to = b.To || '';
    const from = b.From || '';
    const channel = /^whatsapp:/i.test(to) ? 'whatsapp' : 'sms';
    const fromNum = String(from).replace(/^whatsapp:/i, '');
    const company = await companyForBusinessNumber(channel, to);

    // Auth: our sim secret OR a valid Twilio signature. Fail closed otherwise.
    const simOk = SECRET && req.get('x-webhook-secret') === SECRET;
    if (!simOk) {
      const conn = await channelsModel.getConnection(company, 'twilio');
      const token = conn && conn.credentials && conn.credentials.auth_token;
      if (!twilioSignatureValid(req, token)) {
        console.warn('[Webhooks] twilio inbound rejected — bad signature / no secret');
        return res.status(403).type('text/xml').send('<Response></Response>');
      }
    }

    // Opt-out / opt-in keywords (Twilio Advanced Opt-Out sets OptOutType).
    const kw = String(b.Body || '').trim();
    if (b.OptOutType === 'STOP' || STOP_RE.test(kw)) { await suppression.add(company, channel, fromNum, { reason: 'opt_out' }); return twiml(); }
    if (b.OptOutType === 'START' || START_RE.test(kw)) { await suppression.resubscribe(company, channel, fromNum); return twiml(); }
    if (b.OptOutType === 'HELP') return twiml(); // Twilio auto-replies HELP when configured

    // Resolve/create the contact by phone, then record the inbound message.
    let contact = null;
    const found = await query(
      `SELECT * FROM contacts WHERE company_id=$1 AND regexp_replace(coalesce(phone,''),'[^0-9]','','g') = regexp_replace($2,'[^0-9]','','g') AND deleted_at IS NULL LIMIT 1`,
      [company, fromNum]
    );
    contact = found.rows[0] || null;
    if (!contact) {
      const created = await api('POST', '/api/crm/contacts', { name: b.ProfileName || fromNum, phone: fromNum, source: channel }, company);
      contact = created.json;
    }
    if (!contact || !contact.id) return twiml();

    // Inbound opens/refreshes the WhatsApp 24h customer-service window.
    if (channel === 'whatsapp') {
      await query(`UPDATE contacts SET cs_window_expires_at = now() + interval '24 hours', updated_at=now() WHERE id=$1 AND company_id=$2`,
        [contact.id, company]);
    }
    // An inbound reply clears any prior suppression only via explicit START — not here.

    const conv = await api('POST', '/api/crm/conversations', { contact_id: contact.id, channel }, company);
    if (conv.json && conv.json.id) {
      await api('POST', `/api/crm/conversations/${conv.json.id}/messages`, {
        direction: 'inbound', channel, body: b.Body || '(no content)',
        provider_message_id: b.MessageSid || undefined, metadata: { from: fromNum, to },
      }, company);
    }
    return twiml();
  } catch (err) {
    console.error('[Webhooks] twilio inbound error:', err.message);
    return res.status(500).type('text/xml').send('<Response></Response>');
  }
});

// POST /webhooks/twilio/status — delivery status callbacks.
router.post('/twilio/status', providerLimiter.middleware, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.MessageSid) {
      const cls = b.ErrorCode ? 'error' : (b.MessageStatus === 'delivered' || b.MessageStatus === 'read' ? 'ok' : null);
      await query(
        `UPDATE messages SET provider_status=$1, error_code=$2, error_class=COALESCE($3, error_class) WHERE provider_message_id=$4`,
        [b.MessageStatus || null, b.ErrorCode || null, cls, b.MessageSid]
      );
    }
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    console.error('[Webhooks] twilio status error:', err.message);
    res.status(200).type('text/xml').send('<Response></Response>');
  }
});

// ── Inbound lead webhooks ("add prospects from other tools") ─────────────────
// POST /webhooks/leads/:token — no INTERNAL_API_KEY needed; the per-webhook
// token in the URL IS the auth (server/db/models/lead-webhooks.js), so a
// no-code tool that can only fire a plain POST (Zapier, Make, a website form)
// can still integrate. Accepts common field-name variants so the caller
// doesn't need to match our exact schema.
const leadWebhooksDb = require('../db/models/lead-webhooks');

function pick(body, ...names) {
  for (const n of names) {
    if (body[n] !== undefined && body[n] !== null && String(body[n]).trim() !== '') return String(body[n]).trim();
  }
  return undefined;
}

router.post('/leads/:token', tokenLimiter.middleware, async (req, res) => {
  try {
    const hook = await leadWebhooksDb.getByToken(req.params.token);
    // Same shape whether the token is unknown or disabled — a prober learns
    // nothing about which is true, and a disabled webhook still tells its
    // owner "your token is fine, you turned it off" via a distinct message.
    if (!hook) return res.status(404).json({ error: 'unknown webhook' });
    if (!hook.enabled) return res.status(403).json({ error: 'this webhook is disabled' });

    const b = req.body || {};
    const name = pick(b, 'name', 'full_name', 'fullName') ||
      [pick(b, 'first_name', 'firstName'), pick(b, 'last_name', 'lastName')].filter(Boolean).join(' ') || undefined;
    const email = pick(b, 'email', 'email_address', 'emailAddress');
    const phone = pick(b, 'phone', 'phone_number', 'phoneNumber', 'mobile');
    if (!name && !email && !phone) {
      return res.status(400).json({ error: 'at least one of name, email, or phone is required' });
    }
    const company_name = pick(b, 'company', 'company_name', 'companyName', 'organization');
    const title = pick(b, 'title', 'job_title', 'jobTitle', 'position');
    const rawTags = b.tags;
    const tags = [...new Set([
      ...(hook.default_tags || []),
      ...(Array.isArray(rawTags) ? rawTags : typeof rawTags === 'string' ? rawTags.split(',').map(s => s.trim()).filter(Boolean) : []),
    ])];

    const created = await api('POST', '/api/crm/contacts', {
      name, email, phone, company: company_name, title,
      source: pick(b, 'source') || hook.default_source,
      tags: tags.length ? tags : undefined,
      metadata: { lead_webhook_id: hook.id, lead_webhook_label: hook.label || undefined },
    }, hook.company_id);

    if (created.status !== 200 && created.status !== 201) {
      console.error('[Webhooks] lead webhook contact creation failed:', hook.id, created.status, JSON.stringify(created.json));
      return res.status(502).json({ error: 'failed to create contact', upstream_status: created.status });
    }
    await leadWebhooksDb.touch(hook.id);
    res.status(201).json({ ok: true, contact_id: created.json.id });
  } catch (err) {
    console.error('[Webhooks] leads/:token error:', err.message);
    res.status(500).json({ error: 'failed to process lead' });
  }
});

// ─── Capture (POST /webhooks/capture/:tool) — building a real connector ───────
// Point WebinarGeek / Zoom / Instantly / anything else at this to see EXACTLY
// what it sends, instead of a dedicated parser guessed from documentation
// that may be stale or wrong. Public (no internal key — the whole point is a
// third party can reach it) and NOT company-scoped (we don't know the
// payload shape well enough yet to extract a tenant from it). Every capture
// is a debugging aid pruned to the last 20 per tool (webhook-captures.js),
// readable via GET /api/crm/settings/webhook-captures (authenticated).
const webhookCaptures = require('../db/models/webhook-captures');
const zoomCrypto = require('crypto');

router.post('/capture/:tool', tokenLimiter.middleware, async (req, res) => {
  const tool = String(req.params.tool || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  try {
    await webhookCaptures.record(tool, { method: req.method, headers: req.headers, body: req.body });
  } catch (err) {
    console.error('[Webhooks] capture record failed:', err.message);
    // Never let a logging failure be why a real provider sees an error —
    // still respond 200 below.
  }

  // Zoom will not activate a webhook subscription until it gets the correct
  // encrypted response to this ONE-TIME challenge — a plain 200 is not
  // enough, and there is no error visible anywhere if this is wrong, it just
  // silently never turns on. https://developers.zoom.us/docs/api/webhooks/
  // ZOOM_WEBHOOK_SECRET_TOKEN is the app's "Secret Token" from the Zoom
  // Marketplace app's Event Subscriptions page — not set yet, so this
  // degrades to "captured, but cannot complete the handshake" rather than
  // guessing at a value that would fail signature verification anyway.
  if (tool === 'zoom' && req.body && req.body.event === 'endpoint.url_validation') {
    const plainToken = req.body.payload && req.body.payload.plainToken;
    const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    if (plainToken && secret) {
      const encryptedToken = zoomCrypto.createHmac('sha256', secret).update(plainToken).digest('hex');
      return res.status(200).json({ plainToken, encryptedToken });
    }
    return res.status(200).json({
      captured: true,
      note: 'ZOOM_WEBHOOK_SECRET_TOKEN is not set on the server — cannot complete Zoom\'s validation handshake yet, so this subscription will not activate. Set it (from the Marketplace app\'s Event Subscriptions page) and resend the validation.',
    });
  }

  res.status(200).json({ ok: true, captured: true });
});

// ─── Tantra outbound webhook receiver (POST /webhooks/tantra/:token) ─────────
// Per-company token in the URL is the whole auth story (migration 036's
// header explains why: Tantra's webhook carries no signature/API key of its
// own). Real, documented payload shape and event list — from
// usetantra.com/help/api-and-mcp/{outbound-webhooks,webhook-event-triggers} —
// NOT a guess. Every delivery is captured raw first (tool 'tantra', same
// table the other connectors use) regardless of what happens after, so a
// wrong field-name guess below is diagnosable from Settings → Integrations
// instead of silently mis-filing a lead.
const tantraWebhooksDb = require('../db/models/tantra-webhooks');
const tantraSyncDb = require('../db/models/tantra-sync');

// Tantra's envelope nests the recipient inside campaign.events[].attendees[]
// for webinar-style events; the docs separately say every event "includes
// the recipient email address... where applicable" without naming the field
// for the plain email.* events, so the top-level candidates below are a
// best-effort guess pending a real captured payload to confirm against.
function extractTantraEmails(body) {
  const out = new Set();
  const top = pick(body || {}, 'recipient_email', 'recipient', 'email', 'contact_email', 'to');
  if (top) out.add(top.toLowerCase());
  const events = body && body.campaign && body.campaign.events;
  if (Array.isArray(events)) {
    for (const ev of events) {
      const attendees = Array.isArray(ev && ev.attendees) ? ev.attendees : [];
      for (const a of attendees) {
        if (a && a.email) out.add(String(a.email).trim().toLowerCase());
      }
    }
  }
  return [...out];
}

router.post('/tantra/:token', tokenLimiter.middleware, async (req, res) => {
  try {
    const hook = await tantraWebhooksDb.getByToken(req.params.token);
    if (!hook) return res.status(404).json({ error: 'unknown webhook' });

    // Capture first, unconditionally — this is the "prove what actually
    // arrived" record, independent of whether enabled/parsing succeeds below.
    try {
      await webhookCaptures.record('tantra', { method: req.method, headers: req.headers, body: req.body });
    } catch (err) {
      console.error('[Webhooks] tantra capture record failed:', err.message);
    }

    if (!hook.enabled) return res.status(403).json({ error: 'this webhook is disabled' });
    await tantraWebhooksDb.touch(hook.id);

    const companyId = hook.company_id;
    const eventType = req.get('x-tantra-event') || (req.body && req.body.event) || null;

    // ── Mirror nudge + idempotency (migration 039) ──────────────────────────
    //
    // Tantra signs nothing (tantra.md §2.3: no HMAC header), so this body is
    // untrusted input — anyone who learns the URL can forge it. The nudge path
    // is therefore deliberately inert: we take at most a THREAD REFERENCE from
    // it and park that for the executor, which re-reads the thread over the
    // authenticated API. Every byte we persist comes from that response, never
    // from here, so a forged event costs one wasted API read and can inject
    // nothing.
    //
    // `X-Tantra-Event-Id` is Tantra's sha256(eventType + dedupeKey). It was
    // previously ignored entirely, which meant a redelivery wrote a duplicate
    // activity row — and Tantra retries with exponential backoff and runs a
    // recovery cron for orphans, so redelivery is expected traffic. The partial
    // unique index on (company_id, event_id) makes a repeat a no-op.
    //
    // ADDITIVE ON PURPOSE: the legacy handling below is untouched and still
    // runs. Until a tenant connects the Tantra API (Phase 1) there is nothing
    // to poll, so removing it would strand every tenant using the connector
    // today. Once connected, the mirror is authoritative and the legacy path
    // is a redundant-but-harmless second writer — every message it produces
    // carries no provider_message_id, so it cannot collide with mirrored rows.
    const eventId = req.get('x-tantra-event-id') || null;
    let nudgeCreated = false;
    try {
      const threadRef = pick(req.body || {}, 'threadId', 'thread_id', 'chatId', 'chat_id', 'conversationId');
      const { created } = await tantraSyncDb.enqueueNudge(companyId, {
        eventId, eventType, threadRef: threadRef || null,
      });
      nudgeCreated = created;
      if (eventId && !created) {
        // A recognised redelivery. Stop here: the first delivery already
        // enqueued the poll, and re-running the legacy handler below would
        // duplicate its activity/message rows.
        return res.status(200).json({ ok: true, event: eventType, duplicate: true, note: 'already seen this event id' });
      }
    } catch (err) {
      // A nudge is an optimisation, never a precondition — the sweep finds the
      // same thread on its next pass. Never fail the delivery over it.
      console.error('[Webhooks] tantra nudge enqueue failed:', err.message);
    }

    if (!eventType) return res.status(200).json({ ok: true, note: 'no X-Tantra-Event header — captured only', nudged: nudgeCreated });

    const body = req.body || {};
    const campaignName = body.campaign && body.campaign.name;
    const emails = extractTantraEmails(body);
    if (!emails.length) {
      return res.status(200).json({ ok: true, note: 'no recipient email found in payload — captured only, no contact matched' });
    }

    for (const email of emails) {
      let contact, created;
      try {
        const r = await crmRouter.findOrCreateContact(email, { company_id: companyId, source: 'tantra' });
        contact = r.contact; created = r.created;
      } catch (err) {
        console.error('[Webhooks] tantra findOrCreateContact failed:', email, err.message);
        continue;
      }
      if (!contact) continue;

      if (eventType === 'email.replied') {
        // Same self-call shape /email/inbound uses — reuses the conversations
        // route's own engaged→responded advance and trigger-stage enrollment
        // rather than duplicating that logic here.
        const conv = await api('POST', '/api/crm/conversations', { contact_id: contact.id, channel: 'email' }, companyId);
        if (conv.json && conv.json.id) {
          await api('POST', `/api/crm/conversations/${conv.json.id}/messages`, {
            direction: 'inbound', channel: 'email',
            body: body.text || body.body || `(Tantra reply${campaignName ? ' on "' + campaignName + '"' : ''} — no body in payload)`,
            metadata: { source: 'tantra', event: eventType, campaign: campaignName || null },
          }, companyId);
        }
        continue;
      }

      if (eventType === 'email.unsubscribed') {
        try {
          await suppression.add(companyId, 'email', email, { reason: 'tantra_unsubscribe', contactId: contact.id, metadata: { campaign: campaignName || null } });
        } catch (err) {
          console.error('[Webhooks] tantra suppression add failed:', email, err.message);
        }
        await crmRouter.addContactActivity(contact.id, companyId, { type: 'unsubscribed', message: `Tantra: unsubscribed${campaignName ? ' from "' + campaignName + '"' : ''}` });
        continue;
      }

      if (eventType === 'lead.stage.changed') {
        // Tantra's own stage name is not a fixed, documented vocabulary — only
        // apply it if the operator has mapped it (Settings → Integrations →
        // Tantra), otherwise log the raw value so it's visible but nothing
        // moves on a guess.
        const rawStage = pick(body, 'stage', 'new_stage', 'to_stage', 'lead_stage', 'status');
        const mapped = rawStage && hook.stage_map && hook.stage_map[rawStage];
        if (mapped) {
          const adv = await api('POST', `/api/crm/contacts/${contact.id}/advance`,
            { pipeline_key: 'marketing', stage: mapped, automated: true, reason: `Tantra lead.stage.changed (${rawStage})` }, companyId);
          if (adv.status >= 400) {
            await crmRouter.addContactActivity(contact.id, companyId, { type: 'tantra_event', message: `Tantra: stage → "${rawStage}" mapped to "${mapped}" but the advance was refused (${adv.json && adv.json.error || adv.status})` });
          }
        } else {
          await crmRouter.addContactActivity(contact.id, companyId, { type: 'tantra_event', message: `Tantra: lead stage changed to "${rawStage || '(unknown field)'}" — no mapping configured, stage not changed here` });
        }
        continue;
      }

      // email.sent / email.clicked / email.bounced / email.intent.classified /
      // email.sequence.completed, and anything undocumented — logged, not acted on.
      await crmRouter.addContactActivity(contact.id, companyId, {
        type: 'tantra_event',
        message: `Tantra: ${eventType}${campaignName ? ' — "' + campaignName + '"' : ''}`,
      });
    }

    res.status(200).json({ ok: true, event: eventType, contacts_matched: emails.length });
  } catch (err) {
    console.error('[Webhooks] tantra/:token error:', err.message);
    res.status(500).json({ error: 'failed to process Tantra event' });
  }
});

module.exports = router;
