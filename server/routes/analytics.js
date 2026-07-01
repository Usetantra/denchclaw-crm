'use strict';
// Part 5 — Analytics: campaign event ingestion + rollup reads
const express = require('express');
const router = express.Router();
const { query } = require('../db/index');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const VALID_EVENT_TYPES = ['send', 'deliver', 'open', 'click', 'reply', 'bounce', 'unsub', 'suppressed'];
const TYPE_TO_COL = {
  send: 'sends', deliver: 'delivers', open: 'opens', click: 'clicks',
  reply: 'replies', bounce: 'bounces', unsub: 'unsubs', suppressed: 'unsubs',
};

// POST /api/crm/campaign-events
// Receive one event or an array of events from the outreach engine.
// Writes a raw row to campaign_events and upserts the per-(company,campaign,channel,segment,day) rollup.
router.post('/campaign-events', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    const events = Array.isArray(req.body) ? req.body : [req.body];
    let inserted = 0;

    for (const ev of events) {
      const { campaign_id, contact_id, channel, segment, type, ts, metadata = {} } = ev;
      if (!VALID_EVENT_TYPES.includes(type)) continue;

      const eventTs = ts ? new Date(ts) : new Date();

      await query(
        `INSERT INTO campaign_events (company_id, campaign_id, contact_id, channel, segment, type, metadata, ts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, campaign_id || null, contact_id || null, channel || null,
         segment || null, type, JSON.stringify(metadata), eventTs]
      );

      // Upsert rollup — empty-string sentinels instead of NULL for the UNIQUE constraint
      const col = TYPE_TO_COL[type];
      if (col) {
        const day = eventTs.toISOString().slice(0, 10);
        await query(
          `INSERT INTO campaign_event_rollups
             (company_id, campaign_id, channel, segment, day, ${col})
           VALUES ($1,$2,$3,$4,$5,1)
           ON CONFLICT (company_id, campaign_id, channel, segment, day)
           DO UPDATE SET ${col} = campaign_event_rollups.${col} + 1, updated_at = now()`,
          [companyId, campaign_id || '', channel || '', segment || '', day]
        );
      }
      inserted++;
    }

    return res.status(202).json({ ok: true, accepted: inserted, total: events.length });
  } catch (err) {
    console.error('[Analytics] POST /campaign-events error:', err.message);
    res.status(500).json({ error: 'failed to ingest events' });
  }
});

// GET /api/crm/analytics/overview
// High-level counts: total sends/opens/replies/bounces across all campaigns today + 7d + 30d.
router.get('/analytics/overview', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    const { rows } = await query(
      `SELECT
         SUM(sends)::int    AS total_sends,
         SUM(delivers)::int AS total_delivers,
         SUM(opens)::int    AS total_opens,
         SUM(clicks)::int   AS total_clicks,
         SUM(replies)::int  AS total_replies,
         SUM(bounces)::int  AS total_bounces,
         SUM(unsubs)::int   AS total_unsubs,
         SUM(mql_count)::int AS total_mqls,
         ROUND(CASE WHEN SUM(sends) > 0 THEN SUM(opens)::numeric   / SUM(sends) * 100 ELSE 0 END, 2) AS open_rate,
         ROUND(CASE WHEN SUM(sends) > 0 THEN SUM(replies)::numeric / SUM(sends) * 100 ELSE 0 END, 2) AS reply_rate,
         ROUND(CASE WHEN SUM(sends) > 0 THEN SUM(bounces)::numeric / SUM(sends) * 100 ELSE 0 END, 2) AS bounce_rate
       FROM campaign_event_rollups
       WHERE company_id = $1 AND day >= CURRENT_DATE - INTERVAL '30 days'`,
      [companyId]
    );
    return res.json(rows[0] || {});
  } catch (err) {
    console.error('[Analytics] GET /analytics/overview error:', err.message);
    res.status(500).json({ error: 'failed to load overview' });
  }
});

// GET /api/crm/analytics/by-channel?days=30
router.get('/analytics/by-channel', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);

    const { rows } = await query(
      `SELECT channel,
         SUM(sends)::int    AS sends,
         SUM(delivers)::int AS delivers,
         SUM(opens)::int    AS opens,
         SUM(replies)::int  AS replies,
         SUM(bounces)::int  AS bounces,
         SUM(unsubs)::int   AS unsubs,
         ROUND(CASE WHEN SUM(sends) > 0 THEN SUM(replies)::numeric / SUM(sends) * 100 ELSE 0 END, 2) AS reply_rate
       FROM campaign_event_rollups
       WHERE company_id = $1 AND day >= CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY channel
       ORDER BY sends DESC`,
      [companyId, days]
    );
    return res.json({ channels: rows });
  } catch (err) {
    console.error('[Analytics] GET /analytics/by-channel error:', err.message);
    res.status(500).json({ error: 'failed to load channel analytics' });
  }
});

// GET /api/crm/analytics/by-campaign?days=30
router.get('/analytics/by-campaign', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const days = Math.min(parseInt(req.query.days, 10) || 30, 365);

    const { rows } = await query(
      `SELECT campaign_id,
         SUM(sends)::int    AS sends,
         SUM(delivers)::int AS delivers,
         SUM(opens)::int    AS opens,
         SUM(replies)::int  AS replies,
         SUM(bounces)::int  AS bounces,
         SUM(unsubs)::int   AS unsubs,
         SUM(mql_count)::int AS mqls,
         ROUND(CASE WHEN SUM(sends) > 0 THEN SUM(replies)::numeric / SUM(sends) * 100 ELSE 0 END, 2) AS reply_rate,
         ROUND(CASE WHEN SUM(sends) > 0 THEN SUM(mql_count)::numeric / SUM(sends) * 100 ELSE 0 END, 2) AS mql_rate
       FROM campaign_event_rollups
       WHERE company_id = $1 AND day >= CURRENT_DATE - ($2 || ' days')::interval
       GROUP BY campaign_id
       ORDER BY sends DESC`,
      [companyId, days]
    );
    return res.json({ campaigns: rows });
  } catch (err) {
    console.error('[Analytics] GET /analytics/by-campaign error:', err.message);
    res.status(500).json({ error: 'failed to load campaign analytics' });
  }
});

// GET /api/crm/analytics/funnel?pipeline_key=marketing|sales
// Stage counts for the dashboard funnel view.
router.get('/analytics/funnel', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const pipelineKey = req.query.pipeline_key || 'marketing';

    if (pipelineKey === 'marketing') {
      const { rows } = await query(
        `SELECT marketing_stage AS stage, COUNT(*)::int AS count
         FROM contacts
         WHERE company_id = $1 AND deleted_at IS NULL
         GROUP BY marketing_stage`,
        [companyId]
      );
      return res.json({ pipeline_key: 'marketing', stages: rows });
    }

    if (pipelineKey === 'sales') {
      const { rows } = await query(
        `SELECT stage, COUNT(*)::int AS count, SUM(value)::numeric AS total_value
         FROM deals WHERE company_id = $1
         GROUP BY stage`,
        [companyId]
      );
      return res.json({ pipeline_key: 'sales', stages: rows });
    }

    return res.status(400).json({ error: 'pipeline_key must be marketing or sales' });
  } catch (err) {
    console.error('[Analytics] GET /analytics/funnel error:', err.message);
    res.status(500).json({ error: 'failed to load funnel' });
  }
});

module.exports = router;
