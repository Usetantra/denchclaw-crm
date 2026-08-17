'use strict';
const { v4: uuidv4 } = require('uuid');
const tenantDb = require('../db/models/tenants');
const apiKeysDb = require('../db/models/apiKeys');
const usersDb = require('../db/models/users');
const { readSessionCookie } = require('../lib/session-cookie');

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

// Gate-3 posture check: a production deploy running only the wildcard single key
// (no per-tenant INTERNAL_API_KEYS) accepts ANY X-Company-Id for that key. That's
// fine for single-tenant staging (nginx injects a fixed x-company-id), but a real
// multi-tenant deploy MUST bind keys to companies. Warn loudly; do not refuse
// (refusing would break the current single-tenant box). The end-state is DB-backed
// per-tenant keys (roadmap A3) — see README.
(function warnIfKeyUnboundInProduction() {
  if (process.env.NODE_ENV !== 'production' || process.env.INTERNAL_API_KEYS) return;
  console.warn(
    '[Auth] WARNING: production without INTERNAL_API_KEYS — the single key is bound to "*", ' +
    'so any X-Company-Id is accepted. Set INTERNAL_API_KEYS (key→company JSON) to enforce ' +
    'per-tenant isolation (gate 3).'
  );
})();

// Returns the allowed-company set for a key ('*' | Set | null-if-unknown).
function allowedCompaniesFor(key) {
  return KEY_BINDINGS.has(key) ? KEY_BINDINGS.get(key) : null;
}

const ALLOWED_CIDRS = (process.env.INTERNAL_API_ALLOWED_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── Real CIDR matching (gate 2) ──────────────────────────────────────────────
// Parse an IP (v4 or v6, incl. IPv4-mapped ::ffff:) to a BigInt + version, so we
// can compare masked bits against a CIDR instead of the old string-prefix hack
// (which ignored the mask width). Returns null on anything unparseable.
function ipToBig(ip) {
  if (!ip) return null;
  ip = String(ip).trim();
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) ip = mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts.some(p => p > 255)) return null;
    let v = 0n;
    for (const p of parts) v = (v << 8n) | BigInt(p);
    return { version: 4, value: v };
  }
  if (ip.includes(':')) {
    let head, tail;
    if (ip.includes('::')) {
      const [h, t] = ip.split('::');
      if (t === undefined || ip.indexOf('::') !== ip.lastIndexOf('::')) return null; // at most one ::
      head = h ? h.split(':') : [];
      tail = t ? t.split(':') : [];
    } else {
      head = ip.split(':'); tail = [];
    }
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    const groups = [...head, ...Array(missing).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    let v = 0n;
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      v = (v << 16n) | BigInt(parseInt(g, 16));
    }
    return { version: 6, value: v };
  }
  return null;
}

function ipInCidr(ip, cidr) {
  const slash = cidr.lastIndexOf('/');
  const base = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const a = ipToBig(ip), b = ipToBig(base);
  if (!a || !b || a.version !== b.version) return false;
  const bits = a.version === 4 ? 32 : 128;
  const prefix = slash >= 0 ? parseInt(cidr.slice(slash + 1), 10) : bits;
  if (!(prefix >= 0 && prefix <= bits)) return false;
  if (prefix === 0) return true;
  const shift = BigInt(bits - prefix);
  return (a.value >> shift) === (b.value >> shift);
}

