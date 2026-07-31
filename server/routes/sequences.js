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
const templatesDb = require('../db/models/templates');
const contactDb = require('../db/models/contacts');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const CHANNELS = ['email', 'sms', 'whatsapp', 'ai_call', 'linkedin'];

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
    const { name, pipeline_key, trigger_stage } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
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
    });
    res.status(201).json(sequence);
  } catch (err) {
    console.error('[CRM] POST /sequences error:', err.message);
    res.status(500).json({ error: 'failed to create sequence' });
  }
});

// GET /api/crm/sequences/:id — detail with steps + enrollment counts
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

// POST /api/crm/sequences/:id/steps  { step_order, channel, delay_seconds?, template_ref?, entry_conditions?, exit_conditions? }
router.post('/:id/steps', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { step_order, channel, delay_seconds, template_ref, entry_conditions, exit_conditions, stage_writeback, subject, body } = req.body || {};
    if (!Number.isInteger(step_order) || step_order < 1) {
      return res.status(400).json({ error: 'step_order must be a positive integer' });
    }
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'invalid channel' });
    if (delay_seconds !== undefined && (!Number.isInteger(delay_seconds) || delay_seconds < 0)) {
      return res.status(400).json({ error: 'delay_seconds must be a non-negative integer' });
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

    let step;
    try {
      step = await seqDb.addStep(req.params.id, companyId, {
        stepOrder: step_order, channel, delaySeconds: delay_seconds || 0,
        templateRef: template_ref || null, entryConditions: entry_conditions || {}, exitConditions: exit_conditions || {},
        stageWriteback: stage_writeback === undefined ? null : stage_writeback,
        // CP4a-0: optional inline content. A blank string is refused rather than
        // stored, because "" is indistinguishable from "no content" downstream
        // and that ambiguity is exactly what mails a blank.
        subject: subject === undefined ? null : subject,
        body: body === undefined || body === null || !String(body).trim() ? null : String(body),
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
