'use strict';
const { v4: uuidv4 } = require('uuid');
const tenantDb = require('../db/models/tenants');

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || (() => {
  const k = 'denchclaw-dev-' + uuidv4();
  console.warn('[Auth] INTERNAL_API_KEY not set — ephemeral dev key generated:', k);
  return k;
})();

const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || 'tantra';

// Static fallback fold — used ONLY when the tenants table (migration 012)
// can't be consulted (DB not ready yet at boot, or a transient query error).
// Tenant resolution is "best-effort enrichment" the same way company
// auto-identification is (server/db/models/companies.js): a DB hiccup must
// never block auth on this always-on service. Tunable via LEGACY_COMPANY_IDS /
// CANONICAL_COMPANY_ID for back-compat with pre-migration-012 deployments.
const CANONICAL_COMPANY_ID = process.env.CANONICAL_COMPANY_ID || DEFAULT_COMPANY_ID;
const LEGACY_COMPANY_IDS = new Set(
  (process.env.LEGACY_COMPANY_IDS || 'growthclub,dev_company')
    .split(',').map(s => s.trim()).filter(Boolean)
);
function staticFold(id) {
  return LEGACY_COMPANY_IDS.has(id) ? CANONICAL_COMPANY_ID : id;
}

// DB-backed canonicalization (migration 012 `tenants.aliases` replaces the env-
// parsed fold above as the source of truth). A known tenant id or alias
// resolves to that tenant's canonical id; an id no tenant recognizes (e.g. the
// contract suite's ad-hoc co_a_<run> test tenants, which are deliberately never
// provisioned as real tenant rows) passes through the static fold unchanged —
// same back-compat posture as before migration 012, not a behavior change for
// anything that isn't `tantra`/its legacy aliases.
const TENANT_CACHE_TTL_MS = parseInt(process.env.TENANT_CACHE_TTL_MS, 10) || 60_000;
// Bounded LRU-ish cache keyed on the raw incoming X-Company-Id: any caller
// holding a valid internal key controls this header, so an unbounded map
// keyed on attacker-influenced input would be a memory-exhaustion DoS vector
// (many distinct header values -> unbounded growth). Insertion order in a JS
// Map lets a cheap "evict oldest" approximate LRU without a dependency.
const TENANT_CACHE_MAX_ENTRIES = parseInt(process.env.TENANT_CACHE_MAX_ENTRIES, 10) || 1000;
const tenantCache = new Map(); // id -> { canonicalId, expiresAt }

function cacheTenant(id, canonicalId) {
  tenantCache.delete(id); // re-inserting moves it to the "most recent" end
  tenantCache.set(id, { canonicalId, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
  while (tenantCache.size > TENANT_CACHE_MAX_ENTRIES) {
    tenantCache.delete(tenantCache.keys().next().value); // evict oldest
  }
}

async function canonicalCompanyId(id) {
  const cached = tenantCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.canonicalId;

  try {
    const tenant = await tenantDb.resolve(id);
    const canonicalId = tenant ? tenant.id : staticFold(id);
    cacheTenant(id, canonicalId);
    return canonicalId;
  } catch (err) {
    // DB not ready / transient error — fall back without caching, so the next
    // request retries the DB rather than being stuck on a stale fallback.
    // NOTE: staticFold is frozen at process start from LEGACY_COMPANY_IDS/
    // CANONICAL_COMPANY_ID env vars. If tenants.aliases is ever edited in the
    // DB without updating those env vars too, a DB blip during that window
    // falls back to the stale env mapping — accepted tradeoff (availability
    // over consistency during an outage, consistent with this service's
    // "never block on DB pressure" design elsewhere), not an oversight. Keep
    // the env vars in sync with tenants.aliases for this fallback to be safe.
    console.error('[Auth] tenant resolution failed, using static fold:', err.message);
    return staticFold(id);
  }
}

// ─── Key → allowed-company binding (multi-tenant isolation, layer 1) ──────────
// INTERNAL_API_KEYS (optional) is a JSON object mapping each API key to the
// companies it may act for: { "<key>": ["co_a","co_b"], "<key2>": "*" }.
// "*" (or the array ["*"]) means the key may act for any company.
//
// Back-compat: if INTERNAL_API_KEYS is unset, the single INTERNAL_API_KEY is
// bound to "*" — i.e. exactly today's behavior (any X-Company-Id accepted).
// Operators opt into real per-tenant isolation by configuring INTERNAL_API_KEYS
// with explicit company sets; an out-of-set X-Company-Id then gets 403.
function buildKeyBindings() {
  const raw = process.env.INTERNAL_API_KEYS;
  const map = new Map();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('[Auth] INTERNAL_API_KEYS is not valid JSON — refusing to start:', e.message);
      throw new Error('INTERNAL_API_KEYS must be valid JSON');
    }
    for (const [key, val] of Object.entries(parsed)) {
      if (val === '*' || (Array.isArray(val) && val.includes('*'))) {
        map.set(key, '*');
      } else if (Array.isArray(val)) {
        map.set(key, new Set(val));
      } else if (typeof val === 'string') {
        map.set(key, new Set([val]));
      }
    }
  } else {
    map.set(INTERNAL_API_KEY, '*'); // single-key back-compat
  }
  return map;
}

