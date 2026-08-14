'use strict';
// ─── Compliance API (Phase A) ─────────────────────────────────────────────────
// Consent capture/read, suppression (opt-out) management, SMS segment/encoding
// preview, and the regional policy lookup the composer/UI use to stay compliant
// by default. All under requireAuth (internal).
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const contactDb = require('../db/models/contacts');
const consent = require('../db/models/consent');
const suppression = require('../db/models/suppression');
const segments = require('../lib/segments');
const { policyFor, REGIONS } = require('../lib/regions');
const gate = require('../lib/compliance-gate');

router.use(requireAuth);

// ── Consent ──────────────────────────────────────────────────────────────────
// GET /api/crm/compliance/consent?contact_id=
router.get('/consent', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id } = req.query;
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    res.json({ consent: await consent.listForContact(companyId, contact_id) });
  } catch (e) { console.error('[Compliance] consent GET', e.message); res.status(500).json({ error: 'failed' }); }
});

// POST /api/crm/compliance/consent { contact_id, channel, consent_type, method, source, program?, business_named? }
router.post('/consent', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, channel, ...data } = req.body || {};
    if (!contact_id || !channel) return res.status(400).json({ error: 'contact_id and channel required' });
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const rec = await consent.record(companyId, contact_id, channel, data);
    await contactDb.addActivity(contact_id, {
      type: 'consent_granted',
      message: `Consent (${rec.consent_type}) recorded for ${channel}${data.method ? ' via ' + data.method : ''}`,
      channel, data: { program: rec.program, source: data.source || null },
    }, companyId);
    res.json({ consent: rec });
  } catch (e) { console.error('[Compliance] consent POST', e.message); res.status(500).json({ error: 'failed' }); }
});

// DELETE /api/crm/compliance/consent { contact_id, channel, program? } → revoke
router.delete('/consent', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, channel, program } = req.body || {};
    if (!contact_id || !channel) return res.status(400).json({ error: 'contact_id and channel required' });
    res.json({ consent: await consent.revoke(companyId, contact_id, channel, program || 'default') });
  } catch (e) { console.error('[Compliance] consent DELETE', e.message); res.status(500).json({ error: 'failed' }); }
});

// ── Suppression (opt-out) ─────────────────────────────────────────────────────
router.get('/suppression', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    res.json({ suppression: await suppression.list(companyId, req.query.channel, {
      limit: parseInt(req.query.limit, 10) || 200, offset: parseInt(req.query.offset, 10) || 0 }) });
  } catch (e) { console.error('[Compliance] suppression GET', e.message); res.status(500).json({ error: 'failed' }); }
});

// POST /api/crm/compliance/suppression { channel, identifier, reason?, contact_id? }
router.post('/suppression', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { channel, identifier, reason, contact_id } = req.body || {};
    if (!channel || !identifier) return res.status(400).json({ error: 'channel and identifier required' });
    res.json({ suppression: await suppression.add(companyId, channel, identifier, { reason, contactId: contact_id || null }) });
  } catch (e) { console.error('[Compliance] suppression POST', e.message); res.status(500).json({ error: 'failed' }); }
});

// POST /api/crm/compliance/suppression/resubscribe { channel, identifier }
router.post('/suppression/resubscribe', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { channel, identifier } = req.body || {};
    if (!channel || !identifier) return res.status(400).json({ error: 'channel and identifier required' });
    res.json({ suppression: await suppression.resubscribe(companyId, channel, identifier) });
  } catch (e) { console.error('[Compliance] resubscribe', e.message); res.status(500).json({ error: 'failed' }); }
});

// ── SMS segment / encoding preview ────────────────────────────────────────────
// GET /api/crm/compliance/segments?text=...  → { encoding, chars, units, segments, remaining }
router.get('/segments', (req, res) => {
  res.json(segments.analyze(req.query.text || ''));
});

// ── Regional policy lookup ────────────────────────────────────────────────────
// GET /api/crm/compliance/region?country=US
router.get('/region', (req, res) => {
  if (req.query.country) return res.json({ policy: policyFor(req.query.country) });
  res.json({ regions: REGIONS });
});

// ── Dry-run the pre-send gate (UI can pre-check before offering "send") ────────
// POST /api/crm/compliance/precheck { contact_id, channel, category?, windowOpen?, template?, destinationCountry? }
router.post('/precheck', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const b = req.body || {};
    const contact = b.contact_id ? await contactDb.getById(b.contact_id, companyId) : null;
    const result = await gate.check({
      companyId, channel: b.channel, contact,
      identifier: b.identifier, category: b.category, program: b.program,
      windowOpen: b.windowOpen, template: b.template, destinationCountry: b.destinationCountry,
    });
    res.json(result);
  } catch (e) { console.error('[Compliance] precheck', e.message); res.status(500).json({ error: 'failed' }); }
});

module.exports = router;
