'use strict';
// ─── Clerk session-token verification ────────────────────────────────────────
// The ONLY file allowed to talk to Clerk, the same way tantra-client.js is the
// only file allowed to call Tantra. Everything else in the codebase sees a
// plain { clerkUserId, email } and never a JWT, a JWKS, or a Clerk SDK type.
//
// WHY @clerk/backend AND NOT A HAND-ROLLED VERIFIER
//
// This repo's default is to refuse dependencies — session-cookie.js parses
// cookies by hand rather than take cookie-parser. That instinct is right for
// parsing and wrong here: JWKS caching, key rotation, clock skew, and the `azp`
// check are each a place where being subtly wrong produces a verifier that
// accepts tokens it should not, silently, with no failing test. That is not a
// class of bug worth owning to save a dependency.
//
// BEARER ONLY — NEVER THE __session COOKIE
//
// Clerk also sets a `__session` cookie, and reading it would be one line. We
// deliberately do not, because server.js mounts express.urlencoded() and this
// codebase has no CSRF token anywhere. A cookie credential plus a urlencoded
// body parser means a cross-site <form method=POST> is authenticated for free.
// SameSite=Lax narrows that but does not close it, and it is one Clerk
// satellite-domain setting away from SameSite=None. An Authorization header
// cannot be set by a form at all, and setting it from fetch() triggers a
// preflight that this server never answers cross-origin — so the attack stops
// being a configuration question and starts being structurally impossible.
//
// Do not "helpfully" add a cookie fallback here later. That is the whole point.
const { verifyToken, createClerkClient } = require('@clerk/backend');

const SECRET_KEY = process.env.CLERK_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY || '';
// PEM public key from the Clerk dashboard. When set, verification is
// networkless — no JWKS fetch, so a Clerk network blip cannot become a 401
// storm. Strongly recommended in production; also how the test suite verifies
// its own locally-minted tokens with the real library.
const JWT_KEY = (process.env.CLERK_JWT_KEY || '').replace(/\\n/g, '\n');
// Protects against a token minted for a DIFFERENT application on the same Clerk
// instance being replayed here (the `azp` claim). Unset means unchecked, which
// is why there is a startup warning below.
const AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const CLOCK_SKEW_MS = parseInt(process.env.CLERK_CLOCK_SKEW_MS, 10) || 5000;

// Either credential is sufficient to verify: jwtKey does it offline, secretKey
// does it by fetching JWKS. With neither, the Clerk branch simply never
// engages — see the fail-closed note in requireAuthAsync.
function isConfigured() {
  return Boolean(SECRET_KEY || JWT_KEY);
}

function publishableKey() {
  return PUBLISHABLE_KEY || null;
}

// Authorization: Bearer <jwt>. Nothing else — see the header comment.
function extractToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : null;
}

function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
}

// Returns { clerkUserId, email, sessionId, claims } or null. NEVER throws, and
// never logs the token itself — only the reason it was refused.
//
// TWO RETURN SHAPES, ON PURPOSE. @clerk/backend's own .d.ts declares
// verifyToken as resolving to { data, errors }, but the v3.16.8 RUNTIME returns
// the payload directly and THROWS on any verification failure (expiry, nbf,
// azp, malformed — all observed). The typings and the implementation disagree.
// Rather than pick one and break on the next release, accept both: unwrap
// `.data` when present, otherwise treat the result as the payload, and keep the
// try/catch as a real code path rather than a formality.
async function verifyRequest(req) {
  const token = extractToken(req);
  if (!token) return null;
  if (!isConfigured()) return null;
  try {
    const result = await verifyToken(token, {
      secretKey: SECRET_KEY || undefined,
      jwtKey: JWT_KEY || undefined,
      authorizedParties: AUTHORIZED_PARTIES.length ? AUTHORIZED_PARTIES : undefined,
      clockSkewInMs: CLOCK_SKEW_MS,
    });
    if (result && result.errors && result.errors.length) {
      console.warn('[Clerk] token rejected:', result.errors[0]?.message || 'verification failed');
      return null;
    }
    const claims = result && result.data ? result.data : result;
    if (!claims || !claims.sub) {
      console.warn('[Clerk] token verified but carried no subject');
      return null;
    }
    return {
      clerkUserId: claims.sub,
      // `email` is a CUSTOM session claim — see fetchIdentityEmail() below for
      // why it may legitimately be absent.
      email: normalizeEmail(claims.email),
      sessionId: claims.sid || null,
      claims,
    };
  } catch (err) {
    console.warn('[Clerk] token verification threw:', err.message);
    return null;
  }
}

// ── Backend API (provisioning path only) ─────────────────────────────────────
// Everything below needs CLERK_SECRET_KEY specifically — jwtKey alone verifies
// tokens but cannot call the API.
let _client = null;
function client() {
  if (!SECRET_KEY) return null;
  if (!_client) _client = createClerkClient({ secretKey: SECRET_KEY });
  return _client;
}

