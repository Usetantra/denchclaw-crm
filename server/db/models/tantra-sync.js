'use strict';
// ─── DAL: Tantra mirror state (migration 039) ────────────────────────────────
// External identities, sweep watermarks, the webhook nudge queue and the
// two-way contact sync ledger. Every query is company_id-scoped on BOTH sides
// of every join — the same rule inbox.js states and for the same reason: this
// code fans out across contacts, conversations and messages, and a transitively
// safe join is one refactor away from being a cross-tenant leak.
const crypto = require('crypto');
const { query } = require('../index');

// ─── external identities ─────────────────────────────────────────────────────

// Link an external handle to a CRM contact. Idempotent on
// (company_id, system, kind, value).
//
// A conflict here is NOT benign and is not silently overwritten: it means two
// CRM contacts claim one external handle, which is the mis-merge this table
// exists to catch. The existing row wins and the caller is told, so a heuristic
// match can be reviewed instead of quietly repointing a conversation at a
// different person.
async function linkIdentity(companyId, contactId, { system = 'tantra', kind, value, confidence = 'exact', linkedBy = 'sync', metadata = {} }) {
  if (!companyId || !contactId || !kind || !value) {
    throw new Error('tantraSync.linkIdentity requires companyId, contactId, kind and value');
  }
  const r = await query(
    `INSERT INTO external_identities (company_id, contact_id, system, kind, value, confidence, linked_by, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id, system, kind, value) DO NOTHING
     RETURNING *`,
    [companyId, contactId, system, kind, value, confidence, linkedBy, JSON.stringify(metadata || {})]
  );
  if (r.rows[0]) return { identity: r.rows[0], created: true, conflict: false };
  const existing = await findIdentity(companyId, kind, value, system);
  return {
    identity: existing,
    created: false,
    conflict: !!existing && existing.contact_id !== contactId,
  };
}

async function findIdentity(companyId, kind, value, system = 'tantra') {
  if (!companyId || !kind || !value) return null;
  const r = await query(
    `SELECT * FROM external_identities
      WHERE company_id=$1 AND system=$2 AND kind=$3 AND value=$4 LIMIT 1`,
    [companyId, system, kind, value]
  );
  return r.rows[0] || null;
}

async function listIdentitiesForContact(companyId, contactId, system = 'tantra') {
  const r = await query(
    `SELECT * FROM external_identities
      WHERE company_id=$1 AND contact_id=$2 AND system=$3 ORDER BY created_at`,
    [companyId, contactId, system]
  );
  return r.rows;
}

// Links made by the last-10-digit phone fallback, for operator review. This is
// the review queue tantra.md §3 argues the CRM needs and Tantra does not have.
async function listHeuristicLinks(companyId, { limit = 100 } = {}) {
  const r = await query(
    `SELECT ei.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
       FROM external_identities ei
       JOIN contacts c ON c.id = ei.contact_id AND c.company_id = ei.company_id
      WHERE ei.company_id=$1 AND ei.confidence='heuristic'
      ORDER BY ei.created_at DESC LIMIT $2`,
    [companyId, Math.min(limit, 500)]
  );
  return r.rows;
}

// ─── sync state ──────────────────────────────────────────────────────────────

async function getState(companyId) {
  const r = await query(`SELECT * FROM tantra_sync_state WHERE company_id=$1`, [companyId]);
  return r.rows[0] || null;
}

async function getOrCreateState(companyId) {
  const existing = await getState(companyId);
  if (existing) return existing;
  const r = await query(
    `INSERT INTO tantra_sync_state (company_id) VALUES ($1)
     ON CONFLICT (company_id) DO NOTHING RETURNING *`,
    [companyId]
  );
  return r.rows[0] || await getState(companyId);
}

// The watermark only ever moves FORWARD. A sweep that reads an older page must
// not rewind it, or the next sweep re-walks ground it already covered — and
// worse, a failed partial sweep could park the watermark behind reality
// permanently.
async function advanceWatermark(companyId, throughIso) {
  if (!throughIso) return getState(companyId);
  const r = await query(
    `UPDATE tantra_sync_state
        SET threads_synced_through = GREATEST(COALESCE(threads_synced_through, 'epoch'::timestamptz), $2::timestamptz),
            last_sweep_at = now(), last_error = NULL, updated_at = now()
      WHERE company_id=$1 RETURNING *`,
    [companyId, throughIso]
  );
  return r.rows[0] || null;
}

