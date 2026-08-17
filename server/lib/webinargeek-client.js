'use strict';
// ─── WebinarGeek API v2 client ─────────────────────────────────────────────
// Thin wrapper around https://app.webinargeek.com/api/v2, sourced directly
// from webinargeek.docs.apiary.io (fetched 2026-08-17) — auth header, base
// URL, endpoint shapes and error format are all real, not guessed. The API
// is pull-only (no webhooks exist anywhere in that spec), so every call here
// is operator-triggered from Settings, never a background poll.
// Overridable for tests (same pattern as RESEND_API_BASE) so the suite never
// makes a real outbound call to WebinarGeek.
function base() { return process.env.WEBINARGEEK_API_BASE || 'https://app.webinargeek.com/api/v2'; }

async function call(apiKey, path) {
  const r = await fetch(`${base()}${path}`, { headers: { 'Api-Token': apiKey, 'Accept': 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch (_e) {}
  if (!r.ok) {
    const msg = (body && body.message) || `WebinarGeek API error (HTTP ${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return body;
}

// GET /account — the cheapest possible call to prove a key is valid, used to
// verify a key on connect without needing to know a broadcast id yet.
async function getAccount(apiKey) {
  return call(apiKey, '/account');
}

async function listBroadcasts(apiKey, { perPage = 100 } = {}) {
  return call(apiKey, `/broadcasts?nested_resources=webinar,episode&order=date&sort=desc&per_page=${Math.min(perPage, 1000)}`);
}

// One page at a time — the caller (settings.js sync route) walks pages so a
// broadcast with thousands of registrants doesn't require unbounded memory.
async function listSubscriptions(apiKey, { broadcastId, page = 1, perPage = 200 }) {
  return call(apiKey, `/subscriptions?broadcast_id=${encodeURIComponent(broadcastId)}&page=${page}&per_page=${Math.min(perPage, 1000)}`);
}

module.exports = { getAccount, listBroadcasts, listSubscriptions };
