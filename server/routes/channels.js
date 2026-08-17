'use strict';
// ─── Channels connect API (Settings → Channels) ───────────────────────────────
// Self-serve provider connection + sender management, stored per-company. Secrets
// are verified against the provider, encrypted at rest, and never returned to the
// client. Scales from a single account today to multi-tenant later.
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const channels = require('../db/models/channels');
const linkedinAccounts = require('../db/models/linkedin-accounts');
const twilio = require('../lib/twilio');
const resendEmail = require('../lib/email-resend');

router.use(requireAuth);

// GET /api/crm/channels — connections + senders (no secrets) + linkedin_accounts.
// email_configured reflects RESEND_API_KEY, which is global infrastructure (one
// Resend account sends for every tenant, verified sender identities per tenant
// via `senders` below) — not a per-tenant secret the way Twilio's is, so there
// is no per-tenant "connect" step for it, only sender management.
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const [connections, senders, linkedin] = await Promise.all([
      channels.listConnections(companyId),
      channels.listSenders(companyId),
      linkedinAccounts.list(companyId),
    ]);
    res.json({ connections, senders, linkedin_accounts: linkedin, email_configured: resendEmail.isConfigured() });
  } catch (e) { console.error('[Channels] GET', e.message); res.status(500).json({ error: 'failed' }); }
});

// ─── LinkedIn (Unipile) ────────────────────────────────────────────────────────
// Unlike Twilio, there is no credential pair to verify here — the account_id is
// obtained by completing Unipile's own hosted LinkedIn login flow outside this
// app (Unipile does not document a way to originate that flow from a bare API
// key + DSN in a way this codebase could verify against a real account without
// guessing at an unconfirmed endpoint contract), then pasted in here. This
// mirrors exactly what an operator already had to do by hand directly against
// the database — this just gives them a real UI + API for it instead.
//
// POST /api/crm/channels/linkedin/connect
//   { account_id, display_name?, timezone?, engine_dispatch_disabled }
router.post('/linkedin/connect', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { account_id, display_name, timezone, engine_dispatch_disabled } = req.body || {};
    if (!account_id || !String(account_id).trim()) return res.status(400).json({ error: 'account_id required' });
    // Fails closed (server/lib/linkedin-gate.js admits()) — an unconfirmed
    // account cannot send at all, so refuse to even PRESENT it as connected
    // without the operator's explicit assertion, rather than silently landing
    // in a state that looks connected but never sends.
    if (engine_dispatch_disabled !== true) {
      return res.status(400).json({
        error: 'you must confirm the separate outreach engine\'s LinkedIn dispatch is OFF for this account before it can send — set engine_dispatch_disabled:true once you have checked',
      });
    }
    const account = await linkedinAccounts.connect(companyId, {
      accountId: String(account_id).trim(), displayName: display_name || null, timezone: timezone || null,
      engineDispatchDisabled: true,
    });
    res.json({ ok: true, account });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'this account_id is already connected to a different company' });
    console.error('[Channels] linkedin connect', e.message); res.status(500).json({ error: 'failed' });
  }
});

// PATCH /api/crm/channels/linkedin/:id — caps, schedule, pause/resume, the
// engine-dispatch confirmation, display_name.
router.patch('/linkedin/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const account = await linkedinAccounts.update(companyId, req.params.id, req.body || {});
    if (!account) return res.status(404).json({ error: 'account not found or no editable fields given' });
    res.json({ account });
  } catch (e) { console.error('[Channels] linkedin update', e.message); res.status(500).json({ error: 'failed' }); }
});

// DELETE /api/crm/channels/linkedin/:id
router.delete('/linkedin/:id', async (req, res) => {
  try { await linkedinAccounts.remove(getUserCompanyId(req), req.params.id); res.json({ ok: true }); }
  catch (e) { console.error('[Channels] linkedin remove', e.message); res.status(500).json({ error: 'failed' }); }
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
