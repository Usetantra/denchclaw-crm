'use strict';
// ─── Marketing ingestion — the PUBLIC surface (CP-B) ─────────────────────────
//
// Mounted OUTSIDE requireAuth. A landing page, a calendar provider and a social
// listener cannot hold an internal API key, so these endpoints are reachable
// from the internet and are guarded on their own terms.
//
// BORROWED WHOLESALE from ~/nurturing-engine/backend/app/webhooks.py, whose
// registration route solves this exact problem and has already been through a
// critic pass. Carried over, with the reasoning:
//   · header-only shared secret. No `?secret=` form — query strings land in
//     nginx/uvicorn access logs and browser history;
//   · FAIL CLOSED. Secret unset on the server ⇒ every request is refused, never
//     "open because unconfigured" (C4: absent is not permission);
//   · constant-time compare, so the secret can't be recovered by timing;
//   · per-IP sliding-window rate limit taken from the LAST x-forwarded-for hop —
//     nginx APPENDS the true peer, so trusting the FIRST value lets an attacker
//     rotate spoofed IPs into fresh buckets;
//   · body-size cap — these payloads are tiny, bulk goes through the keyed API;
//   · the tenant is decided SERVER-SIDE, never by the caller. One secret must
//     not become a cross-tenant write primitive: a caller-supplied company that
//     disagrees is a loud 403, never a silent reroute. (This CRM goes one step
//     further than the engine — see SECRET_BINDINGS below.)
//
// The one endpoint that is NOT secret-gated is the invite redirect, because it
// is a link in a prospect's inbox. Its security is the 176-bit unguessable
// token, and an unknown token is a plain 404 that moves nobody.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const mk = require('../lib/marketing-events');
const crmRouter = require('./crm');
const tenantDb = require('../db/models/tenants');

const DEFAULT_COMPANY = process.env.DEFAULT_COMPANY_ID || 'tantra';

// ─── Which tenant is this? THE SECRET ANSWERS IT. ────────────────────────────
//
// The engines pin their registration webhook to `default_company_id` and reject
// any caller-supplied company, with the note: "ONE global secret must not grant
// cross-tenant writes." The reasoning is right; the remedy is weaker than what
// this CRM can do, because the engines only ever had one secret. Pinning here
// would mean a second tenant's landing page can never register anybody — the
// public marketing surface would be single-tenant in a system whose whole A3
// checkpoint was per-tenant credentials.
//
// So the secret CARRIES the tenant, exactly like `INTERNAL_API_KEYS` does:
//   MARKETING_WEBHOOK_SECRETS = {"<secret>":"<company_id>", ...}   per-tenant
//   MARKETING_WEBHOOK_SECRET  = "<secret>"                          ⇒ DEFAULT_COMPANY_ID
// A caller cannot name its own tenant at all; it can only prove which one it
// already belongs to. That removes the cross-tenant write primitive rather than
// merely refusing to exercise it, and a claimed `company_id` that disagrees
// with the secret's tenant is still a loud 403 rather than a silent reroute.
const SECRET_BINDINGS = (() => {
  const out = [];
  const raw = process.env.MARKETING_WEBHOOK_SECRETS;
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('[Marketing] MARKETING_WEBHOOK_SECRETS is not valid JSON — refusing to start:', e.message);
      throw new Error('MARKETING_WEBHOOK_SECRETS must be valid JSON');
    }
    for (const [secret, company] of Object.entries(parsed)) {
      if (secret && company) out.push({ secret: String(secret), company: String(company) });
    }
  }
  const single = process.env.MARKETING_WEBHOOK_SECRET;
  if (single) out.push({ secret: String(single), company: DEFAULT_COMPANY });
  return out;
})();

if (!SECRET_BINDINGS.length) {
  console.warn('[Marketing] neither MARKETING_WEBHOOK_SECRET nor MARKETING_WEBHOOK_SECRETS is set — the public marketing webhooks (registration / RSVP / comment) are DISABLED (503). The invite-link redirect still works.');
}

const deps = {
  recordActivity: crmRouter.addContactActivity,
  findOrCreateContact: crmRouter.findOrCreateContact,
};

