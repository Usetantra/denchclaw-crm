'use strict';
// ─── Sequences (GOAL B7 — sequence builder UI backend) ─────────────────────────
// Thin HTTP layer over server/db/models/sequences.js (B1's data model, B2's
// stage-triggered enrollment). No new business logic here — every ownership/
// scoping guarantee already lives in the model layer; these routes just
// translate HTTP <-> that layer and map 404s consistently.
const express = require('express');
const router = express.Router();
const seqDb = require('../db/models/sequences');
const { getPipelineConfig } = require('../db/pipeline');
const workflowTriggers = require('../lib/workflow-triggers');
const templatesDb = require('../db/models/templates');
const contactDb = require('../db/models/contacts');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

// The known channel VOCABULARY — what the CRM understands at all. Deliberately
// wider than what it can SEND on: `ai_call` is a real thing that happens to a
// contact and belongs on their timeline, it just cannot be queued as outbound
// work. `canSend` below is the narrower question, and it is derived from the
// executor registry rather than restated here.
const CHANNELS = ['email', 'sms', 'whatsapp', 'ai_call', 'linkedin', 'action'];
const { canSend, CHANNELS: SENDABLE } = require('../lib/executors');

// CP2 D4b.1 — is the sequence's declared stage_writeback chain actually
// walkable through the pipeline's transitions, in step_order?
//
// Returns null when the chain is fine, or a ready-to-send 400 body when it is
// not. Validation is incremental (each new step is checked against its nearest
// declaring neighbour on both sides) because steps are added one call at a
// time and may arrive out of order — checking both directions means the chain
// is verified whichever order the builder UI submits them in.
async function validateStageWritebackChain(companyId, sequenceId, stepOrder, stageWriteback) {
  const sequence = await seqDb.getSequenceById(sequenceId, companyId);
  if (!sequence) return null; // addStep's own 404 covers this
  if (!sequence.pipeline_key) {
    return { error: 'stage_writeback requires the sequence to be tied to a pipeline_key' };
  }
  const cfg = await getPipelineConfig(companyId, sequence.pipeline_key);
  if (!cfg) return { error: `unknown pipeline_key '${sequence.pipeline_key}' on this sequence` };

  const stageKeys = cfg.stages.map(s => s && s.key);
  if (!stageKeys.includes(stageWriteback)) {
    return {
      error: `stage_writeback '${stageWriteback}' is not a stage of pipeline '${sequence.pipeline_key}'`,
      allowed_stages: stageKeys,
    };
  }

  const transitionsOf = (key) => {
    const s = cfg.stages.find(st => st && st.key === key);
    return s && Array.isArray(s.transitions) ? s.transitions : [];
  };

  const steps = await seqDb.listSteps(sequenceId, companyId);
  const declaring = steps.filter(s => s.stage_writeback && s.step_order !== stepOrder);
  const prev = declaring.filter(s => s.step_order < stepOrder).pop();
  const next = declaring.find(s => s.step_order > stepOrder);

  if (prev && prev.stage_writeback !== stageWriteback && !transitionsOf(prev.stage_writeback).includes(stageWriteback)) {
    return {
      error: `stage_writeback chain is not walkable: step ${prev.step_order} writes back '${prev.stage_writeback}', which cannot transition to '${stageWriteback}'`,
      from: prev.stage_writeback, to: stageWriteback, allowed: transitionsOf(prev.stage_writeback),
    };
  }
  if (next && next.stage_writeback !== stageWriteback && !transitionsOf(stageWriteback).includes(next.stage_writeback)) {
    return {
      error: `stage_writeback chain is not walkable: '${stageWriteback}' cannot transition to '${next.stage_writeback}' declared by step ${next.step_order}`,
      from: stageWriteback, to: next.stage_writeback, allowed: transitionsOf(stageWriteback),
    };
  }
  return null;
}

// GET /api/crm/sequences?status=&pipeline_key=
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const sequences = await seqDb.listSequences(companyId, { status: req.query.status, pipelineKey: req.query.pipeline_key });
    // One bulk query for all steps, not one per sequence (DB_POOL_MAX is a
    // shared, modest budget — an N+1 here would queue behind it under load).
    const stepsBySequence = await seqDb.listStepsForSequences(sequences.map(s => s.id), companyId);
    const withSteps = sequences.map(s => ({ ...s, steps: stepsBySequence[s.id] || [] }));
    res.json({ total: withSteps.length, sequences: withSteps });
  } catch (err) {
    console.error('[CRM] GET /sequences error:', err.message);
    res.status(500).json({ error: 'failed to load sequences' });
  }
});

