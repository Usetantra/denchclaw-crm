'use strict';
const { v4: uuidv4 } = require('uuid');

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || (() => {
  const k = 'denchclaw-dev-' + uuidv4();
  console.warn('[Auth] INTERNAL_API_KEY not set — ephemeral dev key generated:', k);
  return k;
})();

const DEFAULT_COMPANY_ID = process.env.DEFAULT_COMPANY_ID || 'tantra';

// Single-tenant consolidation (migration 011): legacy tenant ids were folded into
// the canonical tenant. Any inbound X-Company-Id in this set is canonicalized so
// a stale caller (an engine, an old bulk-import script) can never re-split the
// tenant. Tunable via LEGACY_COMPANY_IDS / CANONICAL_COMPANY_ID; test tenants
// (co_a_*, cp4_co) are deliberately NOT folded so multi-tenant contract tests
// still exercise real isolation.
const CANONICAL_COMPANY_ID = process.env.CANONICAL_COMPANY_ID || DEFAULT_COMPANY_ID;
const LEGACY_COMPANY_IDS = new Set(
  (process.env.LEGACY_COMPANY_IDS || 'growthclub,dev_company')
    .split(',').map(s => s.trim()).filter(Boolean)
);
function canonicalCompanyId(id) {
  return LEGACY_COMPANY_IDS.has(id) ? CANONICAL_COMPANY_ID : id;
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

function requireAuth(req, res, next) {
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
  const companyId = canonicalCompanyId(req.headers['x-company-id'] || DEFAULT_COMPANY_ID);
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

module.exports = { requireAuth, getUserCompanyId, INTERNAL_API_KEY, ipAllowed, ipInCidr };
