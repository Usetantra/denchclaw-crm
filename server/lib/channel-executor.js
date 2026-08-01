'use strict';
// ─── CP-C: ONE executor, instantiated per channel ────────────────────────────
//
// The governing rule of CP-C is "wrap, do not rebuild", and its sharpest form is
// this: there must not be a second sending path. So rather than copy the email
// executor for SMS and WhatsApp, the email executor's logic IS this file, and
// every channel — email included — is an instance of it.
//
// That means all five hard-won CP4a properties are inherited by every channel
// automatically, instead of being three chances to get them wrong:
//
//   1. An UNKNOWN outcome is never retried. Providers classify their failures
//      (`definitive` / `transient` / `outcomeUnknown` / `configError`) and only a
//      definitive rejection consumes a delivery retry. An unknown outcome keeps
//      its `send_started_at` — which the claim scan treats as untouchable — and
//      is quarantined for a human. A duplicate to a real person is irreversible;
//      a delayed message is recoverable.
//   2. The attempt is RECORDED BEFORE the send, by compare-and-set. Neither
//      Twilio nor Unipile supports an idempotency key, so a client-side reserve
//      is the only mechanism there is — and migration 022 already has one.
//   3. Per-instance `claimed_by`, so a reclaim cannot double-ack.
//   4. A boot gate that requires an EXPLICITLY configured sender, because a key
//      with no sender used to dead-letter jobs, and a dead-letter exits the
//      enrollment terminally — misconfiguration would shred every live ladder.
//   5. A content guard immediately before the provider call, because this is the
//      last code that runs before a real human is contacted.
//
// A provider adapter must expose:
//   isConfigured() -> bool
//   senderFor(channel) -> string|null      (the connected identity, or null)
//   send({ channel, from, to, payload, idempotencyKey }) -> { id, providerStatus }
//   and throw errors carrying one of configError / definitive / transient /
//   outcomeUnknown. Anything else is treated as unknown, i.e. quarantined —
//   failing safe, because "we don't know" must never be read as "it failed".
const os = require('os');
const crypto = require('crypto');
const { query } = require('../db/index');
const dispatchDb = require('../db/models/dispatch');
const contactDb = require('../db/models/contacts');
const { killSwitchOn, liveSendAllowed } = require('./send-safety');

// Channels where a subject is a real field. On chat-shaped channels a subject is
// meaningless, so demanding one would refuse every legitimate SMS.
const SUBJECT_CHANNELS = ['email'];

