'use strict';
// ─── CP4a rev 2: the email executor ──────────────────────────────────────────
// The first thing in this system that puts real mail in front of real people.
// Every rule below exists because rev 1 of this ticket had a way to email a
// human wrongly, and the critic found it.
//
// SHAPE: not a daemon. One HTTP tick (POST /api/crm/executors/email/tick) runs
// one batch — same posture as the dispatcher, which is pull-based on purpose:
// no extra process lifecycle, no crash-loop surface, and a tick is trivially
// testable and trivially stoppable. Cron or an operator drives it.
//
// THE FIVE RULES, each tied to the finding it closes:
//
//  1. NEVER RETRY AN UNKNOWN OUTCOME. `email-resend.js` now distinguishes
//     `err.definitive` (the provider rejected it; nothing was sent) from
//     `err.outcomeUnknown` (timeout/5xx/network fault; it may already be in the
//     prospect's inbox). Only a definitive rejection acks `failed` and consumes
//     a retry. An unknown outcome is QUARANTINED — the row keeps its
//     `send_started_at`, which the claim scan treats as untouchable, so it is
//     never re-served and never re-sent. A duplicate to a real prospect is
//     irreversible; a delayed message is recoverable by a human.
//
//  2. RECORD THE ATTEMPT BEFORE SENDING. `send_started_at` + a per-attempt
//     token are committed BEFORE the provider call, so a crash mid-send leaves
//     evidence the request left. Without it, "crashed before send" and "sent,
//     ack lost" are indistinguishable and the reclaim guesses — wrongly, half
//     the time, at a real person's inbox.
//
//  3. NO STALENESS GUARD BY DEFAULT. Rev 1 measured staleness from
//     `scheduled_for`, which A5 never refreshes while deferring: a step
//     scheduled 22:00 under quiet-hours-until-08:00 is 10h "stale" the moment it
//     becomes claimable, so the guard would have skipped legitimate sends every
//     night by design. Worse, a `skipped` ack ADVANCES the ladder, so the guard
//     would not have stopped a backlog burst — it would have fired "step 2" at
//     people who never got step 1. Any age limit here is therefore opt-in,
//     measured from when the job became CLAIMABLE, and refuses rather than skips.
//
//  4. PER-INSTANCE IDENTITY. `claimed_by` is unique per process. A constant
//     identity lets instance A hang past CLAIM_TIMEOUT_MS, B reclaim with the
//     same string, and both acks pass the ownership check — two sends, two 200s.
//
//  5. BOOT GATE INCLUDES A SENDER. A key with no connected sender used to fail
//     3× into dead-letter, and a dead-lettered ack sets
//     `enrollments.status='exited'`, which is TERMINAL — enabling the executor
//     on a misconfigured deployment permanently killed every active ladder
//     within minutes. Config-shaped errors now abort the tick without acking
//     anything, so they can never consume a retry.
const os = require('os');
const crypto = require('crypto');
const { query } = require('../db/index');
const resendEmail = require('./email-resend');
const dispatchDb = require('../db/models/dispatch');
const contactDb = require('../db/models/contacts');

// Explicit opt-in. A deployment that merely HAS a Resend key must not start
// mailing prospects because someone deployed; sending is switched on
// deliberately, once, by a human.
const ENABLED = () => process.env.EMAIL_EXECUTOR_ENABLED === '1';
const BATCH = () => Math.min(parseInt(process.env.EMAIL_EXECUTOR_BATCH, 10) || 25, 200);