const KEY_BINDINGS = buildKeyBindings();

// Returns the allowed-company set for a key ('*' | Set | null-if-unknown).
function allowedCompaniesFor(key) {
  return KEY_BINDINGS.has(key) ? KEY_BINDINGS.get(key) : null;
}

const ALLOWED_CIDRS = (process.env.INTERNAL_API_ALLOWED_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(s => s.trim()).filter(Boolean);

function ipAllowed(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ALLOWED_CIDRS.some(cidr => {
    const [base] = cidr.split('/');
    return ip === base || ip.startsWith(base.replace(/\.\d+$/, '.'));
  });
}

// Express 4 does not catch a rejected promise from an async middleware — an
// uncaught throw here would leave the request hanging with no response ever
// sent, not just a 500. canonicalCompanyId() currently swallows every error
// internally, so nothing throws today, but that's incidental to its current
// implementation, not a structural guarantee for future edits to this
// function. This wrapper makes "never hang, always respond" true regardless.
function requireAuth(req, res, next) {
  requireAuthAsync(req, res, next).catch((err) => {
    console.error('[Auth] unexpected error in requireAuth:', err.message);
    // Guard against a throw after next() already let a downstream handler
    // respond — a second res.status()/json() call would throw
    // ERR_HTTP_HEADERS_SENT instead of just logging the original error.
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal auth error' });
  });
}

async function requireAuthAsync(req, res, next) {
  const key = req.headers['x-internal-key'];
  const allowed = key ? allowedCompaniesFor(key) : null;
  if (!key || !allowed) {
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }
  const callerIp = req.ip || req.socket?.remoteAddress || '';
  if (!ipAllowed(callerIp)) {
    console.warn('[Auth] X-Internal-Key rejected from IP:', callerIp);
    return res.status(403).json({ error: 'Internal API access denied from this address' });
  }
  const companyId = await canonicalCompanyId(req.headers['x-company-id'] || DEFAULT_COMPANY_ID);
  // Layer-1 isolation: a bound key may only act for companies in its set.
  if (allowed !== '*' && !allowed.has(companyId)) {
    console.warn(`[Auth] key not permitted for company '${companyId}'`);
    return res.status(403).json({ error: 'company not permitted for this key' });
  }
  req.auth = {
    userId: 'internal-agent',
    companyId,
    role: 'agent',
  };
  next();
}

function getUserCompanyId(req) {
  return req.auth?.companyId || null;
}

module.exports = { requireAuth, getUserCompanyId, INTERNAL_API_KEY };
