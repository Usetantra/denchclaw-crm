'use strict';
// ─── CP-D: the automations control surface ───────────────────────────────────
// Mounted at /api/crm/automations. Four things an operator needs: see what is
// available, install it, configure the tenant values its copy depends on, and
// see what is actually wired to a pipeline.
const express = require('express');
const router = express.Router();
const automationsDb = require('../db/models/automations');
const templatesDb = require('../db/models/templates');
const { DEFINITIONS, requiredTokens } = require('../lib/automation-definitions');
const { CONTEXT_TOKENS } = require('../lib/ai-draft');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const co = (req, res) => {
  const companyId = getUserCompanyId(req);
  if (!companyId) { res.status(401).json({ error: 'Authentication required' }); return null; }
  return companyId;
};

// GET /api/crm/automations — the catalogue, and what is installed from it.
router.get('/', async (req, res) => {
  try {
    const companyId = co(req, res); if (!companyId) return;
    const live = await automationsDb.installed(companyId);
    const byDef = Object.fromEntries(live.map(l => [l.definition_key, l]));
    res.json({
      available: DEFINITIONS.map(d => ({
        key: d.key, name: d.name, pipeline_key: d.pipeline_key,
        trigger_stage: d.trigger_stage,
        enrolment: d.trigger_stage ? `on entering '${d.trigger_stage}'` : 'manual only',
        channels: [...new Set(d.steps.map(s => s.channel))],
        steps: d.steps.length,
        // Days from enrolment, which is the shape an operator thinks in — the
        // ladder's cadence is the thing they are deciding about, not seconds.
        cadence_days: d.steps.map(s => +(s.delay_seconds / 86400).toFixed(2)),
        // BORROWED or AUTHORED, and from exactly where. The operator asked for
        // the engines' workflows to be reused, so "which of these did we
        // actually reuse" is a question the API should answer.
        source: d.source,
        caveat: d.caveat,
        // Surfaced in the CATALOGUE, not only on install: an operator choosing
        // what to switch on should see that WhatsApp needs approved-template
        // paperwork, and that the LinkedIn ladder assumes a narrower account
        // window than CP-C2's default, BEFORE they pick it.
        ...(d.blocked_until ? { installs_paused: true, blocked_until: d.blocked_until } : {}),
        ...(d.account_note ? { account_note: d.account_note } : {}),
        required_merge_tokens: requiredTokens(d),
        installed: !!byDef[d.key],
        sequence_id: byDef[d.key] ? byDef[d.key].id : null,
      })),
    });
  } catch (err) {
    console.error('[CRM] GET /automations error:', err.message);
    res.status(500).json({ error: 'failed to list automations' });
  }
});

// POST /api/crm/automations/:key/seed  { overwrite?: boolean }
router.post('/:key/seed', async (req, res) => {
  try {
    const companyId = co(req, res); if (!companyId) return;
    const out = await automationsDb.seed(companyId, req.params.key, {
      overwrite: !!(req.body && req.body.overwrite),
    });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (err) {
    console.error('[CRM] POST /automations/:key/seed error:', err.message);
    res.status(500).json({ error: 'failed to seed automation' });
  }
});

// GET /api/crm/automations/merge-defaults — the tenant values the copy needs.
router.get('/merge-defaults', async (req, res) => {
  try {
    const companyId = co(req, res); if (!companyId) return;
    const have = await templatesDb.mergeDefaults(companyId);
    res.json({
      tokens: CONTEXT_TOKENS.map(t => ({ token: t, value: have[t] || null, set: !!have[t] })),
    });
  } catch (err) {
    console.error('[CRM] GET /automations/merge-defaults error:', err.message);
    res.status(500).json({ error: 'failed to read merge defaults' });
  }
});

// PUT /api/crm/automations/merge-defaults  { book_url: "...", ... }
router.put('/merge-defaults', async (req, res) => {
  try {
    const companyId = co(req, res); if (!companyId) return;
    const body = req.body || {};
    const keys = Object.keys(body);
    if (!keys.length) return res.status(400).json({ error: 'nothing to set', tokens: CONTEXT_TOKENS });
    const unknown = keys.filter(k => !CONTEXT_TOKENS.includes(k));
    // Refused rather than ignored: a silently dropped `booking_url` looks
    // identical to a successful save, and the operator finds out when a ladder
    // refuses to send.
    if (unknown.length) {
      return res.status(400).json({
        error: `not context tokens: ${unknown.join(', ')}`, tokens: CONTEXT_TOKENS,
      });
    }
    // Validate EVERY value before writing ANY. Without this, {book_url:'ok',
    // join_url:'   '} saved book_url and then 400'd — so a failed request had
    // silently changed half the tenant's configuration, which is the worst
    // possible reading of an error response.
    const blank = keys.filter(k => !body[k] || !String(body[k]).trim());
    if (blank.length) {
      return res.status(400).json({ error: `these need a non-empty value: ${blank.join(', ')}`, changed: false });
    }
    const out = {};
    for (const k of keys) {
      const row = await templatesDb.setMergeDefault(companyId, k, body[k]);
      out[k] = row.value;
    }
    res.json({ ok: true, set: out });
  } catch (err) {
    console.error('[CRM] PUT /automations/merge-defaults error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/crm/automations/pipeline/:key — what actually fires on this pipeline.
// This is the projection that replaces `crm_pipeline_configs.automations`; see
// db/models/automations.js for why the column stays empty.
router.get('/pipeline/:key', async (req, res) => {
  try {
    const companyId = co(req, res); if (!companyId) return;
    res.json({
      pipeline_key: req.params.key,
      automations: await automationsDb.automationsFor(companyId, req.params.key),
    });
  } catch (err) {
    console.error('[CRM] GET /automations/pipeline/:key error:', err.message);
    res.status(500).json({ error: 'failed to read pipeline automations' });
  }
});

module.exports = router;