// One identity per process (rule 4). Two instances can never collide, so an
// ack can only ever be accepted from the instance that actually claimed.
const INSTANCE_ID = `email-exec-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// Resolve the connected sending identity — the same table the composer's From
// selector is built from, so the executor and the human UI can never disagree
// about who we are.
// Reads CHANNEL_SENDERS FRESH rather than through crm.js's require-time cache.
// Same env var, so there is no second source of truth — but a safety gate must
// not depend on module load order. crm.js parses this once at require time, so
// whether the gate sees a sender would otherwise depend on when that module
// happened to be first required, which is exactly the kind of accident that
// makes a boot gate unreliable. Falls back to crm.js's table (which carries the
// built-in defaults) when the env var is absent.
function senderFor(channel = 'email') {
  let table = null;
  if (process.env.CHANNEL_SENDERS) {
    try {
      table = JSON.parse(process.env.CHANNEL_SENDERS);
    } catch {
      // FAIL CLOSED. An operator who set CHANNEL_SENDERS and got the JSON wrong
      // has an opinion about who we send as; silently falling back to the
      // built-in default would send real mail from an address they did not
      // choose. Refusing to send is the recoverable outcome.
      console.error('[CRM][email-executor] CHANNEL_SENDERS is not valid JSON — refusing to send rather than falling back to a default sender');
      return null;
    }
  }
  // NO fallback to crm.js's built-in defaults. Those exist so the composer's
  // From selector is populated locally; using them here would mean an operator
  // who set nothing gets real outreach sent from a hardcoded address they never
  // chose. For automated sending the identity must be configured on purpose.
  if (!table) return null;
  const senders = table[channel] || [];
  const chosen = senders.find(s => s && s.default) || senders[0];
  return chosen && chosen.identity ? chosen.identity : null;
}

// Rule 5. Returns null when safe to run, or a reason. Deliberately checks the
// SENDER, not just the key: `isConfigured()` alone was the exact gap that
// dead-lettered every ladder.
function bootGate() {
  if (!ENABLED()) return 'EMAIL_EXECUTOR_ENABLED is not 1 — sending is off';
  if (!resendEmail.isConfigured()) return 'RESEND_API_KEY is not configured';
  if (!senderFor('email')) return 'no explicitly configured sending address for email — set CHANNEL_SENDERS';
  return null;
}

// Defence in depth. The claim door already refuses content-less jobs, but this
// is the last code that runs before a real human is emailed, so it re-checks
// rather than trusting an upstream invariant. A job that fails here is a bug,
// and it is quarantined rather than sent or retried.
function contentProblem(payload) {
  const p = (typeof payload === 'string' ? JSON.parse(payload) : payload) || {};
  if (p.content_resolved !== true) return 'payload is not marked content_resolved';
  if (!p.body || !String(p.body).trim()) return 'payload has no body';
  if (!p.subject || !String(p.subject).trim()) return 'email payload has no subject';
  const leftover = p.content_literal_braces
    ? []  // resolution deliberately emitted literal braces from an {{escape}}
    : require('./ai-draft').unresolvedTokensIn(String(p.body) + ' ' + String(p.subject));
  if (leftover.length) {
    return `payload still contains unresolved ${leftover.map(t => '{' + t + '}').join(', ')}`
      + ' — fill the field on the contact, remove the token, or write {{' + leftover[0] + '}} for literal text';
  }
  return null;
}

// Committed BEFORE the provider call (rule 2), and a COMPARE-AND-SET rather
// than a blind write. This is the last gate before a physical send.
//
// The unguarded version had a real duplicate-send race: a batch is processed
// sequentially, so a slow provider can keep a tick busy past CLAIM_TIMEOUT_MS
// (25 jobs x 15s > 300s). A second tick then legitimately reclaims a job the
// first tick has not reached yet, sends it, and acks it — and the first tick
// afterwards stamps send_started_at onto the now-'sent' row and sends it AGAIN.
// The claim scan's send_started_at guard cannot help: at reclaim time the row
// genuinely had not started sending.
//
// So the send only proceeds if this process still owns the row, it is still
// 'claimed', and nobody has started a send on it. Zero rows updated means we
// lost the race — skip, do not send.
async function markSendStarted(jobId, token, owner) {
  const r = await query(
    `UPDATE scheduled_actions
        SET send_started_at = now(), send_attempt_token = $2, updated_at = now()
      WHERE id = $1
        AND claimed_by = $3
        AND status = 'claimed'
        AND send_started_at IS NULL
        AND outcome_unknown_at IS NULL`,
    [jobId, token, owner]
  );
  return r.rowCount === 1;
}

// A DEFINITIVE rejection means nothing was sent, so the in-flight marker must be
// cleared or the row would be quarantined forever for a failure we understand.
async function clearSendStarted(jobId) {
  await query(
    `UPDATE scheduled_actions SET send_started_at = NULL, updated_at = now() WHERE id = $1`,
    [jobId]
  );
}

async function quarantine(jobId, reason) {
  await query(
    `UPDATE scheduled_actions
        SET outcome_unknown_at = now(), outcome_unknown_reason = $2, updated_at = now()
      WHERE id = $1`,
    [jobId, String(reason).slice(0, 500)]
  );
}

// Runs ONE batch for ONE tenant. Returns a report; never throws for a per-job
// problem, because one bad job must not stop the queue.
async function tick(companyId, { maxAgeHours = null } = {}) {
  const blocked = bootGate();
  if (blocked) return { ok: false, blocked, sent: 0, failed: 0, quarantined: 0, skipped: 0, jobs: [] };

  const from = senderFor('email');
  const claimed = await dispatchDb.claimJobs(companyId, 'email', BATCH(), INSTANCE_ID);
  const report = { ok: true, instance: INSTANCE_ID, claimed: claimed.length, sent: 0, failed: 0, quarantined: 0, skipped: 0, jobs: [] };

  for (const job of claimed) {
   try {
    const problem = contentProblem(job.payload);
    if (problem) {
      await quarantine(job.id, `refused before sending: ${problem}`);
      report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_content', reason: problem });
      continue;
    }

    const contact = await contactDb.getById(job.contact_id, companyId);
    if (!contact || !contact.email) {
      await quarantine(job.id, 'contact has no email address');
      report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_no_recipient' });
      continue;
    }

    const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) || {};
    const token = crypto.randomUUID();
    const won = await markSendStarted(job.id, token, INSTANCE_ID);
    if (!won) {
      // Another tick reclaimed and handled this row while we were working. It
      // is emphatically NOT ours to send.
      report.skipped++; report.jobs.push({ id: job.id, outcome: 'skipped_lost_ownership' });
      continue;
    }

    let sent = null;
    try {
      sent = await resendEmail.sendEmail({
        from, to: contact.email,
        subject: payload.subject, text: payload.body,
        replyTo: process.env.INBOUND_REPLY_TO || undefined,
        idempotencyKey: token,
      });
    } catch (err) {
      if (err.configError) {
        // Rule 5: a misconfiguration is OUR fault, not the message's. Acking
        // failed here would burn a retry and, three times over, dead-letter the
        // job — which exits the enrollment TERMINALLY. Abort the whole tick
        // instead, loudly, having consumed nothing.
        await clearSendStarted(job.id);
        console.error(`[CRM][email-executor] ABORTING TICK — configuration error: ${err.message}`);
        report.ok = false; report.blocked = `configuration error: ${err.message}`;
        report.jobs.push({ id: job.id, outcome: 'aborted_config' });
        return report;
      }
      if (err.transient) {
        // Rate limited: nothing was sent, and it will work later. Release the
        // in-flight marker and leave the row to be claimed again WITHOUT acking,
        // so a provider throttle never costs the message one of its three lives.
        await clearSendStarted(job.id);
        report.skipped++; report.jobs.push({ id: job.id, outcome: 'deferred_rate_limited', reason: err.message });
        continue;
      }
      if (err.outcomeUnknown) {
        // Rule 1. The request left; we cannot know whether it arrived. Leave
        // send_started_at SET so the claim scan never re-serves this row, and
        // leave the job 'claimed' — deliberately not a state anything picks up.
        await quarantine(job.id, err.message);
        report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_unknown', reason: err.message });
        continue;
      }
      // Definitive rejection: nothing was sent, so this is a real failure and
      // may consume a retry. Clear the in-flight marker so the requeued row is
      // claimable again.
      await clearSendStarted(job.id);
      const ack = await dispatchDb.ackJob(companyId, job.id, {
        claimedBy: INSTANCE_ID, status: 'failed', error: err.message,
      });
      report.failed++; report.jobs.push({ id: job.id, outcome: 'failed', reason: err.message, retry: ack?.body?.retry });
      continue;
    }

    // Clear the quarantine marker on success. Leaving it set made a SENT row
    // keep appearing in the quarantine list, so an operator following the UI's
    // own advice would click "resend" on a message that had already gone out.
    await query(
      `UPDATE scheduled_actions
          SET provider_message_id = $2, outcome_unknown_at = NULL,
              outcome_unknown_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [job.id, sent.id || null]
    );
    await dispatchDb.ackJob(companyId, job.id, {
      claimedBy: INSTANCE_ID, status: 'sent', providerMessageId: sent.id || null,
      activity: {
        type: 'email_sent',
        message: `Sent email — "${payload.subject}"`,
        data: { subject: payload.subject, template_ref: payload.template_ref || null, message_id: sent.messageId || null },
      },
    });
    report.sent++;
    report.jobs.push({ id: job.id, outcome: 'sent', provider_message_id: sent.id || null });
   } catch (jobErr) {
    // "never throws for a per-job problem" has to be true in code, not just in
    // the comment: a malformed payload or a DB blip on ONE job used to abort the
    // whole tick, stranding the rest of the batch as 'claimed'.
    console.error(`[CRM][email-executor] job ${job.id} raised: ${jobErr.message}`);
    try { await quarantine(job.id, `executor error: ${jobErr.message}`); } catch { /* best effort */ }
    report.quarantined++; report.jobs.push({ id: job.id, outcome: 'quarantined_error', reason: jobErr.message });
   }
  }
  return report;
}

