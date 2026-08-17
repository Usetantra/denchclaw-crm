'use strict';
// ─── Settings API ───────────────────────────────────────────────────────────
// Business profile, custom field definitions, and tag management — the
// GHL/Salesforce-style "configure your own CRM" surface. All tenant-scoped
// under requireAuth (NOT the admin-only tenants.js provisioning router).
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const businessProfile = require('../db/models/business-profile');
const customFields = require('../db/models/custom-fields');
const tagsDb = require('../db/models/tags');
const leadWebhooksDb = require('../db/models/lead-webhooks');

router.use(requireAuth);

// ── Business profile ──────────────────────────────────────────────────────
router.get('/business-profile', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const profile = await businessProfile.get(companyId);
    res.json({ profile: profile || { company_id: companyId } });
  } catch (e) {
    console.error('[Settings] GET business-profile', e.message);
    res.status(500).json({ error: 'failed to load business profile' });
  }
});

router.patch('/business-profile', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { name, industry, website, phone, timezone, currency, address, logo_url } = req.body || {};
    const profile = await businessProfile.upsert(companyId, { name, industry, website, phone, timezone, currency, address, logo_url });
    res.json({ profile });
  } catch (e) {
    console.error('[Settings] PATCH business-profile', e.message);
    res.status(500).json({ error: 'failed to save business profile' });
  }
});

// ── Custom field definitions ──────────────────────────────────────────────
router.get('/custom-fields', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const fields = await customFields.list(companyId, req.query.entity_type || 'contact');
    res.json({ fields, types: customFields.TYPES });
  } catch (e) {
    console.error('[Settings] GET custom-fields', e.message);
    res.status(500).json({ error: 'failed to load custom fields' });
  }
});

router.post('/custom-fields', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { label, type, options, entity_type } = req.body || {};
    const field = await customFields.create(companyId, { label, type, options, entityType: entity_type });
    res.status(201).json({ field });
  } catch (e) {
    const known = /required|must be one of|at least one letter/.test(e.message);
    if (known) return res.status(400).json({ error: e.message });
    if (e.code === '23505') return res.status(409).json({ error: 'a field with this name already exists' });
    console.error('[Settings] POST custom-fields', e.message);
    res.status(500).json({ error: 'failed to create custom field' });
  }
});

router.patch('/custom-fields/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { label, type, options, position } = req.body || {};
    const field = await customFields.update(companyId, req.params.id, { label, type, options, position });
    if (!field) return res.status(404).json({ error: 'custom field not found' });
    res.json({ field });
  } catch (e) {
    if (/must be one of/.test(e.message)) return res.status(400).json({ error: e.message });
    console.error('[Settings] PATCH custom-fields/:id', e.message);
    res.status(500).json({ error: 'failed to update custom field' });
  }
});

router.delete('/custom-fields/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const removed = await customFields.remove(companyId, req.params.id);
    if (!removed) return res.status(404).json({ error: 'custom field not found' });
    // The definition is gone, but existing contacts keep whatever value they
    // already had under metadata.custom_fields[key] — deleting a definition
    // is not a bulk-erase of everyone's data, only "stop offering this field."
    res.json({ ok: true, key: removed.key });
  } catch (e) {
    console.error('[Settings] DELETE custom-fields/:id', e.message);
    res.status(500).json({ error: 'failed to delete custom field' });
  }
});

// ── Tags ───────────────────────────────────────────────────────────────────
router.get('/tags', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    res.json({ tags: await tagsDb.list(companyId) });
  } catch (e) {
    console.error('[Settings] GET tags', e.message);
    res.status(500).json({ error: 'failed to load tags' });
  }
});

router.patch('/tags', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { old_tag, new_tag } = req.body || {};
    if (!old_tag || !new_tag) return res.status(400).json({ error: 'old_tag and new_tag are required' });
    const n = await tagsDb.rename(companyId, old_tag, new_tag);
    res.json({ ok: true, contacts_updated: n });
  } catch (e) {
    console.error('[Settings] PATCH tags', e.message);
    res.status(500).json({ error: 'failed to rename tag' });
  }
});

