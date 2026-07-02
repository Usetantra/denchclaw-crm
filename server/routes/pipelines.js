'use strict';
// ─── Pipeline management ─────────────────────────────────────────────────────
// Manage pipeline stage configs stored in crm_pipeline_configs (the same table
// getPipelineConfig reads). Two BUILT-IN pipelines exist as global rows
// (company_id IS NULL): 'marketing' (contacts) and 'sales' (deals). Editing a
// built-in writes a COMPANY-SCOPED override row (company_id = tenant) — the
// globals are never mutated, so other tenants and the CI/contract test tenant
// are unaffected. Brand-new pipelines are company-scoped rows with a new key and
// apply to DEALS (deals.pipeline_key), moving freely (no transition gate).
const express = require('express');
const router = express.Router();
const { query } = require('../db/index');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const BUILTINS = {
  marketing: { name: 'Marketing Pipeline', applies_to: 'contact' },
  sales: { name: 'Sales Pipeline', applies_to: 'deal' },
};
const PALETTE = ['#667085', '#2e90fa', '#7a5af8', '#6172f3', '#f97316', '#15b79e', '#0ba5ec', '#12b76a', '#f04438'];

const TEMPLATES = {
  sales: { label: 'Sales', stages: [
    { key: 'new', name: 'New' }, { key: 'contacted', name: 'Contacted' }, { key: 'qualified', name: 'Qualified' },
    { key: 'proposal', name: 'Proposal' }, { key: 'negotiation', name: 'Negotiation' }, { key: 'won', name: 'Won' }, { key: 'lost', name: 'Lost' }] },
  webinar: { label: 'Webinar Funnel', stages: [
    { key: 'registered', name: 'Registered' }, { key: 'reminded', name: 'Reminded' }, { key: 'attended', name: 'Attended' },
    { key: 'no_show', name: 'No-Show' }, { key: 'booked_call', name: 'Booked Call' }, { key: 'won', name: 'Won' }, { key: 'lost', name: 'Lost' }] },
  onboarding: { label: 'Onboarding', stages: [
    { key: 'kickoff', name: 'Kickoff' }, { key: 'setup', name: 'Setup' }, { key: 'training', name: 'Training' },
    { key: 'live', name: 'Live' }, { key: 'won', name: 'Complete' }, { key: 'lost', name: 'Churned' }] },
};

function slugify(s, i) {
  const b = String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return b || `stage_${i + 1}`;
}

// Normalize incoming stages into [{key,name,color,transitions}]. When `prev` is
// given, per-key transitions are preserved (pruned to surviving keys) so a pure
// rename/recolor/reorder of a built-in leaves its state machine intact; new
// stages get a simple linear default.
function normalizeStages(input, prev) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const out = [];
  input.forEach((s, i) => {
    if (!s) return;
    const name = String(s.name || s.key || '').trim();
    if (!name) return;
    let key = (s.key ? String(s.key) : slugify(name, i)).toLowerCase().replace(/[^a-z0-9_]+/g, '_') || slugify(name, i);
    while (seen.has(key)) key = `${key}_${i}`;
    seen.add(key);
    out.push({ key, name, color: s.color || PALETTE[out.length % PALETTE.length] });
  });
  if (!out.length) return null;
  const keys = out.map(s => s.key);
  const prevMap = {};
  (prev || []).forEach(s => { if (s && s.key) prevMap[s.key] = Array.isArray(s.transitions) ? s.transitions : []; });
  return out.map((s, i) => {
    let tr;
    if (prevMap[s.key]) tr = prevMap[s.key].filter(k => keys.includes(k));
    else {
      tr = [];
      if (out[i + 1]) tr.push(out[i + 1].key);
      const lost = keys.find(k => k === 'lost');
      if (lost && lost !== s.key && !tr.includes(lost)) tr.push(lost);
    }
    return { key: s.key, name: s.name, color: s.color, transitions: tr };
  });
}

function withColors(stages) {
  return (stages || []).map((s, i) => ({ key: s.key, name: s.name || s.key, color: s.color || PALETTE[i % PALETTE.length], transitions: s.transitions || [] }));
}

// Resolve a pipeline by key: prefer the company override, else the global row.
async function resolve(companyId, key) {
  const { rows } = await query(
    `SELECT name, stages, (company_id IS NOT NULL) AS overridden
       FROM crm_pipeline_configs
      WHERE key = $1 AND (company_id = $2 OR company_id IS NULL)
      ORDER BY (company_id IS NOT NULL) DESC, created_at ASC LIMIT 1`,
    [key, companyId]
  );
  return rows[0] || null;
}

// GET /api/crm/pipelines/templates
router.get('/templates', (req, res) => {
  res.json({ templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, stages: t.stages })) });
});

