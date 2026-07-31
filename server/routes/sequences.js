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
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const CHANNELS = ['email', 'sms', 'whatsapp', 'ai_call', 'linkedin'];

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
    res.json(updated);
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
    const { step_order, channel, delay_seconds, template_ref, entry_conditions, exit_conditions } = req.body || {};
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

    let step;
    try {
      step = await seqDb.addStep(req.params.id, companyId, {
        stepOrder: step_order, channel, delaySeconds: delay_seconds || 0,
        templateRef: template_ref || null, entryConditions: entry_conditions || {}, exitConditions: exit_conditions || {},
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

module.exports = router;
