'use strict';
// ─── Fixed-window per-IP rate limiting for public endpoints ──────────────────
// Extracted from routes/marketing-public.js, which had the only implementation.
// The public webhook surface — lead capture, Tantra hints, tool captures — had
// none at all, so a token that leaked (or was simply guessed at, in the case of
// /capture/:tool, which is unauthenticated by design) could be hammered as fast
// as the network allowed.
//
// In-process and per-instance on purpose. A shared Redis counter would be more
// correct across a cluster, but this service runs as a single pm2 process
// against a connection-budgeted Postgres, and the threat here is "someone
// floods an open endpoint", not "someone precisely exceeds N by a factor of the
// instance count". Adding a dependency and a network hop to the hot path of an
// endpoint that exists to be cheap would be the wrong trade.
//
// Note this bounds REQUEST RATE, not work: the real protection for the
// expensive paths is that they fail closed without a valid secret or token.

const WINDOW_MS = 60_000;
const MAX_BUCKETS = 10_000;

// nginx APPENDS the true peer to any client-supplied X-Forwarded-For, so the
// LAST entry is the only one an attacker cannot choose. Trusting the first
// would let them rotate spoofed addresses into fresh buckets and never be
// limited at all. This mirrors the reasoning already recorded in
// routes/marketing-public.js.
function clientIp(req) {
  const fwd = req.get ? (req.get('x-forwarded-for') || '') : (req.headers['x-forwarded-for'] || '');
  if (fwd) return String(fwd).split(',').pop().trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Each limiter owns its own bucket map, so a flood of one endpoint cannot
// consume another's allowance or evict its counters.
function createLimiter({ max, windowMs = WINDOW_MS, name = 'public' } = {}) {
  const buckets = new Map();
  const limit = () => Number(typeof max === 'function' ? max() : max) || 60;

  function check(req, now = Date.now()) {
    const ip = clientIp(req);
    const bucket = (buckets.get(ip) || []).filter(t => now - t < windowMs);
    const limited = bucket.length >= limit();
    if (!limited) bucket.push(now);
    buckets.set(ip, bucket);
    if (buckets.size > MAX_BUCKETS) {
      // Prune EXPIRED buckets only — a blanket clear would reset every live
      // counter, including the one belonging to whoever triggered the growth.
      for (const [k, b] of buckets) {
        if (!b.length || now - b[b.length - 1] >= windowMs) buckets.delete(k);
      }
    }
    return limited;
  }

  // Express middleware form. 429 with Retry-After, because a well-behaved
  // provider retrying a webhook should be told when to come back rather than
  // being left to guess or to hot-loop.
  function middleware(req, res, next) {
    if (check(req)) {
      console.warn(`[RateLimit] ${name}: ${clientIp(req)} exceeded ${limit()}/${Math.round(windowMs / 1000)}s on ${req.originalUrl || req.url}`);
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  }

  return { check, middleware, clientIp, _buckets: buckets };
}

module.exports = { createLimiter, clientIp, WINDOW_MS };
