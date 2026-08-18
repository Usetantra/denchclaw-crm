'use strict';
// ─── DAL: channel suppression (do-not-contact) ────────────────────────────────
// The source of truth for opt-outs. A hard pre-send gate: an active suppression
// (resubscribed_at IS NULL) blocks every send on that channel to that identifier.
// Identifiers are normalized (trim + lowercase) so lookups are stable.
const { query } = require('../index');

function norm(id) { return String(id || '').trim().toLowerCase(); }

// Add/refresh a suppression. Idempotent on (company, channel, identifier) while active.
async function add(companyId, channel, identifier, { reason = 'opt_out', scope = 'company', contactId = null, metadata = {} } = {}) {
  // Read BEFORE the upsert: the ON CONFLICT below cannot distinguish an insert
  // from a refresh in its RETURNING, and firing the workflow on a refresh would
  // re-enrol a contact every time an already-unsubscribed person texts STOP again.
  const alreadySuppressed = await isSuppressed(companyId, channel, identifier);
  const r = await query(
    `INSERT INTO channel_suppression
       (company_id, channel, identifier, contact_id, reason, scope, metadata, suppressed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (company_id, channel, identifier) WHERE resubscribed_at IS NULL
     DO UPDATE SET reason=$5, scope=$6, metadata=channel_suppression.metadata || $7, suppressed_at=now()
     RETURNING *`,
    [companyId, channel, norm(identifier), contactId, reason, scope, JSON.stringify(metadata)]
  );

  // Workflow trigger `unsubscribed` (migration 041). Fired from the MODEL, not
  // from the three routes that call it (compliance, Twilio STOP, Tantra
  // email.unsubscribed), because the model is the single door — wiring the
  // routes individually is how the tag trigger ended up missing the
  // contact-creation path, and a fourth caller added later would silently not
  // fire.
  //
  // Only on a genuinely NEW suppression: the ON CONFLICT above refreshes an
  // existing one, and re-running an opt-out that is already recorded must not
  // re-enrol someone into an unsubscribe workflow.
  const row = r.rows[0];
  if (row && !alreadySuppressed) {
    // `contact_id` is optional on this table and two of the three callers do not
    // have it (Twilio STOP knows only a phone number), so resolve by identifier
    // when it is absent — otherwise the trigger would fire for manual
    // unsubscribes and silently not for real ones.
    let cid = contactId || row.contact_id || null;
    if (!cid) cid = await resolveContactByIdentifier(companyId, channel, identifier);
    if (cid) require('../../lib/workflow-triggers').fire(companyId, cid, 'unsubscribed', { channel, reason });
  }
  return row;
}

// Lazy + defensive: a suppression must be recorded even if contact resolution
// fails. Returns null rather than throwing, and the trigger simply does not fire.
async function resolveContactByIdentifier(companyId, channel, identifier) {
  try {
    const v = norm(identifier);
    if (!v) return null;
    if (channel === 'email') {
      const r = await query(
        `SELECT id FROM contacts WHERE company_id=$1 AND deleted_at IS NULL AND lower(email)=$2 LIMIT 1`,
        [companyId, v]);
      return r.rows[0] ? r.rows[0].id : null;
    }
    const digits = v.replace(/\D/g, '');
    if (!digits) return null;
    const r = await query(
      `SELECT id FROM contacts
        WHERE company_id=$1 AND deleted_at IS NULL AND phone IS NOT NULL
          AND regexp_replace(phone, '[^0-9]', '', 'g') = $2
        ORDER BY created_at LIMIT 1`,
      [companyId, digits]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (_e) { return null; }
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