// THE EMAIL TRAP.
//
// Clerk's session token carries sub/sid/iss/exp/nbf/azp and — by default — NO
// email. But provisioning needs one: to match a pending invite, to link a
// pre-existing users row, and to populate users.email. So either
//
//   (a) add a custom session-token claim in the Clerk dashboard
//       (Sessions -> Customize session token):
//           { "email": "{{user.primary_email_address}}" }
//       which is the fast path and costs no network call, or
//   (b) this function, which asks the Backend API.
//
// Configure (a) and keep (b) as the fallback. Without either, every new
// identity lands on `no_workspace` and the cause is invisible.
//
// Cached with the same bounded evict-oldest shape as the tenant cache in
// middleware/auth.js, for the same reason: the key is derived from caller
// input, so the map must not be able to grow without bound.
const EMAIL_CACHE_TTL_MS = parseInt(process.env.CLERK_EMAIL_CACHE_TTL_MS, 10) || 5 * 60 * 1000;
const EMAIL_CACHE_MAX = parseInt(process.env.CLERK_EMAIL_CACHE_MAX, 10) || 1000;
const emailCache = new Map(); // clerkUserId -> { email, expiresAt }

function cacheEmail(clerkUserId, email) {
  if (emailCache.size >= EMAIL_CACHE_MAX) {
    const oldest = emailCache.keys().next();
    if (!oldest.done) emailCache.delete(oldest.value);
  }
  emailCache.set(clerkUserId, { email, expiresAt: Date.now() + EMAIL_CACHE_TTL_MS });
}

async function fetchIdentityEmail(clerkUserId) {
  if (!clerkUserId) return null;
  const hit = emailCache.get(clerkUserId);
  if (hit && hit.expiresAt > Date.now()) return hit.email;
  const c = client();
  if (!c) return null;
  try {
    const user = await c.users.getUser(clerkUserId);
    const primaryId = user.primaryEmailAddressId;
    const addresses = user.emailAddresses || [];
    const primary = addresses.find(a => a.id === primaryId) || addresses[0];
    const email = normalizeEmail(primary && primary.emailAddress);
    cacheEmail(clerkUserId, email);
    return email;
  } catch (err) {
    console.error('[Clerk] could not read the email for', clerkUserId, '-', err.message);
    return null;
  }
}

// Best-effort courtesy on suspend. NOT the security guarantee — the auth path
// re-reads users.status on every request, so a suspension takes effect on the
// very next call whether or not this succeeds. This just logs them out promptly
// instead of leaving a dead tab that looks alive.
async function revokeUserSessions(clerkUserId) {
  if (!clerkUserId) return;
  const c = client();
  if (!c) return;
  try {
    const sessions = await c.sessions.getSessionList({ userId: clerkUserId, status: 'active' });
    const list = sessions?.data || sessions || [];
    for (const s of list) {
      try { await c.sessions.revokeSession(s.id); } catch (_e) { /* best effort, per-session */ }
    }
  } catch (err) {
    console.warn('[Clerk] session revocation failed for', clerkUserId, '-', err.message);
  }
}

// Irreversible, and in a multi-tenant future it would destroy the person's
// memberships of OTHER tenants too — so it is opt-in via env and off by default.
async function deleteIdentity(clerkUserId) {
  if (!clerkUserId) return;
  if (process.env.CLERK_DELETE_IDENTITY_ON_REMOVE !== '1') return;
  const c = client();
  if (!c) return;
  try { await c.users.deleteUser(clerkUserId); }
  catch (err) { console.warn('[Clerk] identity deletion failed for', clerkUserId, '-', err.message); }
}

// Mirrors warnIfKeyUnboundInProduction() in middleware/auth.js: warn loudly at
// boot about a posture that is legal but weaker than it looks. Never fatal —
// this service does not refuse to start over configuration.
(function warnOnWeakClerkPosture() {
  if (!isConfigured()) return;
  if (process.env.NODE_ENV === 'production' && !AUTHORIZED_PARTIES.length) {
    console.warn(
      '[Clerk] WARNING: CLERK_AUTHORIZED_PARTIES is unset — the azp claim is not checked, so a ' +
      'token minted for a DIFFERENT application on this Clerk instance would be accepted here. ' +
      'Set it to this app\'s exact origin, e.g. https://claw.usetantra.com'
    );
  }
  if (process.env.NODE_ENV === 'production' && !JWT_KEY) {
    console.warn(
      '[Clerk] WARNING: CLERK_JWT_KEY is unset — every token verification may hit Clerk\'s JWKS ' +
      'endpoint, so a network blip becomes a 401 storm. Paste the PEM public key from the Clerk ' +
      'dashboard to verify offline.'
    );
  }
})();

module.exports = {
  isConfigured,
  publishableKey,
  extractToken,
  verifyRequest,
  fetchIdentityEmail,
  revokeUserSessions,
  deleteIdentity,
};