function constantEq(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Compare against EVERY binding, no early exit — an early `break` on the first
// match leaks, through response timing, roughly where in the map a guessed
// prefix lands.
function companyForSecret(provided) {
  let match = null;
  for (const b of SECRET_BINDINGS) {
    if (constantEq(provided, b.secret)) match = match || b;
  }
  return match ? match.company : null;
}

// ─── Rate limit (ported) ─────────────────────────────────────────────────────
const RL_WINDOW_MS = 60_000;
const RL_MAX = Number(process.env.MARKETING_WEBHOOK_RATE_LIMIT || 60) || 60;
const rlBuckets = new Map();

function clientIp(req) {
  const fwd = req.get('x-forwarded-for') || '';
  if (fwd) return fwd.split(',').pop().trim();
  return req.ip || 'unknown';
}

function rateLimited(req, now = Date.now()) {
  const ip = clientIp(req);
  const bucket = (rlBuckets.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  const limited = bucket.length >= RL_MAX;
  if (!limited) bucket.push(now);
  rlBuckets.set(ip, bucket);
  if (rlBuckets.size > 10_000) {
    // Bound memory under IP churn by pruning EXPIRED buckets only — a blanket
    // clear would reset every live counter, the attacker's included.
    for (const [k, b] of rlBuckets) {
      if (!b.length || now - b[b.length - 1] >= RL_WINDOW_MS) rlBuckets.delete(k);
    }
  }
  return limited;
}

// Canonicalize a tenant id through its aliases (migration 012 seeds `tantra`
// with aliases), so a binding written against an alias and a claim written
// against the canonical id are compared as equals rather than as strangers.
async function canonical(id) {
  try {
    const t = await tenantDb.resolve(id);
    if (t && t.id) return t.id;
  } catch (e) {
    console.error('[Marketing] tenant canonicalization failed, using the value as-is:', e.message);
  }
  return id;
}

// The single gate for the three secret-protected POST routes. Returns the
// resolved company id, or null when it has already answered the request.
async function gate(req, res) {
  if (!SECRET_BINDINGS.length) {
    console.error('[Marketing] public webhook rejected — no marketing webhook secret is configured');
    res.status(503).json({ error: 'marketing webhooks not configured' });
    return null;
  }
  if (rateLimited(req)) {
    res.set('Retry-After', '60').status(429).json({ error: 'rate_limited' });
    return null;
  }
  const bound = companyForSecret(req.get('x-marketing-secret'));
  if (!bound) {
    res.status(401).json({ error: 'invalid marketing webhook secret' });
    return null;
  }
  if (JSON.stringify(req.body || {}).length > 16_384) {
    res.status(413).json({ error: 'body_too_large' });
    return null;
  }

  const company = await canonical(bound);
  // A claimed company is never used to CHOOSE a tenant — only to disagree with
  // the one the secret already established, which is a loud refusal.
  const claimed = String((req.body || {}).company_id || req.get('x-company-id') || '').trim();
  if (claimed && (await canonical(claimed)) !== company) {
    console.error(`[Marketing] rejected company_id=${JSON.stringify(claimed)} — this secret is bound to ${company}`);
    res.status(403).json({ error: 'unknown_company' });
    return null;
  }
  return company;
}

// ─── GET /m/i/:token — the tracked invite link → the `visits` stage ──────────
//
// This is the mechanism behind the operator's definition: "Visits — invitees
// that have visited the landing pages FROM THE INVITES or invite emails." The
// token is what carries the invitee's identity across the click; without it a
// landing-page hit is anonymous and cannot be a Visit at all.
//
// The redirect happens regardless of what the funnel decides. A prospect who
// clicked our link must land on the page even if their stage move was refused
// or the DB was having a bad minute — the CRM's bookkeeping is not the
// prospect's problem.
router.get('/i/:token', async (req, res) => {
  let link = null;
  try {
    link = await mk.getInviteLinkByToken(req.params.token);
    if (!link) {
      // Unknown or forged token: nothing to attribute, nobody to move.
      return res.status(404).json({ error: 'unknown invite link' });
    }

    // Fire-and-record before redirecting, but never let it block the redirect.
    await mk.ingestMarketingEvent(link.company_id, {
      event_type: 'landing_page_visit',
      channel: link.channel,
      contact_id: link.contact_id,
      webinar_id: link.webinar_id,
      token: link.token,
      source: 'invite_link',
      metadata: { user_agent: String(req.get('user-agent') || '').slice(0, 300) },
    }, deps);

    const { query } = require('../db/index');
    await query(
      `UPDATE crm_invite_links
          SET visit_count = visit_count + 1,
              first_visited_at = COALESCE(first_visited_at, now()),
              last_visited_at = now()
        WHERE id = $1`,
      [link.id]
    );
  } catch (err) {
    console.error('[Marketing] invite-link visit ingest failed (redirecting anyway):', err.message);
  }
  if (!link) return res.status(404).json({ error: 'unknown invite link' });
  return res.redirect(302, link.destination_url);
});

// ─── POST /m/registration — the landing-page form → the `registrants` stage ──
// "Registrants — visitors on the landing page that register for the webinar
// from the landing page."
router.post('/registration', async (req, res) => {
  try {
    const company = await gate(req, res);
    if (!company) return;

    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!email || !email.includes('@') || email.length > 320) {
      return res.status(400).json({ error: 'valid email required' });
    }
    const out = await mk.ingestMarketingEvent(company, {
      event_type: 'registration', channel: 'web',
      email, name: b.name, phone: b.phone,
      webinar_key: b.webinar_key, webinar_id: b.webinar_id,
      // An LP that carries the invite token registers a KNOWN invitee rather
      // than a look-alike by email — same attribution primitive as the visit.
      token: b.token,
      source: b.registration_source || 'landing_page',
      provider: 'landing_page',
      metadata: { utm: b.utm || null, registration_source: b.registration_source || null },
    }, deps);
    if (out.ok === false) return res.status(out.status || 400).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[Marketing] registration webhook error:', err.message);
    return res.status(500).json({ error: 'registration ingest failed' });
  }
});

// ─── POST /m/rsvp — auto-registrant path 1 ───────────────────────────────────
// "Invitees that respond YES / MAYBE to cold CALENDAR INVITE outreach."
router.post('/rsvp', async (req, res) => {
  try {
    const company = await gate(req, res);
    if (!company) return;

    const b = req.body || {};
    const out = await mk.ingestMarketingEvent(company, {
      event_type: 'calendar_rsvp', channel: 'calendar',
      email: b.email, contact_id: b.contact_id, phone: b.phone,
      webinar_key: b.webinar_key, webinar_id: b.webinar_id,
      rsvp: b.rsvp ?? b.response ?? b.partstat ?? b.responseStatus,
      provider: b.provider || 'calendar',
      provider_event_id: b.provider_event_id || b.event_id || undefined,
      source: 'calendar_invite',
    }, deps);
    if (out.ok === false) return res.status(out.status || 400).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[Marketing] rsvp webhook error:', err.message);
    return res.status(500).json({ error: 'rsvp ingest failed' });
  }
});

// ─── POST /m/comment — auto-registrant path 3 ────────────────────────────────
// "Prospects that COMMENT BELOW CONTENT POSTS expressing interest in joining
// the webinar." The comment text is classified conservatively; a comment with
// no explicit interest signal registers nobody.
router.post('/comment', async (req, res) => {
  try {
    const company = await gate(req, res);
    if (!company) return;

    const b = req.body || {};
    const out = await mk.ingestMarketingEvent(company, {
      event_type: 'content_comment', channel: 'content',
      email: b.email, contact_id: b.contact_id, phone: b.phone,
      webinar_key: b.webinar_key, webinar_id: b.webinar_id,
      body: b.body ?? b.comment ?? b.text,
      interested: typeof b.interested === 'boolean' ? b.interested : undefined,
      post_ref: b.post_ref || b.post_id || null,
      post_url: b.post_url || null,
      provider: b.provider || 'content',
      provider_event_id: b.provider_event_id || b.comment_id || undefined,
      source: 'content_post',
    }, deps);
    if (out.ok === false) return res.status(out.status || 400).json(out);
    return res.json(out);
  } catch (err) {
    console.error('[Marketing] comment webhook error:', err.message);
    return res.status(500).json({ error: 'comment ingest failed' });
  }
});

module.exports = router;
