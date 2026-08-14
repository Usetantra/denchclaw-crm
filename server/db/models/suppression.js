'use strict';
// ─── DAL: channel suppression (do-not-contact) ────────────────────────────────
// The source of truth for opt-outs. A hard pre-send gate: an active suppression
// (resubscribed_at IS NULL) blocks every send on that channel to that identifier.
// Identifiers are normalized (trim + lowercase) so lookups are stable.
const { query } = require('../index');

function norm(id) { return String(id || '').trim().toLowerCase(); }

// Add/refresh a suppression. Idempotent on (company, channel, identifier) while active.
async function add(companyId, channel, identifier, { reason = 'opt_out', scope = 'company', contactId = null, metadata = {} } = {}) {
  const r = await query(
    `INSERT INTO channel_suppression
       (company_id, channel, identifier, contact_id, reason, scope, metadata, suppressed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (company_id, channel, identifier) WHERE resubscribed_at IS NULL
     DO UPDATE SET reason=$5, scope=$6, metadata=channel_suppression.metadata || $7, suppressed_at=now()
     RETURNING *`,
    [companyId, channel, norm(identifier), contactId, reason, scope, JSON.stringify(metadata)]
  );
  return r.rows[0];
}

// True if there is an active suppression for this identifier on this channel.
async function isSuppressed(companyId, channel, identifier) {
  const r = await query(
    `SELECT 1 FROM channel_suppression
      WHERE company_id=$1 AND channel=$2 AND identifier=$3 AND resubscribed_at IS NULL LIMIT 1`,
    [companyId, channel, norm(identifier)]
  );
  return r.rowCount > 0;
}

// Re-subscribe (e.g. START keyword) — clears the active suppression.
async function resubscribe(companyId, channel, identifier) {
  const r = await query(
    `UPDATE channel_suppression SET resubscribed_at=now()
      WHERE company_id=$1 AND channel=$2 AND identifier=$3 AND resubscribed_at IS NULL RETURNING *`,
    [companyId, channel, norm(identifier)]
  );
  return r.rows[0] || null;
}

async function list(companyId, channel, { limit = 200, offset = 0 } = {}) {
  const params = [companyId];
  let where = 'company_id=$1 AND resubscribed_at IS NULL';
  if (channel) { params.push(channel); where += ` AND channel=$${params.length}`; }
  params.push(Math.min(limit, 500), offset);
  const r = await query(
    `SELECT * FROM channel_suppression WHERE ${where} ORDER BY suppressed_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows;
}

module.exports = { add, isSuppressed, resubscribe, list, norm };