// POST /api/crm/sequences  { name, pipeline_key?, trigger_stage? }
router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { name, pipeline_key, trigger_stage, trigger_tag, trigger_event, trigger_config } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if ([trigger_stage, trigger_tag, trigger_event].filter(Boolean).length > 1) {
      return res.status(400).json({ error: 'a sequence can trigger on a stage, a tag OR an event — not more than one' });
    }
    // A trigger_event with no firing site would be a workflow that silently
    // never runs, which is indistinguishable to an operator from a broken one.
    // The allowed set is the one workflow-triggers.js actually fires.
    if (trigger_event && !workflowTriggers.EVENT_KEYS.includes(trigger_event)) {
      return res.status(400).json({
        error: `unknown trigger_event '${trigger_event}'`,
        allowed_events: workflowTriggers.EVENT_KEYS,
      });
    }
    // Config-driven (CP1 decision 9): any pipeline this tenant can resolve is
    // a valid trigger source. getPipelineConfig's (company_id = $2 OR
    // company_id IS NULL) scoping IS the tenant-isolation guarantee here —
    // tenant A can never reference tenant B's company-scoped key.
    // Known+accepted: the loader's 60s cache means a just-deleted pipeline
    // still validates for up to a minute.
    if (pipeline_key) {
      const cfg = await getPipelineConfig(companyId, pipeline_key);
      if (!cfg) return res.status(400).json({ error: `unknown pipeline_key '${pipeline_key}'` });
      // A typo'd trigger_stage used to be accepted and then silently never
      // fire — reject it against the pipeline's real stage keys instead.
      if (trigger_stage && !cfg.stages.some(s => s && s.key === trigger_stage)) {
        return res.status(400).json({
          error: `trigger_stage '${trigger_stage}' is not a stage of pipeline '${pipeline_key}'`,
          allowed_stages: cfg.stages.map(s => s.key),
        });
      }
    }
    const sequence = await seqDb.createSequence({
      companyId, name: String(name).trim(), pipelineKey: pipeline_key || null, triggerStage: trigger_stage || null,
      triggerTag: trigger_tag ? String(trigger_tag).trim() : null,
      triggerEvent: trigger_event || null,
      triggerConfig: trigger_config && typeof trigger_config === 'object' ? trigger_config : {},
    });
    res.status(201).json(sequence);
  } catch (err) {
    console.error('[CRM] POST /sequences error:', err.message);
    res.status(500).json({ error: 'failed to create sequence' });
  }
});

// GET /api/crm/sequences/:id — detail with steps + enrollment counts
// GET /api/crm/sequences/trigger-events — the events a workflow can start on.
// Served rather than hardcoded in the client so the builder's dropdown cannot
// drift from what the server actually fires; `fires_at` is shown to the
// operator so "what makes this run?" is answerable in the UI.
// MUST precede '/:id' or that route captures 'trigger-events'.
router.get('/trigger-events', (req, res) => {
  res.json({
    events: workflowTriggers.EVENT_KEYS.map((key) => ({
      key,
      label: workflowTriggers.TRIGGER_EVENTS[key].label,
      fires_at: workflowTriggers.TRIGGER_EVENTS[key].firesAt,
      config: workflowTriggers.TRIGGER_EVENTS[key].config || [],
    })),
  });
});

router.get('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const sequence = await seqDb.getSequenceById(req.params.id, companyId);
    if (!sequence) return res.status(404).json({ error: 'sequence not found' });
    const [steps, enrollments] = await Promise.all([
      seqDb.listSteps(req.params.id, companyId),
      seqDb.listEnrollments(companyId, { sequenceId: req.params.id }),
    ]);
    const enrollmentsByStatus = enrollments.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] || 0) + 1;
      return acc;
    }, {});
    res.json({ ...sequence, steps, enrollment_count: enrollments.length, enrollments_by_status: enrollmentsByStatus });
  } catch (err) {
    console.error('[CRM] GET /sequences/:id error:', err.message);
    res.status(500).json({ error: 'failed to load sequence' });
  }
});