function ipAllowed(ip) {
  if (!ip) return true; // no address info (unix socket / trusted local) — allow, as before
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ALLOWED_CIDRS.some(cidr => ipInCidr(ip, cidr));
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
  if (!key) {
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }

  // GOAL A3: a DB-backed per-tenant key (tenant_api_keys, migration 017)
  // resolves independently of the legacy env-configured map below — both are
  // checked before deciding anything, specifically so the collision case
  // right below can be caught before either path is trusted.
  let dbCompanyId = null;
  let dbCheckFailed = false;
  try {
    dbCompanyId = await apiKeysDb.resolveKey(key);
  } catch (err) {
    // DB not ready / transient error. The collision check right below can
    // only detect an ambiguous key if BOTH sides were actually queried —
    // when this side errors, we CANNOT prove this key isn't also a
    // DB-backed one, so we can't just silently trust the env side as if
    // nothing were wrong. Handled below: narrowly-scoped env keys still
    // work (no escalation risk even if an undetected collision existed —
    // a colliding DB key grants at most the same narrow access), but a
    // wildcard ('*') env key is refused during this window rather than
    // risking an undetected collision handing out admin power.
    console.error('[Auth] DB-backed API key resolution failed:', err.message);
    dbCheckFailed = true;
  }
  const envAllowed = allowedCompaniesFor(key);

  // SECURITY: a literal key string must never be valid in BOTH systems at
  // once. This can only happen via an operator manually reusing a string
  // across tenant_api_keys and INTERNAL_API_KEYS (createKey() always
  // generates its own random value, so the DB side of this can't happen
  // through normal API use) — but if it ever does, silently preferring
  // either side is dangerous: preferring the DB side would let a per-tenant
  // key inherit '*'-admin power should that same string also be an env
  // wildcard key (requireAdmin re-derives admin-ness from the raw key via
  // allowedCompaniesFor, independent of how requireAuth resolved it); and
  // preferring the env side would silently bind the request to whatever
  // tenant the env config says instead of the DB-issued key's actual tenant.
  // Fail loud (401) instead of silently picking a side.
  if (dbCompanyId && envAllowed) {
    console.error('[Auth] SECURITY: a key resolved via BOTH tenant_api_keys and INTERNAL_API_KEYS — refusing (ambiguous binding); rotate one of them');
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }
  if (dbCheckFailed && envAllowed) {
    // NOT narrowed to wildcard-only: a narrowly-bound env key is not "safe"
    // here either. The narrow env key's granted tenant comes from the
    // CALLER-SUPPLIED X-Company-Id header, not from anything the colliding
    // DB key was actually issued for — if key K is DB-bound to tenant A but
    // also present (operator error) in INTERNAL_API_KEYS narrowly bound to
    // {B, C}, an attacker sends X-Company-Id: C and authenticates as C, not
    // A and not "the same or a narrower" tenant. That's cross-tenant
    // confusion, not a privilege reduction — refusing wildcard keys alone
    // does not close it. Any env binding, wide or narrow, is refused when
    // the collision check itself can't run.
    console.error('[Auth] SECURITY: DB key-collision check unavailable (DB error) for an env-bound key — refusing rather than risk an undetected collision');
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }
  if (!dbCompanyId && !envAllowed) {
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }

  const callerIp = req.ip || req.socket?.remoteAddress || '';
  if (!ipAllowed(callerIp)) {
    console.warn('[Auth] X-Internal-Key rejected from IP:', callerIp);
    return res.status(403).json({ error: 'Internal API access denied from this address' });
  }

  if (dbCompanyId) {
    // X-Company-Id is irrelevant for a DB-backed key — it belongs to exactly
    // one tenant, unlike the legacy env-based keys below which are bound to
    // a SET of companies and still need the header to pick one.
    req.auth = { userId: 'internal-agent', companyId: dbCompanyId, role: 'agent' };
    return applySessionOverride(req, res, next);
  }

  const companyId = await canonicalCompanyId(req.headers['x-company-id'] || DEFAULT_COMPANY_ID);
  // Layer-1 isolation: a bound key may only act for companies in its set.
  if (envAllowed !== '*' && !envAllowed.has(companyId)) {
    console.warn(`[Auth] key not permitted for company '${companyId}'`);
    return res.status(403).json({ error: 'company not permitted for this key' });
  }
  req.auth = {
    userId: 'internal-agent',
    companyId,
    role: 'agent',
  };
  return applySessionOverride(req, res, next);
}

// A real per-person session (migration 033), layered ON TOP of the key check
// above rather than replacing it — the key remains "is this caller allowed to
// talk to the API at all" (nginx/the dev proxy inject it server-side, a
// browser never sees it); a session identifies WHO within that. When a valid
// session cookie is present, its company_id and role OVERRIDE whatever the
// key resolution above decided — a logged-in user can never act as a
// different tenant by sending an X-Company-Id header, no matter what the key
// itself is bound to. No session cookie (every test/automation/webhook
// caller today) means zero behavior change from before this existed.
async function applySessionOverride(req, res, next) {
  const token = readSessionCookie(req);
  if (!token) return next();
  try {
    const user = await usersDb.resolveSession(token);
    if (user) {
      req.auth = { userId: user.id, companyId: user.company_id, role: user.role };
      req.user = user;
    }
  } catch (err) {
    console.error('[Auth] session resolution failed:', err.message);
  }
  next();
}

function getUserCompanyId(req) {
  return req.auth?.companyId || null;
}

// Tenant management (creating/listing tenants) isn't a company-scoped
// operation — it's the operation that DEFINES companies — so it needs a
// stronger gate than "bound to this one company": only a key bound to '*'
// (unrestricted) may manage tenants. Composes with requireAuth rather than
// duplicating its key/IP checks.
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const allowed = allowedCompaniesFor(req.headers['x-internal-key']);
    if (allowed !== '*') {
      return res.status(403).json({ error: 'tenant management requires a key bound to all companies (*)' });
    }
    next();
  });
}

// Requires an actual logged-in person (req.user, set only by a resolved
// session — see applySessionOverride), not just a valid internal key. Every
// server-to-server/automation caller has no session and is correctly refused
// here — this gate is for routes a human, not a script, should be doing
// (managing teammates, changing your own password).
function requireUser(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'not logged in' });
    next();
  });
}

// role hierarchy: owner > admin > member. `min` is the lowest role allowed.
const ROLE_RANK = { member: 0, admin: 1, owner: 2 };
function requireRole(min) {
  return (req, res, next) => {
    requireUser(req, res, () => {
      if ((ROLE_RANK[req.user.role] ?? -1) < ROLE_RANK[min]) {
        return res.status(403).json({ error: `requires ${min} role or higher` });
      }
      next();
    });
  };
}

// CP-M union (D2): the branch's requireAdmin survives, and the export surface is
// the UNION of both sides — the branch's four plus main's ipAllowed/ipInCidr.
// Nothing outside auth.js imports the CIDR helpers today, but exporting them is
// what lets M9 probe the allowlist behaviourally instead of by reading the code.
module.exports = {
  requireAuth, requireAdmin, requireUser, requireRole, getUserCompanyId,
  INTERNAL_API_KEY, ipAllowed, ipInCidr,
};
