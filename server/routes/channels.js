'use strict';
// ─── Channels connect API (Settings → Channels) ───────────────────────────────
// Self-serve provider connection + sender management, stored per-company. Secrets
// are verified against the provider, encrypted at rest, and never returned to the
// client. Scales from a single account today to multi-tenant later.
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const channels = require('../db/models/channels');
const twilio = require('../lib/twilio');

router.use(requireAuth);

// GET /api/crm/channels — connections + senders (no secrets).
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const [connections, senders] = await Promise.all([
      channels.listConnections(companyId),
      channels.listSenders(companyId),
    ]);
    res.json({ connections, senders });
  } catch (e) { console.error('[Channels] GET', e.message); res.status(500).json({ error: 'failed' }); }
});

// POST /api/crm/channels/twilio/connect { account_sid, auth_token? , api_key_sid?, api_key_secret? }
// Verifies against Twilio, then stores encrypted. Returns status only.
router.post('/twilio/connect', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { account_sid, auth_token, api_key_sid, api_key_secret } = req.body || {};
    if (!account_sid) return res.status(400).json({ error: 'account_sid required' });
    const creds = { account_sid, auth_token, api_key_sid, api_key_secret };
    let acct;
    try { acct = await twilio.verify(creds); }
    catch (e) { return res.status(400).json({ error: `Twilio rejected the credentials — ${e.message}` }); }
    await channels.upsertConnection(companyId, 'twilio', {
      accountRef: acct.account_sid, credentials: creds, status: 'connected',
    });
    res.json({ ok: true, provider: 'twilio', account: acct });
  } catch (e) { console.error('[Channels] connect', e.message); res.status(500).json({ error: 'failed' }); }
});

// POST /api/crm/channels/twilio/disconnect
router.post('/twilio/disconnect', async (req, res) => {
  try { await channels.disconnect(getUserCompanyId(req), 'twilio'); res.json({ ok: true }); }
  catch (e) { console.error('[Channels] disconnect', e.message); res.status(500).json({ error: 'failed' }); }
});

// GET /api/crm/channels/twilio/numbers — list numbers on the connected account.
router.get('/twilio/numbers', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const conn = await channels.getConnection(companyId, 'twilio');
    if (!conn || conn.status !== 'connected' || !conn.credentials) return res.status(409).json({ error: 'Twilio not connected' });
    res.json({ numbers: await twilio.listNumbers(conn.credentials) });
  } catch (e) { console.error('[Channels] numbers', e.message); res.status(502).json({ error: e.message }); }
});

// GET /api/crm/channels/twilio/whatsapp-senders — registered WhatsApp senders.
router.get('/twilio/whatsapp-senders', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const conn = await channels.getConnection(companyId, 'twilio');
    if (!conn || conn.status !== 'connected' || !conn.credentials) return res.status(409).json({ error: 'Twilio not connected' });
    res.json({ senders: await twilio.listWhatsAppSenders(conn.credentials) });
  } catch (e) { console.error('[Channels] wa-senders', e.message); res.status(502).json({ error: e.message }); }
});

// POST /api/crm/channels/senders { channel, identifier, label?, country?, ... }
router.post('/senders', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const s = req.body || {};
    if (!s.channel || !s.identifier) return res.status(400).json({ error: 'channel and identifier required' });
    res.json({ sender: await channels.addSender(companyId, s) });
  } catch (e) { console.error('[Channels] addSender', e.message); res.status(500).json({ error: 'failed' }); }
});

// PATCH /api/crm/channels/senders/:id — update registration/quality/status fields.
router.patch('/senders/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const sender = await channels.updateSenderStatus(companyId, req.params.id, req.body || {});
    if (!sender) return res.status(404).json({ error: 'sender not found or no fields' });
    res.json({ sender });
  } catch (e) { console.error('[Channels] updateSender', e.message); res.status(500).json({ error: 'failed' }); }
});

// DELETE /api/crm/channels/senders/:id
router.delete('/senders/:id', async (req, res) => {
  try { await channels.removeSender(getUserCompanyId(req), req.params.id); res.json({ ok: true }); }
  catch (e) { console.error('[Channels] removeSender', e.message); res.status(500).json({ error: 'failed' }); }
});

module.exports = router;
