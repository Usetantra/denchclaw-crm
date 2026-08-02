'use strict';
// ─── Marketing ingestion — the authenticated door (CP-B) ─────────────────────
//
// These are the routes an engine, a webinar platform, or the CRM's own sender
// calls to tell the CRM what happened in the world. Everything here is a thin
// adapter over server/lib/marketing-events.js — normalize the caller's shape,
// hand it to the one ingest, return what it decided. No stage logic lives in
// this file, and none should ever be added to it.
//
// Thin-adapter discipline borrowed from ~/nurturing-engine/backend/app/webhooks.py:
// "verify → normalize to the canonical event → ingest_event. No business logic here."

const express = require('express');
const router = express.Router();
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const mk = require('../lib/marketing-events');
const crmRouter = require('./crm');
const { query } = require('../db/index');

router.use(requireAuth);

// Injected into the ingest so it can write timeline entries and find-or-create a
// registrant using the CRM's own canonical helpers, without lib→route imports
// creating a require cycle.
const deps = {
  recordActivity: crmRouter.addContactActivity,
  findOrCreateContact: crmRouter.findOrCreateContact,
};

// ─── Webinars ────────────────────────────────────────────────────────────────

// GET /api/crm/marketing/webinars
router.get('/webinars', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    res.json({ company_id: companyId, webinars: await mk.listWebinars(companyId) });
  } catch (err) {
    console.error('[marketing] GET /webinars error:', err.message);
    res.status(500).json({ error: 'failed to list webinars' });
  }
});

// POST /api/crm/marketing/webinars — create or update by key.
router.post('/webinars', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { key, name, scheduled_at, landing_page_url, status, metadata } = req.body || {};
    if (!key || !String(key).trim()) return res.status(400).json({ error: 'key required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    // C9: catch a bad landing page while the human is typing it, not when a
    // prospect clicks the invite three days later.
    if (landing_page_url) {
      const bad = mk.validateDestination(landing_page_url);
      if (bad) return res.status(400).json({ error: `landing_page_url invalid: ${bad}` });
    }
    if (scheduled_at && Number.isNaN(Date.parse(scheduled_at))) {
      return res.status(400).json({ error: 'scheduled_at must be a parseable timestamp' });
    }
    const webinar = await mk.upsertWebinar(companyId, {
      key: String(key).trim(), name: String(name).trim(),
      scheduled_at, landing_page_url, status, metadata,
    });
    res.status(201).json({ company_id: companyId, webinar });
  } catch (err) {
    console.error('[marketing] POST /webinars error:', err.message);
    res.status(500).json({ error: 'failed to save webinar' });
  }
});

// ─── Invites → the `invitees` stage, and the attribution token ───────────────
//
// "Invitees — prospects that have been sent invites on different channels."
// Recording an invite does two things at once, and both matter:
//   1. mints/returns the tracked link that makes a later landing-page hit
//      attributable (without it, `visits` is unimplementable, not just unbuilt);
//   2. ingests an `invite_sent` event, which is what advances prospects→invitees.
//
// The caller is expected to put the returned `invite_url` in the message it
// sends. That is the whole contract between the sender and the funnel.
//
// POST /api/crm/marketing/invites
//   { webinar_key, channel, destination_url?,
//     invitees: [{contact_id?|email?}] }   (or a single contact_id/email)
router.post('/invites', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const b = req.body || {};
    const webinar = b.webinar_id
      ? await mk.getWebinarById(companyId, b.webinar_id)
      : await mk.getWebinarByKey(companyId, b.webinar_key);
    if (!webinar) return res.status(400).json({ error: 'unknown webinar — pass a webinar_key that exists for this tenant' });

    const channel = b.channel;
    const INVITE_CHANNELS = ['email', 'sms', 'whatsapp', 'linkedin', 'ai_call', 'calendar', 'content'];
    if (!INVITE_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `channel required, one of: ${INVITE_CHANNELS.join(', ')}` });
    }

    const destination = b.destination_url || webinar.landing_page_url;
    if (!destination) {
      return res.status(400).json({
        error: 'no destination — pass destination_url, or set landing_page_url on the webinar',
      });
    }
    const bad = mk.validateDestination(destination);
    if (bad) return res.status(400).json({ error: `destination_url invalid: ${bad}` });

    const list = Array.isArray(b.invitees) && b.invitees.length
      ? b.invitees
      : [{ contact_id: b.contact_id, email: b.email }];

    const results = [];
    for (const item of list) {
      const ingested = await mk.ingestMarketingEvent(companyId, {
        event_type: 'invite_sent', channel,
        contact_id: item.contact_id, email: item.email, phone: item.phone,
        webinar_id: webinar.id,
        pipeline_key: b.pipeline_key,
        source: b.source || 'crm_invite',
      }, deps);

      let invite_url = null;
      if (ingested.contact_id) {
        // Mint the link even when the stage move was refused. The refusal is
        // usually "a human must put them in Prospects first" — that is a
        // pipeline question, and it must not also cost us the tracking link for
        // an invite that is genuinely going out.
        const link = await mk.mintInviteLink(companyId, {
          webinarId: webinar.id, contactId: ingested.contact_id,
          channel, destinationUrl: destination,
        });
        invite_url = mk.inviteUrlFor(link.token);
      }
      results.push({ ...ingested, invite_url });
    }

    res.status(200).json({
      company_id: companyId, webinar_key: webinar.key, channel,
      advanced: results.filter(r => r.outcome === 'advanced').length,
      refused: results.filter(r => r.outcome === 'refused').length,
      results,
    });
  } catch (err) {
    console.error('[marketing] POST /invites error:', err.message);
    res.status(500).json({ error: 'failed to record invites' });
  }
});

