'use strict';
// ─── Tenant API keys (GOAL A3 — issue/rotate) ───────────────────────────────────
// Admin-gated like tenants.js: issuing a key for a tenant isn't something
// that tenant can bootstrap for itself (you need a key to make any
// authenticated request at all), so only a '*'-bound key may manage keys.
const express = require('express');
const router = express.Router();
const apiKeysDb = require('../db/models/apiKeys');
const tenantDb = require('../db/models/tenants');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/crm/api-keys  { company_id, label? }
// Returns the plaintext key ONCE — it is never retrievable again.
router.post('/', async (req, res) => {
  try {
    const { company_id, label } = req.body || {};
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    const tenant = await tenantDb.getById(company_id);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    const created = await apiKeysDb.createKey(company_id, label || null);
    res.status(201).json(created);
  } catch (err) {
    console.error('[CRM] POST /api-keys error:', err.message);
    res.status(500).json({ error: 'failed to create API key' });
  }
});

// GET /api/crm/api-keys?company_id=  — never returns key_hash or the plaintext.
router.get('/', async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    const tenant = await tenantDb.getById(company_id);
    if (!tenant) return res.status(404).json({ error: 'tenant not found' });
    const keys = await apiKeysDb.listKeys(company_id);
    res.json({ total: keys.length, keys });
  } catch (err) {
    console.error('[CRM] GET /api-keys error:', err.message);
    res.status(500).json({ error: 'failed to list API keys' });
  }
});

// DELETE /api/crm/api-keys/:id  { company_id }
router.delete('/:id', async (req, res) => {
  try {
    const { company_id } = req.body || {};
    if (!company_id) return res.status(400).json({ error: 'company_id required' });
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'id must be a UUID' });
    const revoked = await apiKeysDb.revokeKey(company_id, req.params.id);
    if (!revoked) return res.status(404).json({ error: 'API key not found (or already revoked)' });
    res.json(revoked);
  } catch (err) {
    console.error('[CRM] DELETE /api-keys/:id error:', err.message);
    res.status(500).json({ error: 'failed to revoke API key' });
  }
});

module.exports = router;
