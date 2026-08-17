'use strict';
// ─── Resend domain-management API client ───────────────────────────────────
// Wraps https://api.resend.com/domains — a DIFFERENT surface from
// server/lib/email-resend.js (which sends mail). This is what backs
// self-serve "connect your own domain": create the domain in OUR Resend
// account on the tenant's behalf, hand back the DNS records they need to
// paste into their own DNS provider, and poll/verify from there.
// RESEND_API_BASE overridable for tests, same convention as email-resend.js.
const API_BASE = () => process.env.RESEND_API_BASE || 'https://api.resend.com';

async function call(apiKey, method, path, body) {
  const r = await fetch(`${API_BASE()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_e) {}
  if (!r.ok) {
    const err = new Error((json && json.message) || `Resend API error (HTTP ${r.status})`);
    err.status = r.status;
    throw err;
  }
  return json;
}

function createDomain(apiKey, { name, region = 'us-east-1' }) {
  return call(apiKey, 'POST', '/domains', { name, region });
}

function getDomain(apiKey, id) {
  return call(apiKey, 'GET', `/domains/${id}`);
}

// Kicks off Resend's async re-check of DNS records — the response does not
// itself carry the fresh status, a getDomain() poll afterward does.
function verifyDomain(apiKey, id) {
  return call(apiKey, 'POST', `/domains/${id}/verify`);
}

function updateDomain(apiKey, id, { receiving } = {}) {
  const capabilities = {};
  if (receiving !== undefined) capabilities.receiving = receiving ? 'enabled' : 'disabled';
  return call(apiKey, 'PATCH', `/domains/${id}`, { capabilities });
}

function deleteDomain(apiKey, id) {
  return call(apiKey, 'DELETE', `/domains/${id}`);
}

module.exports = { createDomain, getDomain, verifyDomain, updateDomain, deleteDomain };
