'use strict';
// ─── CP4a rev 2: executor control surface ────────────────────────────────────
// Mounted at /api/crm/executors. Deliberately NOT a daemon: one tick = one
// batch, driven by cron or an operator, so there is no extra process lifecycle
// to keep alive and stopping the world is `EMAIL_EXECUTOR_ENABLED=0`.
const express = require('express');
const router = express.Router();
const emailExecutor = require('../lib/email-executor');
const { byChannel, CHANNELS } = require('../lib/executors');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/crm/executors/email/status — is sending on, and why not?
router.get('/email/status', (req, res) => {
  const blocked = emailExecutor.bootGate();
  res.json({
    channel: 'email',
    enabled: !blocked,
    blocked_reason: blocked,
    instance: emailExecutor.INSTANCE_ID,
    sender: emailExecutor.senderFor('email'),
  });
});

// POST /api/crm/executors/email/tick — run one batch for this tenant.
router.post('/email/tick', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const maxAgeHours = req.body && req.body.max_age_hours ? Number(req.body.max_age_hours) : null;
    if (maxAgeHours !== null && (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)) {
      return res.status(400).json({ error: 'max_age_hours must be a positive number' });
    }
    const report = await emailExecutor.tick(companyId, { maxAgeHours });
    // A blocked tick is a 200 with `ok:false` — it is a legitimate, expected
    // state (sending is off, or misconfigured), not a request error.
    res.json(report);
  } catch (err) {
    console.error('[CRM] POST /executors/email/tick error:', err.message);
    res.status(500).json({ error: 'tick failed' });
  }
});

// GET /api/crm/executors/email/quarantine — sends whose outcome is unknown.
// The whole justification for quarantining rather than retrying is that a human
// decides, so this list has to exist.
router.get('/email/quarantine', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const rows = await emailExecutor.listQuarantine(companyId, { limit: req.query.limit });
    res.json({ total: rows.length, quarantined: rows });
  } catch (err) {
    console.error('[CRM] GET /executors/email/quarantine error:', err.message);
    res.status(500).json({ error: 'failed to list quarantine' });
  }
});

// POST /api/crm/executors/email/quarantine/:id/release  { decision: resend|discard }
router.post('/email/quarantine/:id/release', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const decision = req.body && req.body.decision;
    if (!['resend', 'discard'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'resend' (it never arrived) or 'discard' (it did)" });
    }
    const out = await emailExecutor.releaseQuarantine(companyId, req.params.id, decision);
    if (!out) return res.status(404).json({ error: 'quarantined job not found' });
    res.json(out);
  } catch (err) {
    console.error('[CRM] POST /executors/email/quarantine/:id/release error:', err.message);
    res.status(500).json({ error: 'failed to release' });
  }
});

// ─── CP-C: the same four operations for every channel ────────────────────────
// `/email/*` above is kept because it is already wired and tested; these are the
// same operations addressed generically, and they resolve to the SAME executor
// instances — there is one implementation, not a per-channel copy.
function resolve(req, res) {
  const ex = byChannel[req.params.channel];
  if (!ex) {
    res.status(404).json({ error: `no executor for channel '${req.params.channel}'`, channels: CHANNELS });
    return null;
  }
  return ex;
}

router.get('/:channel/status', (req, res) => {
  const ex = resolve(req, res); if (!ex) return;
  const blocked = ex.bootGate();
  res.json({ channel: ex.channel, enabled: !blocked, blocked_reason: blocked,
    instance: ex.INSTANCE_ID, sender: ex.senderFor() });
});

router.post('/:channel/tick', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const ex = resolve(req, res); if (!ex) return;
    res.json(await ex.tick(companyId));
  } catch (err) {
    console.error('[CRM] POST /executors/:channel/tick error:', err.message);
    res.status(500).json({ error: 'tick failed' });
  }
});

router.get('/:channel/quarantine', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const ex = resolve(req, res); if (!ex) return;
    const rows = await ex.listQuarantine(companyId, { limit: req.query.limit });
    res.json({ channel: ex.channel, total: rows.length, quarantined: rows });
  } catch (err) {
    console.error('[CRM] GET /executors/:channel/quarantine error:', err.message);
    res.status(500).json({ error: 'failed to list quarantine' });
  }
});

router.post('/:channel/quarantine/:id/release', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const ex = resolve(req, res); if (!ex) return;
    const decision = req.body && req.body.decision;
    if (!['resend', 'discard'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'resend' (it never arrived) or 'discard' (it did)" });
    }
    const out = await ex.releaseQuarantine(companyId, req.params.id, decision);
    if (!out) return res.status(404).json({ error: 'quarantined job not found' });
    res.json(out);
  } catch (err) {
    console.error('[CRM] POST /executors/:channel/quarantine/:id/release error:', err.message);
    res.status(500).json({ error: 'failed to release' });
  }
});

module.exports = router;
