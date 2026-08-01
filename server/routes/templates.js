'use strict';
// ─── CP4a-0: message template CRUD + content readiness ───────────────────────
// Mounted at /api/crm/templates.
//
// This is the surface an operator uses to author what actually goes out, and —
// more importantly — the surface that answers "is this sequence safe to switch
// on?" BEFORE a ladder fires at anyone. Until CP4a-0 the honest answer was "no,
// every step would send a blank email", and nothing in the product could say so.
//
// Everything is tenant-scoped; a cross-tenant ref is a 404, never a 403 and
// never an empty 200.
const express = require('express');
const router = express.Router();
const templatesDb = require('../db/models/templates');
const seqDb = require('../db/models/sequences');
const contactDb = require('../db/models/contacts');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

// The known channel vocabulary. Wider than the sendable set on purpose — see
// routes/sequences.js. The GET filter below accepts the full vocabulary (you may
// legitimately want to LIST copy for a channel you cannot yet send on); only
// authoring new copy is narrowed.
const CHANNELS = ['email', 'sms', 'whatsapp', 'ai_call', 'linkedin'];
const { canSend, CHANNELS: SENDABLE } = require('../lib/executors');

// GET /api/crm/templates?channel=
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const channel = req.query.channel || null;
    if (channel && !CHANNELS.includes(channel)) return res.status(400).json({ error: `unknown channel '${channel}'` });
    const templates = await templatesDb.listTemplates(companyId, { channel });
    res.json({ total: templates.length, templates });
  } catch (err) {
    console.error('[CRM] GET /templates error:', err.message);
    res.status(500).json({ error: 'failed to list templates' });
  }
});

// GET /api/crm/templates/:ref
router.get('/:ref', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const t = await templatesDb.getTemplate(companyId, req.params.ref);
    if (!t) return res.status(404).json({ error: 'template not found' });
    res.json(t);
  } catch (err) {
    console.error('[CRM] GET /templates/:ref error:', err.message);
    res.status(500).json({ error: 'failed to load template' });
  }
});

// POST /api/crm/templates  { ref, channel?, subject?, body }
// Upsert by (tenant, ref) — authoring the same ref twice edits it rather than
// producing a second row the resolver would have to choose between.
router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { ref, channel = null, subject = null, body } = req.body || {};
    if (!ref || !String(ref).trim()) return res.status(400).json({ error: 'ref required' });
    // The whole point of this checkpoint: content cannot be empty. A blank body
    // is the hazard, so it is refused at the only door that creates content.
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required and must not be blank' });
    if (channel && !CHANNELS.includes(channel)) return res.status(400).json({ error: `unknown channel '${channel}'` });
    // CP-Z: authoring copy PINNED to a channel nothing can send is a trap that
    // only surfaces later, as a step that will not fire.
    if (channel && !canSend(channel)) {
      return res.status(422).json({
        error: `no executor exists for channel '${channel}' — copy pinned to it could never be sent`,
        channel, sendable_channels: SENDABLE,
      });
    }
    const t = await templatesDb.upsertTemplate(companyId, { ref, channel, subject, body });
    res.status(201).json(t);
  } catch (err) {
    console.error('[CRM] POST /templates error:', err.message);
    res.status(500).json({ error: 'failed to save template' });
  }
});

// DELETE /api/crm/templates/:ref
router.delete('/:ref', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const gone = await templatesDb.deleteTemplate(companyId, req.params.ref);
    if (!gone) return res.status(404).json({ error: 'template not found' });
    res.json({ ok: true, ref: req.params.ref });
  } catch (err) {
    console.error('[CRM] DELETE /templates/:ref error:', err.message);
    res.status(500).json({ error: 'failed to delete template' });
  }
});

// POST /api/crm/templates/preview  { ref? , subject?, body?, contact_id? }
// Renders content against a real contact so an operator sees the actual words a
// prospect would receive, tokens and all, without sending anything.
router.post('/preview', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { ref = null, subject = null, body = null, contact_id = null, channel = 'email' } = req.body || {};
    let contact = null;
    if (contact_id) {
      contact = await contactDb.getById(contact_id, companyId);
      if (!contact) return res.status(404).json({ error: 'contact not found' });
    }
    const pseudoStep = { channel, template_ref: ref, subject, body };
    const resolved = await templatesDb.resolveStepContent(companyId, pseudoStep, contact);
    res.json({ ...resolved, sent: false });
  } catch (err) {
    console.error('[CRM] POST /templates/preview error:', err.message);
    res.status(500).json({ error: 'failed to preview' });
  }
});

module.exports = router;
