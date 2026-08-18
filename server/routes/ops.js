'use strict';
// ─── Operational health surface ──────────────────────────────────────────────
// Mounted at /api/crm/ops.
//
// The question every endpoint here exists to answer is "is anything actually
// happening?" — which, in a system that is fail-closed everywhere and driven by
// cron rather than a daemon, is NOT answerable from any other screen. A tenant
// with sending off, a tenant whose cron was never installed, and a tenant that
// is fully caught up all look identical from the inbox and the pipeline.
const express = require('express');
const router = express.Router();
const opsDb = require('../db/models/ops');
const { query } = require('../db/index');
const { requireAuth, requireAdmin, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/crm/ops/health — this tenant's engine, queue and integrations.
router.get('/health', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    res.json(await opsDb.getHealth(companyId));
  } catch (err) {
    console.error('[Ops] GET /health error:', err.message);
    res.status(500).json({ error: 'failed to load health' });
  }
});

// GET /api/crm/ops/fleet — every tenant at once.
//
// Deliberately NOT tenant-scoped, and therefore admin-only: the whole point is
// to catch the tenant nobody thought to check. `requireAdmin` is the existing
// wildcard-key gate, so a per-tenant key cannot reach it.
router.get('/fleet', requireAdmin, async (req, res) => {
  try {
    res.json(await opsDb.getFleet({ limit: parseInt(req.query.limit, 10) || 200 }));
  } catch (err) {
    console.error('[Ops] GET /fleet error:', err.message);
    res.status(500).json({ error: 'failed to load fleet health' });
  }
});

// GET /api/crm/ops/quarantine — stuck jobs across EVERY channel.
//
// The executors already expose this per channel; an operator checking four
// channels one at a time is how a stuck job goes unnoticed for a week. Same
// predicate as the per-channel version so the two can never disagree about what
// "stuck" means.
router.get('/quarantine', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { rows } = await query(
      `SELECT sa.id, sa.channel, sa.status, sa.attempt, sa.scheduled_for,
              sa.send_started_at, sa.outcome_unknown_at, sa.outcome_unknown_reason,
              sa.provider_message_id, sa.payload->>'subject' AS subject,
              c.name AS contact_name, c.email AS contact_email
         FROM scheduled_actions sa
         LEFT JOIN contacts c ON c.id = sa.contact_id AND c.company_id = sa.company_id
        WHERE sa.company_id = $1
          AND (sa.outcome_unknown_at IS NOT NULL
               OR (sa.send_started_at IS NOT NULL AND sa.status = 'claimed'
                   AND sa.send_started_at < now() - interval '15 minutes'))
        ORDER BY COALESCE(sa.outcome_unknown_at, sa.send_started_at) DESC
        LIMIT $2`,
      [companyId, limit]
    );
    res.json({ total: rows.length, quarantined: rows });
  } catch (err) {
    console.error('[Ops] GET /quarantine error:', err.message);
    res.status(500).json({ error: 'failed to load quarantine' });
  }
});

module.exports = router;
