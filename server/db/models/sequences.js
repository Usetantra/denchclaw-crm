'use strict';
// ─── DAL: Sequences (GOAL B1 — data model only) ────────────────────────────────
// sequences/sequence_steps/enrollments/scheduled_actions (migration 014).
// Every company-scoped function requires companyId and throws without it —
// same "fail loud, never silently unscoped" contract established for
// contacts.js in A1. Every function that takes a foreign id belonging to
// another table (sequenceId, contactId, enrollmentId, stepId) verifies that
// id actually belongs to companyId before writing — passing companyId
// alongside a foreign id owned by a DIFFERENT tenant must never succeed.
// enrollForTriggerStage is B2's hook point (called from crm.js's /advance and
// legacy PATCH stage-change routes); B3 (dispatcher) and B7 (builder UI)
// still build on top of this file. No HTTP routes of its own.
const { query } = require('../index');
const contactDb = require('./contacts');

// ─── sequences ─────────────────────────────────────────────────────────────

async function createSequence({ companyId, name, pipelineKey = null, triggerStage = null }) {
  if (!companyId) throw new Error('sequences.createSequence requires companyId');
  if (!name) throw new Error('sequences.createSequence requires name');
  const result = await query(
    `INSERT INTO sequences (company_id, name, pipeline_key, trigger_stage)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [companyId, name, pipelineKey, triggerStage]
  );
  return result.rows[0];
}

async function getSequenceById(id, companyId) {
  if (!companyId) throw new Error('sequences.getSequenceById requires companyId');
  const result = await query('SELECT * FROM sequences WHERE id = $1 AND company_id = $2', [id, companyId]);
  return result.rows[0] || null;
}

async function listSequences(companyId, { status, pipelineKey } = {}) {
  if (!companyId) throw new Error('sequences.listSequences requires companyId');
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (pipelineKey) { params.push(pipelineKey); conditions.push(`pipeline_key = $${params.length}`); }
  const result = await query(
    `SELECT * FROM sequences WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

// GOAL B2 — stage-triggered enrollment. Called from the existing stage
// authority (POST /contacts/:id/advance, legacy PATCH stage) right after a
// REAL transition (not on an idempotent same-stage no-op) lands. Enrolls the
// contact into every active sequence configured to trigger on this exact
// (pipeline_key, stage) pair. Never throws into the caller's request path —
// a sequence-enrollment failure must not turn an already-persisted stage
// change into a 500, same posture as companies.js's identifyAndLink.
async function enrollForTriggerStage(companyId, contactId, pipelineKey, stage) {
  if (!companyId) throw new Error('sequences.enrollForTriggerStage requires companyId');
  try {
    const matches = await query(
      `SELECT id FROM sequences
        WHERE company_id = $1 AND status = 'active' AND pipeline_key = $2 AND trigger_stage = $3`,
      [companyId, pipelineKey, stage]
    );
    // Distinct sequences for the same contact never contend with each other
    // (the partial unique index is keyed on (sequence_id, contact_id)), so
    // running them concurrently is safe and keeps this out of the way of the
    // core stage-transition endpoint's latency budget when a tenant has
    // several sequences sharing one trigger_stage.
    const results = await Promise.all(
      matches.rows.map((seq) => enroll(companyId, { sequenceId: seq.id, contactId }))
    );
    return results
      .map((enrollment, i) => (enrollment ? { sequence_id: matches.rows[i].id, enrollment_id: enrollment.id } : null))
      .filter(Boolean);
  } catch (err) {
    // Never throws into the caller's request path — but a tenant with a
    // systematically broken sequence config (bad SQL state, FK drift) would
    // otherwise fail silently forever. Tag the log distinctly and include
    // enough context (company/pipeline/stage) to actually diagnose it,
    // instead of just the bare error message.
    console.error(
      `[CRM][sequence-enrollment-failure] company=${companyId} pipeline=${pipelineKey} stage=${stage}: ${err.message}`
    );
    return [];
  }
}

async function updateSequenceStatus(id, companyId, status) {
  if (!companyId) throw new Error('sequences.updateSequenceStatus requires companyId');
  const result = await query(
    `UPDATE sequences SET status = $1, updated_at = now()
     WHERE id = $2 AND company_id = $3 RETURNING *`,
    [status, id, companyId]
  );
  return result.rows[0] || null;
}

// ─── sequence_steps ────────────────────────────────────────────────────────
// Carries its own company_id (denormalized from sequence_id -> sequences,
// but stored anyway) — every other tenant-scoped table in this codebase does,
// and a future direct query against this table that forgets to join through
// sequences would otherwise have no defense-in-depth layer at all.

async function addStep(sequenceId, companyId, { stepOrder, channel, delaySeconds = 0, templateRef = null, entryConditions = {}, exitConditions = {} }) {
  if (!companyId) throw new Error('sequences.addStep requires companyId');
  const owned = await getSequenceById(sequenceId, companyId);
  if (!owned) return null;
  const result = await query(
    `INSERT INTO sequence_steps (company_id, sequence_id, step_order, channel, delay_seconds, template_ref, entry_conditions, exit_conditions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, sequenceId, stepOrder, channel, delaySeconds, templateRef, JSON.stringify(entryConditions), JSON.stringify(exitConditions)]
  );
  return result.rows[0];
}

async function listSteps(sequenceId, companyId) {
  if (!companyId) throw new Error('sequences.listSteps requires companyId');
  const result = await query(
    'SELECT * FROM sequence_steps WHERE sequence_id = $1 AND company_id = $2 ORDER BY step_order ASC',
    [sequenceId, companyId]
  );
  return result.rows;
}

// ─── enrollments ───────────────────────────────────────────────────────────

async function enroll(companyId, { sequenceId, contactId }) {
  if (!companyId) throw new Error('sequences.enroll requires companyId');
  // Both foreign ids must actually belong to this tenant — without this, a
  // caller could enroll ANY tenant's contact into ANY tenant's sequence by
  // passing companyId alongside a foreign sequenceId/contactId it doesn't own.
  const sequence = await getSequenceById(sequenceId, companyId);
  if (!sequence) return null;
  const contact = await contactDb.getById(contactId, companyId);
  if (!contact) return null;

  // Idempotent: re-enrolling a contact that already has an active enrollment
  // in this sequence returns the existing row rather than erroring — mirrors
  // prospect_inbox's enqueue idempotency posture (docs/API_CONTRACT.md). The
  // partial unique index on (sequence_id, contact_id) WHERE status='active'
  // is the real race guard; this SELECT is just the fast path for the common
  // sequential case.
  const existing = await query(
    `SELECT * FROM enrollments WHERE sequence_id = $1 AND contact_id = $2 AND company_id = $3 AND status = 'active'`,
    [sequenceId, contactId, companyId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const firstStep = await query(
    'SELECT id FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC LIMIT 1',
    [sequenceId]
  );

  try {
    const result = await query(
      `INSERT INTO enrollments (company_id, sequence_id, contact_id, current_step_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [companyId, sequenceId, contactId, firstStep.rows[0]?.id || null]
    );
    return result.rows[0];
  } catch (err) {
    // Two concurrent enroll() calls for the same (sequence, contact) both
    // pass the SELECT above (classic TOCTOU under READ COMMITTED) — the
    // partial unique index rejects the loser with 23505. Re-select and
    // return the winner rather than surfacing a raw constraint violation.
    if (err.code === '23505') {
      const winner = await query(
        `SELECT * FROM enrollments WHERE sequence_id = $1 AND contact_id = $2 AND company_id = $3 AND status = 'active'`,
        [sequenceId, contactId, companyId]
      );
      if (winner.rows[0]) return winner.rows[0];
    }
    throw err;
  }
}

async function getEnrollment(id, companyId) {
  if (!companyId) throw new Error('sequences.getEnrollment requires companyId');
  const result = await query('SELECT * FROM enrollments WHERE id = $1 AND company_id = $2', [id, companyId]);
  return result.rows[0] || null;
}

async function listEnrollments(companyId, { sequenceId, contactId, status } = {}) {
  if (!companyId) throw new Error('sequences.listEnrollments requires companyId');
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (sequenceId) { params.push(sequenceId); conditions.push(`sequence_id = $${params.length}`); }
  if (contactId) { params.push(contactId); conditions.push(`contact_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  const result = await query(
    `SELECT * FROM enrollments WHERE ${conditions.join(' AND ')} ORDER BY enrolled_at DESC`,
    params
  );
  return result.rows;
}

async function updateEnrollment(id, companyId, { status, currentStepId, exitReason } = {}) {
  if (!companyId) throw new Error('sequences.updateEnrollment requires companyId');
  // currentStepId must belong to the SAME sequence as this enrollment — a
  // caller could otherwise point one tenant's enrollment at another
  // tenant's (or a totally unrelated) step id.
  if (currentStepId !== undefined && currentStepId !== null) {
    const enrollment = await getEnrollment(id, companyId);
    if (!enrollment) return null;
    const step = await query(
      'SELECT id FROM sequence_steps WHERE id = $1 AND sequence_id = $2 AND company_id = $3',
      [currentStepId, enrollment.sequence_id, companyId]
    );
    if (!step.rows[0]) return null;
  }
  const setClauses = [];
  const params = [];
  let idx = 1;
  if (status !== undefined) { setClauses.push(`status = $${idx++}`); params.push(status); }
  if (currentStepId !== undefined) { setClauses.push(`current_step_id = $${idx++}`); params.push(currentStepId); }
  if (exitReason !== undefined) { setClauses.push(`exit_reason = $${idx++}`); params.push(exitReason); }
  if (status === 'completed') setClauses.push(`completed_at = now()`);
  if (!setClauses.length) return getEnrollment(id, companyId);
  params.push(id, companyId);
  const result = await query(
    `UPDATE enrollments SET ${setClauses.join(', ')}
     WHERE id = $${idx++} AND company_id = $${idx++} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

// ─── scheduled_actions ─────────────────────────────────────────────────────
// The backing store for B4's channel-executor contract — a row here becomes
// a ChannelJob once B3 (dispatcher) wires claim/ack to real routes.

async function scheduleAction(companyId, { enrollmentId, stepId, payload = {}, scheduledFor }) {
  if (!companyId) throw new Error('sequences.scheduleAction requires companyId');
  // contactId, channel, and template_ref are deliberately NOT caller-supplied
  // — all three are derived from the enrollment/step themselves, so there's
  // no way to schedule a job against a contact other than the one actually
  // enrolled, or a channel/template that doesn't match what the step defines
  // (a caller passing e.g. channel='sms' for an email step would otherwise
  // silently create a scheduled_action whose channel lies about what the
  // step actually configured).
  const enrollment = await getEnrollment(enrollmentId, companyId);
  if (!enrollment) return null;
  const step = await query(
    'SELECT * FROM sequence_steps WHERE id = $1 AND sequence_id = $2 AND company_id = $3',
    [stepId, enrollment.sequence_id, companyId]
  );
  if (!step.rows[0]) return null;

  const result = await query(
    `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, template_ref, payload, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, enrollmentId, stepId, enrollment.contact_id, step.rows[0].channel, step.rows[0].template_ref, JSON.stringify(payload), scheduledFor]
  );
  return result.rows[0];
}

async function listScheduledActions(companyId, { enrollmentId, status, channel } = {}) {
  if (!companyId) throw new Error('sequences.listScheduledActions requires companyId');
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (enrollmentId) { params.push(enrollmentId); conditions.push(`enrollment_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (channel) { params.push(channel); conditions.push(`channel = $${params.length}`); }
  const result = await query(
    `SELECT * FROM scheduled_actions WHERE ${conditions.join(' AND ')} ORDER BY scheduled_for ASC`,
    params
  );
  return result.rows;
}

module.exports = {
  createSequence, getSequenceById, listSequences, updateSequenceStatus,
  addStep, listSteps,
  enroll, getEnrollment, listEnrollments, updateEnrollment,
  scheduleAction, listScheduledActions,
  enrollForTriggerStage,
};
