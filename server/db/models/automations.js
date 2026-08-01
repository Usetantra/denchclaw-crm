'use strict';
// ─── CP-D: installing the operator's automations ─────────────────────────────
//
// A definition (server/lib/automation-definitions.js) is a description. This
// turns one into the rows that actually fire: a `sequences` row bound to a
// trigger stage, its `sequence_steps`, and a `message_templates` row per step.
//
// WHY TEMPLATES RATHER THAN INLINE STEP CONTENT. Both work — CP4a-0 built the
// precedence — but a template row is editable through the templates API that
// already exists, and `reresolveUnresolvedJobs` (CP4a-0 F1) means editing the
// copy genuinely un-sticks a ladder that was blocked on it. Inline content would
// have been fewer rows and a dead end for the operator.
//
// SEEDING IS IDEMPOTENT AND NON-DESTRUCTIVE. Re-seeding an installed automation
// does NOT overwrite the copy, because by then a human may have rewritten it and
// silently reverting their words would be the worst possible behaviour for a
// "seed" button. It reports `already_installed` and changes nothing. There is a
// separate, explicit `overwrite` for when that is genuinely what is wanted.
const { query, getClient } = require('../index');
const { byKey, requiredTokens } = require('../../lib/automation-definitions');
const templatesDb = require('./templates');
const { getPipelineConfig, isManualStage } = require('../pipeline');

// Identified by `sequences.automation_key` (migration 025), NOT by display name.
// The name is mutable and not unique: matching on it meant a rename produced a
// silent duplicate, and — worse — a human who happened to name their own
// sequence "No-Show follow-up ladder" could have it clobbered by an
// overwrite-seed they never ran against it.
const templateRef = (def, order) => `${def.key}__s${order}`;
const findSeeded = (companyId, key, run = query) =>
  run('SELECT * FROM sequences WHERE company_id = $1 AND automation_key = $2', [companyId, key])
    .then(r => r.rows[0] || null);

async function installed(companyId) {
  if (!companyId) throw new Error('automations.installed requires companyId');
  const r = await query(
    `SELECT s.id, s.name, s.pipeline_key, s.trigger_stage, s.status, s.automation_key,
            COUNT(st.id)::int AS step_count
       FROM sequences s LEFT JOIN sequence_steps st ON st.sequence_id = s.id
      WHERE s.company_id = $1 AND s.automation_key = ANY($2)
      GROUP BY s.id ORDER BY s.name`,
    [companyId, Object.keys(byKey)]
  );
  return r.rows.map(row => ({ ...row, definition_key: row.automation_key }));
}

// What an operator must configure before any of this can send. Returned by the
// seeder so the gap is visible at INSTALL time, not discovered later as a job
// sitting refused in the queue.
async function readiness(companyId, def) {
  const have = await templatesDb.mergeDefaults(companyId);
  const need = requiredTokens(def);
  return {
    required_merge_tokens: need,
    missing_merge_tokens: need.filter(t => !have[t]),
  };
}

