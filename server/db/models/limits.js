'use strict';
// ─── DAL: Per-tenant limits/quotas/suppression (GOAL A5) ───────────────────────
// suppressions + tenant_channel_limits (migration 015). Every company-scoped
// function requires companyId and throws without it — same "fail loud, never
// silently unscoped" contract established for contacts.js in A1. Consumed by
// B3 (dispatcher): before firing a scheduled_action, check isSuppressed,
// isQuietHours, and checkRateLimit.
const { query, getClient } = require('../index');
const contactDb = require('./contacts');

// ─── suppressions ──────────────────────────────────────────────────────────

// channel=null suppresses every channel for this contact (broadcast idiom,
// mirrors prospect_inbox's NULL target_engine). Runs inside a transaction
// holding a per-contact advisory lock (same pattern as tenants.js's alias-
// collision guard) so the insert + "clean up now-redundant channel-specific
// rows" DELETE are atomic together — without the lock, a concurrent
// channel-specific suppress() call could land between them and resurrect the
// global+specific coexistence this is meant to eliminate.
async function suppress(companyId, contactId, channel = null, reason = null) {
  if (!companyId) throw new Error('limits.suppress requires companyId');
  const contact = await contactDb.getById(contactId, companyId);
  if (!contact) return null;

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [contactId]);

    // Enforce "a global suppression is always the sole row" in BOTH
    // directions under the lock, not just one: a channel-specific request
    // arriving when a global row already exists is redundant — return the
    // existing global row instead of inserting a coexisting specific one
    // (closes the gap the other direction's cleanup, below, can't reach: a
    // specific suppress() arriving strictly AFTER a global one already
    // committed isn't "concurrent" with that commit, so only a check here,
    // not just a race guard, prevents the coexistence from reappearing).
    if (channel !== null) {
      const existingGlobal = await client.query(
        'SELECT * FROM suppressions WHERE company_id = $1 AND contact_id = $2 AND channel IS NULL',
        [companyId, contactId]
      );
      if (existingGlobal.rows[0]) {
        await client.query('COMMIT');
        return existingGlobal.rows[0];
      }
    }

    const inserted = await client.query(
      `INSERT INTO suppressions (company_id, contact_id, channel, reason) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING *`,
      [companyId, contactId, channel, reason]
    );
    const row = inserted.rows[0] || (
      channel === null
        ? (await client.query('SELECT * FROM suppressions WHERE company_id = $1 AND contact_id = $2 AND channel IS NULL', [companyId, contactId])).rows[0]
        : (await client.query('SELECT * FROM suppressions WHERE company_id = $1 AND contact_id = $2 AND channel = $3', [companyId, contactId, channel])).rows[0]
    );

    // A global (all-channel) suppression makes any channel-specific rows for
    // this contact redundant — clean them up so there's one authoritative
    // state instead of an unspecified coexistence (isSuppressed's OR-based
    // read was already correct either way, but a stale specific row
    // surviving a global suppress/unsuppress cycle is confusing state).
    if (channel === null) {
      await client.query('DELETE FROM suppressions WHERE company_id = $1 AND contact_id = $2 AND channel IS NOT NULL', [companyId, contactId]);
    }

    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// channel=null un-suppresses EVERYTHING for this contact (both the global
// row and any channel-specific ones) — symmetric with suppress(null)'s "all
// channels" meaning. A specific channel un-suppresses only that row.
async function unsuppress(companyId, contactId, channel = null) {
  if (!companyId) throw new Error('limits.unsuppress requires companyId');
  const result = channel === null
    ? await query('DELETE FROM suppressions WHERE company_id = $1 AND contact_id = $2 RETURNING *', [companyId, contactId])
    : await query('DELETE FROM suppressions WHERE company_id = $1 AND contact_id = $2 AND channel = $3 RETURNING *', [companyId, contactId, channel]);
  return result.rows[0] || null;
}

// True if this contact is suppressed either specifically on `channel` or
// globally (channel IS NULL row).
async function isSuppressed(companyId, contactId, channel) {
  if (!companyId) throw new Error('limits.isSuppressed requires companyId');
  const result = await query(
    `SELECT 1 FROM suppressions WHERE company_id = $1 AND contact_id = $2 AND (channel IS NULL OR channel = $3) LIMIT 1`,
    [companyId, contactId, channel]
  );
  return result.rows.length > 0;
}