// PATCH /api/crm/sequences/:id  { status }
router.patch('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { status } = req.body || {};
    if (!['active', 'paused', 'archived'].includes(status)) {
      return res.status(400).json({ error: "status must be one of 'active', 'paused', 'archived'" });
    }
    const updated = await seqDb.updateSequenceStatus(req.params.id, companyId, status);
    if (!updated) return res.status(404).json({ error: 'sequence not found' });
    // CP2: re-activating must actually resume. While a sequence is paused, an
    // ack advances the enrollment but queues nothing (D5b) — so without this
    // backfill any enrollment whose ack landed inside the pause window would
    // stay active with an empty queue forever, and "pause" would be a
    // one-way door rather than a pause.
    let requeued = [];
    if (status === 'active') requeued = await seqDb.resumeSequenceQueue(companyId, req.params.id);
    res.json({ ...updated, ...(requeued.length ? { requeued_actions: requeued.length } : {}) });
  } catch (err) {
    console.error('[CRM] PATCH /sequences/:id error:', err.message);
    res.status(500).json({ error: 'failed to update sequence' });
  }
});

// POST /api/crm/sequences/:id/steps  { step_order, channel, delay_seconds?, anchor_offset_seconds?, template_ref?, entry_conditions?, exit_conditions? }
router.post('/:id/steps', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { step_order, channel, delay_seconds, anchor_offset_seconds, template_ref, entry_conditions, exit_conditions, stage_writeback, subject, body, linkedin_action, action_type, action_config } = req.body || {};
    if (!Number.isInteger(step_order) || step_order < 1) {
      return res.status(400).json({ error: 'step_order must be a positive integer' });
    }
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'invalid channel' });
    // CP-Z: refuse at the FRONT DOOR. The claim door already declines to hand
    // out a job it has no executor for, so nothing gets stranded either way —
    // but a step created today and discovered as a silently stuck queue in three
    // weeks is a much worse way to learn this. 422: the channel is a real one,
    // the request is well-formed, and the CRM simply cannot act on it yet.
    if (!canSend(channel)) {
      return res.status(422).json({
        error: `no executor exists for channel '${channel}' — a step on it would queue work nothing can send`,
        channel, sendable_channels: SENDABLE,
      });
    }
    if (delay_seconds !== undefined && (!Number.isInteger(delay_seconds) || delay_seconds < 0)) {
      return res.status(400).json({ error: 'delay_seconds must be a non-negative integer' });
    }
    // F38: anchor_offset_seconds is SIGNED (negative = before the anchor, e.g.
    // a reminder) and cannot coexist with a non-zero delay_seconds — mirrors
    // migration 032's sequence_steps_anchor_xor_delay DB constraint, checked
    // here too so the operator gets a 400 with an explanation instead of a
    // raw constraint-violation 500.
    if (anchor_offset_seconds !== undefined && anchor_offset_seconds !== null) {
      if (!Number.isInteger(anchor_offset_seconds)) {
        return res.status(400).json({ error: 'anchor_offset_seconds must be an integer (negative = before the anchor)' });
      }
      if (delay_seconds) {
        return res.status(400).json({ error: 'a step cannot set both anchor_offset_seconds and a non-zero delay_seconds — an anchored step fires at anchor_at + offset, never relative to the previous step' });
      }
    }
    for (const [label, value] of [['entry_conditions', entry_conditions], ['exit_conditions', exit_conditions]]) {
      if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        return res.status(400).json({ error: `${label} must be an object` });
      }
    }

    // CP2 D4b.1 — validate the declared stage_writeback CHAIN at configuration
    // time. webinar_sales' follow-up transitions are strictly linear, so a
    // chain that cannot walk the pipeline is not a cosmetic mistake: the first
    // write-back that can't apply is refused, which leaves the deal stale, which
    // makes every later write-back illegal too — messages keep sending while
    // the board lies, for up to 13 days. Catching it here turns a silent
    // 13-day drift into a 400 at the moment the sequence is configured.
    if (stage_writeback !== undefined && stage_writeback !== null) {
      if (typeof stage_writeback !== 'string' || !stage_writeback.trim()) {
        return res.status(400).json({ error: 'stage_writeback must be a non-empty string' });
      }
      const invalid = await validateStageWritebackChain(companyId, req.params.id, step_order, stage_writeback);
      if (invalid) return res.status(400).json(invalid);
    }

    // CP4a-0: a template pinned to another channel is an authoring error, and
    // CP2's stage_writeback precedent says catch those at CONFIGURATION time
    // rather than letting the sequence fire and discover it at a prospect. A
    // ref that does not resolve yet is NOT an error here — copy is routinely
    // authored after the ladder is laid out, and the readiness endpoint
    // (GET /sequences/:id/content) is what reports that gap before switch-on.
    if (template_ref && String(template_ref).trim()) {
      const tpl = await templatesDb.getTemplate(companyId, template_ref);
      const mismatch = templatesDb.templateChannelMismatch(tpl, channel);
      if (mismatch) {
        return res.status(400).json({
          error: mismatch,
          template_channel: tpl.channel,
          step_channel: channel,
          hint: 'use a template written for this channel, or clear the template\'s channel to make it usable on any channel',
        });
      }
    }

    if (linkedin_action !== undefined && linkedin_action !== null) {
      if (channel !== 'linkedin') {
        return res.status(400).json({ error: `linkedin_action is only meaningful on a 'linkedin' step (this step is '${channel}')` });
      }
      if (!['invite', 'message', 'inmail'].includes(linkedin_action)) {
        return res.status(400).json({ error: "linkedin_action must be 'invite', 'message' or 'inmail'", got: linkedin_action });
      }
    }

    // F-WF: an 'action' step performs a DB effect instead of sending a
    // message — action_type is REQUIRED on that channel (mirrors migration
    // 034's DB constraint) and meaningless on every other one.
    if (channel === 'action') {
      if (!action_type || !['add_tag', 'remove_tag', 'change_stage', 'create_task', 'webhook_out'].includes(action_type)) {
        return res.status(400).json({ error: "an 'action' step requires action_type: 'add_tag' | 'remove_tag' | 'change_stage' | 'create_task' | 'webhook_out'" });
      }
      const cfg = action_config || {};
      const need = {
        add_tag: ['tag'], remove_tag: ['tag'], change_stage: ['pipeline_key', 'stage'],
        create_task: ['title'], webhook_out: ['url'],
      }[action_type];
      const missing = need.filter(k => !cfg[k]);
      if (missing.length) return res.status(400).json({ error: `action_type '${action_type}' requires action_config.${missing.join(', .')}` });
    } else if (action_type !== undefined && action_type !== null) {
      return res.status(400).json({ error: `action_type is only meaningful on an 'action' step (this step is '${channel}')` });
    }

    let step;
    try {
      step = await seqDb.addStep(req.params.id, companyId, {
        stepOrder: step_order, channel, delaySeconds: delay_seconds || 0,
        anchorOffsetSeconds: anchor_offset_seconds === undefined ? null : anchor_offset_seconds,
        templateRef: template_ref || null, entryConditions: entry_conditions || {}, exitConditions: exit_conditions || {},
        stageWriteback: stage_writeback === undefined ? null : stage_writeback,
        // CP4a-0: optional inline content. A blank string is refused rather than
        // stored, because "" is indistinguishable from "no content" downstream
        // and that ambiguity is exactly what mails a blank.
        subject: subject === undefined ? null : subject,
        body: body === undefined || body === null || !String(body).trim() ? null : String(body),
        // CP-D: which LinkedIn action this rung performs. Without this the API
        // could only ever author NULL — which the CP-C2 gate reads as 'message',
        // and a message with no connection evidence is held forever. An operator
        // building a LinkedIn ladder through the API got a silent stall and no
        // way to say "this rung is the invite".
        linkedinAction: linkedin_action || null,
        actionType: channel === 'action' ? action_type : null,
        actionConfig: channel === 'action' ? (action_config || {}) : {},
      });
    } catch (dbErr) {
      // sequence_steps has UNIQUE(sequence_id, step_order) with no
      // ON CONFLICT clause in addStep — a duplicate step_order throws a raw
      // Postgres 23505 rather than returning null, so it needs its own
      // catch here to map to a clean 409 instead of a generic 500. Checked
      // against the constraint name (not just the bare error code) so a
      // future, unrelated unique constraint on this table isn't mislabeled
      // as a step_order conflict.
      if (dbErr.code === '23505' && /step_order/.test(dbErr.constraint || '')) {
        return res.status(409).json({ error: `step_order ${step_order} already exists on this sequence` });
      }
      throw dbErr;
    }
    if (!step) return res.status(404).json({ error: 'sequence not found' });
    res.status(201).json(step);
  } catch (err) {
    console.error('[CRM] POST /sequences/:id/steps error:', err.message);
    res.status(500).json({ error: 'failed to add step' });
  }
});

