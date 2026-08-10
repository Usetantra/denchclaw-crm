'use strict';
// ─── DAL: channel connections + senders ───────────────────────────────────────
// Per-company provider connections (encrypted secrets) and the connected senders
// (numbers) used per channel. Secrets are decrypted only inside getConnection()
// for server-side calls; they are never returned to the client.
const { query } = require('../index');
const box = require('../../lib/crypto-box');

// ── Connections ───────────────────────────────────────────────────────────────
async function upsertConnection(companyId, provider, { accountRef, credentials, status = 'connected' }) {
  const enc = credentials ? box.encryptJSON(credentials) : null;
  const r = await query(
    `INSERT INTO channel_connections (company_id, provider, account_ref, credentials_enc, status, verified_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, now(), now())
     ON CONFLICT (company_id, provider) DO UPDATE SET
       account_ref=COALESCE($3, channel_connections.account_ref),
       credentials_enc=COALESCE($4, channel_connections.credentials_enc),
       status=$5, verified_at=now(), last_error=NULL, updated_at=now()
     RETURNING id, company_id, provider, account_ref, status, verified_at`,
    [companyId, provider, accountRef || null, enc, status]
  );
  return r.rows[0];
}

// Returns the connection WITH decrypted credentials (server-side use only).
async function getConnection(companyId, provider) {
  const r = await query(
    `SELECT * FROM channel_connections WHERE company_id=$1 AND provider=$2 LIMIT 1`,
    [companyId, provider]
  );
  const row = r.rows[0];
  if (!row) return null;
  let credentials = null;
  try { credentials = row.credentials_enc ? box.decryptJSON(row.credentials_enc) : null; } catch (_e) {}
  return { ...row, credentials };
}

// Public (safe) view — never includes secrets.
async function listConnections(companyId) {
  const r = await query(
    `SELECT provider, account_ref, status, verified_at, last_error FROM channel_connections WHERE company_id=$1`,
    [companyId]
  );
  return r.rows;
}

async function disconnect(companyId, provider) {
  await query(
    `UPDATE channel_connections SET status='disconnected', credentials_enc=NULL, updated_at=now()
      WHERE company_id=$1 AND provider=$2`,
    [companyId, provider]
  );
  return true;
}

// ── Senders ───────────────────────────────────────────────────────────────────
async function addSender(companyId, s) {
  const r = await query(
    `INSERT INTO channel_senders
       (company_id, channel, provider, identifier, label, is_default, country,
        registration_status, messaging_service_sid, brand_id, campaign_id, dlt_entity_id, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (company_id, channel, identifier) DO UPDATE SET
       label=COALESCE($5, channel_senders.label), country=COALESCE($7, channel_senders.country),
       registration_status=COALESCE($8, channel_senders.registration_status),
       messaging_service_sid=COALESCE($9, channel_senders.messaging_service_sid),
       brand_id=COALESCE($10, channel_senders.brand_id), campaign_id=COALESCE($11, channel_senders.campaign_id),
       dlt_entity_id=COALESCE($12, channel_senders.dlt_entity_id), updated_at=now()
     RETURNING *`,
    [companyId, s.channel, s.provider || 'twilio', s.identifier, s.label || null, s.is_default === true,
     s.country || null, s.registration_status || 'pending', s.messaging_service_sid || null,
     s.brand_id || null, s.campaign_id || null, s.dlt_entity_id || null, JSON.stringify(s.metadata || {})]
  );
  return r.rows[0];
}

async function listSenders(companyId, channel) {
  const params = [companyId];
  let where = 'company_id=$1';
  if (channel) { params.push(channel); where += ` AND channel=$${params.length}`; }
  const r = await query(`SELECT * FROM channel_senders WHERE ${where} ORDER BY channel, is_default DESC, created_at`, params);
  return r.rows;
}

async function removeSender(companyId, id) {
  await query(`DELETE FROM channel_senders WHERE company_id=$1 AND id=$2`, [companyId, id]);
  return true;
}

async function updateSenderStatus(companyId, id, fields) {
  const allowed = ['registration_status', 'quality_rating', 'messaging_tier', 'trust_score', 'daily_cap',
    'messaging_service_sid', 'brand_id', 'campaign_id', 'dlt_entity_id', 'is_default', 'label'];
  const sets = [], params = []; let i = 1;
  for (const k of allowed) if (fields[k] !== undefined) { sets.push(`${k}=$${i++}`); params.push(fields[k]); }
  if (!sets.length) return null;
  params.push(companyId, id);
  const r = await query(`UPDATE channel_senders SET ${sets.join(', ')}, updated_at=now()
    WHERE company_id=$${i++} AND id=$${i} RETURNING *`, params);
  return r.rows[0] || null;
}

module.exports = { upsertConnection, getConnection, listConnections, disconnect,
  addSender, listSenders, removeSender, updateSenderStatus };