async function listSuppressions(companyId, { contactId } = {}) {
  if (!companyId) throw new Error('limits.listSuppressions requires companyId');
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (contactId) { params.push(contactId); conditions.push(`contact_id = $${params.length}`); }
  const result = await query(
    `SELECT * FROM suppressions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

// ─── tenant_channel_limits ──────────────────────────────────────────────────

const DEFAULT_LIMITS = Object.freeze({
  max_per_hour: null, max_per_day: null,
  quiet_hours_start: null, quiet_hours_end: null,
  timezone: 'UTC',
});

// Absent row is a valid, permissive state ("no limit configured") — returns
// defaults rather than null so callers never need a separate null-check.
async function getChannelLimits(companyId, channel) {
  if (!companyId) throw new Error('limits.getChannelLimits requires companyId');
  const result = await query(
    'SELECT * FROM tenant_channel_limits WHERE company_id = $1 AND channel = $2',
    [companyId, channel]
  );
  return result.rows[0] || { company_id: companyId, channel, ...DEFAULT_LIMITS };
}

// Partial update: an omitted (`undefined`) field keeps its existing value; an
// explicit `null` clears it. Same undefined-vs-provided convention as
// contactDb.update/sequences.updateEnrollment — a caller updating just
// maxPerHour must not silently wipe an existing quiet-hours config.
async function setChannelLimits(companyId, channel, { maxPerHour, maxPerDay, quietHoursStart, quietHoursEnd, timezone } = {}) {
  if (!companyId) throw new Error('limits.setChannelLimits requires companyId');
  const existing = await query('SELECT * FROM tenant_channel_limits WHERE company_id = $1 AND channel = $2', [companyId, channel]);
  const current = existing.rows[0] || { max_per_hour: null, max_per_day: null, quiet_hours_start: null, quiet_hours_end: null, timezone: 'UTC' };
  const merged = {
    max_per_hour: maxPerHour !== undefined ? maxPerHour : current.max_per_hour,
    max_per_day: maxPerDay !== undefined ? maxPerDay : current.max_per_day,
    quiet_hours_start: quietHoursStart !== undefined ? quietHoursStart : current.quiet_hours_start,
    quiet_hours_end: quietHoursEnd !== undefined ? quietHoursEnd : current.quiet_hours_end,
    timezone: timezone !== undefined ? timezone : current.timezone,
  };
  const result = await query(
    `INSERT INTO tenant_channel_limits (company_id, channel, max_per_hour, max_per_day, quiet_hours_start, quiet_hours_end, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id, channel) DO UPDATE SET
       max_per_hour = EXCLUDED.max_per_hour,
       max_per_day = EXCLUDED.max_per_day,
       quiet_hours_start = EXCLUDED.quiet_hours_start,
       quiet_hours_end = EXCLUDED.quiet_hours_end,
       timezone = EXCLUDED.timezone,
       updated_at = now()
     RETURNING *`,
    [companyId, channel, merged.max_per_hour, merged.max_per_day, merged.quiet_hours_start, merged.quiet_hours_end, merged.timezone]
  );
  return result.rows[0];
}

// Current local hour (0-23) in `timezone`, using Intl — no extra dependency.
function currentHourInTimezone(timezone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).formatToParts(at);
  let hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  if (hour === 24) hour = 0; // some locales render midnight as "24"
  return hour;
}

// False (never quiet) when quiet hours aren't configured for this channel —
// permissive default, matching getChannelLimits' "absent = no limit" posture.
async function isQuietHours(companyId, channel, at = new Date()) {
  if (!companyId) throw new Error('limits.isQuietHours requires companyId');
  const limits = await getChannelLimits(companyId, channel);
  if (limits.quiet_hours_start == null || limits.quiet_hours_end == null) return false;
  const hour = currentHourInTimezone(limits.timezone, at);
  const { quiet_hours_start: start, quiet_hours_end: end } = limits;
  return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end); // wraps midnight, e.g. 22->6
}

// Counts SENT scheduled_actions in the trailing hour/day for (companyId,
// channel) and compares against configured caps. Counts against `sent_at`
// (migration 016) — a dedicated, set-exactly-once-at-send timestamp — not
// `updated_at`, which is a generic last-touched column with no contract that
// it changes only at the sent transition (a future retry/backfill/admin-edit
// touching updated_at on an already-sent row would otherwise re-enter it into
// the rate window and corrupt the count). No separate counter table —
// scheduled_actions already carries the timestamp B3 needs.
//
// NOT ATOMIC — this is read-only advice, not a reservation. B3 (not yet
// built) MUST wrap "check, then mark sent" in either a transaction holding
// `pg_advisory_xact_lock(hashtext(companyId || channel))` or an atomic
// counter/increment-and-check, or N concurrent dispatcher workers can each
// observe "under cap" and all fire, exceeding max_per_hour/max_per_day. This
// function alone cannot prevent that race — it has no way to "hold" a slot.
async function checkRateLimit(companyId, channel, at = new Date()) {
  if (!companyId) throw new Error('limits.checkRateLimit requires companyId');
  const limits = await getChannelLimits(companyId, channel);
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE sent_at > $3::timestamptz - interval '1 hour')::int AS hourly,
       COUNT(*) FILTER (WHERE sent_at > $3::timestamptz - interval '1 day')::int  AS daily
     FROM scheduled_actions
     WHERE company_id = $1 AND channel = $2 AND status = 'sent' AND sent_at IS NOT NULL`,
    [companyId, channel, at.toISOString()]
  );
  const hourlyCount = counts.rows[0].hourly;
  const dailyCount = counts.rows[0].daily;
  const hourlyOk = limits.max_per_hour == null || hourlyCount < limits.max_per_hour;
  const dailyOk = limits.max_per_day == null || dailyCount < limits.max_per_day;
  return {
    allowed: hourlyOk && dailyOk,
    hourlyCount, dailyCount,
    hourlyLimit: limits.max_per_hour, dailyLimit: limits.max_per_day,
  };
}

module.exports = {
  suppress, unsuppress, isSuppressed, listSuppressions,
  getChannelLimits, setChannelLimits, isQuietHours, checkRateLimit,
};
