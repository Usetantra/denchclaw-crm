'use strict';
// ─── Tenants (GOAL A2 — provisioning) ──────────────────────────────────────────
// Minimal internal provisioning surface so a tenant row exists before any
// company_id-scoped data references it (migration 013's FK requires this).
// NOT the full tenant lifecycle (A6 — billing/onboarding UX is a separate,
// gated product decision); this is just enough to create the row.
const express = require('express');
const router = express.Router();
const tenantDb = require('../db/models/tenants');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.post('/', async (req, res) => {
  try {
    const { id, name, slug, status, plan, aliases } = req.body || {};
    if (!id || !name || !slug) {
      return res.status(400).json({ error: 'id, name, and slug are required' });
    }
    const existing = await tenantDb.getById(id);
    if (existing) return res.status(409).json({ error: 'tenant already exists', tenant: existing });
    const tenant = await tenantDb.create({ id, name, slug, status, plan, aliases });
    res.status(201).json(tenant);
  } catch (err) {
    console.error('[CRM] POST /tenants error:', err.message);
    res.status(500).json({ error: 'failed to create tenant' });
  }
});

router.get('/', async (req, res) => {
  try {
    res.json({ tenants: await tenantDb.list() });
  } catch (err) {
    console.error('[CRM] GET /tenants error:', err.message);
    res.status(500).json({ error: 'failed to list tenants' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const tenant = await tenantDb.getById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    res.json(tenant);
  } catch (err) {
    console.error('[CRM] GET /tenants/:id error:', err.message);
    res.status(500).json({ error: 'failed to load tenant' });
  }
});

module.exports = router;
