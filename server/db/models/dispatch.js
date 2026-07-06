'use strict';
// ─── DAL: Dispatcher (GOAL B3) ──────────────────────────────────────────────
// Backs the real claim/ack routes (server/routes/channel-jobs.js) implementing
// docs/contracts/channel-executor.openapi.yaml against real scheduled_actions
// rows (B1) instead of the reference mock (examples/mock-channel-jobs-server.mjs).
// "Ticks scheduled_actions... applies timing/quiet-hours/throttle/suppression
// (from A5) once centrally" (roadmap) happens HERE, at claim time — there is
// no separate background timer process; each engine's claim() poll IS a tick.
// This keeps the CRM's "always-on, a channel failure must not stall the
// pipeline" posture simple: no extra process lifecycle to keep alive, no new
// crash-loop surface — just query logic invoked on demand.
const { query, getClient } = require('../index');
const limitsDb = require('./limits');
const analyticsRouter = require('../../routes/analytics');

const CLAIM_TIMEOUT_MS = parseInt(process.env.CHANNEL_JOB_CLAIM_TIMEOUT_MS, 10) || 300_000;
const MAX_ATTEMPTS = parseInt(process.env.CHANNEL_JOB_MAX_ATTEMPTS, 10) || 3;
// How many extra candidate rows to lock beyond the caller's requested limit,
// to absorb rows filtered out for being suppressed (marked 'skipped' inline,
// not returned) without an extra round-trip. Bounded, not unlimited scan.
const OVERFETCH_FACTOR = 3;

function computeRetryInfo(attempt) {
  const willRetry = attempt < MAX_ATTEMPTS;
  return {
    will_retry: willRetry,
    next_attempt_at: willRetry ? new Date(Date.now() + 60_000 * attempt).toISOString() : null,
    attempt,
    max_attempts: MAX_ATTEMPTS,
  };
}

