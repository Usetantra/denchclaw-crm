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
const { query, getClient } = require('../index');
const contactDb = require('./contacts');
const templatesDb = require('./templates');

// ─── sequences ─────────────────────────────────────────────────────────────

// F-WF: triggerTag (migration 034) is the workflow-style alternative to
// triggerStage — "when a contact gets tagged X, run this" instead of "when a
// contact enters stage Y". A sequence has at most one trigger (the DB
// constraint enforces it too); passing both here is a caller error, not
// silently resolved by preferring one.
async function createSequence({ companyId, name, pipelineKey = null, triggerStage = null, triggerTag = null }) {
  if (!companyId) throw new Error('sequences.createSequence requires companyId');
  if (!name) throw new Error('sequences.createSequence requires name');
  if (triggerStage && triggerTag) throw new Error('a sequence can have trigger_stage or trigger_tag, not both');
  const result = await query(
    `INSERT INTO sequences (company_id, name, pipeline_key, trigger_stage, trigger_tag)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [companyId, name, pipelineKey, triggerStage, triggerTag]
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
    // CP2 D10: a swallowed error used to be invisible to everyone but the
    // server log, and D1 widened the failure surface from "enrollment" to
    // "enrollment AND its first queued step" — so a dropped ladder now also
    // means no messages will ever send. Record it on the contact's timeline
    // where a human actually looks. Best-effort by construction: this is the
    // failure path already, so it must not be able to throw either.
    try {
      await contactDb.addActivity(contactId, {
        type: 'sequence_enrollment_failed',
        message: `Sequence enrollment failed for ${pipelineKey}/${stage} — no messages were scheduled`,
        data: { pipeline_key: pipelineKey, stage, error: err.message },
      }, companyId);
    } catch (activityErr) {
      console.error(`[CRM][sequence-enrollment-failure] could not record activity: ${activityErr.message}`);
    }
    return [];
  }
}

// F-WF: the tag-triggered twin of enrollForTriggerStage — called wherever a
// tag actually lands on a contact (PATCH /contacts/:id, the bulk-tag action),
// never wherever a tag is merely PRESENT, so re-saving a contact that already
// has the tag doesn't re-enroll them into a workflow that already ran. Same
// "never throws into the caller" posture, for the same reason: a workflow
// misconfiguration must not turn an otherwise-successful tag write into a 500.
async function enrollForTriggerTag(companyId, contactId, tag) {
  if (!companyId) throw new Error('sequences.enrollForTriggerTag requires companyId');
  try {
    const matches = await query(
      `SELECT id FROM sequences WHERE company_id = $1 AND status = 'active' AND trigger_tag = $2`,
      [companyId, tag]
    );
    const results = await Promise.all(
      matches.rows.map((seq) => enroll(companyId, { sequenceId: seq.id, contactId }))
    );
    return results
      .map((enrollment, i) => (enrollment ? { sequence_id: matches.rows[i].id, enrollment_id: enrollment.id } : null))
      .filter(Boolean);
  } catch (err) {
    console.error(`[CRM][workflow-enrollment-failure] company=${companyId} tag=${tag}: ${err.message}`);
    try {
      await contactDb.addActivity(contactId, {
        type: 'sequence_enrollment_failed',
        message: `Workflow enrollment failed for tag '${tag}' — no actions were scheduled`,
        data: { tag, error: err.message },
      }, companyId);
    } catch (activityErr) {
      console.error(`[CRM][workflow-enrollment-failure] could not record activity: ${activityErr.message}`);
    }
    return [];
  }
}

// CP2 — re-materialize the queue for a sequence coming back from paused/archived.
//
// D5b says a non-active sequence enqueues nothing. Without this, that skip is
// PERMANENT: if a step is acked while the sequence is paused, the enrollment
// advances its current_step_id but no row is ever queued for the new step, and
// nothing re-drives it — so "re-activating resumes" would be false for every
// enrollment whose ack landed inside the pause window, and the ladder would be
// silently dead forever.
//
// The backfill is deliberately narrow: only ACTIVE enrollments, only where the
// current step has no scheduled_action at all. Re-timing is anchored on the
// resume (now + the step's own delay), never on the original pause, so a long
// pause can never dump a backlog of instantly-due sends on a contact.
async function resumeSequenceQueue(companyId, sequenceId) {
  if (!companyId) throw new Error('sequences.resumeSequenceQueue requires companyId');
  const stranded = await query(
    `SELECT e.id FROM enrollments e
      WHERE e.sequence_id = $1 AND e.company_id = $2
        AND e.status = 'active' AND e.current_step_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_actions sa
           WHERE sa.enrollment_id = e.id AND sa.step_id = e.current_step_id
        )`,
    [sequenceId, companyId]
  );
  const requeued = [];
  for (const row of stranded.rows) {
    const action = await materializeNextStep(companyId, row.id, { after: new Date() });
    if (action) requeued.push(action.id);
  }
  return requeued;
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

async function addStep(sequenceId, companyId, { stepOrder, channel, delaySeconds = 0, anchorOffsetSeconds = null, templateRef = null, entryConditions = {}, exitConditions = {}, stageWriteback = null, subject = null, body = null, linkedinAction = null, actionType = null, actionConfig = {} }) {
  if (!companyId) throw new Error('sequences.addStep requires companyId');
  const owned = await getSequenceById(sequenceId, companyId);
  if (!owned) return null;
  // stage_writeback (CP2 D4, migration 019) is the reporting stage this step
  // mirrors onto the pipeline when it is acked 'sent'. NULL — the default and
  // every pre-CP2 step — means "write nothing back".
  // CP4a-0: `subject`/`body` are OPTIONAL inline content for a one-off step and
  // take precedence over `template_ref` (see db/models/templates.js, which owns
  // that precedence). NULL on every pre-existing step, so nothing changes for
  // steps that already resolve through a template.
  // CP-D: `linkedinAction` (migration 024) is which LinkedIn action this step
  // performs — invite | message | inmail. NULL means 'message' at the gate, and
  // that default falls the SAFE way: an unverified message is refused, whereas
  // defaulting to 'invite' would fire connection requests nobody asked for.
  // F38: `anchorOffsetSeconds` (migration 032) makes this step ANCHORED to the
  // enrolling contact's `enrollments.anchor_at` (e.g. a webinar's start time)
  // instead of relative to the previous step — see materializeNextStep. Signed:
  // negative is "before the anchor" (a reminder), positive is "after". Passing
  // both this and a non-zero delaySeconds is rejected by the DB constraint
  // (sequence_steps_anchor_xor_delay) — one step cannot mean both at once.
  // F-WF: `actionType`/`actionConfig` (migration 034) make this an ACTION step
  // — add/remove tag, change stage, create a task, or an outbound webhook —
  // instead of a message send. The DB constraint enforces the pairing
  // (channel='action' iff action_type is set), so a mismatch here surfaces as
  // a clean constraint violation rather than a step that silently does nothing.
  const result = await query(
    `INSERT INTO sequence_steps (company_id, sequence_id, step_order, channel, delay_seconds, anchor_offset_seconds, template_ref, entry_conditions, exit_conditions, stage_writeback, subject, body, linkedin_action, action_type, action_config)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [companyId, sequenceId, stepOrder, channel, delaySeconds, anchorOffsetSeconds, templateRef, JSON.stringify(entryConditions), JSON.stringify(exitConditions), stageWriteback, subject, body,
     channel === 'linkedin' ? linkedinAction : null,
     channel === 'action' ? actionType : null, JSON.stringify(channel === 'action' ? (actionConfig || {}) : {})]
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

// Bulk variant for list views (e.g. GET /sequences attaching step counts to
// every row) — one query instead of one-per-sequence, avoiding pool pressure
// when a tenant has many sequences (DB_POOL_MAX is a shared, modest budget).
async function listStepsForSequences(sequenceIds, companyId) {
  if (!companyId) throw new Error('sequences.listStepsForSequences requires companyId');
  if (!sequenceIds.length) return {};
  const result = await query(
    'SELECT * FROM sequence_steps WHERE sequence_id = ANY($1) AND company_id = $2 ORDER BY sequence_id, step_order ASC',
    [sequenceIds, companyId]
  );
  return result.rows.reduce((acc, step) => {
    (acc[step.sequence_id] = acc[step.sequence_id] || []).push(step);
    return acc;
  }, {});
}

// ─── enrollments ───────────────────────────────────────────────────────────

async function enroll(companyId, { sequenceId, contactId, anchorAt = null }) {
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

  // CP2 D1: the enrollment row and its first scheduled_action are written in
  // ONE transaction. Before CP2 the insert stood alone and nothing ever
  // queued — an enrollment was a dead record. Doing it atomically is what
  // makes "an enrollment always has its first queued action" an invariant
  // rather than a hope: a crash between the two writes can no longer leave a
  // contact enrolled in a ladder that will never fire.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const firstStep = await client.query(
      'SELECT id FROM sequence_steps WHERE sequence_id = $1 AND company_id = $2 ORDER BY step_order ASC LIMIT 1',
      [sequenceId, companyId]
    );
    const stepId = firstStep.rows[0]?.id || null;

    // CP2 D1b: a sequence with NO steps completes on the spot. Leaving it
    // 'active' would strand the contact forever — sequences are created
    // 'active' and steps are added by a separate call, so a trigger firing in
    // that window enrolls into a stepless sequence; the partial unique index
    // then blocks re-enrolment while that row stays active, and no route
    // exists to update an enrollment back out of it.
    const result = await client.query(
      `INSERT INTO enrollments (company_id, sequence_id, contact_id, current_step_id, status, completed_at, anchor_at)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $5 = 'completed' THEN now() ELSE NULL END, $6) RETURNING *`,
      [companyId, sequenceId, contactId, stepId, stepId ? 'active' : 'completed', anchorAt]
    );
    const enrollment = result.rows[0];

    if (stepId) {
      // Anchored on the enrollment's own enrolled_at (D2: step 1 fires at
      // enrolled_at + delay_seconds), not on wall-clock now().
      await materializeNextStep(companyId, enrollment.id, { client, after: enrollment.enrolled_at });
    }

    await client.query('COMMIT');
    return enrollment;
  } catch (err) {
    await client.query('ROLLBACK');
    // Two concurrent enroll() calls for the same (sequence, contact) both
    // pass the SELECT above (classic TOCTOU under READ COMMITTED) — the
    // partial unique index rejects the loser with 23505. Re-select and
    // return the winner rather than surfacing a raw constraint violation.
    // The loser's whole transaction (enrollment AND its queued step 1) rolls
    // back together, so the winner's single step-1 row is the only one left.
    if (err.code === '23505') {
      const winner = await query(
        `SELECT * FROM enrollments WHERE sequence_id = $1 AND contact_id = $2 AND company_id = $3 AND status = 'active'`,
        [sequenceId, contactId, companyId]
      );
      if (winner.rows[0]) return winner.rows[0];
    }
    throw err;
  } finally {
    client.release();
  }
}

