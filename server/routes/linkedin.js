'use strict';
// ─── LinkedIn channel endpoints (inbox composer) ──────────────────────────────
// Connected accounts for the From dropdown, hosted connect-links, profile /
// connection-distance checks, and connection requests.
const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const contactDb = require('../db/models/contacts');
const li = require('../lib/linkedin-unipile');

router.use(requireAuth);

function linkedinIdent(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : '';
}

// GET /api/crm/linkedin/accounts — connected LinkedIn accounts.
router.get('/accounts', async (req, res) => {
  try {
    if (!li.isConfigured()) return res.json({ configured: false, accounts: [] });
    const accounts = await li.listAccounts();
    res.json({ configured: true, default_account_id: li.defaultAccountId(), accounts });
  } catch (e) {
    console.error('[LinkedIn] accounts error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// POST /api/crm/linkedin/connect-link — hosted-auth URL to connect a new account.
router.post('/connect-link', async (req, res) => {
  try {
    const { url } = await li.hostedAuthLink({ name: getUserCompanyId(req) });
    if (!url) return res.status(502).json({ error: 'Unipile returned no connect URL' });
    res.json({ url });
  } catch (e) {
    console.error('[LinkedIn] connect-link error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// GET /api/crm/linkedin/profile?contact_id=&account_id=
// Resolve the contact's LinkedIn profile from that account's viewpoint. The
// composer uses `connected` to decide between "message" and "connection request".
router.get('/profile', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, account_id } = req.query;
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const ident = linkedinIdent(contact.linkedin_url);
    if (!ident) return res.json({ has_linkedin: false });
    const account = account_id || li.defaultAccountId();
    if (!account) return res.status(422).json({ error: 'no LinkedIn account connected' });
    const p = await li.resolveProfile(ident, account);
    res.json({ has_linkedin: true, ...p, connected: p.distance === 'FIRST_DEGREE' });
  } catch (e) {
    console.error('[LinkedIn] profile error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// POST /api/crm/linkedin/invite — send a connection request to the contact
// { contact_id, account_id?, message? (≤300 chars) }
router.post('/invite', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, account_id, message } = req.body || {};
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const ident = linkedinIdent(contact.linkedin_url);
    if (!ident) return res.status(400).json({ error: 'contact has no LinkedIn profile URL' });
    if (!li.sendEnabled()) return res.status(503).json({ error: 'LinkedIn sending is disabled (set LINKEDIN_SEND_ENABLED=true)' });

    const account = account_id || li.defaultAccountId();
    const p = await li.resolveProfile(ident, account);
    if (!p.providerId) return res.status(502).json({ error: 'could not resolve LinkedIn profile' });
    if (p.distance === 'FIRST_DEGREE') return res.status(409).json({ error: 'already connected — you can message directly' });

    await li.sendInvite({ accountId: account, providerId: p.providerId, message });
    await contactDb.addActivity(contact.id, {
      type: 'linkedin_invite_sent',
      message: `LinkedIn connection request sent${message ? ': ' + String(message).slice(0, 140) : ''}`,
      channel: 'linkedin',
      data: { account_id: account, provider_id: p.providerId },
    }, companyId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[LinkedIn] invite error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