// Claims up to `limit` scheduled_actions for (companyId, channel), applying
// quiet-hours + rate-limit gates BEFORE touching any row, and filtering out
// suppressed contacts DURING the scan (marking those rows 'skipped' —
// terminal, never returned to the caller — instead of leaving them to be
// retried forever). Atomic per-row via FOR UPDATE SKIP LOCKED (same pattern
// as prospect_inbox's real claim route) — no two concurrent claim() calls,
// from the same or different engine instances, can ever return the same row.
// A per-(company,channel) advisory lock serializes the rate-limit
// check-then-claim sequence itself, closing the TOCTOU gap limits.js's
// checkRateLimit explicitly documents it cannot close alone.
async function claimJobs(companyId, channel, limit, claimedBy) {
  if (!companyId) throw new Error('dispatch.claimJobs requires companyId');
  if (!claimedBy) throw new Error('dispatch.claimJobs requires claimedBy');

  if (await limitsDb.isQuietHours(companyId, channel)) return [];

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${companyId}:${channel}`]);

    const rate = await limitsDb.checkRateLimit(companyId, channel);
    if (!rate.allowed) {
      await client.query('COMMIT');
      return [];
    }
    // Only NON-stale in-flight claims count against budget — a claim stuck
    // past CLAIM_TIMEOUT_MS is about to be reclaimed by the query below, so
    // counting it here would permanently starve a tight rate limit (e.g.
    // max_per_hour=1 with one abandoned stale claim would never recover).
    const inFlight = await client.query(
      `SELECT COUNT(*)::int AS n FROM scheduled_actions
        WHERE company_id=$1 AND channel=$2 AND status='claimed'
          AND claimed_at >= now() - ($3 || ' milliseconds')::interval`,
      [companyId, channel, String(CLAIM_TIMEOUT_MS)]
    );
    const remainingBudget = Math.min(
      rate.hourlyLimit != null ? rate.hourlyLimit - rate.hourlyCount - inFlight.rows[0].n : Infinity,
      rate.dailyLimit != null ? rate.dailyLimit - rate.dailyCount - inFlight.rows[0].n : Infinity,
    );
    const effectiveLimit = Math.min(limit, remainingBudget);
    if (effectiveLimit <= 0) {
      await client.query('COMMIT');
      return [];
    }

    // Scalar subquery (not a JOIN) for sequence_id — scheduled_actions only
    // stores step_id/enrollment_id directly; sequence_id is one hop away via
    // sequence_steps. A subquery avoids FOR UPDATE trying to lock rows in
    // sequence_steps too (a plain JOIN + FOR UPDATE locks every joined
    // table's rows unless scoped with FOR UPDATE OF).
    const candidates = await client.query(
      `SELECT sa.*, (SELECT sequence_id FROM sequence_steps ss WHERE ss.id = sa.step_id) AS sequence_id
         FROM scheduled_actions sa
        WHERE sa.company_id = $1 AND sa.channel = $2 AND sa.scheduled_for <= now()
          AND (sa.status = 'pending' OR (sa.status = 'claimed' AND sa.claimed_at < now() - ($3 || ' milliseconds')::interval))
        ORDER BY sa.scheduled_for ASC
        FOR UPDATE OF sa SKIP LOCKED
        LIMIT $4`,
      [companyId, channel, String(CLAIM_TIMEOUT_MS), Math.ceil(effectiveLimit * OVERFETCH_FACTOR)]
    );

    const claimed = [];
    for (const row of candidates.rows) {
      if (claimed.length >= effectiveLimit) break;
      if (await limitsDb.isSuppressed(companyId, row.contact_id, channel)) {
        await client.query(`UPDATE scheduled_actions SET status='skipped', updated_at=now() WHERE id=$1`, [row.id]);
        continue;
      }
      const updated = await client.query(
        `UPDATE scheduled_actions SET status='claimed', claimed_by=$1, claimed_at=now(), updated_at=now()
         WHERE id=$2 RETURNING *`,
        [claimedBy, row.id]
      );
      // RETURNING * only carries scheduled_actions' own columns — sequence_id
      // came from the candidates query's subquery, not this table.
      claimed.push({ ...updated.rows[0], sequence_id: row.sequence_id });
    }

    await client.query('COMMIT');
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Reports the outcome of a claimed job. See
// docs/contracts/channel-executor.openapi.yaml for the full contract this
// implements (ownership check, idempotent terminal replay, 409 on
// conflicting re-ack, retry/dead-letter signaling).
//
// Runs inside a transaction holding SELECT ... FOR UPDATE on the job row, so
// two concurrent ack() calls for the SAME job (an executor retrying an ack
// after a lost HTTP response) can't both observe status='claimed' and both
// process the outcome — the second call blocks until the first commits, then
// correctly sees the already-updated status and takes the idempotent-replay
// path instead of double-writing activity/campaign-event rows.
async function ackJob(companyId, jobId, { claimedBy, status, providerMessageId, error, activity, campaignEvent } = {}) {
  if (!companyId) throw new Error('dispatch.ackJob requires companyId');
  if (!claimedBy) return { httpStatus: 400, body: { error: 'claimed_by required' } };
  if (!['sent', 'failed', 'skipped'].includes(status)) return { httpStatus: 400, body: { error: 'invalid status' } };
  if (status === 'failed' && !error) return { httpStatus: 400, body: { error: 'error required when status=failed' } };

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const jobRes = await client.query(
      'SELECT * FROM scheduled_actions WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [jobId, companyId]
    );
    const job = jobRes.rows[0];
    // Same 404 whether the job doesn't exist or belongs to someone else — no
    // existence disclosure to a caller that never won the claim.
    if (!job || job.claimed_by !== claimedBy) {
      await client.query('ROLLBACK');
      return { httpStatus: 404, body: { error: 'unknown job, or not claimed by this claimed_by' } };
    }

    if (job.status === 'pending') {
      // A previous 'failed' ack already requeued this job for retry (and,
      // deliberately, did NOT clear claimed_by — see below — specifically so
      // this replay can still be recognized instead of 404ing). Only a
      // replayed 'failed' ack is a legitimate idempotent no-op here; any
      // other status now conflicts with the fact that this job already
      // failed-and-requeued. job.attempt is POST-increment (exactly one
      // increment happened, by this same ack, to get here) — subtract 1 to
      // reconstruct the exact pre-increment value the original response was
      // computed from. Without this, replaying an ack right at the
      // MAX_ATTEMPTS boundary would flip will_retry from true (original) to
      // false (recomputed from the incremented count) — a genuine
      // idempotency-contract violation, not just imprecise metadata.
      await client.query('COMMIT');
      if (status === 'failed') {
        // next_attempt_at is pinned to the value already persisted in
        // scheduled_for by the original ack (not recomputed from
        // Date.now()) — otherwise a replay minutes later would return a
        // different wall-clock timestamp than the original response, even
        // though will_retry itself is correctly reconstructed above.
        const retry = { ...computeRetryInfo(job.attempt - 1), next_attempt_at: job.scheduled_for };
        return { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'failed', retry } };
      }
      return { httpStatus: 409, body: { error: `job already acked as 'failed' (requeued for retry), cannot re-ack as '${status}'` } };
    }

    if (job.status !== 'claimed') {
      // Already acked to a TERMINAL outcome (sent/skipped/dead-lettered
      // failed) — idempotent replay if it's the SAME status, 409 otherwise.
      await client.query('COMMIT');
      if (job.status === status) {
        return {
          httpStatus: 200,
          body: { ok: true, job_id: job.id, status: job.status, retry: status === 'failed' ? computeRetryInfo(job.attempt) : null },
        };
      }
      return { httpStatus: 409, body: { error: `job already acked as '${job.status}', cannot re-ack as '${status}'` } };
    }

    // First-time ack — job.status is still 'claimed'.
    if (status === 'sent') {
      await client.query(`UPDATE scheduled_actions SET status='sent', sent_at=now(), updated_at=now() WHERE id=$1`, [jobId]);
      await client.query(
        `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [job.contact_id, companyId, activity?.type || `${job.channel}_sent`, activity?.message || `Sent via ${job.channel}`,
         job.channel, JSON.stringify({ ...(activity?.data || {}), scheduled_action_id: job.id, provider_message_id: providerMessageId || null })]
      );
      await client.query('COMMIT');
      if (campaignEvent) {
        // The contract's field is `campaign` (docs/contracts/channel-executor.
        // openapi.yaml); ingestCampaignEvent's/campaign_events' column is
        // campaign_id — same identifier, different name at each layer.
        // Uses the shared pool, not this transaction, and runs AFTER commit
        // deliberately: a non-critical analytics side effect that must not
        // roll back an already-persisted ack, and — running after commit
        // rather than before — a replay of this ack (which will now see
        // status='sent' and take the idempotent-terminal-replay path above)
        // will not re-forward the event even if this call fails, avoiding a
        // double-write window that existed when this ran before COMMIT.
        // Caught locally: the ack itself already succeeded and was returned
        // to the caller as such — a rollup-write failure here must not turn
        // an already-successful ack into a 500 (the executor would then
        // retry an ack that's already done, and never learn the rollup was
        // dropped, so this is logged, not silently swallowed).
        try {
          const { campaign, ...restCampaignEvent } = campaignEvent;
          await analyticsRouter.ingestCampaignEvent(companyId, {
            ...restCampaignEvent, campaign_id: campaign, channel: job.channel, contact_id: job.contact_id,
          });
        } catch (campaignErr) {
          console.error(`[CRM][channel-jobs] campaign_event forward failed after a successful ack (job=${jobId}):`, campaignErr.message);
        }
      }
      return { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'sent', retry: null } };
    }

    if (status === 'skipped') {
      await client.query(`UPDATE scheduled_actions SET status='skipped', updated_at=now() WHERE id=$1`, [jobId]);
      if (activity) {
        await client.query(
          `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,now())`,
          [job.contact_id, companyId, activity.type || `${job.channel}_skipped`, activity.message || `Skipped on ${job.channel}`,
           job.channel, JSON.stringify(activity.data || {})]
        );
      }
      await client.query('COMMIT');
      return { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'skipped', retry: null } };
    }

    // status === 'failed'
    const retry = computeRetryInfo(job.attempt);
    if (retry.will_retry) {
      // scheduled_for is pushed to next_attempt_at (the actual backoff) —
      // without this, the requeued row's scheduled_for is still in the past
      // and would be immediately reclaimable on the very next poll, meaning
      // no backoff would occur at all. claimed_by/claimed_at are
      // deliberately NOT cleared here (unlike a plain requeue) so a replay
      // of this exact ack call, before anyone reclaims the job, is still
      // recognized as idempotent above rather than 404ing.
      await client.query(
        `UPDATE scheduled_actions SET status='pending', attempt=attempt+1, scheduled_for=$2, updated_at=now() WHERE id=$1`,
        [jobId, retry.next_attempt_at]
      );
    } else {
      await client.query(`UPDATE scheduled_actions SET status='failed', updated_at=now() WHERE id=$1`, [jobId]);
    }
    await client.query(
      `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [job.contact_id, companyId, activity?.type || `${job.channel}_failed`, activity?.message || `Failed on ${job.channel}: ${error}`,
       job.channel, JSON.stringify({ ...(activity?.data || {}), scheduled_action_id: job.id, error, will_retry: retry.will_retry })]
    );
    await client.query('COMMIT');
    return { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'failed', retry } };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { claimJobs, ackJob, CLAIM_TIMEOUT_MS, MAX_ATTEMPTS };