// CP2 D1/D2 — materialize the enrollment's CURRENT step as a scheduled_actions
// row (the dispatcher's queue). This is the single seam that was missing
// before CP2: scheduleAction() existed but no server code ever called it.
//
// `after` is the anchor the step's delay is measured FROM — enrolled_at for
// step 1, the ack time for every later step (D2: delays are relative to the
// predecessor's fire time, never cumulative from enrollment).
// `client` threads an open transaction through so the caller can make this
// atomic with whatever else it is writing.
//
// ON CONFLICT DO NOTHING against migration 019's UNIQUE (enrollment_id,
// step_id) is the idempotency backstop (D8): a replayed ack can never queue
// the same step twice. A conflict returns null, which callers treat as
// "already queued", not as a failure.
// F38: a step whose anchor time has already passed by the time it would be
// materialized is SKIPPED, never sent late — a late registrant must not
// receive four reminders in one tick because their enrollment started after
// the earlier rungs' anchor times. Records a terminal 'skipped' row (so the
// timeline shows what happened, same as any other terminal outcome) and
// activity, advances current_step_id, then recurses — the NEXT rung might
// also already be past its own anchor time for a very late registrant.
async function skipAnchoredStep(companyId, enrollment, step, { client, reason, computedFor }) {
  const run = (text, params) => (client ? client.query(text, params) : query(text, params));
  await run(
    `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, template_ref, payload, scheduled_for, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'skipped')
     ON CONFLICT (enrollment_id, step_id) DO NOTHING`,
    [companyId, enrollment.id, step.id, enrollment.contact_id, step.channel, step.template_ref,
     JSON.stringify({ anchor_skipped: true, reason }), (computedFor || new Date()).toISOString()]
  );
  await run(
    `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())`,
    [enrollment.contact_id, companyId, 'sequence_step_skipped_anchor',
     `Step ${step.step_order} skipped — ${reason}`, step.channel,
     JSON.stringify({ enrollment_id: enrollment.id, step_id: step.id, reason })]
  ).catch(() => {}); // best-effort, mirrors dispatch.js's noteActivity

  const next = await run(
    `SELECT id FROM sequence_steps WHERE sequence_id = $1 AND company_id = $2 AND step_order > $3
     ORDER BY step_order ASC LIMIT 1`,
    [enrollment.sequence_id, companyId, step.step_order]
  );
  if (!next.rows[0]) {
    await run(`UPDATE enrollments SET status='completed', completed_at=now() WHERE id=$1 AND company_id=$2`, [enrollment.id, companyId]);
    return null;
  }
  await run(`UPDATE enrollments SET current_step_id=$1 WHERE id=$2 AND company_id=$3`, [next.rows[0].id, enrollment.id, companyId]);
  return materializeNextStep(companyId, enrollment.id, { client, after: new Date() });
}

