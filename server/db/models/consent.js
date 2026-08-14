'use strict';
// ─── DAL: channel consent ─────────────────────────────────────────────────────
// Provable per-contact, per-channel consent. consent_type is a one-way ladder:
// conversational < transactional < marketing. A send may never use a weaker
// consent than the message category requires (satisfies(...) enforces this).
const { query } = require('../index');

const RANK = { conversational: 1, transactional: 2, marketing: 3 };

// Does a granted consent of `have` cover a message needing `need`?
function satisfies(have, need) {
  if (!have) return false;
  return (RANK[have] || 0) >= (RANK[need] || 99);
}

async function get(companyId, contactId, channel, program = 'default') {
  const r = await query(
    `SELECT * FROM channel_consent
      WHERE company_id=$1 AND contact_id=$2 AND channel=$3 AND program=$4 LIMIT 1`,
    [companyId, contactId, channel, program]
  );
  return r.rows[0] || null;
}

// Record/upsert consent. Never silently downgrades a stronger existing grant.
async function record(companyId, contactId, channel, data = {}) {
  const program = data.program || 'default';
  const existing = await get(companyId, contactId, channel, program);
  const type = data.consent_type || 'transactional';
  // keep the stronger consent_type if one already exists and is granted
  const effectiveType = (existing && existing.status === 'granted' && (RANK[existing.consent_type] || 0) > (RANK[type] || 0))
    ? existing.consent_type : type;
  const r = await query(
    `INSERT INTO channel_consent
       (company_id, contact_id, channel, program, status, consent_type, method, source,
        disclosure_version, business_named, granted_at, updated_at)
     VALUES ($1,$2,$3,$4,'granted',$5,$6,$7,$8,$9, now(), now())
     ON CONFLICT (contact_id, channel, program) DO UPDATE SET
       status='granted', consent_type=$5, method=COALESCE($6, channel_consent.method),
       source=COALESCE($7, channel_consent.source),
       disclosure_version=COALESCE($8, channel_consent.disclosure_version),
       business_named=COALESCE($9, channel_consent.business_named),
       granted_at=COALESCE(channel_consent.granted_at, now()), revoked_at=NULL, updated_at=now()
     RETURNING *`,
    [companyId, contactId, channel, program, effectiveType, data.method || null, data.source || null,
     data.disclosure_version || null, data.business_named || null]
  );
  return r.rows[0];
}

async function revoke(companyId, contactId, channel, program = 'default') {
  const r = await query(
    `UPDATE channel_consent SET status='revoked', revoked_at=now(), updated_at=now()
      WHERE company_id=$1 AND contact_id=$2 AND channel=$3 AND program=$4 RETURNING *`,
    [companyId, contactId, channel, program]
  );
  return r.rows[0] || null;
}

// True if the contact has granted consent covering `neededType` on this channel.
async function has(companyId, contactId, channel, neededType, program = 'default') {
  const c = await get(companyId, contactId, channel, program);
  return !!(c && c.status === 'granted' && satisfies(c.consent_type, neededType));
}

async function listForContact(companyId, contactId) {
  const r = await query(
    `SELECT * FROM channel_consent WHERE company_id=$1 AND contact_id=$2 ORDER BY channel, program`,
    [companyId, contactId]
  );
  return r.rows;
}

module.exports = { get, record, revoke, has, satisfies, listForContact, RANK };
