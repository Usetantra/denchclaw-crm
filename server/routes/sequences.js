'use strict';
// ─── Sequences API (Goal B) ───────────────────────────────────────────────────
// CRUD for multi-channel sequences + steps, plus manual enrollment and the
// enrollment views. Stage-triggered enrollment (B2) and the dispatcher (B3) reuse
// this DAL. All handlers are company-scoped via requireAuth.
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const seq = require('../db/models/sequences');
const contactDb = require('../db/models/contacts');
const dispatcher = require('../lib/sequence-dispatcher');

router.use(requireAuth);

// ── Executor job API (B4) ─────────────────────────────────────────────────────
// External engine executors own a channel (SEQUENCE_EXTERNAL_CHANNELS) and pull
// its due jobs here, do the send themselves, then post the result back. The
// built-in dispatcher skips those channels, so exactly one worker handles each.
// Claims are per-tenant, in-flight-marked ('claimed'), and reaped if unacked.
const RESULT_STATUS = { sent: 'sent', delivered: 'sent', failed: 'failed', skipped: 'skipped' };

router.post('/jobs/claim', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const channel = req.body && req.body.channel;
    if (!channel) return res.status(400).json({ error: 'channel required' });
    const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 10, 50);
    const actions = await seq.claimDueActions({ company: companyId, includeChannels: [channel], limit });
    const jobs = [];
    for (const a of actions) {
      const contact = await contactDb.getById(a.contact_id, companyId);
      const sequence = await seq.get(companyId, a.sequence_id);
      const step = ((sequence && sequence.steps) || []).find(s => s.id === a.step_id) || {};
      jobs.push({
        job_id: a.id, channel: a.channel, step_order: a.step_order, run_at: a.run_at, attempts: a.attempts,
        contact: contact
          ? { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone, wa_id: contact.wa_id, destination_country: contact.destination_country }
          : { id: a.contact_id },
        message: {
          body: step.body || null, subject: step.subject || null, template_id: step.template_id || null,
          category: step.category || null, template_variables: (step.metadata && step.metadata.template_variables) || null,
        },
      });
    }
    res.json({ jobs });
  } catch (e) { console.error('[Sequences] jobs/claim', e.message); res.status(500).json({ error: 'failed' }); }
});

router.post('/jobs/:id/result', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const status = RESULT_STATUS[(req.body && req.body.status) || ''];
    if (!status) return res.status(400).json({ error: 'status must be sent|delivered|failed|skipped' });
    const a = await seq.getAction(companyId, req.params.id);
    if (!a) return res.status(404).json({ error: 'job not found' });
    await seq.completeAction(companyId, a, {
      status,
      result: { provider_message_id: (req.body && req.body.provider_message_id) || null, via: 'executor' },
      error: (req.body && req.body.error) || null,
    });
    res.json({ ok: true });
  } catch (e) { console.error('[Sequences] jobs/result', e.message); res.status(500).json({ error: 'failed' }); }
});

// Force one dispatcher tick now (ops: drain due steps on demand; tests: make the
// send loop deterministic instead of waiting for the interval). Company-agnostic —
// the dispatcher processes all due actions — but gated behind internal auth.
router.post('/_tick', async (req, res) => {
  try { res.json(await dispatcher.tick()); }
  catch (e) { console.error('[Sequences] manual tick', e.message); res.status(500).json({ error: 'failed' }); }
});

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
