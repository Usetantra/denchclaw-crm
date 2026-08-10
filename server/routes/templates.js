'use strict';
// ─── Template Manager API ─────────────────────────────────────────────────────
// Author WhatsApp templates in the CRM, submit for approval via Twilio's Content
// API (forwarded to Meta), sync approval status back, edit (versioned), archive,
// categorize. Validation mirrors Meta's rules so bad templates are caught before
// submission.
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const tpl = require('../db/models/templates');
const channels = require('../db/models/channels');
const twilio = require('../lib/twilio');

router.use(requireAuth);

const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

// Validate a template against Meta's rules; returns array of error strings.
function validate(t) {
  const errs = [];
  if (!t.name || !/^[a-z0-9_]{1,512}$/.test(t.name)) errs.push('name must be lowercase letters, numbers, underscores');
  if (!CATEGORIES.includes(String(t.category || '').toUpperCase())) errs.push('category must be MARKETING, UTILITY or AUTHENTICATION');
  const body = String(t.body || '');
  if (!body.trim()) errs.push('body is required');
  if (body.length > 1024) errs.push('body exceeds 1024 characters');
  if (/^\s*\{\{/.test(body) || /\}\}\s*$/.test(body)) errs.push('body cannot start or end with a variable');
  if (/[#$%]/.test((body.match(/\{\{[^}]*\}\}/g) || []).join(''))) errs.push('variables cannot contain # $ %');
  if (t.footer && String(t.footer).length > 60) errs.push('footer exceeds 60 characters');
  if (t.header && t.header.type === 'text' && String(t.header.text || '').length > 60) errs.push('header text exceeds 60 characters');
  for (const b of (t.buttons || [])) {
    if (b.title && String(b.title).length > 25) errs.push('button text exceeds 25 characters');
  }
  if ((t.buttons || []).length > 10) errs.push('at most 10 buttons');
  if (String(t.category).toUpperCase() === 'AUTHENTICATION') {
    if (/https?:\/\//i.test(body) || (t.header && t.header.media)) errs.push('authentication templates cannot contain URLs or media');
  }
  return errs;
}

router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    res.json({ templates: await tpl.list(companyId, { channel: req.query.channel, status: req.query.status, includeArchived: req.query.includeArchived === 'true' }) });
  } catch (e) { console.error('[Templates] list', e.message); res.status(500).json({ error: 'failed' }); }
});

router.get('/:id', async (req, res) => {
  try { const t = await tpl.get(getUserCompanyId(req), req.params.id); if (!t) return res.status(404).json({ error: 'not found' }); res.json({ template: t }); }
  catch (e) { console.error('[Templates] get', e.message); res.status(500).json({ error: 'failed' }); }
});

router.get('/:id/versions', async (req, res) => {
  try { res.json({ versions: await tpl.versions(getUserCompanyId(req), req.params.id) }); }
  catch (e) { console.error('[Templates] versions', e.message); res.status(500).json({ error: 'failed' }); }
});

router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const errs = validate(req.body || {});
    if (errs.length) return res.status(400).json({ error: 'validation failed', errors: errs });
    res.json({ template: await tpl.create(companyId, req.body) });
  } catch (e) { console.error('[Templates] create', e.message); res.status(500).json({ error: 'failed' }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const cur = await tpl.get(companyId, req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const merged = { ...cur, ...req.body };
    const errs = validate(merged);
    if (errs.length) return res.status(400).json({ error: 'validation failed', errors: errs });
    res.json({ template: await tpl.update(companyId, req.params.id, req.body) });
  } catch (e) { console.error('[Templates] update', e.message); res.status(500).json({ error: 'failed' }); }
});

// Submit to Twilio Content + WhatsApp approval (→ Meta). Sets status PENDING.
router.post('/:id/submit', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const t = await tpl.get(companyId, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const errs = validate(t);
    if (errs.length) return res.status(400).json({ error: 'validation failed', errors: errs });
    const conn = await channels.getConnection(companyId, 'twilio');
    if (!conn || conn.status !== 'connected' || !conn.credentials) return res.status(409).json({ error: 'Twilio not connected' });

    let contentSid = t.provider_template_id;
    if (!contentSid) {
      const content = await twilio.createContent(conn.credentials, {
        name: t.name, language: t.language, body: t.body, footer: t.footer,
        header: t.header, buttons: t.buttons, variables_map: buildVarMap(t.variables),
      });
      contentSid = content.sid;
    }
    await twilio.submitApproval(conn.credentials, contentSid, { name: t.name, category: t.category });
    const updated = await tpl.setProvider(companyId, req.params.id, { providerTemplateId: contentSid, status: 'PENDING', submittedCategory: t.category });
    res.json({ template: updated });
  } catch (e) { console.error('[Templates] submit', e.message); res.status(502).json({ error: e.message }); }
});

// Pull latest approval status from Twilio/Meta.
router.post('/:id/sync', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const t = await tpl.get(companyId, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    if (!t.provider_template_id) return res.status(409).json({ error: 'template has not been submitted yet' });
    const conn = await channels.getConnection(companyId, 'twilio');
    if (!conn || !conn.credentials) return res.status(409).json({ error: 'Twilio not connected' });
    const ap = await twilio.fetchApproval(conn.credentials, t.provider_template_id);
    const status = ({ approved: 'APPROVED', rejected: 'REJECTED', pending: 'PENDING', received: 'PENDING', paused: 'PAUSED', disabled: 'DISABLED' })[String(ap.status).toLowerCase()] || t.status;
    res.json({ template: await tpl.syncStatus(companyId, req.params.id, { status, currentCategory: ap.category, rejectionReason: ap.rejection_reason }) });
  } catch (e) { console.error('[Templates] sync', e.message); res.status(502).json({ error: e.message }); }
});

router.post('/:id/archive', async (req, res) => {
  try { res.json({ template: await tpl.archive(getUserCompanyId(req), req.params.id) }); }
  catch (e) { console.error('[Templates] archive', e.message); res.status(500).json({ error: 'failed' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const t = await tpl.get(companyId, req.params.id);
    if (t && t.provider_template_id) {
      const conn = await channels.getConnection(companyId, 'twilio');
      if (conn && conn.credentials) { try { await twilio.deleteContent(conn.credentials, t.provider_template_id); } catch (_e) {} }
    }
    await tpl.remove(companyId, req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error('[Templates] delete', e.message); res.status(500).json({ error: 'failed' }); }
});

// [{name|index, example}] → Twilio Content variables map { "1": example, ... }
function buildVarMap(vars) {
  const m = {};
  (vars || []).forEach((v, i) => { m[String(v.name || v.index || i + 1)] = v.example || ''; });
  return m;
}

module.exports = router;
