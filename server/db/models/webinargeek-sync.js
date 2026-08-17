'use strict';
// ─── DAL: WebinarGeek sync dedupe state (migration 037) ────────────────────
const { query } = require('../index');

async function getState(companyId, subscriptionId) {
  const r = await query(
    `SELECT * FROM webinargeek_synced_subscriptions WHERE company_id=$1 AND subscription_id=$2`,
    [companyId, subscriptionId]
  );
  return r.rows[0] || null;
}

async function upsertState(companyId, subscriptionId, { contactId, watched }) {
  const r = await query(
    `INSERT INTO webinargeek_synced_subscriptions (company_id, subscription_id, contact_id, watched)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, subscription_id) DO UPDATE SET watched=$4, contact_id=$3, synced_at=now()
     RETURNING *`,
    [companyId, subscriptionId, contactId || null, !!watched]
  );
  return r.rows[0];
}

module.exports = { getState, upsertState };