function makeExecutor({ channel, provider, enabledEnv, batchEnv, recipientField = 'email' }) {
  const ENABLED = () => process.env[enabledEnv] === '1';
  const BATCH = () => Math.min(parseInt(process.env[batchEnv], 10) || 25, 200);
  const INSTANCE_ID =
    `${channel}-exec-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  function bootGate() {
    // CP-C2: the global kill switch, checked HERE because tick() calls bootGate
    // at the top of every tick and every check below reads process.env fresh.
    // That is the whole requirement — an operator flipping this needs sending to
    // stop within one poll, not on the next restart. It is deliberately ahead of
    // the per-channel enable flag: during an incident you want one lever, not
    // one lever per channel you happened to remember.
    if (killSwitchOn()) return 'LIVE_SENDS_DISABLED is set — all sending is off';
    if (!ENABLED()) return `${enabledEnv} is not 1 — sending is off for ${channel}`;
    // A provider may supply its own wording — email's is load-bearing, because
    // its boot-gate reasons are asserted by CP4a's banked tests and naming the
    // actual env var is what makes the message actionable.
    if (!provider.isConfigured()) {
      return provider.configReason || `${channel} provider is not configured`;
    }
    if (!provider.senderFor(channel)) {
      return provider.senderReason || `no explicitly configured sending identity for ${channel}`;
    }
    return null;
  }

  function contentProblem(payload) {
    const p = (typeof payload === 'string' ? JSON.parse(payload) : payload) || {};
    if (p.content_resolved !== true) return 'payload is not marked content_resolved';
    if (!p.body || !String(p.body).trim()) return 'payload has no body';
    if (SUBJECT_CHANNELS.includes(channel) && (!p.subject || !String(p.subject).trim())) {
      return `${channel} payload has no subject`;
    }
    const leftover = p.content_literal_braces
      ? []
      : require('./ai-draft').unresolvedTokensIn(String(p.body) + ' ' + String(p.subject || ''));
    if (leftover.length) {
      return `payload still contains unresolved ${leftover.map(t => '{' + t + '}').join(', ')}`
        + ' — fill the field on the contact, remove the token, or write {{' + leftover[0] + '}} for literal text';
    }
    return null;
  }

  // Compare-and-set: the send proceeds only if this process still owns the row,
  // it is still 'claimed', and nobody has started a send on it. A batch is
  // processed sequentially, so a slow provider can keep a tick busy past
  // CLAIM_TIMEOUT_MS; a second tick then legitimately reclaims a job the first
  // has not reached, sends it — and without this the first tick would send it
  // again. Zero rows updated means we lost the race: skip, do not send.
  async function markSendStarted(jobId, token) {
    const r = await query(
      `UPDATE scheduled_actions
          SET send_started_at = now(), send_attempt_token = $2, updated_at = now()
        WHERE id = $1 AND claimed_by = $3 AND status = 'claimed'
          AND send_started_at IS NULL AND outcome_unknown_at IS NULL`,
      [jobId, token, INSTANCE_ID]
    );
    return r.rowCount === 1;
  }
  const clearSendStarted = (jobId) =>
    query(`UPDATE scheduled_actions SET send_started_at = NULL, updated_at = now() WHERE id = $1`, [jobId]);
  // CP-C2: hand a claimed job straight back, consuming NOTHING — no retry, no
  // reservation, no ladder movement. This is upstream's `release_send`
  // (linkedin_gate.py:246) in CRM terms: the job was legitimately claimed, then
  // a per-recipient rail refused it, and the slot must stop counting against the
  // caps immediately rather than ageing out. Deliberately NOT an ack: 'failed'
  // would burn a life and 'skipped' would advance the ladder past a message the
  // prospect never received.
  //
  // THREE GUARDS, each one a critic finding, each one a real duplicate-send:
  //   * `claimed_by = INSTANCE_ID` — without it, a slow tick returning to a job a
  //     second instance legitimately reclaimed and is CURRENTLY SENDING would
  //     hand that row back to the queue mid-flight. The ack would then 404 and
  //     the scan would re-serve a message already delivered to a real person.
  //   * `send_started_at IS NULL` — the same row, seen from the other side: a
  //     reservation that exists must never be erased by a release, because the
  //     claim scan's whole duplicate guard is that column being non-NULL.
  //   * `scheduled_for` is pushed out. A released job keeps a past
  //     `scheduled_for`, and the scan orders by it ASC — so a full batch of
  //     released jobs is re-claimed and re-released every tick forever, and a
  //     job to an ALLOWLISTED recipient scheduled later never surfaces. The
  //     allowlist would starve exactly the sends it exists to permit.
  // `linkedin_account_id` is deliberately NOT cleared: a released row is
  // 'pending' with no reservation, which the cap ledger already does not count,
  // and naming a channel-specific column here would make this generic path fail
  // on any deploy that ran before migration 024.
  const releaseClaim = (jobId) =>
    query(`UPDATE scheduled_actions
              SET status='pending', claimed_by=NULL, claimed_at=NULL,
                  scheduled_for = GREATEST(scheduled_for, now() + interval '15 minutes'),
                  updated_at=now()
            WHERE id = $1 AND status='claimed' AND claimed_by = $2
              AND send_started_at IS NULL`, [jobId, INSTANCE_ID]);
  const quarantine = (jobId, reason) =>
    query(`UPDATE scheduled_actions SET outcome_unknown_at = now(), outcome_unknown_reason = $2,
             updated_at = now() WHERE id = $1`, [jobId, String(reason).slice(0, 500)]);

  async function tick(companyId, _opts = {}) {
    const blocked = bootGate();
    if (blocked) return { ok: false, blocked, channel, sent: 0, failed: 0, quarantined: 0, skipped: 0, jobs: [] };

    // CP-C2: a per-tick, per-tenant preflight for anything the sync boot gate
    // cannot answer — LinkedIn's connected identity is a DB row (its caps, its
    // window and its timezone all hang off it), and an account an operator
    // paused must stop sending on the NEXT tick, which a boot-time check would
    // miss entirely.
    let ctx = null;
    if (provider.preflight) {
      const pre = await provider.preflight(companyId);
      if (pre && pre.blocked) {
        return { ok: false, blocked: pre.blocked, channel, sent: 0, failed: 0, quarantined: 0, skipped: 0, jobs: [] };
      }
      ctx = pre || null;
    }

    const from = (ctx && ctx.sender) || provider.senderFor(channel);
    const claimed = await dispatchDb.claimJobs(companyId, channel, BATCH(), INSTANCE_ID);
    const report = { ok: true, channel, instance: INSTANCE_ID, claimed: claimed.length,
      sent: 0, failed: 0, quarantined: 0, skipped: 0, jobs: [] };

    for (const job of claimed) {
      try {
        const problem = contentProblem(job.payload);
        if (problem) {
          await quarantine(job.id, `refused before sending: ${problem}`);
          report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_content', reason: problem });
          continue;
        }
        const contact = await contactDb.getById(job.contact_id, companyId);
        const to = contact && contact[recipientField];
        if (!to) {
          await quarantine(job.id, `contact has no ${recipientField} for ${channel}`);
          report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_no_recipient' });
          continue;
        }

        // CP-C2: the live allowlist, checked per RECIPIENT and therefore here
        // rather than at the claim door. Empty allowlist ⇒ unchanged behaviour;
        // set ⇒ only these people may receive a real send, which is what makes a
        // verification run against production data safe to do at all. Checked
        // BEFORE markSendStarted so no reservation is created and nothing leaks.
        if (!liveSendAllowed(channel, to)) {
          await releaseClaim(job.id);
          report.skipped++;
          report.jobs.push({ id: job.id, outcome: 'skipped_not_in_live_allowlist' });
          continue;
        }

        // A LAST-MOMENT per-job refusal. The claim door gates the whole scan,
        // but a batch is processed sequentially and a provider may take tens of
        // seconds per job, so a tick that started at 17:58 can reach its tail
        // after the send window closed. Upstream re-checked the window
        // immediately before every provider call; checking it only at the door
        // would have been the one place this port LOOSENED the original.
        if (provider.admitJob) {
          const refusal = await provider.admitJob({ job, contact, ctx, to });
          if (refusal) {
            await releaseClaim(job.id);
            report.skipped++;
            report.jobs.push({ id: job.id, outcome: 'skipped_gate', reason: refusal });
            continue;
          }
        }

        const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) || {};
        const token = crypto.randomUUID();
        if (!(await markSendStarted(job.id, token))) {
          report.skipped++; report.jobs.push({ id: job.id, outcome: 'skipped_lost_ownership' });
          continue;
        }

        let sent = null;
        try {
          // `job`, `contact` and `ctx` are passed for providers that need more
          // than an address: LinkedIn's action (invite/message/inmail) is a
          // property of the row the claim door stamped, and its target is a
          // profile identifier that has to be parsed off the contact.
          sent = await provider.send({ channel, from, to, payload, idempotencyKey: token, job, contact, ctx });
        } catch (err) {
          if (err.ineligible) {
            // The provider says this action is ILLEGAL for this relationship —
            // inviting someone already connected, messaging a stranger. Nothing
            // about retrying changes that, and a doomed retry loop against
            // LinkedIn is exactly the account-restriction path this checkpoint
            // exists to close. So it is TERMINAL: force the attempt count to the
            // ceiling and ack failed, which routes through the existing
            // dead-letter path (ending the ladder) instead of inventing a second
            // terminal state the rest of the system would not understand.
            await clearSendStarted(job.id);
            if (provider.onIneligible) {
              await provider.onIneligible({ companyId, job, contact, ctx, error: err }).catch(() => {});
            }
            await query(
              `UPDATE scheduled_actions SET attempt = $2
                WHERE id = $1 AND claimed_by = $3 AND status = 'claimed'`,
              [job.id, dispatchDb.MAX_ATTEMPTS, INSTANCE_ID]);
            await dispatchDb.ackJob(companyId, job.id, {
              claimedBy: INSTANCE_ID, status: 'failed', error: `ineligible: ${err.message}` });
            report.failed++;
            report.jobs.push({ id: job.id, outcome: 'ineligible', reason: err.message });
            continue;
          }
          if (err.configError) {
            // OUR misconfiguration, identical for every job. Acking failed would
            // burn a retry and, three times over, dead-letter the job — which
            // exits the enrollment terminally. Abort the tick having consumed
            // nothing.
            await clearSendStarted(job.id);
            console.error(`[CRM][${channel}-executor] ABORTING TICK — configuration error: ${err.message}`);
            report.ok = false; report.blocked = `configuration error: ${err.message}`;
            report.jobs.push({ id: job.id, outcome: 'aborted_config' });
            return report;
          }
          if (err.transient) {
            await clearSendStarted(job.id);
            report.skipped++; report.jobs.push({ id: job.id, outcome: 'deferred_rate_limited', reason: err.message });
            continue;
          }
          if (err.definitive) {
            await clearSendStarted(job.id);
            const ack = await dispatchDb.ackJob(companyId, job.id, {
              claimedBy: INSTANCE_ID, status: 'failed', error: err.message });
            report.failed++; report.jobs.push({ id: job.id, outcome: 'failed', reason: err.message, retry: ack?.body?.retry });
            continue;
          }
          // Unknown, INCLUDING an unclassified error: the request may have left,
          // so it is never retried. Failing safe means treating "we don't know"
          // as "may have been delivered".
          await quarantine(job.id, err.message);
          report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_unknown', reason: err.message });
          continue;
        }

        await query(
          `UPDATE scheduled_actions SET provider_message_id = $2, outcome_unknown_at = NULL,
                  outcome_unknown_reason = NULL, updated_at = now() WHERE id = $1`,
          [job.id, sent.id || null]
        );
        // Post-send bookkeeping the provider owns — for LinkedIn, recording that
        // an invite is now pending, which is what the accept gate and the
        // pending-invite ceiling both read on the next tick. Run BEFORE the ack
        // so a crash between them leaves the state recorded rather than a send
        // the safety spine has no memory of.
        if (provider.onSent) {
          await provider.onSent({ companyId, job, contact, ctx, sent }).catch((e) =>
            console.error(`[CRM][${channel}-executor] post-send bookkeeping failed for ${job.id}: ${e.message}`));
        }
        await dispatchDb.ackJob(companyId, job.id, {
          claimedBy: INSTANCE_ID, status: 'sent', providerMessageId: sent.id || null,
          activity: {
            type: `${channel}_sent`,
            message: `Sent ${channel}${payload.subject ? ` — "${payload.subject}"` : ''}`,
            data: { channel, subject: payload.subject || null, template_ref: payload.template_ref || null,
              provider_status: sent.providerStatus || null },
          },
        });
        report.sent++; report.jobs.push({ id: job.id, outcome: 'sent', provider_message_id: sent.id || null });
      } catch (jobErr) {
        console.error(`[CRM][${channel}-executor] job ${job.id} raised: ${jobErr.message}`);
        try { await quarantine(job.id, `executor error: ${jobErr.message}`); } catch { /* best effort */ }
        report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_error', reason: jobErr.message });
      }
    }
    return report;
  }

  async function listQuarantine(companyId, { limit = 100 } = {}) {
    if (!companyId) throw new Error('listQuarantine requires companyId');
    const r = await query(
      `SELECT id, contact_id, channel, status, attempt, scheduled_for, claimed_by,
              send_started_at, provider_message_id, outcome_unknown_at, outcome_unknown_reason,
              payload->>'subject' AS subject
         FROM scheduled_actions
        WHERE company_id = $1 AND channel = $2
          AND (outcome_unknown_at IS NOT NULL
               OR (send_started_at IS NOT NULL AND status = 'claimed'
                   AND send_started_at < now() - interval '15 minutes'))
        ORDER BY COALESCE(outcome_unknown_at, send_started_at) DESC
        LIMIT $3`,
      [companyId, channel, Math.min(parseInt(limit, 10) || 100, 500)]
    );
    return r.rows;
  }

  async function releaseQuarantine(companyId, jobId, decision) {
    if (!companyId) throw new Error('releaseQuarantine requires companyId');
    if (!['resend', 'discard'].includes(decision)) throw new Error("decision must be 'resend' or 'discard'");
    const owned = await query(
      `SELECT * FROM scheduled_actions WHERE id = $1 AND company_id = $2 AND channel = $3
         AND (outcome_unknown_at IS NOT NULL OR send_started_at IS NOT NULL)`,
      [jobId, companyId, channel]
    );
    const job = owned.rows[0];
    if (!job) return null;
    if (['sent', 'skipped'].includes(job.status)) {
      return { ok: false, decision, job_id: jobId, refused: `job is already '${job.status}' — releasing it would send a second copy` };
    }
    if (decision === 'discard' && !job.send_started_at) {
      return { ok: false, decision, job_id: jobId, refused: 'nothing was ever sent for this job — discarding would advance the ladder past a message the contact never received' };
    }
    if (decision === 'resend') {
      await query(
        `UPDATE scheduled_actions
            SET status='pending', send_started_at=NULL, send_attempt_token=NULL,
                outcome_unknown_at=NULL, outcome_unknown_reason=NULL,
                claimed_by=NULL, claimed_at=NULL, scheduled_for=now(), updated_at=now()
          WHERE id=$1 AND company_id=$2`, [jobId, companyId]);
      return { ok: true, decision, job_id: jobId };
    }
    await query(
      `UPDATE scheduled_actions SET status='claimed', claimed_by=$3, claimed_at=now(),
              outcome_unknown_at=NULL, outcome_unknown_reason=NULL, updated_at=now()
        WHERE id=$1 AND company_id=$2`, [jobId, companyId, INSTANCE_ID]);
    const ack = await dispatchDb.ackJob(companyId, jobId, {
      claimedBy: INSTANCE_ID, status: 'sent', providerMessageId: job.provider_message_id,
      activity: { type: `${channel}_sent`, message: 'Marked sent by an operator after an unknown-outcome send',
        data: { released_from_quarantine: true, channel } },
    });
    return { ok: ack?.httpStatus === 200, decision, job_id: jobId };
  }

  return { channel, tick, bootGate, contentProblem, listQuarantine, releaseQuarantine, INSTANCE_ID,
    senderFor: () => provider.senderFor(channel) };
}

module.exports = { makeExecutor, SUBJECT_CHANNELS };