router.delete('/tags', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { tag } = req.body || {};
    if (!tag) return res.status(400).json({ error: 'tag is required' });
    const n = await tagsDb.remove(companyId, tag);
    res.json({ ok: true, contacts_updated: n });
  } catch (e) {
    console.error('[Settings] DELETE tags', e.message);
    res.status(500).json({ error: 'failed to delete tag' });
  }
});

// ── Inbound lead webhooks (Integrations) ────────────────────────────────────
router.get('/lead-webhooks', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    res.json({ webhooks: await leadWebhooksDb.list(companyId) });
  } catch (e) {
    console.error('[Settings] GET lead-webhooks', e.message);
    res.status(500).json({ error: 'failed to load webhooks' });
  }
});

router.post('/lead-webhooks', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { label, default_source, default_tags } = req.body || {};
    const webhook = await leadWebhooksDb.create(companyId, { label, defaultSource: default_source, defaultTags: default_tags });
    res.status(201).json({ webhook });
  } catch (e) {
    console.error('[Settings] POST lead-webhooks', e.message);
    res.status(500).json({ error: 'failed to create webhook' });
  }
});

router.patch('/lead-webhooks/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { label, enabled, default_source, default_tags } = req.body || {};
    const webhook = await leadWebhooksDb.update(companyId, req.params.id, { label, enabled, defaultSource: default_source, defaultTags: default_tags });
    if (!webhook) return res.status(404).json({ error: 'webhook not found' });
    res.json({ webhook });
  } catch (e) {
    console.error('[Settings] PATCH lead-webhooks/:id', e.message);
    res.status(500).json({ error: 'failed to update webhook' });
  }
});

router.post('/lead-webhooks/:id/regenerate', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const webhook = await leadWebhooksDb.regenerateToken(companyId, req.params.id);
    if (!webhook) return res.status(404).json({ error: 'webhook not found' });
    res.json({ webhook });
  } catch (e) {
    console.error('[Settings] POST lead-webhooks/:id/regenerate', e.message);
    res.status(500).json({ error: 'failed to rotate token' });
  }
});

router.delete('/lead-webhooks/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const n = await leadWebhooksDb.remove(companyId, req.params.id);
    if (!n) return res.status(404).json({ error: 'webhook not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Settings] DELETE lead-webhooks/:id', e.message);
    res.status(500).json({ error: 'failed to delete webhook' });
  }
});

// GET /api/crm/settings/webhook-captures — what's actually arrived at
// POST /webhooks/capture/:tool, for building a real connector from real
// payloads instead of guessed-at documentation. Not company-scoped (see
// migration 035) — this is a shared debugging surface, same posture as the
// inbound-email-status endpoint below.
const webhookCapturesDb = require('../db/models/webhook-captures');
router.get('/webhook-captures', async (req, res) => {
  try {
    if (req.query.tool) return res.json({ captures: await webhookCapturesDb.list(req.query.tool, req.query.limit) });
    res.json({ tools: await webhookCapturesDb.listTools() });
  } catch (e) {
    console.error('[Settings] GET webhook-captures', e.message);
    res.status(500).json({ error: 'failed to load webhook captures' });
  }
});

// GET /api/crm/settings/inbound-email-status — is the server-wide inbound
// email webhook configured? Never returns the secret itself (it's one
// server-wide value from INBOUND_WEBHOOK_SECRET, not a per-tenant credential
// worth round-tripping through an API response) — just enough for the
// Integrations panel to say "set up" vs "needs INBOUND_WEBHOOK_SECRET".
router.get('/inbound-email-status', (req, res) => {
  res.json({
    configured: !!process.env.INBOUND_WEBHOOK_SECRET,
    path: '/webhooks/email/inbound',
    header: 'x-webhook-secret',
  });
});

module.exports = router;
