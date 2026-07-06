#!/usr/bin/env node
// DenchClaw CRM — B3 (always-on dispatcher) verification. Drives the REAL
// claim/ack HTTP routes (server/routes/channel-jobs.js, implementing
// docs/contracts/channel-executor.openapi.yaml) against real scheduled_actions
// rows, applying A5's suppression/quiet-hours/rate-limit gates. Mixes HTTP
// (claim/ack — the routes automation engines actually call) with direct DB
// access (sequences/limits have no HTTP route of their own yet, per B1/A5's
// data-model-only scope).
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-b3-dispatcher.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import limitsDb from '../server/db/models/limits.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'b3_co_' + RUN;

if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': CO },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

async function makeEnrolledJob(overrides = {}) {
  const contact = await contactDb.create({ name: 'B3 Contact', email: `b3-${Math.random()}-${RUN}@example.com`, company_id: CO });
  const seq = await seqDb.createSequence({ companyId: CO, name: 'B3 Seq ' + Math.random(), pipelineKey: 'marketing', triggerStage: 'segmented' });
  const step = await seqDb.addStep(seq.id, CO, { stepOrder: 1, channel: overrides.channel || 'email', templateRef: overrides.templateRef || 'welcome' });
  const enrollment = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
  const action = await seqDb.scheduleAction(CO, {
    enrollmentId: enrollment.id, stepId: step.id,
    payload: overrides.payload || {}, scheduledFor: overrides.scheduledFor || new Date().toISOString(),
  });
  return { contact, seq, step, enrollment, action };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  // ── basic claim/ack round trip ────────────────────────────────────────────
  const { contact, seq, step, action } = await makeEnrolledJob();
  const claim = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 10, claimed_by: 'test-executor-1' });
  check('claim returns the scheduled job', claim.status === 200 && claim.json?.jobs?.some(j => j.job_id === action.id), JSON.stringify(claim.json));
  const claimedJob = claim.json.jobs.find(j => j.job_id === action.id);
  check('claimed job carries the right contact_id', claimedJob?.contact_id === contact.id, JSON.stringify(claimedJob));
  check('claimed job carries the right sequence_id (via step -> sequence join)', claimedJob?.sequence_id === seq.id, JSON.stringify(claimedJob));
  check('claimed job carries the right template_ref from the step', claimedJob?.template_ref === step.template_ref, JSON.stringify(claimedJob));

  const ack = await req('POST', `/api/crm/channel-jobs/${action.id}/ack`, { status: 'sent', claimed_by: 'test-executor-1', provider_message_id: 'pm-1' });
  check('ack(sent) returns 200', ack.status === 200 && ack.json?.status === 'sent', JSON.stringify(ack.json));
  const { rows: [dbRow] } = await db.query('SELECT * FROM scheduled_actions WHERE id = $1', [action.id]);
  check('ack(sent) actually persists status=sent and sent_at', dbRow.status === 'sent' && !!dbRow.sent_at, JSON.stringify(dbRow));
  const activity = await contactDb.getActivity(contact.id, 10, CO);
  check('ack(sent) writes a contact_activity row', activity.some(a => a.type === 'email_sent'), JSON.stringify(activity));

  // ── idempotency + conflict ────────────────────────────────────────────────
  const replay = await req('POST', `/api/crm/channel-jobs/${action.id}/ack`, { status: 'sent', claimed_by: 'test-executor-1' });
  check('replaying the same ack is idempotent (200)', replay.status === 200 && replay.json?.status === 'sent', JSON.stringify(replay.json));
  const conflict = await req('POST', `/api/crm/channel-jobs/${action.id}/ack`, { status: 'failed', claimed_by: 'test-executor-1', error: 'x' });
  check('re-acking with a conflicting status is rejected (409)', conflict.status === 409, JSON.stringify(conflict.json));

  // ── ownership enforcement (ack spoofing guard) ────────────────────────────
  const { action: action2 } = await makeEnrolledJob();
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'real-executor' });
  const spoofed = await req('POST', `/api/crm/channel-jobs/${action2.id}/ack`, { status: 'sent', claimed_by: 'impostor' });
  check('acking with a claimed_by that did not win the claim is rejected (404)', spoofed.status === 404, JSON.stringify(spoofed.json));

  // ── ack atomicity: two concurrent identical acks must not double-write ──
  const { contact: raceContact, action: raceAckAction } = await makeEnrolledJob();
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'race-executor' });
  const [ackRaceA, ackRaceB] = await Promise.all([
    req('POST', `/api/crm/channel-jobs/${raceAckAction.id}/ack`, { status: 'sent', claimed_by: 'race-executor' }),
    req('POST', `/api/crm/channel-jobs/${raceAckAction.id}/ack`, { status: 'sent', claimed_by: 'race-executor' }),
  ]);
  check('two concurrent identical acks both resolve 200 (one processes, one replays)',
    ackRaceA.status === 200 && ackRaceB.status === 200, `A=${ackRaceA.status} B=${ackRaceB.status}`);
  const raceActivity = await contactDb.getActivity(raceContact.id, 10, CO);
  check('...but write exactly ONE contact_activity row, not two (ack is atomic)',
    raceActivity.filter(a => a.type === 'email_sent').length === 1, JSON.stringify(raceActivity));

  // ── input validation ──────────────────────────────────────────────────────
  const badLimit = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: -1, claimed_by: 'x' });
  check('a negative limit is rejected with 400, not passed through to a raw DB error', badLimit.status === 400, JSON.stringify(badLimit.json));
  const nanLimit = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 'abc', claimed_by: 'x' });
  check('a non-numeric limit is rejected with 400', nanLimit.status === 400, JSON.stringify(nanLimit.json));
  const badJobId = await req('POST', '/api/crm/channel-jobs/not-a-uuid/ack', { status: 'sent', claimed_by: 'x' });
  check('a malformed job_id is rejected with 400, not a raw DB cast error (500)', badJobId.status === 400, JSON.stringify(badJobId.json));

  // ── channel scoping ────────────────────────────────────────────────────────
  const { action: smsAction } = await makeEnrolledJob({ channel: 'sms' });
  const emailClaimAfterSms = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'e' });
  check('an email claim never returns an sms-channel job', !emailClaimAfterSms.json.jobs.some(j => j.job_id === smsAction.id), JSON.stringify(emailClaimAfterSms.json));

  // ── retry / dead-letter ────────────────────────────────────────────────────
  const { action: retryAction } = await makeEnrolledJob();
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'flaky' });
  const failed1 = await req('POST', `/api/crm/channel-jobs/${retryAction.id}/ack`, { status: 'failed', claimed_by: 'flaky', error: 'boom' });
  check('a failed ack reports will_retry so the executor never has to guess', failed1.json?.retry?.will_retry === true, JSON.stringify(failed1.json));
  const { rows: [afterFail1] } = await db.query('SELECT * FROM scheduled_actions WHERE id = $1', [retryAction.id]);
  check('a retryable failure requeues the job (back to pending) with a future scheduled_for (actual backoff)',
    afterFail1.status === 'pending' && afterFail1.attempt === 2 && new Date(afterFail1.scheduled_for) > new Date(), JSON.stringify(afterFail1));
  check('...but does NOT clear claimed_by (so a replay of this exact ack is still idempotent, not a 404)',
    afterFail1.claimed_by === 'flaky', afterFail1.claimed_by);

  // Boundary regression: replaying the ack that pushes attempt to exactly
  // MAX_ATTEMPTS (default 3, i.e. the SECOND failure: attempt 2->3) must NOT
  // flip will_retry from the original true to a recomputed false — the
  // response must stay consistent with what the executor was already told.
  const { action: boundaryAction } = await makeEnrolledJob();
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'boundary-exec' });
  await req('POST', `/api/crm/channel-jobs/${boundaryAction.id}/ack`, { status: 'failed', claimed_by: 'boundary-exec', error: 'first' });
  await db.query(`UPDATE scheduled_actions SET scheduled_for = now() WHERE id = $1`, [boundaryAction.id]);
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'boundary-exec-2' });
  const secondFail = await req('POST', `/api/crm/channel-jobs/${boundaryAction.id}/ack`, { status: 'failed', claimed_by: 'boundary-exec-2', error: 'second' });
  check('setup: the second failure (attempt 2->3) still reports will_retry:true (2<3)',
    secondFail.json?.retry?.will_retry === true, JSON.stringify(secondFail.json));
  const replayedSecondFail = await req('POST', `/api/crm/channel-jobs/${boundaryAction.id}/ack`, { status: 'failed', claimed_by: 'boundary-exec-2', error: 'second' });
  check('replaying that exact ack does NOT flip will_retry to false (idempotent replay stays consistent)',
    replayedSecondFail.json?.retry?.will_retry === true, JSON.stringify(replayedSecondFail.json));
  const replayedFail1 = await req('POST', `/api/crm/channel-jobs/${retryAction.id}/ack`, { status: 'failed', claimed_by: 'flaky', error: 'boom' });
  check('replaying that exact failed ack (before anyone reclaims) is idempotent, not a 404/409',
    replayedFail1.status === 200 && replayedFail1.json?.retry?.will_retry === true, JSON.stringify(replayedFail1.json));
  // A job backed off into the future isn't reclaimable yet — fast-forward by
  // pulling scheduled_for back to "now" directly (simulating time passing
  // without an actual sleep) to exercise attempts 2 and 3 toward dead-letter.
  await db.query(`UPDATE scheduled_actions SET scheduled_for = now() WHERE id = $1`, [retryAction.id]);
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'flaky2' });
  await req('POST', `/api/crm/channel-jobs/${retryAction.id}/ack`, { status: 'failed', claimed_by: 'flaky2', error: 'boom again' });
  await db.query(`UPDATE scheduled_actions SET scheduled_for = now() WHERE id = $1`, [retryAction.id]);
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'flaky3' });
  const finalFail = await req('POST', `/api/crm/channel-jobs/${retryAction.id}/ack`, { status: 'failed', claimed_by: 'flaky3', error: 'boom final' });
  check('once max_attempts is reached, will_retry is false (dead-letter)', finalFail.json?.retry?.will_retry === false, JSON.stringify(finalFail.json));
  const { rows: [deadLettered] } = await db.query('SELECT * FROM scheduled_actions WHERE id = $1', [retryAction.id]);
  check('a dead-lettered job stays in terminal failed status (not requeued again)', deadLettered.status === 'failed', JSON.stringify(deadLettered));

  // ── suppression: claimed inline, never returned, marked skipped ──────────
  const { contact: suppressedContact, action: suppressedAction } = await makeEnrolledJob();
  await limitsDb.suppress(CO, suppressedContact.id, 'email', 'test suppression');
  const claimWithSuppressed = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'sup-test' });
  check('a suppressed contact\'s job is never returned by claim', !claimWithSuppressed.json.jobs.some(j => j.job_id === suppressedAction.id), JSON.stringify(claimWithSuppressed.json));
  const { rows: [suppressedRow] } = await db.query('SELECT * FROM scheduled_actions WHERE id = $1', [suppressedAction.id]);
  check('...and is marked skipped (terminal), not left pending forever', suppressedRow.status === 'skipped', JSON.stringify(suppressedRow));

  // ── quiet hours: nothing claimable while configured window covers "now" ──
  const { action: quietAction } = await makeEnrolledJob();
  const nowHour = new Date().getUTCHours();
  await limitsDb.setChannelLimits(CO, 'email', { quietHoursStart: 0, quietHoursEnd: (nowHour + 1) % 24, timezone: 'UTC' });
  const claimDuringQuiet = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'quiet-test' });
  check('claim returns nothing while quiet hours cover the current time', claimDuringQuiet.json.jobs.length === 0, JSON.stringify(claimDuringQuiet.json));
  await limitsDb.setChannelLimits(CO, 'email', { quietHoursStart: null, quietHoursEnd: null });
  const claimAfterQuiet = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'quiet-test-2' });
  check('...and returns it again once quiet hours are cleared', claimAfterQuiet.json.jobs.some(j => j.job_id === quietAction.id), JSON.stringify(claimAfterQuiet.json));

  // ── rate limit: caps how many jobs a single claim can hand out ───────────
  const rateJobs = await Promise.all([makeEnrolledJob(), makeEnrolledJob(), makeEnrolledJob()]);
  await limitsDb.setChannelLimits(CO, 'email', { maxPerHour: 1, maxPerDay: 100 });
  const rateClaim = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'rate-test' });
  check('claim caps the batch to the remaining rate budget (max_per_hour=1, 0 already sent -> at most 1)',
    rateClaim.json.jobs.filter(j => rateJobs.some(r => r.action.id === j.job_id)).length <= 1, JSON.stringify(rateClaim.json));
  await limitsDb.setChannelLimits(CO, 'email', { maxPerHour: null });

  // ── campaign_event forwarding on ack(sent) ────────────────────────────────
  const { action: campaignAction } = await makeEnrolledJob();
  await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'camp-test' });
  await req('POST', `/api/crm/channel-jobs/${campaignAction.id}/ack`, {
    status: 'sent', claimed_by: 'camp-test', campaign_event: { campaign: 'b3-test-campaign-' + RUN, type: 'send' },
  });
  const { rows: campaignRows } = await db.query(
    `SELECT * FROM campaign_events WHERE company_id = $1 AND campaign_id = $2`, [CO, 'b3-test-campaign-' + RUN]
  );
  check('ack(sent) with campaign_event forwards to the campaign_events pipeline', campaignRows.length === 1 && campaignRows[0].type === 'send', JSON.stringify(campaignRows));

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM B3 (dispatcher) verification — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