async function recordSweep(companyId, { error = null, stats = null, backfillCursorPage, backfillComplete } = {}) {
  const sets = [`last_sweep_at = now()`, `updated_at = now()`];
  const params = [companyId];
  let i = 2;
  sets.push(`last_error = $${i++}`); params.push(error);
  if (stats !== null && stats !== undefined) { sets.push(`stats = $${i++}`); params.push(JSON.stringify(stats)); }
  if (backfillCursorPage !== undefined) { sets.push(`backfill_cursor_page = $${i++}`); params.push(backfillCursorPage); }
  if (backfillComplete !== undefined) { sets.push(`backfill_complete = $${i++}`); params.push(!!backfillComplete); }
  const r = await query(
    `UPDATE tantra_sync_state SET ${sets.join(', ')} WHERE company_id=$1 RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

// ─── nudges ──────────────────────────────────────────────────────────────────

// Park a webhook delivery as "go look at this thread". Returns created:false for
// a redelivery — Tantra retries with backoff and runs a recovery cron for
// orphans, so a repeat is expected traffic, not an anomaly.
async function enqueueNudge(companyId, { eventId = null, eventType = null, threadRef = null }) {
  const r = await query(
    `INSERT INTO tantra_nudges (company_id, event_id, event_type, thread_ref)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, event_id) WHERE event_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [companyId, eventId, eventType, threadRef]
  );
  if (r.rows[0]) return { nudge: r.rows[0], created: true };
  return { nudge: null, created: false };
}

async function claimNudges(companyId, limit = 25) {
  // FOR UPDATE SKIP LOCKED so two concurrent ticks cannot claim the same row.
  const r = await query(
    `UPDATE tantra_nudges SET status='done', attempts = attempts + 1, processed_at = now()
      WHERE id IN (
        SELECT id FROM tantra_nudges
         WHERE company_id=$1 AND status='pending'
         ORDER BY created_at LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [companyId, Math.min(limit, 200)]
  );
  return r.rows;
}

async function failNudge(id, message) {
  await query(
    `UPDATE tantra_nudges SET status='failed', last_error=$2, processed_at=now() WHERE id=$1`,
    [id, String(message || '').slice(0, 500)]
  );
}

async function countPendingNudges(companyId) {
  const r = await query(
    `SELECT count(*)::int AS n FROM tantra_nudges WHERE company_id=$1 AND status='pending'`,
    [companyId]
  );
  return r.rows[0] ? r.rows[0].n : 0;
}

// ─── two-way contact sync ledger ─────────────────────────────────────────────

function hashValue(v) {
  return crypto.createHash('sha256').update(String(v === undefined || v === null ? '' : v)).digest('hex').slice(0, 32);
}

async function recordSync(companyId, contactId, { direction, field, value, system = 'tantra' }) {
  await query(
    `INSERT INTO contact_sync_log (company_id, contact_id, system, direction, field, value_hash)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [companyId, contactId, system, direction, field, hashValue(value)]
  );
}

// The echo test. Returns true when the value we are about to PUSH is the very
// value we last PULLED for that field — i.e. pushing it would bounce Tantra's
// own change straight back, Tantra would emit a change event, and the two
// systems would oscillate indefinitely. Without this, two-way sync does not
// converge; it is the whole reason contact_sync_log exists.
async function isEcho(companyId, contactId, field, value, system = 'tantra') {
  const r = await query(
    `SELECT direction, value_hash FROM contact_sync_log
      WHERE company_id=$1 AND contact_id=$2 AND system=$3 AND field=$4
      ORDER BY at DESC LIMIT 1`,
    [companyId, contactId, system, field]
  );
  const last = r.rows[0];
  if (!last) return false;
  return last.direction === 'pull' && last.value_hash === hashValue(value);
}

module.exports = {
  linkIdentity, findIdentity, listIdentitiesForContact, listHeuristicLinks,
  getState, getOrCreateState, advanceWatermark, recordSweep,
  enqueueNudge, claimNudges, failNudge, countPendingNudges,
  recordSync, isEcho, hashValue,
};
