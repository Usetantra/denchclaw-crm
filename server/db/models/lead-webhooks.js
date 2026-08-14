'use strict';
// ─── DAL: inbound lead webhooks ─────────────────────────────────────────────
// A per-tenant, token-authenticated URL external tools POST leads to. The
// token is the entire auth story (no INTERNAL_API_KEY needed) — long, random,
// rotatable, revocable per-webhook (not shared secret-in-URL like marketing's,
// each row here is independently revocable so one leaked Zapier URL doesn't
// take down every integration).
const crypto = require('crypto');
const { query } = require('../index');

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function list(companyId) {
  if (!companyId) throw new Error('leadWebhooks.list requires companyId');
  const r = await query(`SELECT * FROM lead_webhooks WHERE company_id=$1 ORDER BY created_at DESC`, [companyId]);
  return r.rows;
}

async function create(companyId, { label, defaultSource, defaultTags } = {}) {
  if (!companyId) throw new Error('leadWebhooks.create requires companyId');
  const token = generateToken();
  const r = await query(
    `INSERT INTO lead_webhooks (company_id, token, label, default_source, default_tags)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [companyId, token, label || null, defaultSource || 'webhook', defaultTags || []]
  );
  return r.rows[0];
}

// Server-side lookup only — never exposed by company_id, only by the token
// itself, so knowing a company_id never lets you enumerate its webhooks.
async function getByToken(token) {
  const r = await query(`SELECT * FROM lead_webhooks WHERE token=$1`, [token]);
  return r.rows[0] || null;
}

async function touch(id) {
  await query(`UPDATE lead_webhooks SET request_count = request_count + 1, last_used_at = now() WHERE id=$1`, [id]);
}

async function update(companyId, id, { label, enabled, defaultSource, defaultTags }) {
  const sets = [], params = []; let i = 1;
  if (label !== undefined) { sets.push(`label=$${i++}`); params.push(label); }
  if (enabled !== undefined) { sets.push(`enabled=$${i++}`); params.push(!!enabled); }
  if (defaultSource !== undefined) { sets.push(`default_source=$${i++}`); params.push(defaultSource); }
  if (defaultTags !== undefined) { sets.push(`default_tags=$${i++}`); params.push(defaultTags); }
  if (!sets.length) return get(companyId, id);
  params.push(companyId, id);
  const r = await query(
    `UPDATE lead_webhooks SET ${sets.join(', ')}, updated_at=now() WHERE company_id=$${i++} AND id=$${i} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function get(companyId, id) {
  const r = await query(`SELECT * FROM lead_webhooks WHERE company_id=$1 AND id=$2`, [companyId, id]);
  return r.rows[0] || null;
}

async function regenerateToken(companyId, id) {
  const token = generateToken();
  const r = await query(
    `UPDATE lead_webhooks SET token=$3, updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING *`,
    [companyId, id, token]
  );
  return r.rows[0] || null;
}

async function remove(companyId, id) {
  const r = await query(`DELETE FROM lead_webhooks WHERE company_id=$1 AND id=$2 RETURNING id`, [companyId, id]);
  return r.rowCount;
}

module.exports = { list, create, getByToken, touch, update, get, regenerateToken, remove };
