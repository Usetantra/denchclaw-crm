'use strict';
// ─── Sequences API (Goal B) ───────────────────────────────────────────────────
// CRUD for multi-channel sequences + steps, plus manual enrollment and the
// enrollment views. Stage-triggered enrollment (B2) and the dispatcher (B3) reuse
// this DAL. All handlers are company-scoped via requireAuth.
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const seq = require('../db/models/sequences');

router.use(requireAuth);

const CHANNELS = new Set(['email', 'whatsapp', 'sms', 'linkedin', 'wait']);

function validate(s) {
  const errs = [];
  if (!s.name || !String(s.name).trim()) errs.push('name is required');
  for (const [i, st] of (s.steps || []).entries()) {
    if (!CHANNELS.has(st.channel)) errs.push(`step ${i + 1}: channel must be one of ${[...CHANNELS].join(', ')}`);
    if (st.channel !== 'wait' && !st.template_id && !st.body) errs.push(`step ${i + 1}: needs a template or a body`);
    if (st.delay_minutes != null && (isNaN(parseInt(st.delay_minutes, 10)) || parseInt(st.delay_minutes, 10) < 0)) errs.push(`step ${i + 1}: delay_minutes must be >= 0`);
  }
  return errs;
}

router.get('/', async (req, res) => {
  try {
    res.json({ sequences: await seq.list(getUserCompanyId(req), { status: req.query.status, includeArchived: req.query.includeArchived === 'true' }) });
  } catch (e) { console.error('[Sequences] list', e.message); res.status(500).json({ error: 'failed' }); }
});

// Enrollments for a contact (drawer/inbox): /sequences/enrollments?contact_id=…
router.get('/enrollments', async (req, res) => {
  try {
    res.json({ enrollments: await seq.listEnrollments(getUserCompanyId(req), { contactId: req.query.contact_id, status: req.query.status }) });
  } catch (e) { console.error('[Sequences] enrollments', e.message); res.status(500).json({ error: 'failed' }); }
});

router.post('/enrollments/:id/exit', async (req, res) => {
  try {
    const r = await seq.exitEnrollment(getUserCompanyId(req), req.params.id, (req.body && req.body.reason) || 'manual');
    if (!r) return res.status(404).json({ error: 'enrollment not found or not active' });
    res.json({ enrollment: r });
  } catch (e) { console.error('[Sequences] exit', e.message); res.status(500).json({ error: 'failed' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const s = await seq.get(getUserCompanyId(req), req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({ sequence: s });
  } catch (e) { console.error('[Sequences] get', e.message); res.status(500).json({ error: 'failed' }); }
});

router.post('/', async (req, res) => {
  try {
    const errs = validate(req.body || {});
    if (errs.length) return res.status(400).json({ error: 'validation failed', errors: errs });
    res.json({ sequence: await seq.create(getUserCompanyId(req), req.body) });
  } catch (e) { console.error('[Sequences] create', e.message); res.status(500).json({ error: 'failed' }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const cur = await seq.get(companyId, req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    const errs = validate({ ...cur, ...req.body });
    if (errs.length) return res.status(400).json({ error: 'validation failed', errors: errs });
    res.json({ sequence: await seq.update(companyId, req.params.id, req.body) });
  } catch (e) { console.error('[Sequences] update', e.message); res.status(500).json({ error: 'failed' }); }
});

// Activate / pause / archive.
router.post('/:id/status', async (req, res) => {
  try {
    const status = (req.body && req.body.status) || '';
    if (!['draft', 'active', 'paused', 'archived'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    const s = await seq.setStatus(getUserCompanyId(req), req.params.id, status);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({ sequence: s });
  } catch (e) { console.error('[Sequences] status', e.message); res.status(500).json({ error: 'failed' }); }
});

router.delete('/:id', async (req, res) => {
  try { await seq.remove(getUserCompanyId(req), req.params.id); res.json({ ok: true }); }
  catch (e) { console.error('[Sequences] delete', e.message); res.status(500).json({ error: 'failed' }); }
});

// Manually enroll a contact.
router.post('/:id/enroll', async (req, res) => {
  try {
    const contactId = req.body && req.body.contact_id;
    if (!contactId) return res.status(400).json({ error: 'contact_id required' });
    const r = await seq.enroll(getUserCompanyId(req), req.params.id, contactId, { enrolledBy: 'api' });
    if (!r.enrollment) return res.status(409).json({ error: r.reason || 'could not enroll', reason: r.reason });
    res.json({ enrollment: r.enrollment, created: r.created });
  } catch (e) { console.error('[Sequences] enroll', e.message); res.status(500).json({ error: 'failed' }); }
});

router.get('/:id/enrollments', async (req, res) => {
  try {
    res.json({ enrollments: await seq.listEnrollments(getUserCompanyId(req), { sequenceId: req.params.id, status: req.query.status }) });
  } catch (e) { console.error('[Sequences] seq enrollments', e.message); res.status(500).json({ error: 'failed' }); }
});

module.exports = router;