async function seed(companyId, key, { overwrite = false } = {}) {
  if (!companyId) throw new Error('automations.seed requires companyId');
  const def = byKey[key];
  if (!def) return { ok: false, error: `unknown automation '${key}'`, available: Object.keys(byKey) };

  // THE INVARIANT, CHECKED AT INSTALL TIME. A step that writes back a manual
  // stage would be refused later by applyStageWriteback — correctly, but silently
  // and one contact at a time, long after whoever installed it walked away.
  // Refusing the whole install is how it stays a design error rather than an
  // operational mystery.
  const cfg = await getPipelineConfig(companyId, def.pipeline_key);
  if (!cfg) return { ok: false, error: `unknown pipeline '${def.pipeline_key}'` };
  const stageKeys = cfg.stages.map(s => s && s.key);
  for (const step of def.steps) {
    if (!step.stage_writeback) continue;
    if (!stageKeys.includes(step.stage_writeback)) {
      return { ok: false, error: `'${step.stage_writeback}' is not a stage of '${def.pipeline_key}'` };
    }
    if (isManualStage(cfg, step.stage_writeback)) {
      return {
        ok: false,
        error: `refusing to install: a step writes back '${step.stage_writeback}', which is a MANUAL stage. `
          + 'Manual stages are moved by people, never by an automation.',
      };
    }
  }
  if (def.trigger_stage && !stageKeys.includes(def.trigger_stage)) {
    return { ok: false, error: `trigger stage '${def.trigger_stage}' is not a stage of '${def.pipeline_key}'` };
  }

  const found = await findSeeded(companyId, key);
  if (found && !overwrite) {
    return {
      ok: true, already_installed: true, sequence_id: found.id, key,
      note: 'left untouched — re-seeding never overwrites copy a human may have rewritten. '
        + 'Pass overwrite:true to replace it.',
      ...(await readiness(companyId, def)),
    };
  }

  // OVERWRITE IS REFUSED ONCE THE LADDER HAS RUN, and this is the sharpest thing
  // in the file. `scheduled_actions.step_id` is ON DELETE **CASCADE**
  // (migrations/014_sequences.sql:86), so replacing the steps of a ladder with
  // history deletes its whole send ledger — not just the pending rows. Three
  // consequences, each worse than the last:
  //
  //   * The LinkedIn daily/weekly caps are COUNTED FROM scheduled_actions
  //     (lib/linkedin-gate.js — "the ledger is scheduled_actions, not a second
  //     table"). Erasing it resets the counters to zero mid-day, and the gate
  //     then re-issues a full day's invites on a real account.
  //   * A row with `send_started_at` committed is a send PHYSICALLY IN FLIGHT.
  //     Deleting it destroys the only record that it left, which is the entire
  //     basis of the no-double-send guarantee.
  //   * `enrollments.current_step_id` is ON DELETE SET NULL, so every contact
  //     mid-ladder survives as `active` with a NULL current step: never
  //     materialised again, never resumable, and blocked from re-enrolling by
  //     the active-enrolment unique index. They silently stop receiving anything.
  //
  // So overwrite stays available for the real use case — "I seeded it and
  // changed my mind before anyone got anything" — and refuses otherwise.
  if (found && overwrite) {
    const hist = await query(
      `SELECT
         (SELECT COUNT(*)::int FROM scheduled_actions sa
           WHERE sa.company_id = $1 AND sa.status <> 'pending'
             AND sa.step_id IN (SELECT id FROM sequence_steps WHERE sequence_id = $2)) AS sent,
         (SELECT COUNT(*)::int FROM enrollments e
           WHERE e.company_id = $1 AND e.sequence_id = $2 AND e.status = 'active') AS live`,
      [companyId, found.id]);
    const { sent, live } = hist.rows[0];
    if (sent > 0 || live > 0) {
      return {
        ok: false, key, sequence_id: found.id,
        error: 'refusing to overwrite a ladder that has already run: '
          + `${sent} job(s) beyond pending and ${live} live enrolment(s). Replacing its steps would `
          + 'cascade-delete the send ledger (which is also the LinkedIn rate-limit ledger) and strand '
          + 'every contact mid-ladder with no way to re-enrol. Edit the templates instead — they are '
          + 'editable, and editing them re-resolves queued jobs.',
        sent_jobs: sent, live_enrolments: live,
      };
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    let sequenceId;
    if (found) {
      sequenceId = found.id;
      // Only reachable for a ladder with NO history (guarded above). Steps are
      // replaced wholesale rather than patched, because a definition that
      // changed its step COUNT would otherwise leave an orphaned rung behind —
      // and a stale extra rung sends a real message nobody authored.
      await client.query('DELETE FROM sequence_steps WHERE sequence_id = $1 AND company_id = $2',
        [sequenceId, companyId]);
      await client.query(
        `UPDATE sequences SET pipeline_key = $2, trigger_stage = $3, status = $4, updated_at = now()
          WHERE id = $1`,
        [sequenceId, def.pipeline_key, def.trigger_stage, def.blocked_until ? 'paused' : 'active']);
    } else {
      // A definition that declares `blocked_until` installs PAUSED. The CP2
      // claim door already refuses steps whose sequence is not 'active', so a
      // paused install is genuinely inert rather than merely labelled — and an
      // operator activating it is asserting they resolved the blocker.
      const created = await client.query(
        `INSERT INTO sequences (company_id, name, pipeline_key, trigger_stage, status, automation_key)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [companyId, def.name, def.pipeline_key, def.trigger_stage,
         def.blocked_until ? 'paused' : 'active', def.key]);
      sequenceId = created.rows[0].id;
    }

    let order = 0;
    for (const step of def.steps) {
      order += 1;
      const ref = templateRef(def, order);
      await client.query(
        `INSERT INTO message_templates (company_id, ref, channel, subject, body)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id, ref) DO UPDATE
           SET channel = EXCLUDED.channel, subject = EXCLUDED.subject,
               body = EXCLUDED.body, updated_at = now()`,
        [companyId, ref, step.channel, step.subject || null, step.body]);
      await client.query(
        `INSERT INTO sequence_steps
           (company_id, sequence_id, step_order, channel, delay_seconds, template_ref,
            stage_writeback, linkedin_action)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, sequenceId, order, step.channel, step.delay_seconds, ref,
         step.stage_writeback || null, step.channel === 'linkedin' ? (step.linkedin_action || null) : null]);
    }
    await client.query('COMMIT');
    return {
      ok: true, installed: true, key, sequence_id: sequenceId, steps: order,
      source: def.source, caveat: def.caveat,
      status: def.blocked_until ? 'paused' : 'active',
      ...(def.blocked_until ? { blocked_until: def.blocked_until } : {}),
      ...(def.account_note ? { account_note: def.account_note } : {}),
      ...(await readiness(companyId, def)),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── what `crm_pipeline_configs.automations` holds ───────────────────────────
//
// Nothing. And that is the answer, not an omission.
//
// The column has been empty on every row since migration 003 and NO code has
// ever read it. The obvious move was to fill it with the stage→sequence bindings
// — except `sequences.trigger_stage` already IS that binding: indexed, validated
// at authoring time, enforced by `enrollForTriggerStage`, and covered by tests.
// Writing the same fact into a JSONB column would create a second source of
// truth that nothing keeps in step, which is the identical mistake this build
// refused twice already (a second lease table in CP-C2, a second ledger in CP-C).
// The first time the two disagreed, an operator would be looking at a pipeline
// screen that confidently described automations that were not running.
//
// So `automations` becomes a PROJECTION: computed on read from `sequences`, never
// stored. The pipeline screen gets its answer, and there is exactly one place
// where "what fires on this stage" is true.
async function automationsFor(companyId, pipelineKey) {
  if (!companyId) throw new Error('automations.automationsFor requires companyId');
  const r = await query(
    `SELECT s.id, s.name, s.trigger_stage, s.status,
            COUNT(st.id)::int AS step_count,
            MIN(st.delay_seconds) AS first_delay_seconds,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT st.channel), NULL) AS channels,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT st.stage_writeback), NULL) AS writes_back
       FROM sequences s LEFT JOIN sequence_steps st ON st.sequence_id = s.id
      WHERE s.company_id = $1 AND s.pipeline_key = $2 AND s.status <> 'archived'
      GROUP BY s.id ORDER BY s.name`,
    [companyId, pipelineKey]);
  return r.rows.map(row => ({
    sequence_id: row.id,
    name: row.name,
    // NULL means the sequence exists but nothing enrols into it automatically.
    // Saying so beats an empty string that reads like a missing value.
    trigger_stage: row.trigger_stage,
    enrolment: row.trigger_stage ? 'on entering stage' : 'manual only',
    status: row.status,
    steps: row.step_count,
    channels: row.channels,
    advances_stages_to: row.writes_back,
  }));
}

module.exports = { seed, installed, automationsFor, readiness };