// GET /api/crm/pipelines — built-ins (resolved) + company custom pipelines.
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const list = [];
    for (const [key, meta] of Object.entries(BUILTINS)) {
      const r = await resolve(companyId, key);
      list.push({ key, name: (r && r.name) || meta.name, applies_to: meta.applies_to, builtin: true,
        overridden: !!(r && r.overridden), stages: withColors(r && r.stages) });
    }
    const custom = await query(
      `SELECT key, name, stages FROM crm_pipeline_configs
        WHERE company_id = $1 AND key NOT IN ('marketing','sales') ORDER BY created_at ASC`,
      [companyId]
    );
    custom.rows.forEach(r => list.push({ key: r.key, name: r.name, applies_to: 'deal', builtin: false, overridden: true, stages: withColors(r.stages) }));
    res.json({ pipelines: list });
  } catch (err) {
    console.error('[CRM] GET /pipelines error:', err.message);
    res.status(500).json({ error: 'failed to load pipelines' });
  }
});

// POST /api/crm/pipelines — create a custom DEAL pipeline { name, stages?|template? }
router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { name, stages, template } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

    let raw = stages;
    if (!Array.isArray(raw) && template && TEMPLATES[template]) raw = TEMPLATES[template].stages;
    if (!Array.isArray(raw)) raw = TEMPLATES.sales.stages;
    const norm = normalizeStages(raw, null);
    if (!norm) return res.status(400).json({ error: 'at least one stage required' });

    // Derive a unique, non-builtin key from the name.
    let key = slugify(name, 0);
    if (key === 'marketing' || key === 'sales') key = `${key}_pipeline`;
    const existing = await query(`SELECT 1 FROM crm_pipeline_configs WHERE company_id = $1 AND key = $2`, [companyId, key]);
    if (existing.rows.length) key = `${key}_${Date.now().toString(36).slice(-4)}`;

    const { rows } = await query(
      `INSERT INTO crm_pipeline_configs (company_id, key, name, stages) VALUES ($1,$2,$3,$4) RETURNING key, name, stages`,
      [companyId, key, String(name).trim(), JSON.stringify(norm)]
    );
    res.status(201).json({ key: rows[0].key, name: rows[0].name, applies_to: 'deal', builtin: false, overridden: true, stages: withColors(rows[0].stages) });
  } catch (err) {
    console.error('[CRM] POST /pipelines error:', err.message);
    res.status(500).json({ error: 'failed to create pipeline' });
  }
});

// PATCH /api/crm/pipelines/:key — edit name/stages. Built-ins upsert a
// company-scoped override; the global rows are never mutated.
router.patch('/:key', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const key = req.params.key;
    const isBuiltin = !!BUILTINS[key];
    const current = await resolve(companyId, key);
    if (!isBuiltin && !current) return res.status(404).json({ error: 'pipeline not found' });

    const { name, stages } = req.body || {};
    const norm = stages !== undefined ? normalizeStages(stages, current && current.stages) : (current ? withColors(current.stages) : null);
    if (stages !== undefined && !norm) return res.status(400).json({ error: 'at least one stage required' });
    const finalName = (name && String(name).trim()) || (current && current.name) || (isBuiltin ? BUILTINS[key].name : key);
    const finalStages = norm || [];

    await query(
      `INSERT INTO crm_pipeline_configs (company_id, key, name, stages) VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, key) WHERE company_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, stages = EXCLUDED.stages, updated_at = now()`,
      [companyId, key, finalName, JSON.stringify(finalStages)]
    );
    res.json({ key, name: finalName, applies_to: isBuiltin ? BUILTINS[key].applies_to : 'deal', builtin: isBuiltin, overridden: true, stages: withColors(finalStages) });
  } catch (err) {
    console.error('[CRM] PATCH /pipelines/:key error:', err.message);
    res.status(500).json({ error: 'failed to update pipeline' });
  }
});

// DELETE /api/crm/pipelines/:key — custom only; reassign its deals back to sales.
router.delete('/:key', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const key = req.params.key;
    if (BUILTINS[key]) return res.status(400).json({ error: 'cannot delete a built-in pipeline' });
    const { rows } = await query(`DELETE FROM crm_pipeline_configs WHERE company_id = $1 AND key = $2 RETURNING key`, [companyId, key]);
    if (!rows.length) return res.status(404).json({ error: 'pipeline not found' });
    await query(`UPDATE deals SET pipeline_key = NULL WHERE company_id = $1 AND pipeline_key = $2`, [companyId, key]);
    res.json({ ok: true, deleted: key });
  } catch (err) {
    console.error('[CRM] DELETE /pipelines/:key error:', err.message);
    res.status(500).json({ error: 'failed to delete pipeline' });
  }
});

module.exports = router;
