'use strict';
// ─── DAL: multi-channel sequences (Goal B) ────────────────────────────────────
// Sequences + steps + enrollments + the dispatcher's scheduled-action queue. The
// scheduling model is "one step ahead": enrolling schedules step 1; completing a
// step schedules the next. This handles exit conditions naturally (nothing is
// pre-scheduled past the current step) and keeps the queue small. Everything is
// company_id-scoped.
const { query, getClient } = require('../index');

const SEQ_FIELDS = 'id, company_id, name, description, status, trigger_pipeline_key, trigger_stage, quiet_hours, entry_conditions, exit_conditions, allow_reenroll, metadata, created_at, updated_at';
const STEP_FIELDS = 'id, sequence_id, company_id, step_order, channel, delay_minutes, template_id, subject, body, category, conditions, metadata, created_at, updated_at';
const ENR_FIELDS = 'id, company_id, sequence_id, contact_id, status, current_step, enrolled_at, next_action_at, completed_at, exit_reason, enrolled_by, metadata, created_at, updated_at';

// ── Sequences ─────────────────────────────────────────────────────────────────
async function list(companyId, { status, includeArchived = false } = {}) {
  const params = [companyId]; let where = 'company_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (!includeArchived) where += ` AND status <> 'archived'`;
  const r = await query(`SELECT ${SEQ_FIELDS} FROM sequences WHERE ${where} ORDER BY updated_at DESC`, params);
  return r.rows;
}