// ─── Step editing (migration 042) ────────────────────────────────────────────
// A saved workflow was view-only because deleting a step cascades into its
// scheduled_actions — including sent ones. These routes make editing possible
// without that hazard: content is editable freely, removal soft-archives
// anything with history, and reordering is a permutation, not a free-for-all.

// PATCH /api/crm/sequences/:id/steps/:stepId
router.patch('/:id/steps/:stepId', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const seq = await seqDb.getSequenceById(req.params.id, companyId);
    if (!seq) return res.status(404).json({ error: 'sequence not found' });
    const step = await seqDb.getStepById(req.params.stepId, companyId);
    if (!step || step.sequence_id !== seq.id) return res.status(404).json({ error: 'step not found' });
    if (step.archived_at) return res.status(409).json({ error: 'this step has been removed from the workflow' });

    const b = req.body || {};
    // channel/action_type are immutable — they are mirrored onto every job this
    // step already produced. Say so rather than ignoring the field silently.
    if (b.channel !== undefined || b.action_type !== undefined) {
      return res.status(400).json({
        error: 'channel and action_type cannot be changed — remove this step and add the one you want',
      });
    }
    if (b.delay_seconds !== undefined && (!Number.isFinite(Number(b.delay_seconds)) || Number(b.delay_seconds) < 0)) {
      return res.status(400).json({ error: 'delay_seconds must be a non-negative number' });
    }
    const updated = await seqDb.updateStep(step.id, companyId, {
      delaySeconds: b.delay_seconds !== undefined ? Math.round(Number(b.delay_seconds)) : undefined,
      anchorOffsetSeconds: b.anchor_offset_seconds,
      subject: b.subject, body: b.body, templateRef: b.template_ref,
      actionConfig: b.action_config, entryConditions: b.entry_conditions, exitConditions: b.exit_conditions,
    });
    if (!updated) return res.status(404).json({ error: 'step not found' });
    res.json(updated);
  } catch (err) {
    console.error('[CRM] PATCH /sequences/:id/steps/:stepId error:', err.message);
    res.status(500).json({ error: 'failed to update step' });
  }
});

