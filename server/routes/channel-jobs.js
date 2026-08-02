'use strict';
// ─── Channel jobs (GOAL B3 — the real claim/ack routes) ────────────────────────
// Implements docs/contracts/channel-executor.openapi.yaml against real
// scheduled_actions rows (B1) via server/db/models/dispatch.js, replacing the
// reference mock (examples/mock-channel-jobs-server.mjs) engines built
// against during B4. Same request/response shapes, same semantics.
const express = require('express');
const router = express.Router();
const dispatchDb = require('../db/models/dispatch');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

// CP-C2: 'linkedin' is deliberately NOT claimable over HTTP, and this is a
// CONTRACT NARROWING worth stating plainly.
//
// The claim door gates LinkedIn correctly for any claimant — caps, window and
// accept gate all hold. What an external claimant does NOT get is the
// reserve-before-send: `send_started_at` is written by the CRM's own executor
// immediately before the provider call, and the reclaim scan's entire duplicate
// guard is that column being non-NULL. An engine that claims a LinkedIn invite,
// sends it through its own path and dies before acking leaves a row that looks
// exactly like "claimed but never sent" — so it is re-served and a SECOND
// connection request goes to the same person. On email that is an apology; on
// LinkedIn it is how an account gets restricted.
//
// So LinkedIn sends through /executors/linkedin/tick, in-process, where the
// reservation and the send are the same code. Ack stays open for every channel:
// acking a job you already hold is not a send.
const CHANNELS = ['email', 'sms', 'whatsapp', 'ai_call'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/claim', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    const { channel, limit = 10, claimed_by } = req.body || {};
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'invalid channel' });
    if (!claimed_by) return res.status(400).json({ error: 'claimed_by required' });
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
      return res.status(400).json({ error: 'limit must be a positive integer no greater than 100' });
    }

    const jobs = await dispatchDb.claimJobs(companyId, channel, limit, claimed_by);
    res.json({
      jobs: jobs.map(j => ({
        job_id: j.id, company_id: j.company_id, contact_id: j.contact_id,
        sequence_id: j.sequence_id, step_id: j.step_id, channel: j.channel,
        template_ref: j.template_ref, payload: j.payload,
        scheduled_for: j.scheduled_for, claimed_at: j.claimed_at, attempt: j.attempt,
      })),
    });
  } catch (err) {
    console.error('[CRM] POST /channel-jobs/claim error:', err.message);
    res.status(500).json({ error: 'failed to claim jobs' });
  }
});

router.post('/:job_id/ack', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    if (!UUID_RE.test(req.params.job_id)) return res.status(400).json({ error: 'job_id must be a UUID' });

    const { status, claimed_by, provider_message_id, error, activity, campaign_event } = req.body || {};
    const result = await dispatchDb.ackJob(companyId, req.params.job_id, {
      claimedBy: claimed_by, status, providerMessageId: provider_message_id, error, activity, campaignEvent: campaign_event,
    });
    res.status(result.httpStatus).json(result.body);
  } catch (err) {
    console.error('[CRM] POST /channel-jobs/:job_id/ack error:', err.message);
    res.status(500).json({ error: 'failed to record ack' });
  }
});

module.exports = router;