async function materializeNextStep(companyId, enrollmentId, { client = null, after = new Date() } = {}) {
  if (!companyId) throw new Error('sequences.materializeNextStep requires companyId');
  const run = (text, params) => (client ? client.query(text, params) : query(text, params));

  const enr = await run('SELECT * FROM enrollments WHERE id = $1 AND company_id = $2', [enrollmentId, companyId]);
  const enrollment = enr.rows[0];
  // Only an ACTIVE enrollment queues work — a completed/exited/paused one is
  // done and must not be resurrected by a late side-effect.
  if (!enrollment || enrollment.status !== 'active' || !enrollment.current_step_id) return null;

  const st = await run(
    'SELECT * FROM sequence_steps WHERE id = $1 AND sequence_id = $2 AND company_id = $3',
    [enrollment.current_step_id, enrollment.sequence_id, companyId]
  );
  const step = st.rows[0];
  if (!step) return null;

  // F38: an ANCHORED step (anchor_offset_seconds set) fires at the
  // enrollment's own anchor_at + offset, never relative to `after` — a
  // reminder ladder's rungs are all measured from the SAME external event
  // (e.g. a webinar's start time), not from each other.
  if (step.anchor_offset_seconds !== null) {
    if (!enrollment.anchor_at) {
      return skipAnchoredStep(companyId, enrollment, step, { client, reason: 'enrollment has no anchor_at set' });
    }
    const scheduledFor = new Date(new Date(enrollment.anchor_at).getTime() + step.anchor_offset_seconds * 1000);
    if (scheduledFor.getTime() <= Date.now()) {
      return skipAnchoredStep(companyId, enrollment, step, { client, reason: 'anchor time already passed', computedFor: scheduledFor });
    }
    const content = await templatesDb.resolveStepContent(companyId, step,
      (await run('SELECT id, name, email, company_name, marketing_stage, deal_stage FROM contacts WHERE id = $1 AND company_id = $2', [enrollment.contact_id, companyId])).rows[0] || null,
      { client });
    const inserted = await run(
      `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, template_ref, payload, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (enrollment_id, step_id) DO NOTHING
       RETURNING *`,
      [companyId, enrollment.id, step.id, enrollment.contact_id, step.channel, step.template_ref,
       JSON.stringify(templatesDb.contentPayload(content, { step_order: step.step_order })), scheduledFor.toISOString()]
    );
    return inserted.rows[0] || null;
  }

  // F-WF: an ACTION step has no message to resolve — templatesDb's whole
  // subject/body machinery doesn't apply. content_resolved:true and a
  // placeholder body are stamped anyway so the shared content guard in
  // channel-executor.js (written for every OTHER channel, which all send a
  // real message) doesn't need a special case for the one channel that
  // doesn't. The 'action' provider (server/lib/executors.js) reads
  // action_type/action_config, never body.
  if (step.channel === 'action') {
    const inserted = await run(
      `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, template_ref, payload, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$9::jsonb, $7::timestamptz + ($8 || ' seconds')::interval)
       ON CONFLICT (enrollment_id, step_id) DO NOTHING
       RETURNING *`,
      [companyId, enrollment.id, step.id, enrollment.contact_id, step.channel, step.template_ref,
       after instanceof Date ? after.toISOString() : after, String(step.delay_seconds),
       JSON.stringify({ content_resolved: true, body: `(${step.action_type})`, action_type: step.action_type, action_config: step.action_config || {} })]
    );
    return inserted.rows[0] || null;
  }

  // CP4a-0: freeze the RESOLVED message content into the job.
  //
  // The payload used to be literally '{}'::jsonb, so the queue said WHEN and TO
  // WHOM but never WHAT — an executor reading it would have called the provider
  // with an empty subject and body. Resolving here means the executor reads one
  // row and never has to reach around the claim/ack contract to find out what to
  // send, and it means the copy is resolved against the contact as they are when
  // the message is actually scheduled (step 5 of a ladder resolves 16 days after
  // enrolment, not at enrolment).
  //
  // Unresolvable content does NOT block the enrolment — it is frozen in as
  // `content_resolved: false` with the reason. The ladder still advances and the
  // gap is visible on the readiness surface, while the executor refuses to send
  // it. Throwing here would instead strand a contact mid-ladder for a copy
  // mistake, and swallowing it would mail a blank.
  const ct = await run(
    'SELECT id, name, email, company_name, marketing_stage, deal_stage FROM contacts WHERE id = $1 AND company_id = $2',
    [enrollment.contact_id, companyId]
  );
  const content = await templatesDb.resolveStepContent(companyId, step, ct.rows[0] || null, { client });

  // channel/template_ref/contact_id are derived from the enrollment+step, never
  // from a caller — the same property scheduleAction() established and which
  // stops a caller scheduling a job whose channel lies about the step's own.
  const inserted = await run(
    `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, template_ref, payload, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$9::jsonb, $7::timestamptz + ($8 || ' seconds')::interval)
     ON CONFLICT (enrollment_id, step_id) DO NOTHING
     RETURNING *`,
    [companyId, enrollment.id, step.id, enrollment.contact_id, step.channel, step.template_ref,
     after instanceof Date ? after.toISOString() : after, String(step.delay_seconds),
     JSON.stringify(templatesDb.contentPayload(content, { step_order: step.step_order }))]
  );
  return inserted.rows[0] || null;
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

// CP2 — one enrollment per row with the contact's name, its current step
// number, and every queued/sent action, for the sequence detail's
// "Enrollments & queue" block. Two queries, not one-per-enrollment: the same
// pool-budget reasoning as listStepsForSequences.
async function listEnrollmentsWithQueue(companyId, sequenceId) {
  if (!companyId) throw new Error('sequences.listEnrollmentsWithQueue requires companyId');
  const enrollments = await query(
    `SELECT e.id, e.status, e.exit_reason, e.enrolled_at, e.completed_at, e.contact_id,
            c.name AS contact_name, c.email AS contact_email,
            cs.step_order AS current_step_order
       FROM enrollments e
       JOIN contacts c ON c.id = e.contact_id AND c.company_id = e.company_id
       LEFT JOIN sequence_steps cs ON cs.id = e.current_step_id
      WHERE e.sequence_id = $1 AND e.company_id = $2
      ORDER BY e.enrolled_at DESC`,
    [sequenceId, companyId]
  );
  if (!enrollments.rows.length) return [];

  const actions = await query(
    `SELECT sa.id, sa.enrollment_id, sa.channel, sa.status, sa.scheduled_for, sa.sent_at,
            sa.template_ref, sa.attempt, ss.step_order, ss.stage_writeback
       FROM scheduled_actions sa
       JOIN sequence_steps ss ON ss.id = sa.step_id
      WHERE sa.enrollment_id = ANY($1::uuid[]) AND sa.company_id = $2
      ORDER BY ss.step_order ASC`,
    [enrollments.rows.map(e => e.id), companyId]
  );
  const byEnrollment = actions.rows.reduce((acc, a) => {
    (acc[a.enrollment_id] = acc[a.enrollment_id] || []).push(a);
    return acc;
  }, {});
  return enrollments.rows.map(e => ({ ...e, actions: byEnrollment[e.id] || [] }));
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

  // CP2/migration 019 added UNIQUE (enrollment_id, step_id), and enroll() now
  // materializes step 1 itself — so "schedule this step for this enrollment"
  // is naturally an UPSERT rather than a blind INSERT. Re-scheduling an
  // already-queued step re-times it instead of raising 23505 or creating the
  // duplicate the constraint exists to forbid. `status` is deliberately NOT
  // reset: re-timing a row must never resurrect one that already sent.
  // CP4a-0: the same content freeze materializeNextStep does. A caller-supplied
  // `payload` is merged UNDER the resolved content, never over it — otherwise a
  // caller could hand-write `{subject, body}` and bypass the template store,
  // which is exactly the "reach around the contract" the content freeze exists
  // to prevent. Caller payload keeps its use for scheduling metadata.
  const ct = await query(
    'SELECT id, name, email, company_name, marketing_stage, deal_stage FROM contacts WHERE id = $1 AND company_id = $2',
    [enrollment.contact_id, companyId]
  );
  const content = await templatesDb.resolveStepContent(companyId, step.rows[0], ct.rows[0] || null);
  const merged = templatesDb.contentPayload(content, {
    ...(payload && typeof payload === 'object' ? payload : {}),
    step_order: step.rows[0].step_order,
  });

  const result = await query(
    `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, template_ref, payload, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (enrollment_id, step_id) DO UPDATE
       SET scheduled_for = EXCLUDED.scheduled_for,
           payload = EXCLUDED.payload,
           updated_at = now()
     RETURNING *`,
    [companyId, enrollmentId, stepId, enrollment.contact_id, step.rows[0].channel, step.rows[0].template_ref, JSON.stringify(merged), scheduledFor]
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
  createSequence, getSequenceById, listSequences, updateSequenceStatus, resumeSequenceQueue,
  addStep, listSteps, listStepsForSequences,
  enroll, getEnrollment, listEnrollments, listEnrollmentsWithQueue, updateEnrollment,
  scheduleAction, listScheduledActions, materializeNextStep,
  enrollForTriggerStage, enrollForTriggerTag,
};
