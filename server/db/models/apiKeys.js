'use strict';
// ─── DAL: Per-tenant API keys (GOAL A3) ────────────────────────────────────────
// tenant_api_keys (migration 017). Keys are high-entropy random secrets, not
// user-chosen passwords, so a fast cryptographic hash (SHA-256) is the right
// tool here — not bcrypt/scrypt, which exist to slow down brute-forcing a
// LOW-entropy secret and would add needless latency to every authenticated
// request on this hot path.
const crypto = require('crypto');
const { query } = require('../index');

const KEY_PREFIX = 'dc_live_';
const KEY_PREFIX_DISPLAY_LEN = 12; // "dc_live_" + 4 chars — enough to eyeball-identify, not enough to brute-force

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Returns { id, key, key_prefix, company_id, label } — `key` (the plaintext)
// is returned ONLY here, at creation time, and never persisted or returned
// again by any other function in this file.
async function createKey(companyId, label = null) {
  if (!companyId) throw new Error('apiKeys.createKey requires companyId');
  const rawKey = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, KEY_PREFIX_DISPLAY_LEN);
  const result = await query(
    `INSERT INTO tenant_api_keys (company_id, key_hash, key_prefix, label)
     VALUES ($1,$2,$3,$4) RETURNING id, company_id, key_prefix, label, created_at`,
    [companyId, keyHash, keyPrefix, label]
  );
  return { ...result.rows[0], key: rawKey };
}

// The hot-path check every authenticated request goes through — must stay
// fast (one indexed lookup on key_hash, no bcrypt-style deliberate slowness).
// Returns the active key's company_id, or null (unknown key, or revoked).
// Updates last_used_at best-effort (never blocks/fails the auth check on it).
async function resolveKey(rawKey) {
  if (!rawKey) return null;
  const keyHash = hashKey(rawKey);
  const result = await query(
    'SELECT id, company_id FROM tenant_api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
    [keyHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  query('UPDATE tenant_api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  return row.company_id;
}

// Never returns key_hash — only the prefix, enough to identify a key in a
// list without ever exposing or reconstructing the secret.
async function listKeys(companyId) {
  if (!companyId) throw new Error('apiKeys.listKeys requires companyId');
  const result = await query(
    `SELECT id, company_id, key_prefix, label, created_at, last_used_at, revoked_at
       FROM tenant_api_keys WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  return result.rows;
}

async function revokeKey(companyId, keyId) {
  if (!companyId) throw new Error('apiKeys.revokeKey requires companyId');
  const result = await query(
    `UPDATE tenant_api_keys SET revoked_at = now()
     WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
     RETURNING id, company_id, key_prefix, label, revoked_at`,
    [keyId, companyId]
  );
  return result.rows[0] || null;
}

module.exports = { createKey, resolveKey, listKeys, revokeKey };