async function get(companyId, id) {
  const r = await query(`SELECT ${SEQ_FIELDS} FROM sequences WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  const seq = r.rows[0];
  if (!seq) return null;
  seq.steps = await listSteps(companyId, id);
  return seq;
}

async function create(companyId, s) {
  const r = await query(
    `INSERT INTO sequences
       (company_id, name, description, status, trigger_pipeline_key, trigger_stage,
        quiet_hours, entry_conditions, exit_conditions, allow_reenroll, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     RETURNING ${SEQ_FIELDS}`,
    [companyId, s.name, s.description || null, s.status || 'draft',
     s.trigger_pipeline_key || null, s.trigger_stage || null,
     JSON.stringify(s.quiet_hours || {}), JSON.stringify(s.entry_conditions || {}),
     JSON.stringify(s.exit_conditions || {}), s.allow_reenroll === true,
     JSON.stringify(s.metadata || {})]
  );
  const seq = r.rows[0];
  if (Array.isArray(s.steps)) seq.steps = await setSteps(companyId, seq.id, s.steps);
  else seq.steps = [];
  return seq;
}

const SEQ_PATCH_COLS = ['name', 'description', 'status', 'trigger_pipeline_key', 'trigger_stage', 'quiet_hours', 'entry_conditions', 'exit_conditions', 'allow_reenroll', 'metadata'];
async function update(companyId, id, patch) {
  const sets = [], params = []; let i = 1;
  for (const col of SEQ_PATCH_COLS) {
    if (patch[col] === undefined) continue;
    const isJson = ['quiet_hours', 'entry_conditions', 'exit_conditions', 'metadata'].includes(col);
    sets.push(`${col} = $${i++}`);
    params.push(isJson ? JSON.stringify(patch[col]) : patch[col]);
  }
  if (sets.length) {
    params.push(companyId, id);
    await query(`UPDATE sequences SET ${sets.join(', ')}, updated_at = now() WHERE company_id = $${i++} AND id = $${i}`, params);
  }
  if (Array.isArray(patch.steps)) await setSteps(companyId, id, patch.steps);
  return get(companyId, id);
}

async function setStatus(companyId, id, status) {
  const r = await query(`UPDATE sequences SET status = $1, updated_at = now() WHERE company_id = $2 AND id = $3 RETURNING ${SEQ_FIELDS}`, [status, companyId, id]);
  return r.rows[0] || null;
}

async function remove(companyId, id) {
  await query(`DELETE FROM sequences WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return true;
}

// ── Steps ─────────────────────────────────────────────────────────────────────
async function listSteps(companyId, sequenceId) {
  const r = await query(`SELECT ${STEP_FIELDS} FROM sequence_steps WHERE company_id = $1 AND sequence_id = $2 ORDER BY step_order ASC`, [companyId, sequenceId]);
  return r.rows;
}

// Replace all steps for a sequence, renumbered 1..n in the given order (atomic).
async function setSteps(companyId, sequenceId, steps) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM sequence_steps WHERE company_id = $1 AND sequence_id = $2`, [companyId, sequenceId]);
    let order = 1;
    for (const s of steps) {
      await client.query(
        `INSERT INTO sequence_steps
           (sequence_id, company_id, step_order, channel, delay_minutes, template_id, subject, body, category, conditions, metadata, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
        [sequenceId, companyId, order++, s.channel, Math.max(0, parseInt(s.delay_minutes, 10) || 0),
         s.template_id || null, s.subject || null, s.body || null, s.category || null,
         JSON.stringify(s.conditions || {}), JSON.stringify(s.metadata || {})]
      );
    }
    await client.query('UPDATE sequences SET updated_at = now() WHERE company_id = $1 AND id = $2', [companyId, sequenceId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
  return listSteps(companyId, sequenceId);
}

// ── Enrollments ───────────────────────────────────────────────────────────────
async function listEnrollments(companyId, { sequenceId, contactId, status } = {}) {
  const params = [companyId]; let where = 'company_id = $1';
  if (sequenceId) { params.push(sequenceId); where += ` AND sequence_id = $${params.length}`; }
  if (contactId) { params.push(contactId); where += ` AND contact_id = $${params.length}`; }
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  const r = await query(`SELECT ${ENR_FIELDS} FROM sequence_enrollments WHERE ${where} ORDER BY updated_at DESC LIMIT 500`, params);
  return r.rows;
}

async function getEnrollment(companyId, id) {
  const r = await query(`SELECT ${ENR_FIELDS} FROM sequence_enrollments WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return r.rows[0] || null;
}

async function getAction(companyId, id) {
  const r = await query(`SELECT * FROM sequence_scheduled_actions WHERE company_id = $1 AND id = $2 LIMIT 1`, [companyId, id]);
  return r.rows[0] || null;
}

// Enroll a contact and schedule step 1. Returns { enrollment, created }. Respects
// the active-uniqueness index and the sequence's allow_reenroll policy. Only
// enrolls into an ACTIVE sequence that has at least one step.
async function enroll(companyId, sequenceId, contactId, { enrolledBy = 'api' } = {}) {
  const seq = await get(companyId, sequenceId);
  if (!seq) return { enrollment: null, created: false, reason: 'sequence_not_found' };
  if (seq.status !== 'active') return { enrollment: null, created: false, reason: 'sequence_not_active' };
  if (!seq.steps.length) return { enrollment: null, created: false, reason: 'sequence_has_no_steps' };

  const active = await query(
    `SELECT ${ENR_FIELDS} FROM sequence_enrollments WHERE company_id = $1 AND sequence_id = $2 AND contact_id = $3 AND status = 'active' LIMIT 1`,
    [companyId, sequenceId, contactId]
  );
  if (active.rows[0]) return { enrollment: active.rows[0], created: false, reason: 'already_active' };

  if (!seq.allow_reenroll) {
    const prior = await query(
      `SELECT 1 FROM sequence_enrollments WHERE company_id = $1 AND sequence_id = $2 AND contact_id = $3 LIMIT 1`,
      [companyId, sequenceId, contactId]
    );
    if (prior.rows[0]) return { enrollment: null, created: false, reason: 'reenroll_disabled' };
  }

  const ins = await query(
    `INSERT INTO sequence_enrollments (company_id, sequence_id, contact_id, status, current_step, enrolled_by, updated_at)
     VALUES ($1,$2,$3,'active',0,$4, now()) RETURNING ${ENR_FIELDS}`,
    [companyId, sequenceId, contactId, enrolledBy]
  );
  const enrollment = ins.rows[0];
  await scheduleNextStep(companyId, enrollment, seq);
  return { enrollment: await getEnrollment(companyId, enrollment.id), created: true };
}

// Exit an enrollment (reply / stage change / suppression / manual). Cancels any
// pending scheduled actions so the dispatcher won't fire them.
async function exitEnrollment(companyId, enrollmentId, reason = 'manual') {
  await query(
    `UPDATE sequence_scheduled_actions SET status = 'canceled', updated_at = now()
      WHERE company_id = $1 AND enrollment_id = $2 AND status = 'pending'`,
    [companyId, enrollmentId]
  );
  const r = await query(
    `UPDATE sequence_enrollments SET status = 'exited', exit_reason = $1, next_action_at = NULL, updated_at = now()
      WHERE company_id = $2 AND id = $3 AND status IN ('active','paused') RETURNING ${ENR_FIELDS}`,
    [reason, companyId, enrollmentId]
  );
  return r.rows[0] || null;
}

// Exit every active enrollment for a contact (used by reply/stage-change/opt-out
// hooks). Optionally limit to one sequence.
async function exitContact(companyId, contactId, reason, { sequenceId } = {}) {
  const params = [companyId, contactId]; let where = 'company_id = $1 AND contact_id = $2 AND status = \'active\'';
  if (sequenceId) { params.push(sequenceId); where += ` AND sequence_id = $${params.length}`; }
  const rows = (await query(`SELECT id FROM sequence_enrollments WHERE ${where}`, params)).rows;
  for (const row of rows) await exitEnrollment(companyId, row.id, reason);
  return rows.length;
}

// ── Scheduling (dispatcher support) ───────────────────────────────────────────
// Schedule the enrollment's NEXT step, or complete the enrollment if none remain.
// Idempotent via the dedupe_key unique index (a retried tick won't double-insert).
async function scheduleNextStep(companyId, enrollment, seq) {
  const sequence = seq || await get(companyId, enrollment.sequence_id);
  const nextOrder = (enrollment.current_step || 0) + 1;
  const step = (sequence.steps || []).find(s => s.step_order === nextOrder);
  if (!step) {
    await query(
      `UPDATE sequence_enrollments SET status = 'completed', completed_at = now(), next_action_at = NULL, exit_reason = 'finished', updated_at = now()
        WHERE company_id = $1 AND id = $2 AND status = 'active'`,
      [companyId, enrollment.id]
    );
    return null;
  }
  const runAt = `now() + ($1 || ' minutes')::interval`;
  const dedupe = `${companyId}:${enrollment.id}:${step.step_order}`;
  const r = await query(
    `INSERT INTO sequence_scheduled_actions
       (company_id, enrollment_id, sequence_id, step_id, contact_id, step_order, channel, run_at, status, dedupe_key, updated_at)
     VALUES ($2,$3,$4,$5,$6,$7,$8, ${runAt}, 'pending', $9, now())
     ON CONFLICT (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, run_at`,
    [String(step.delay_minutes || 0), companyId, enrollment.id, sequence.id, step.id,
     enrollment.contact_id, step.step_order, step.channel, dedupe]
  );
  await query(
    `UPDATE sequence_enrollments SET next_action_at = (now() + ($1 || ' minutes')::interval), updated_at = now()
      WHERE company_id = $2 AND id = $3`,
    [String(step.delay_minutes || 0), companyId, enrollment.id]
  );
  return r.rows[0] || null;
}

// Atomically claim up to `limit` due, pending actions (FOR UPDATE SKIP LOCKED so
// concurrent claimers never grab the same row). Marks them in-flight (claimed_at).
// Options scope the claim by channel: includeChannels (only these — the executor
// job API) or excludeChannels (everything but these — the built-in dispatcher
// skipping externally-executed channels). Returns the claimed rows.
async function claimDueActions(opts = {}) {
  const { limit = 20, includeChannels = null, excludeChannels = null, company = null } = typeof opts === 'number' ? { limit: opts } : opts;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const params = []; let where = `status = 'pending' AND run_at <= now()`;
    if (company) { params.push(company); where += ` AND company_id = $${params.length}`; }
    if (includeChannels && includeChannels.length) { params.push(includeChannels); where += ` AND channel = ANY($${params.length})`; }
    if (excludeChannels && excludeChannels.length) { params.push(excludeChannels); where += ` AND channel <> ALL($${params.length})`; }
    params.push(limit);
    const due = await client.query(
      `SELECT id FROM sequence_scheduled_actions
        WHERE ${where}
        ORDER BY run_at ASC
        LIMIT $${params.length} FOR UPDATE SKIP LOCKED`,
      params
    );
    const ids = due.rows.map(r => r.id);
    if (!ids.length) { await client.query('COMMIT'); return []; }
    const claimed = await client.query(
      `UPDATE sequence_scheduled_actions SET status = 'claimed', claimed_at = now(), updated_at = now()
        WHERE id = ANY($1) RETURNING *`,
      [ids]
    );
    await client.query('COMMIT');
    return claimed.rows;
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
}

// Record an action's TERMINAL outcome (sent | skipped | failed). Any terminal
// outcome advances the enrollment to this step and schedules the next one, so a
// single un-sendable step (blocked by the gate, or failed past retries) never
// freezes a contact mid-drip — the outcome is recorded for visibility either way.
async function completeAction(companyId, action, { status, result, error } = {}) {
  await query(
    `UPDATE sequence_scheduled_actions SET status = $1, result = $2, last_error = $3,
        sent_at = CASE WHEN $1 = 'sent' THEN now() ELSE sent_at END, updated_at = now()
      WHERE company_id = $4 AND id = $5`,
    [status, JSON.stringify(result || {}), error || null, companyId, action.id]
  );
  const enr = await getEnrollment(companyId, action.enrollment_id);
  if (enr && enr.status === 'active' && action.step_order > enr.current_step) {
    await query(`UPDATE sequence_enrollments SET current_step = $1, updated_at = now() WHERE company_id = $2 AND id = $3`,
      [action.step_order, companyId, enr.id]);
    const fresh = await getEnrollment(companyId, enr.id);
    await scheduleNextStep(companyId, fresh);
  }
  return true;
}

// Re-queue an action for a later retry (transient send failure). Counts an attempt
// and does NOT advance the enrollment — the same step fires again after `minutes`.
async function retryAction(companyId, actionId, minutes, error) {
  await query(
    `UPDATE sequence_scheduled_actions
        SET status = 'pending', attempts = attempts + 1, last_error = $1, claimed_at = NULL,
            run_at = now() + ($2 || ' minutes')::interval, updated_at = now()
      WHERE company_id = $3 AND id = $4`,
    [error || null, String(minutes), companyId, actionId]
  );
  return true;
}

// Recover jobs claimed by a worker/executor that died before reporting a result:
// after `minutes`, a still-claimed action returns to pending for re-claim.
async function sweepStaleClaims(minutes = 15) {
  const r = await query(
    `UPDATE sequence_scheduled_actions SET status = 'pending', claimed_at = NULL, updated_at = now()
      WHERE status = 'claimed' AND claimed_at < now() - ($1 || ' minutes')::interval`,
    [String(minutes)]
  );
  return r.rowCount || 0;
}

// Defer an action without consuming a retry attempt (e.g. quiet hours). The step
// stays pending and fires once `minutes` have passed.
async function deferAction(companyId, actionId, minutes) {
  await query(
    `UPDATE sequence_scheduled_actions
        SET status = 'pending', claimed_at = NULL,
            run_at = now() + ($1 || ' minutes')::interval, updated_at = now()
      WHERE company_id = $2 AND id = $3`,
    [String(minutes), companyId, actionId]
  );
  return true;
}

// Active sequences whose trigger matches a stage entry (B2 lookup). A NULL
// trigger_pipeline_key is a wildcard — it fires for any pipeline on that stage.
async function activeForStageTrigger(companyId, pipelineKey, stage) {
  const r = await query(
    `SELECT ${SEQ_FIELDS} FROM sequences
      WHERE company_id = $1 AND status = 'active' AND trigger_stage = $2
        AND (trigger_pipeline_key = $3 OR trigger_pipeline_key IS NULL)`,
    [companyId, stage, pipelineKey || null]
  );
  return r.rows;
}

module.exports = {
  list, get, create, update, setStatus, remove,
  listSteps, setSteps,
  listEnrollments, getEnrollment, getAction, enroll, exitEnrollment, exitContact,
  scheduleNextStep, claimDueActions, completeAction, retryAction, deferAction, sweepStaleClaims, activeForStageTrigger,
};
