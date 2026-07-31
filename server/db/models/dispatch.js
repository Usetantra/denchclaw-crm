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
const seqDb = require('./sequences');
const { getPipelineConfig, findStage, isManualStage, isTerminalStage, getPipelineTransitions } = require('../pipeline');
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
  // The client is released as soon as the claim transaction commits, so the
  // post-commit side effects below run without holding a pooled connection.
  let releasedEarly = false;
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
    // CP2 D5b: the owning sequence must be 'active'. Before CP2 this filter
    // did not exist, so pausing a sequence stopped nothing — its already-queued
    // rows kept being claimed and sent, and a user who hit "pause" had a send
    // control they only believed they had. The sequence is one hop past the
    // step the scalar subquery already reaches.
    const candidates = await client.query(
      `SELECT sa.*, (SELECT sequence_id FROM sequence_steps ss WHERE ss.id = sa.step_id) AS sequence_id
         FROM scheduled_actions sa
        WHERE sa.company_id = $1 AND sa.channel = $2 AND sa.scheduled_for <= now()
          AND (sa.status = 'pending' OR (sa.status = 'claimed' AND sa.claimed_at < now() - ($3 || ' milliseconds')::interval))
          AND (SELECT s.status
                 FROM sequence_steps ss JOIN sequences s ON s.id = ss.sequence_id
                WHERE ss.id = sa.step_id) = 'active'
        ORDER BY sa.scheduled_for ASC
        FOR UPDATE OF sa SKIP LOCKED
        LIMIT $4`,
      [companyId, channel, String(CLAIM_TIMEOUT_MS), Math.ceil(effectiveLimit * OVERFETCH_FACTOR)]
    );

    const claimed = [];
    // Suppression skips are committed with the claim scan, then acted on
    // AFTER the commit (same D3 discipline as the ack path): a failing
    // enrollment side-effect must never roll back the 'skipped' marking and
    // hand the row back to the next scan.
    const suppressionSkips = [];
    for (const row of candidates.rows) {
      if (claimed.length >= effectiveLimit) break;
      // CP2 D7: GLOBAL (channel IS NULL) vs CHANNEL-SPECIFIC suppression are
      // different decisions, and limitsDb.isSuppressed collapses both to a
      // bare boolean. A global suppression withdraws consent entirely and
      // exits the enrollment; a channel-specific one only means "not by this
      // channel" and must not kill a multi-channel ladder — that one advances
      // like an executor skip. Read inside the claim transaction so the scope
      // seen here is the same snapshot the skip is written against.
      const supp = await client.query(
        `SELECT channel FROM suppressions
          WHERE company_id = $1 AND contact_id = $2 AND (channel IS NULL OR channel = $3)`,
        [companyId, row.contact_id, channel]
      );
      if (supp.rows.length) {
        await client.query(`UPDATE scheduled_actions SET status='skipped', updated_at=now() WHERE id=$1`, [row.id]);
        suppressionSkips.push({ job: row, global: supp.rows.some(r => r.channel === null) });
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
    client.release();
    releasedEarly = true;

    // Post-commit, and with the CLAIM's pooled client already returned, so the
    // side effect cannot undo the skip above and does not stack a second
    // connection on top of the claim transaction's.
    // (Caveat, stated honestly: runStepSideEffects itself holds its own client
    // while applyStageWriteback calls getPipelineConfig, which reads through
    // the shared pool. That is normally a cached hit, and it matches the
    // pre-existing shape of checkRateLimit inside the claim transaction — but
    // under pool saturation (DB_POOL_MAX default 10, connectionTimeoutMillis
    // 5000) it degrades to a timed-out side effect, i.e. a stalled ladder,
    // never a lost or duplicated send.)
    for (const skip of suppressionSkips) {
      await runStepSideEffects(companyId, {
        job: skip.job,
        outcome: skip.global ? 'suppressed_global' : 'suppressed_channel',
        anchor: new Date(),
      });
    }
    return claimed;
  } catch (err) {
    if (!releasedEarly) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (!releasedEarly) client.release();
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
// Returns { result, sideEffect } rather than the HTTP result alone: CP2's
// side-effects (enrollment advance, next-step enqueue, stage write-back) are
// deliberately NOT part of this transaction — see ackJob() below and D3.
async function ackJobCore(companyId, jobId, { claimedBy, status, providerMessageId, error, activity, campaignEvent } = {}) {
  if (!companyId) throw new Error('dispatch.ackJob requires companyId');
  if (!claimedBy) return { result: { httpStatus: 400, body: { error: 'claimed_by required' } } };
  if (!['sent', 'failed', 'skipped'].includes(status)) return { result: { httpStatus: 400, body: { error: 'invalid status' } } };
  if (status === 'failed' && !error) return { result: { httpStatus: 400, body: { error: 'error required when status=failed' } } };

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
      return { result: { httpStatus: 404, body: { error: 'unknown job, or not claimed by this claimed_by' } } };
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
        return { result: { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'failed', retry } } };
      }
      return { result: { httpStatus: 409, body: { error: `job already acked as 'failed' (requeued for retry), cannot re-ack as '${status}'` } } };
    }

    if (job.status !== 'claimed') {
      // Already acked to a TERMINAL outcome (sent/skipped/dead-lettered
      // failed) — idempotent replay if it's the SAME status, 409 otherwise.
      await client.query('COMMIT');
      if (job.status === status) {
        // CP2 D8: an idempotent replay returns the same 200 and must not
        // advance twice, queue the next step twice, or write the stage back
        // twice. It nonetheless CARRIES the side-effect — because the
        // side-effect is itself idempotent, and replay is the only repair
        // path this design has.
        //
        // Why: D3 commits the send first and runs the side-effects in a
        // separate transaction, so there is a window (side-effect throws, or
        // the process dies right after COMMIT) where the message went out but
        // the enrollment never advanced. The job row is terminal, so the claim
        // scan will never revisit it, and resumeSequenceQueue() cannot see it
        // either — a scheduled_action for the current step DOES exist, it is
        // just 'sent'. Without this the ladder is stranded FOREVER after a
        // single transient error, which the critic reproduced.
        // Replaying is safe by construction: runStepSideEffects acts only when
        // job.step_id === enrollment.current_step_id (D3b) and only on an
        // active enrollment, and the enqueue is ON CONFLICT DO NOTHING (D8).
        // So on a healthy enrollment — already advanced past this step — the
        // replay is a no-op, and on a stranded one it is the repair.
        const replayable = ['sent', 'skipped'].includes(job.status);
        return {
          result: {
            httpStatus: 200,
            body: { ok: true, job_id: job.id, status: job.status, retry: status === 'failed' ? computeRetryInfo(job.attempt) : null },
          },
          sideEffect: replayable ? { job, outcome: job.status, anchor: new Date() } : null,
        };
      }
      return { result: { httpStatus: 409, body: { error: `job already acked as '${job.status}', cannot re-ack as '${status}'` } } };
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
      return {
        result: { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'sent', retry: null } },
        // The send is now committed. Everything CP2 does next runs outside
        // this transaction and cannot undo it (D3).
        sideEffect: { job, outcome: 'sent', anchor: new Date() },
      };
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
      // CP2 D7: an executor-chosen skip declined THIS message; it did not
      // withdraw consent. The ladder advances, anchored on the ack (D2/LOW-7).
      return {
        result: { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'skipped', retry: null } },
        sideEffect: { job, outcome: 'skipped', anchor: new Date() },
      };
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
    return {
      result: { httpStatus: 200, body: { ok: true, job_id: job.id, status: 'failed', retry } },
      // CP2 D7: a retryable failure changes nothing — the row requeues itself
      // and the enrollment stays exactly where it is. Only a dead-lettered
      // failure ends the ladder.
      sideEffect: retry.will_retry ? null : { job, outcome: 'failed_dead', anchor: new Date() },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── CP2: the step-scheduler side effects ───────────────────────────────────
// Everything below runs AFTER the job's own transaction has committed and
// after its pooled client has been released.
//
// D3 (the critic's HIGH finding) is the reason for that shape. If the
// enrollment advance / next-step enqueue / stage write-back ran inside
// ackJob's transaction, then ANY of them throwing — a 23505, a malformed
// deal.metadata, a transient DB error — would roll back status='sent' for a
// message the executor has ALREADY physically sent. The row would stay
// 'claimed', cross CLAIM_TIMEOUT_MS, be reclaimed by the scan in claimJobs()
// and be sent AGAIN, every ~5 minutes, forever, for any persistent error.
// The codebase already knew this: campaign_events are forwarded after COMMIT
// for exactly the same reason. So: the send is committed first, and no
// side-effect can undo it. A side-effect failure is logged and recorded on
// the contact's timeline; the ack still returns 200.

// Records a CP2 side-effect note on the contact's timeline. Best-effort: this
// is used on failure paths, so it must never throw.
async function noteActivity(client, companyId, contactId, { type, message, channel = null, data = {} }) {
  try {
    await client.query(
      `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`,
      [contactId, companyId, type, message, channel, JSON.stringify(data)]
    );
  } catch (err) {
    console.error(`[CRM][cp2] could not record activity '${type}' for contact=${contactId}: ${err.message}`);
  }
}

// D4 — mirror the step's declared reporting stage onto the pipeline, THROUGH
// CP1's mode gate. Never an HTTP call to /advance, never a raw UPDATE that
// skips the gate.
//
// The two refusals below are the CP1 invariant surviving contact with the
// scheduler: this write-back is programmatic by definition, so a manual stage
// is NEVER set by it (same rule conversations.js follows), and an illegal
// transition is never forced. In both cases the send still succeeded and the
// ack still returns 200 — the refusal is recorded on the timeline naming the
// stage it wanted and the stage it found, so a frozen board is diagnosable
// (D4b.2) instead of silently lying.
async function applyStageWriteback(client, companyId, { job, step, enrollment }) {
  const target = step.stage_writeback;
  if (!target) return { applied: false, reason: 'no_writeback' };

  const seq = await client.query('SELECT pipeline_key FROM sequences WHERE id = $1 AND company_id = $2', [enrollment.sequence_id, companyId]);
  const pipelineKey = seq.rows[0]?.pipeline_key || null;
  if (!pipelineKey) return { applied: false, reason: 'sequence_has_no_pipeline' };

  // Tenant-scoped resolution (D9) — a tenant override wins, exactly as CP1.
  const pipeline = await getPipelineConfig(companyId, pipelineKey);
  if (!pipeline || !findStage(pipeline, target)) {
    await noteActivity(client, companyId, job.contact_id, {
      type: 'stage_writeback_skipped', channel: job.channel,
      message: `Stage write-back skipped: '${target}' is not a stage of pipeline '${pipelineKey}'`,
      data: { pipeline_key: pipelineKey, wanted: target, reason: 'unknown_stage', scheduled_action_id: job.id },
    });
    return { applied: false, reason: 'unknown_stage' };
  }

  // Which object does this pipeline's stages live on? (CP1's entity_type.)
  const isDeal = pipeline.entity_type === 'deal';
  let currentStage = null;
  let deal = null;
  if (isDeal) {
    const terminals = pipeline.stages.filter(s => s && s.terminal === true).map(s => s.key);
    const dealRes = await client.query(
      `SELECT * FROM deals WHERE contact_id=$1 AND company_id=$2 AND pipeline_key=$3
         AND NOT (stage = ANY($4::text[]))
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [job.contact_id, companyId, pipelineKey, terminals]
    );
    deal = dealRes.rows[0];
    if (!deal) {
      await noteActivity(client, companyId, job.contact_id, {
        type: 'stage_writeback_skipped', channel: job.channel,
        message: `Stage write-back skipped: no active '${pipelineKey}' deal for this contact (wanted '${target}')`,
        data: { pipeline_key: pipelineKey, wanted: target, reason: 'no_active_deal', scheduled_action_id: job.id },
      });
      return { applied: false, reason: 'no_active_deal' };
    }
    currentStage = deal.stage;
  } else {
    const c = await client.query('SELECT marketing_stage FROM contacts WHERE id=$1 AND company_id=$2', [job.contact_id, companyId]);
    if (!c.rows[0]) return { applied: false, reason: 'contact_missing' };
    currentStage = c.rows[0].marketing_stage;
  }

  if (currentStage === target) return { applied: false, reason: 'already_there' };

  // THE CP1 INVARIANT. A manual stage is a human's to set, and this caller is
  // by definition not a human.
  if (isManualStage(pipeline, target)) {
    await noteActivity(client, companyId, job.contact_id, {
      type: 'stage_writeback_refused', channel: job.channel,
      message: `Stage write-back refused: '${target}' is a manual stage — only a human may set it (stage left at '${currentStage}')`,
      data: { pipeline_key: pipelineKey, wanted: target, found: currentStage, reason: 'manual_stage', scheduled_action_id: job.id },
    });
    return { applied: false, reason: 'manual_stage' };
  }

  const allowed = getPipelineTransitions(pipeline, currentStage);
  if (!allowed.includes(target)) {
    await noteActivity(client, companyId, job.contact_id, {
      type: 'stage_writeback_refused', channel: job.channel,
      message: `Stage write-back refused: '${currentStage}' → '${target}' is not a legal transition (stage left at '${currentStage}')`,
      data: { pipeline_key: pipelineKey, wanted: target, found: currentStage, allowed, reason: 'illegal_transition', scheduled_action_id: job.id },
    });
    return { applied: false, reason: 'illegal_transition' };
  }

  if (isDeal) {
    const meta = (typeof deal.metadata === 'string' ? JSON.parse(deal.metadata) : deal.metadata) || {};
    const activity = meta.activity || [];
    activity.push({ type: 'stage_change', message: `Stage: ${currentStage} → ${target}`, timestamp: new Date().toISOString(), actor: 'sequence' });
    // Same terminal semantics as crm.js's /advance — closed_at lives in
    // metadata there, so it lives in metadata here too rather than inventing
    // a second convention.
    if (['won', 'lost'].includes(target) || isTerminalStage(pipeline, target)) meta.closed_at = new Date().toISOString();
    await client.query(
      `UPDATE deals SET stage=$1, metadata=$2, updated_at=now() WHERE id=$3 AND company_id=$4`,
      [target, JSON.stringify({ ...meta, activity }), deal.id, companyId]
    );
  } else {
    await client.query(
      `UPDATE contacts SET marketing_stage=$1, deal_stage=$1, updated_at=now() WHERE id=$2 AND company_id=$3`,
      [target, job.contact_id, companyId]
    );
  }

  await noteActivity(client, companyId, job.contact_id, {
    type: 'stage_change', channel: null,
    message: `Stage (${pipelineKey}): ${currentStage} → ${target} (sequence step)`,
    data: { pipeline_key: pipelineKey, from: currentStage, to: target, deal_id: deal?.id || null, via: 'sequence_step', scheduled_action_id: job.id },
  });
  return { applied: true, from: currentStage, to: target };
}

// Advances the enrollment past the acked step and queues the next one.
// Anchored on the ack time (D2): step N fires at "when its predecessor was
// acked" + its own delay, never at enrollment time plus a cumulative offset.
async function advanceEnrollment(client, companyId, { enrollment, anchor }) {
  const cur = await client.query(
    'SELECT step_order FROM sequence_steps WHERE id = $1 AND company_id = $2',
    [enrollment.current_step_id, companyId]
  );
  if (!cur.rows[0]) return { advanced: false, reason: 'current_step_missing' };

  const next = await client.query(
    `SELECT id FROM sequence_steps WHERE sequence_id = $1 AND company_id = $2 AND step_order > $3
     ORDER BY step_order ASC LIMIT 1`,
    [enrollment.sequence_id, companyId, cur.rows[0].step_order]
  );

  if (!next.rows[0]) {
    await client.query(
      `UPDATE enrollments SET status='completed', completed_at=now() WHERE id=$1 AND company_id=$2`,
      [enrollment.id, companyId]
    );
    return { advanced: true, completed: true };
  }

  await client.query(
    `UPDATE enrollments SET current_step_id=$1 WHERE id=$2 AND company_id=$3`,
    [next.rows[0].id, enrollment.id, companyId]
  );

  // D5b: a paused/archived sequence queues nothing further. Pausing is a send
  // control the user already believes they have; honouring it only in the
  // claim query would still let the ladder keep materializing rows.
  const seq = await client.query('SELECT status FROM sequences WHERE id=$1 AND company_id=$2', [enrollment.sequence_id, companyId]);
  if (seq.rows[0]?.status !== 'active') {
    // Record it. A skipped enqueue used to be invisible, which made a paused
    // ladder indistinguishable from a broken one. Re-activating the sequence
    // backfills the missing row (sequences.resumeSequenceQueue), so this is a
    // pause, not a silent death — but the operator should still see it.
    await noteActivity(client, companyId, enrollment.contact_id, {
      type: 'sequence_step_not_queued',
      message: `Next step not queued: the sequence is ${seq.rows[0]?.status || 'missing'}. Re-activating it will queue the step.`,
      data: { enrollment_id: enrollment.id, sequence_id: enrollment.sequence_id, sequence_status: seq.rows[0]?.status || null, next_step_id: next.rows[0].id },
    });
    return { advanced: true, completed: false, enqueued: false, reason: `sequence_${seq.rows[0]?.status || 'missing'}` };
  }

  const queued = await seqDb.materializeNextStep(companyId, enrollment.id, { client, after: anchor });
  return { advanced: true, completed: false, enqueued: !!queued };
}

// The single entry point for every CP2 side-effect. Owns its own transaction
// and its own pooled client, and NEVER throws — by the time it runs, the
// outcome it is reacting to is already committed.
async function runStepSideEffects(companyId, { job, outcome, anchor }) {
  // getClient() is acquired INSIDE the try. It was outside, which made the
  // "never throws" contract above a lie in exactly the condition the pool is
  // most likely to be under: DB_POOL_MAX is a small shared budget, so a
  // saturated pool made getClient() reject, and that rejection propagated out
  // through ackJob() into the route — turning an ack whose send was ALREADY
  // COMMITTED into an HTTP 500. An executor told "your ack failed" for a
  // message that physically went out is precisely the input that produces a
  // duplicate send. Same hazard in claimJobs(), which calls this after its own
  // COMMIT: a throw there discards the list of claimed job ids that the
  // executor never receives, orphaning committed claims for CLAIM_TIMEOUT_MS.
  let client = null;
  try {
    client = await getClient();
    await client.query('BEGIN');

    // Lock the enrollment so two side-effect runs for the same enrollment
    // (e.g. a claim-time suppression skip racing an ack) serialize.
    const enr = await client.query(
      'SELECT * FROM enrollments WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [job.enrollment_id, companyId]
    );
    const enrollment = enr.rows[0];
    if (!enrollment || enrollment.status !== 'active') {
      await client.query('COMMIT');
      return;
    }

    // D3b — act ONLY on the enrollment's current step. Migration 019 is told
    // to tolerate pre-existing duplicate (enrollment_id, step_id) rows, and
    // without this guard each of them would advance the enrollment, so it
    // would jump two steps and write the stage back twice.
    if (job.step_id !== enrollment.current_step_id) {
      await client.query('COMMIT');
      return;
    }

    if (outcome === 'suppressed_global' || outcome === 'failed_dead') {
      await client.query(
        `UPDATE enrollments SET status='exited', exit_reason=$1 WHERE id=$2 AND company_id=$3`,
        [outcome === 'suppressed_global' ? 'suppressed' : 'failed', enrollment.id, companyId]
      );
      await noteActivity(client, companyId, job.contact_id, {
        type: 'sequence_exited', channel: job.channel,
        message: outcome === 'suppressed_global'
          ? 'Sequence exited: contact is suppressed on all channels'
          : 'Sequence exited: message failed and exhausted its retries',
        data: { enrollment_id: enrollment.id, exit_reason: outcome === 'suppressed_global' ? 'suppressed' : 'failed' },
      });
      await client.query('COMMIT');
      return;
    }

    // 'sent' | 'skipped' | 'suppressed_channel' all advance the ladder.
    if (outcome === 'sent') {
      const step = await client.query(
        'SELECT * FROM sequence_steps WHERE id = $1 AND company_id = $2',
        [job.step_id, companyId]
      );
      if (step.rows[0]) {
        await applyStageWriteback(client, companyId, { job, step: step.rows[0], enrollment });
      }
    }

    await advanceEnrollment(client, companyId, { enrollment, anchor: anchor || new Date() });
    await client.query('COMMIT');
  } catch (err) {
    // client is null when getClient() itself failed — there is no transaction
    // to roll back in that case, only a failure to record.
    if (client) await client.query('ROLLBACK').catch(() => {});
    // D3: the send is already committed. A side-effect failure is loud in the
    // log and visible on the timeline, but it never becomes a failed ack and
    // never re-sends the message.
    console.error(`[CRM][cp2][side-effect-failure] company=${companyId} job=${job.id} outcome=${outcome}: ${err.message}`);
    try {
      await query(
        `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())`,
        [job.contact_id, companyId, 'sequence_step_side_effect_failed',
         `The message was sent, but advancing the sequence failed: ${err.message}`,
         job.channel, JSON.stringify({ scheduled_action_id: job.id, enrollment_id: job.enrollment_id, outcome, error: err.message })]
      );
    } catch (activityErr) {
      console.error(`[CRM][cp2] could not record side-effect failure: ${activityErr.message}`);
    }
  } finally {
    if (client) client.release();
  }
}

// Public ack: run the job's own transaction to completion, then — and only
// then — run CP2's side-effects (D3). runStepSideEffects never throws, so the
// HTTP result the executor sees is decided entirely by whether the SEND was
// recorded.
async function ackJob(companyId, jobId, opts = {}) {
  const { result, sideEffect } = await ackJobCore(companyId, jobId, opts);
  if (sideEffect) await runStepSideEffects(companyId, sideEffect);
  return result;
}

module.exports = { claimJobs, ackJob, CLAIM_TIMEOUT_MS, MAX_ATTEMPTS };