// DELETE /api/crm/sequences/:id/steps/:stepId
// Archives rather than deletes whenever the step has produced any job, so send
// history survives. The response says which happened and how much was kept.
router.delete('/:id/steps/:stepId', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const seq = await seqDb.getSequenceById(req.params.id, companyId);
    if (!seq) return res.status(404).json({ error: 'sequence not found' });
    const step = await seqDb.getStepById(req.params.stepId, companyId);
    if (!step || step.sequence_id !== seq.id) return res.status(404).json({ error: 'step not found' });

    const out = await seqDb.removeStep(step.id, companyId);
    res.json({
      ok: true, id: step.id, mode: out.deleted,
      history_preserved: out.history_preserved || 0,
      note: out.deleted === 'archived'
        ? 'Step removed from the workflow. Its send history was kept.'
        : 'Step deleted — it had never run, so there was no history to keep.',
    });
  } catch (err) {
    console.error('[CRM] DELETE /sequences/:id/steps/:stepId error:', err.message);
    res.status(500).json({ error: 'failed to remove step' });
  }
});

// POST /api/crm/sequences/:id/steps/reorder  { step_ids: [...] }
router.post('/:id/steps/reorder', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const seq = await seqDb.getSequenceById(req.params.id, companyId);
    if (!seq) return res.status(404).json({ error: 'sequence not found' });
    const ids = (req.body && req.body.step_ids) || [];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'step_ids array required' });
    try {
      const steps = await seqDb.reorderSteps(seq.id, companyId, ids);
      res.json({ ok: true, steps });
    } catch (e) {
      if (e.code === 'BAD_ORDER') {
        return res.status(400).json({
          error: 'step_ids must list every current step of this workflow exactly once',
        });
      }
      throw e;
    }
  } catch (err) {
    console.error('[CRM] POST /sequences/:id/steps/reorder error:', err.message);
    res.status(500).json({ error: 'failed to reorder steps' });
  }
});

// DELETE /api/crm/sequences/:id — archives a workflow that has run, deletes one
// that never did. Deleting outright would cascade through enrollments into
// scheduled_actions and erase the send history.
router.delete('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const out = await seqDb.removeSequence(req.params.id, companyId);
    if (!out) return res.status(404).json({ error: 'sequence not found' });
    res.json({
      ok: true, id: req.params.id, mode: out.deleted, enrollments: out.enrollments,
      note: out.deleted === 'archived'
        ? `Workflow archived and stopped. ${out.enrollments} enrolment(s) kept for history.`
        : 'Workflow deleted — nobody had ever been enrolled.',
    });
  } catch (err) {
    console.error('[CRM] DELETE /sequences/:id error:', err.message);
    res.status(500).json({ error: 'failed to delete workflow' });
  }
});


