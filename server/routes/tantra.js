'use strict';
// ─── Tantra mirror control surface ───────────────────────────────────────────
// Mounted at /api/crm/tantra.
//
// WHY THIS IS NOT UNDER /api/crm/executors
//
// routes/executors.js registers `/:channel/status` and `/:channel/tick`
// wildcards that resolve against `lib/executors.js`'s byChannel map. Adding
// `tantra` there would either be swallowed by the wildcard and 404 as "no
// executor for channel 'tantra'", or force Tantra into a channel registry it
// does not belong in — it is not a channel, it is a mirror of several. A
// separate router touches none of that and keeps the existing routes exactly as
// they are.
const express = require('express');
const router = express.Router();
const channelsDb = require('../db/models/channels');
const tantraClient = require('../lib/tantra-client');
const tantraExecutor = require('../lib/tantra-executor');
const tantraSync = require('../db/models/tantra-sync');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const opsDb = require('../db/models/ops');

router.use(requireAuth);

const PROVIDER = 'tantra';

// ─── connection ──────────────────────────────────────────────────────────────

router.get('/connection', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const conn = await channelsDb.getConnection(companyId, PROVIDER);
    // Never echo the key back. It is effectively a root credential on the Tantra
    // side (their ScopesGuard is registered nowhere), so it goes in and never
    // comes out.
    res.json({
      connection: conn
        ? { connected: conn.status === 'connected', account_ref: conn.account_ref, status: conn.status, verified_at: conn.verified_at, last_error: conn.last_error }
        : { connected: false },
    });
  } catch (e) {
    console.error('[Tantra] GET /connection', e.message);
    res.status(500).json({ error: 'failed to load Tantra connection' });
  }
});

router.post('/connect', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const apiKey = req.body && req.body.api_key && String(req.body.api_key).trim();
    if (!apiKey) return res.status(400).json({ error: 'api_key is required' });

    // Prove the key works before storing it — a key that 401s later surfaces as
    // a silently empty inbox, which is far harder to diagnose than a failed
    // connect. The key must be minted in Tantra's own dashboard: its `api-keys`
    // domain applies a class-level JWT guard with no API-key branch, so it
    // requires a Clerk session and cannot be minted programmatically from here.
    try {
      await tantraClient.verifyKey(apiKey);
    } catch (err) {
      return res.status(400).json({ error: `Tantra rejected this key: ${err.message}` });
    }

    const conn = await channelsDb.upsertConnection(companyId, PROVIDER, {
      accountRef: (req.body && req.body.label) || tantraClient.base(),
      credentials: { api_key: apiKey },
      status: 'connected',
    });
    await tantraSync.getOrCreateState(companyId);
    res.json({
      connection: { connected: true, account_ref: conn.account_ref, status: conn.status, verified_at: conn.verified_at },
      // Said plainly, because a tenant handing us this key deserves to know
      // what it grants on the other side.
      warning: 'This key grants full account access on Tantra — its API-key scopes are stored but not enforced. Treat it as a root credential.',
    });
  } catch (e) {
    console.error('[Tantra] POST /connect', e.message);
    res.status(500).json({ error: 'failed to connect Tantra' });
  }
});

router.delete('/connection', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    await channelsDb.disconnect(companyId, PROVIDER);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Tantra] DELETE /connection', e.message);
    res.status(500).json({ error: 'failed to disconnect Tantra' });
  }
});

// ─── mirror ──────────────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    res.json(await tantraExecutor.status(companyId));
  } catch (e) {
    console.error('[Tantra] GET /status', e.message);
    res.status(500).json({ error: 'failed to load Tantra status' });
  }
});

// A blocked tick is a 200 with ok:false — the house convention (see
// routes/executors.js). "Not connected" is an expected state for a tenant that
// has not set this up, not a server error.
router.post('/tick', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const maxPages = Math.min(parseInt(req.body && req.body.max_pages, 10) || 3, 20);
    const report = await tantraExecutor.tick(companyId, { maxPages });
    // The mirror is cron-driven exactly like the channel executors, so it feeds
    // the same heartbeat — otherwise "Tantra hasn't synced" and "nobody is
    // running the sync" would be indistinguishable.
    await opsDb.recordTick(companyId, 'tantra', report);
    res.json(report);
  } catch (e) {
    console.error('[Tantra] POST /tick', e.message);
    res.status(500).json({ error: 'tick failed' });
  }
});

router.post('/backfill', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const pages = Math.min(parseInt(req.body && req.body.pages, 10) || 5, 50);
    res.json(await tantraExecutor.backfill(companyId, { pages }));
  } catch (e) {
    console.error('[Tantra] POST /backfill', e.message);
    res.status(500).json({ error: 'backfill failed' });
  }
});

// Links made by a non-exact match, for operator review. Tantra resolves WhatsApp
// by the last 10 digits of a free-form phone and will eventually match two
// different people; this is the review queue that keeps that from becoming a
// silent merge in the CRM.
router.get('/identities/review', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    res.json({ links: await tantraSync.listHeuristicLinks(companyId) });
  } catch (e) {
    console.error('[Tantra] GET /identities/review', e.message);
    res.status(500).json({ error: 'failed to load review queue' });
  }
});

module.exports = router;