// ─── The generic canonical door ──────────────────────────────────────────────
// POST /api/crm/marketing/events — any event_type in the taxonomy. This is what
// the outreach/nurturing engines call; the specific routes above and the public
// webhooks below all funnel into the same ingest.
router.post('/events', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const out = await mk.ingestMarketingEvent(companyId, req.body || {}, deps);
    if (out.ok === false) return res.status(out.status || 400).json(out);
    res.status(200).json({ company_id: companyId, ...out });
  } catch (err) {
    console.error('[marketing] POST /events error:', err.message);
    res.status(500).json({ error: 'marketing event ingest failed' });
  }
});

// ─── Attendance roster → the `attendees` stage ───────────────────────────────
//
// "Attendees — Registrants (or Auto-Registrants) that attend the webinar."
// Bulk, because that is the shape every webinar platform exports.
//
// A person on the roster who never registered is NOT force-advanced: the stage
// authority refuses the hop, we record the refusal with its reason, and the
// response reports it so an operator can see it and decide. Silently walking
// them up the funnel would fire the "thanks for registering" mail at somebody
// who has already been to the webinar.
//
// POST /api/crm/marketing/attendance
//   { webinar_key, attended: [{email|contact_id}], no_show: [{email|contact_id}] }
router.post('/attendance', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const b = req.body || {};
    const webinar = b.webinar_id
      ? await mk.getWebinarById(companyId, b.webinar_id)
      : await mk.getWebinarByKey(companyId, b.webinar_key);
    if (!webinar) return res.status(400).json({ error: 'unknown webinar — pass a webinar_key that exists for this tenant' });

    const run = async (rows, eventType) => {
      const out = [];
      for (const item of rows || []) {
        out.push(await mk.ingestMarketingEvent(companyId, {
          event_type: eventType, webinar_id: webinar.id, channel: 'web',
          contact_id: item.contact_id, email: item.email, phone: item.phone,
          pipeline_key: b.pipeline_key,
          metadata: item.metadata || undefined,
        }, deps));
      }
      return out;
    };

    const attended = await run(b.attended, 'attendance');
    const noShow = await run(b.no_show, 'no_show');
    const all = attended.concat(noShow);

    res.status(200).json({
      company_id: companyId, webinar_key: webinar.key,
      attended: attended.length, no_show: noShow.length,
      advanced: all.filter(r => r.outcome === 'advanced').length,
      // Surfaced deliberately — this is the "attended but never registered"
      // population, and it is an operator decision, not something to bury.
      refused: all.filter(r => r.outcome === 'refused')
        .map(r => ({ contact_id: r.contact_id, detail: r.detail })),
      results: all,
    });
  } catch (err) {
    console.error('[marketing] POST /attendance error:', err.message);
    res.status(500).json({ error: 'failed to ingest attendance' });
  }
});

// ─── Reads ───────────────────────────────────────────────────────────────────

// GET /api/crm/marketing/events?contact_id=&webinar_id=&event_type=&outcome=
router.get('/events', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const events = await mk.listEvents(companyId, {
      contactId: req.query.contact_id, webinarId: req.query.webinar_id,
      eventType: req.query.event_type, outcome: req.query.outcome, limit: req.query.limit,
    });
    res.json({ company_id: companyId, count: events.length, events });
  } catch (err) {
    console.error('[marketing] GET /events error:', err.message);
    res.status(500).json({ error: 'failed to list marketing events' });
  }
});

// GET /api/crm/marketing/funnel — the marketing funnel as it actually stands.
// This is the view that makes CP-B visible: before this checkpoint every stage
// above `prospects` was permanently zero, because nothing could move a contact
// into it.
router.get('/funnel', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const pipelineKey = req.query.pipeline_key || mk.DEFAULT_MARKETING_PIPELINE;
    const { getPipelineConfig } = require('../db/pipeline');
    const pipeline = await getPipelineConfig(companyId, pipelineKey);
    if (!pipeline) return res.status(404).json({ error: `Pipeline '${pipelineKey}' not configured` });

    const counts = await query(
      `SELECT marketing_stage AS stage, COUNT(*)::int AS count
         FROM contacts WHERE company_id=$1 AND deleted_at IS NULL
        GROUP BY marketing_stage`,
      [companyId]
    );
    const byStage = Object.fromEntries(counts.rows.map(r => [r.stage, r.count]));

    const drivers = await query(
      `SELECT event_type, outcome, COUNT(*)::int AS count
         FROM crm_marketing_events WHERE company_id=$1
        GROUP BY event_type, outcome ORDER BY event_type`,
      [companyId]
    );

    res.json({
      company_id: companyId, pipeline_key: pipelineKey,
      stages: pipeline.stages.map(s => ({
        key: s.key, label: s.label, mode: s.mode || 'auto',
        count: byStage[s.key] || 0,
        // Which observation drives this stage — so it is obvious from the API
        // alone whether a stage has a mechanism behind it or is still a diagram.
        driven_by: Object.entries(mk.EVENT_STAGE).filter(([, v]) => v === s.key).map(([k]) => k),
      })),
      event_outcomes: drivers.rows,
    });
  } catch (err) {
    console.error('[marketing] GET /funnel error:', err.message);
    res.status(500).json({ error: 'failed to build funnel view' });
  }
});

module.exports = router;