// POST /api/crm/sequences/:id/enroll  { contact_id, anchor_at? }
// Manual enrollment — the only path today is stage-triggered
// (enrollForTriggerStage). F38: `anchor_at` is the external event this ONE
// enrollment is anchored to (e.g. the specific webinar occurrence the contact
// registered for) — required for any step on this sequence that carries an
// anchor_offset_seconds; every ordinary sequence just omits it.
router.post('/:id/enroll', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { contact_id, anchor_at } = req.body || {};
    if (!contact_id || typeof contact_id !== 'string') {
      return res.status(400).json({ error: 'contact_id is required' });
    }
    let anchorAt = null;
    if (anchor_at !== undefined && anchor_at !== null) {
      const d = new Date(anchor_at);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'anchor_at must be a valid date/time' });
      anchorAt = d.toISOString();
    }
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const enrollment = await seqDb.enroll(companyId, { sequenceId: req.params.id, contactId: contact_id, anchorAt });
    if (!enrollment) return res.status(404).json({ error: 'sequence not found' });
    res.status(201).json(enrollment);
  } catch (err) {
    console.error('[CRM] POST /sequences/:id/enroll error:', err.message);
    res.status(500).json({ error: 'failed to enroll contact' });
  }
});

// GET /api/crm/sequences/:id/enrollments?status=
router.get('/:id/enrollments', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const sequence = await seqDb.getSequenceById(req.params.id, companyId);
    if (!sequence) return res.status(404).json({ error: 'sequence not found' });
    const enrollments = await seqDb.listEnrollments(companyId, { sequenceId: req.params.id, status: req.query.status });
    res.json({ total: enrollments.length, enrollments });
  } catch (err) {
    console.error('[CRM] GET /sequences/:id/enrollments error:', err.message);
    res.status(500).json({ error: 'failed to load enrollments' });
  }
});

// GET /api/crm/sequences/:id/queue — CP2's proof surface: who is enrolled, at
// which step, and what is actually queued for them.
//
// A NEW endpoint rather than an extension of /enrollments: that one returns
// bare enrollment rows and is already consumed, and this one joins contacts
// and scheduled_actions for a read-only view. It also closes CP1 follow-up F3
// (the detail pane could show a COUNT of enrollments but never WHO).
// Tenant-scoped through getSequenceById, so another tenant's sequence id is a
// 404, not a leak.
router.get('/:id/queue', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const sequence = await seqDb.getSequenceById(req.params.id, companyId);
    if (!sequence) return res.status(404).json({ error: 'sequence not found' });

    const enrollments = await seqDb.listEnrollmentsWithQueue(companyId, req.params.id);
    res.json({ total: enrollments.length, sequence_status: sequence.status, enrollments });
  } catch (err) {
    console.error('[CRM] GET /sequences/:id/queue error:', err.message);
    res.status(500).json({ error: 'failed to load sequence queue' });
  }
});

// GET /api/crm/sequences/:id/content — CP4a-0 readiness.
// "Would this sequence send blank messages?" answered BEFORE it is switched on.
// `sendable` is the single line an operator needs; `steps[]` says which rung is
// missing copy and why.
router.get('/:id/content', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const sequence = await seqDb.getSequenceById(req.params.id, companyId);
    if (!sequence) return res.status(404).json({ error: 'sequence not found' });
    // Render against a real enrolled contact when there is one, so the preview
    // shows the words a prospect would actually receive rather than raw tokens.
    const enrolled = await seqDb.listEnrollments(companyId, { sequenceId: req.params.id });
    let sample = null;
    if (enrolled.length) {
      const c = await contactDb.getById(enrolled[0].contact_id, companyId);
      sample = c || null;
    }
    const readiness = await templatesDb.sequenceContentReadiness(companyId, req.params.id, { sampleContact: sample });
    res.json({ ...readiness, sequence_status: sequence.status, previewed_against_contact: sample ? sample.id : null });
  } catch (err) {
    console.error('[CRM] GET /sequences/:id/content error:', err.message);
    res.status(500).json({ error: 'failed to check sequence content' });
  }
});

module.exports = router;
