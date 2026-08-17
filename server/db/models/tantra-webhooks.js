'use strict';
// ─── DAL: Tantra outbound webhook receiver (migration 036) ─────────────────
// One row per company. The token in the URL is the whole auth story — see
// that migration's header for why (Tantra's webhook has no signature/key).
const crypto = require('crypto');
const { query } = require('../index');

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function get(companyId) {
  if (!companyId) throw new Error('tantraWebhooks.get requires companyId');
  const r = await query(`SELECT * FROM tantra_webhooks WHERE company_id=$1`, [companyId]);
  return r.rows[0] || null;
}

// Idempotent — a company only ever has one Tantra webhook row.
async function getOrCreate(companyId) {
  const existing = await get(companyId);
  if (existing) return existing;
  const token = generateToken();
  const r = await query(
    `INSERT INTO tantra_webhooks (company_id, token) VALUES ($1,$2)
     ON CONFLICT (company_id) DO NOTHING RETURNING *`,
    [companyId, token]
  );
  return r.rows[0] || await get(companyId);
}

// Server-side lookup only — never exposed by company_id, only by the token
// itself, matching lead-webhooks' posture.
async function getByToken(token) {
  const r = await query(`SELECT * FROM tantra_webhooks WHERE token=$1`, [token]);
  return r.rows[0] || null;
}

async function touch(id) {
  await query(`UPDATE tantra_webhooks SET request_count = request_count + 1, last_used_at = now() WHERE id=$1`, [id]);
}

async function update(companyId, { enabled, stageMap } = {}) {
  const sets = [], params = []; let i = 1;
  if (enabled !== undefined) { sets.push(`enabled=$${i++}`); params.push(!!enabled); }
  if (stageMap !== undefined) { sets.push(`stage_map=$${i++}`); params.push(JSON.stringify(stageMap || {})); }
  if (!sets.length) return get(companyId);
  params.push(companyId);
  const r = await query(
    `UPDATE tantra_webhooks SET ${sets.join(', ')}, updated_at=now() WHERE company_id=$${i} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function regenerateToken(companyId) {
  const token = generateToken();
  const r = await query(
    `UPDATE tantra_webhooks SET token=$2, updated_at=now() WHERE company_id=$1 RETURNING *`,
    [companyId, token]
  );
  return r.rows[0] || null;
}

module.exports = { get, getOrCreate, getByToken, touch, update, regenerateToken };
