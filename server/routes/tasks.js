'use strict';
// ─── Tasks (human follow-up reminders) ─────────────────────────────────────
// Distinct from Sequences (automated/bot-sent). A task is either created
// manually from a contact, or auto-generated when a stage with
// `reminder_days` is entered (server/lib/stage-reminders.js). This route
// never sends anything — it only tracks "a human should do X by Y."
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const tasksDb = require('../db/models/tasks');
const contactDb = require('../db/models/contacts');

router.use(requireAuth);

// GET /api/crm/tasks?status=pending&contact_id=&due_before=&limit=&offset=
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { status, contact_id, due_before, limit, offset } = req.query;
    const tasks = await tasksDb.list(companyId, { status, contactId: contact_id, dueBefore: due_before, limit, offset });
    res.json({ tasks });
  } catch (e) {
    console.error('[Tasks] GET /', e.message);
    res.status(500).json({ error: 'failed to load tasks' });
  }
});

// GET /api/crm/tasks/summary — overdue/due-today/total counts (Dashboard badge).
router.get('/summary', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    res.json(await tasksDb.countDueByStatus(companyId, 'pending'));
  } catch (e) {
    console.error('[Tasks] GET /summary', e.message);
    res.status(500).json({ error: 'failed to load task summary' });
  }
});

// POST /api/crm/tasks { contact_id, deal_id?, title, notes?, due_at }
router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, deal_id, title, notes, due_at } = req.body || {};
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const task = await tasksDb.create(companyId, { contactId: contact_id, dealId: deal_id, title, notes, dueAt: due_at });
    res.status(201).json({ task });
  } catch (e) {
    if (/required/.test(e.message)) return res.status(400).json({ error: e.message });
    console.error('[Tasks] POST /', e.message);
    res.status(500).json({ error: 'failed to create task' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { title, notes, due_at, status } = req.body || {};
    const task = await tasksDb.update(companyId, req.params.id, { title, notes, dueAt: due_at, status });
    if (!task) return res.status(404).json({ error: 'task not found' });
    res.json({ task });
  } catch (e) {
    if (/must be/.test(e.message)) return res.status(400).json({ error: e.message });
    console.error('[Tasks] PATCH /:id', e.message);
    res.status(500).json({ error: 'failed to update task' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const n = await tasksDb.remove(companyId, req.params.id);
    if (!n) return res.status(404).json({ error: 'task not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Tasks] DELETE /:id', e.message);
    res.status(500).json({ error: 'failed to delete task' });
  }
});

module.exports = router;
