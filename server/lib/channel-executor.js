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

// Channels where a subject is a real field. On chat-shaped channels a subject is
// meaningless, so demanding one would refuse every legitimate SMS.
const SUBJECT_CHANNELS = ['email'];

function makeExecutor({ channel, provider, enabledEnv, batchEnv, recipientField = 'email' }) {
  const ENABLED = () => process.env[enabledEnv] === '1';
  const BATCH = () => Math.min(parseInt(process.env[batchEnv], 10) || 25, 200);
  const INSTANCE_ID =
    `${channel}-exec-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  function bootGate() {
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
  const quarantine = (jobId, reason) =>
    query(`UPDATE scheduled_actions SET outcome_unknown_at = now(), outcome_unknown_reason = $2,
             updated_at = now() WHERE id = $1`, [jobId, String(reason).slice(0, 500)]);

  async function tick(companyId, _opts = {}) {
    const blocked = bootGate();
    if (blocked) return { ok: false, blocked, channel, sent: 0, failed: 0, quarantined: 0, skipped: 0, jobs: [] };

    const from = provider.senderFor(channel);
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

        const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) || {};
        const token = crypto.randomUUID();
        if (!(await markSendStarted(job.id, token))) {
          report.skipped++; report.jobs.push({ id: job.id, outcome: 'skipped_lost_ownership' });
          continue;
        }

        let sent = null;
        try {
          sent = await provider.send({ channel, from, to, payload, idempotencyKey: token });
        } catch (err) {
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