// Operator-facing: what needs a human? Quarantine is only useful if someone can
// see it, and its whole justification is that a human decides.
async function listQuarantine(companyId, { limit = 100 } = {}) {
  if (!companyId) throw new Error('email-executor.listQuarantine requires companyId');
  const r = await query(
    `SELECT id, contact_id, channel, status, attempt, scheduled_for, claimed_by,
            send_started_at, provider_message_id, outcome_unknown_at, outcome_unknown_reason,
            payload->>'subject' AS subject
       FROM scheduled_actions
      WHERE company_id = $1
        AND (
          outcome_unknown_at IS NOT NULL
          -- Crash limbo: the send started but nothing recorded an outcome
          -- (process killed mid-send). The claim scan will never re-serve such a
          -- row, so if it were not listed here it would freeze its enrollment
          -- permanently and invisibly.
          OR (send_started_at IS NOT NULL AND status = 'claimed'
              AND send_started_at < now() - interval '15 minutes')
        )
      ORDER BY COALESCE(outcome_unknown_at, send_started_at) DESC
      LIMIT $2`,
    [companyId, Math.min(parseInt(limit, 10) || 100, 500)]
  );
  return r.rows;
}

// Releasing a quarantined job is a deliberate human act with two options,
// because only a human can know which happened.
//   'resend'  — we believe it never arrived: clear the markers so it can be
//               claimed and sent again.
//   'discard' — we believe it did arrive: ack it sent so the ladder advances
//               without another physical send.
async function releaseQuarantine(companyId, jobId, decision) {
  if (!companyId) throw new Error('email-executor.releaseQuarantine requires companyId');
  if (!['resend', 'discard'].includes(decision)) throw new Error("decision must be 'resend' or 'discard'");
  const owned = await query(
    `SELECT * FROM scheduled_actions
      WHERE id = $1 AND company_id = $2
        AND (outcome_unknown_at IS NOT NULL OR send_started_at IS NOT NULL)`,
    [jobId, companyId]
  );
  const job = owned.rows[0];
  if (!job) return null;

  // A row that already reached a terminal state is NOT releasable. Without this
  // an operator could "resend" a message that had already gone out — acting on
  // a stale quarantine entry and mailing a prospect twice with our blessing.
  if (['sent', 'skipped'].includes(job.status)) {
    return { ok: false, decision, job_id: jobId, refused: `job is already '${job.status}' — releasing it would send a second copy` };
  }
  // 'discard' means "we believe it DID arrive", so it is only meaningful for a
  // send that actually left. On a pre-send quarantine (bad content, no
  // recipient) nothing was ever delivered, and advancing the ladder would make
  // step 2 reference a step-1 email that does not exist.
  if (decision === 'discard' && !job.send_started_at) {
    return { ok: false, decision, job_id: jobId, refused: 'nothing was ever sent for this job — discarding would advance the ladder past a message the contact never received' };
  }

  if (decision === 'resend') {
    await query(
      `UPDATE scheduled_actions
          SET status='pending', send_started_at=NULL, send_attempt_token=NULL,
              outcome_unknown_at=NULL, outcome_unknown_reason=NULL,
              claimed_by=NULL, claimed_at=NULL, scheduled_for=now(), updated_at=now()
        WHERE id=$1 AND company_id=$2`,
      [jobId, companyId]
    );
    return { ok: true, decision, job_id: jobId };
  }
  // 'discard' — treat the send as having happened. Goes through the normal ack
  // path so the ladder advances exactly as it would have, with no second send.
  await query(
    `UPDATE scheduled_actions SET status='claimed', claimed_by=$3, claimed_at=now(),
            outcome_unknown_at=NULL, outcome_unknown_reason=NULL, updated_at=now()
      WHERE id=$1 AND company_id=$2`,
    [jobId, companyId, INSTANCE_ID]
  );
  const ack = await dispatchDb.ackJob(companyId, jobId, {
    claimedBy: INSTANCE_ID, status: 'sent', providerMessageId: job.provider_message_id,
    activity: { type: 'email_sent', message: 'Marked sent by an operator after an unknown-outcome send', data: { released_from_quarantine: true } },
  });
  return { ok: ack?.httpStatus === 200, decision, job_id: jobId };
}

module.exports = { tick, bootGate, listQuarantine, releaseQuarantine, INSTANCE_ID, contentProblem, senderFor };
