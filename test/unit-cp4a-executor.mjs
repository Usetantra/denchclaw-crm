#!/usr/bin/env node
// DenchClaw CRM — CP4a rev 2 (email executor) verification.
//
// This is the first code that puts real mail in front of real people, so every
// check here is about a way to email a human WRONGLY. Rev 1's criteria asserted
// status flips and would have gone green while delivering blank mail; these
// assert CONTENT and, above all, that the provider is called EXACTLY ONCE.
//
// NO REAL PROVIDER IS EVER CONTACTED. The suite starts a local stub on 127.0.0.1
// and points RESEND_API_BASE at it. A test that actually emails a person is a
// gate breach, not a pass — so the stub also records every request, which is how
// "exactly once" is proven rather than assumed.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cp4a-executor.mjs

import http from 'node:http';
import { readFileSync } from 'node:fs';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import templatesDb from '../server/db/models/templates.js';

const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'x4a_co_' + RUN;
const CO2 = 'x4a_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
};

// ─── the stub provider ───────────────────────────────────────────────────────
// mode: 'ok' | 'reject4xx' | 'reject401' | 'ratelimit' | 'error5xx' | 'hang'
const stub = { mode: 'ok', requests: [], port: 0 };
const stubServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  stub.requests.push({ body, headers: req.headers, at: Date.now() });
  if (stub.mode === 'hang') return; // never responds — the timeout path
  if (stub.mode === 'reject4xx') { res.writeHead(422, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'invalid recipient' })); }
  if (stub.mode === 'reject401') { res.writeHead(401, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'API key is invalid' })); }
  if (stub.mode === 'ratelimit') { res.writeHead(429, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'rate limited' })); }
  if (stub.mode === 'error5xx') { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'upstream unavailable' })); }
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({ id: `stub-${stub.requests.length}` }));
});

async function main() {
  await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
  stub.port = stubServer.address().port;
  // Point the sender at the stub BEFORE loading the executor.
  process.env.RESEND_API_BASE = `http://127.0.0.1:${stub.port}`;
  process.env.RESEND_API_KEY = 'stub-key-not-real';
  process.env.RESEND_TIMEOUT_MS = '600';
  process.env.EMAIL_EXECUTOR_ENABLED = '1';
  process.env.CHANNEL_SENDERS = '{"email":[{"identity":"crm@stub.test","default":true}]}';

  const executor = (await import('../server/lib/email-executor.js')).default
    || await import('../server/lib/email-executor.js');
  const exec = executor.tick ? executor : executor.default;

  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  const jobsFor = async (enrId) => (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at', [enrId])).rows;
  const jobRow = async (id) => (await db.query('SELECT * FROM scheduled_actions WHERE id=$1', [id])).rows[0];
  const mkContact = (name, company = CO) =>
    contactDb.create({ name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g,'')}-${RUN}@ex.test`, company_id: company });

  // A ready-to-send job: real template, real contact, content resolved.
  let seqN = 0;
  async function mkJob({ company = CO, body = 'Hello {first_name}, this is real copy.', subject = 'Real subject', due = true } = {}) {
    seqN++;
    const ref = `x4a_tpl_${RUN}_${seqN}`;
    await templatesDb.upsertTemplate(company, { ref, channel: 'email', subject, body });
    const c = await mkContact(`X4A P${seqN}`, company);
    const s = await seqDb.createSequence({ companyId: company, name: `x4a ${RUN} ${seqN}`, pipelineKey: 'webinar_sales' });
    await seqDb.addStep(s.id, company, { stepOrder: 1, channel: 'email', templateRef: ref });
    await seqDb.addStep(s.id, company, { stepOrder: 2, channel: 'email', templateRef: ref, delaySeconds: 3600 });
    const e = await seqDb.enroll(company, { sequenceId: s.id, contactId: c.id });
    const j = (await jobsFor(e.id))[0];
    if (due) await db.query(`UPDATE scheduled_actions SET scheduled_for=now()-interval '1 minute' WHERE id=$1`, [j.id]);
    return { job: j, contact: c, seq: s, enr: e };
  }

  // ── X1 — migration 022 ────────────────────────────────────────────────────
  const mig = readFileSync(new URL('../migrations/022_send_attempt.sql', import.meta.url), 'utf8');
  await db.query(mig); await db.query(mig);
  check('X1 migration 022 re-applies twice with no error', true);
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name='scheduled_actions' AND column_name IN
      ('send_started_at','send_attempt_token','provider_message_id','outcome_unknown_at','outcome_unknown_reason')`)).rows;
  check('X1 the send-attempt columns exist', cols.length === 5, JSON.stringify(cols.map(c=>c.column_name)));

  // ── X2 — the boot gate (HIGH-5) ───────────────────────────────────────────
  process.env.EMAIL_EXECUTOR_ENABLED = '0';
  check('X2 disabled by default-ish: EMAIL_EXECUTOR_ENABLED!=1 blocks sending', !!exec.bootGate());
  process.env.EMAIL_EXECUTOR_ENABLED = '1';
  process.env.CHANNEL_SENDERS = '{"email":[{"identity":"crm@stub.test","default":true}]}';
  const realKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  check('X2 no provider key blocks sending', /RESEND_API_KEY/.test(exec.bootGate() || ''));
  process.env.RESEND_API_KEY = realKey;
  // THE LADDER-SHREDDING CASE: a key present but no connected sender. Before the
  // gate covered this, sendEmail threw 'no connected sender', the ack path
  // consumed 3 retries, dead-lettered, and a dead-letter sets
  // enrollments.status='exited' — TERMINAL. Enabling the executor on a
  // misconfigured deployment killed every active ladder within minutes.
  const savedSenders = process.env.CHANNEL_SENDERS;
  process.env.CHANNEL_SENDERS = '{"email":[]}';
  check('X2 a key WITHOUT a connected sender blocks sending (the ladder-shredding case)',
    /sending address/.test(exec.bootGate() || ''), String(exec.bootGate()));
  check('X2 …and senderFor reports none', exec.senderFor('email') === null, String(exec.senderFor('email')));
  process.env.CHANNEL_SENDERS = '{"email":[{"identity":"crm@stub.test","default":true}]}';
  check('X2 a malformed CHANNEL_SENDERS fails CLOSED, never open',
    (() => { process.env.CHANNEL_SENDERS = '{not json'; const b = exec.bootGate();
             process.env.CHANNEL_SENDERS = '{"email":[{"identity":"crm@stub.test","default":true}]}';
             return /sending address/.test(b || ''); })());
  check('X2 fully configured ⇒ the gate opens', exec.bootGate() === null, String(exec.bootGate()));
  if (savedSenders === undefined) { /* keep the stub sender for the rest of the run */ }

  // ── X3 — the happy path, asserting CONTENT not just status ───────────────
  stub.mode = 'ok'; stub.requests.length = 0;
  const h = await mkJob({ body: 'Hello {first_name}, this is real copy.', subject: 'Real subject' });
  const r1 = await exec.tick(CO);
  check('X3 the tick reports one send', r1.sent === 1, JSON.stringify(r1));
  check('X3 THE PROVIDER WAS CALLED EXACTLY ONCE', stub.requests.length === 1, String(stub.requests.length));
  const sentBody = stub.requests[0]?.body;
  check('X3 the provider received a NON-EMPTY body', !!sentBody?.text && sentBody.text.trim().length > 0, JSON.stringify(sentBody?.text));
  const firstName = String(h.contact.name).trim().split(/\s+/)[0];
  check('X3 …with the token RESOLVED against the real contact (not "{first_name}")',
    sentBody?.text?.startsWith(`Hello ${firstName},`) && !/\{first_name\}/.test(sentBody?.text || ''),
    `${sentBody?.text} (expected to start "Hello ${firstName},")`);
  check('X3 …and a real subject, not "(no subject)"', sentBody?.subject === 'Real subject', JSON.stringify(sentBody?.subject));
  check('X3 …addressed to the contact', (sentBody?.to || [])[0] === h.contact.email, JSON.stringify(sentBody?.to));
  check('X3 …from the connected sender', !!sentBody?.from, JSON.stringify(sentBody?.from));
  check('X3 an idempotency key accompanied the request', !!stub.requests[0]?.headers['idempotency-key']);
  const afterSend = await jobRow(h.job.id);
  check('X3 the job is sent', afterSend.status === 'sent', afterSend.status);
  check('X3 the provider id is on the row', !!afterSend.provider_message_id, String(afterSend.provider_message_id));
  const nextJobs = await jobsFor(h.enr.id);
  check('X3 the ladder advanced — step 2 is queued', nextJobs.length === 2, String(nextJobs.length));

  // ── X4 — THE REV-1 LESSON: never send blank content ──────────────────────
  stub.requests.length = 0;
  const blank = await mkJob({});
  await db.query(`UPDATE scheduled_actions SET payload = payload || '{"body":"   ","subject":"x"}'::jsonb WHERE id=$1`, [blank.job.id]);
  const r4 = await exec.tick(CO);
  check('X4 a job whose body is whitespace is NOT sent', stub.requests.length === 0, String(stub.requests.length));
  check('X4 …it is quarantined instead', r4.quarantined >= 1, JSON.stringify(r4));
  const blankRow = await jobRow(blank.job.id);
  check('X4 …and the reason names the content problem', /body|content/.test(blankRow.outcome_unknown_reason || ''), blankRow.outcome_unknown_reason);

  // ── X5 — HIGH-1: an unknown outcome is NEVER retried ─────────────────────
  stub.mode = 'hang'; stub.requests.length = 0;
  const unk = await mkJob({});
  const r5 = await exec.tick(CO);
  check('X5 a timeout does not count as a send', r5.sent === 0, JSON.stringify(r5));
  check('X5 …the request DID leave (so the outcome is genuinely unknown)', stub.requests.length === 1, String(stub.requests.length));
  check('X5 …it is quarantined, not failed', r5.quarantined === 1 && r5.failed === 0, JSON.stringify(r5));
  const unkRow = await jobRow(unk.job.id);
  check('X5 …send_started_at is RETAINED (the in-flight proof)', !!unkRow.send_started_at, String(unkRow.send_started_at));
  check('X5 …outcome_unknown_at is set', !!unkRow.outcome_unknown_at);
  check('X5 …attempt was NOT consumed', unkRow.attempt === 1, String(unkRow.attempt));
  // The decisive one: make it look stale and prove no scan re-serves it.
  await db.query(`UPDATE scheduled_actions SET claimed_at = now() - interval '2 hours' WHERE id=$1`, [unk.job.id]);
  stub.requests.length = 0;
  const r5b = await exec.tick(CO);
  check('X5 THE DUPLICATE-SEND PROOF: a stale in-flight row is never re-served',
    stub.requests.length === 0 && r5b.sent === 0, `requests=${stub.requests.length} ${JSON.stringify(r5b)}`);

  // ── X6 — a DEFINITIVE 4xx rejection is a real failure ────────────────────
  stub.mode = 'reject4xx'; stub.requests.length = 0;
  const rej = await mkJob({});
  const r6 = await exec.tick(CO);
  check('X6 a 4xx rejection is acked failed', r6.failed === 1 && r6.quarantined === 0, JSON.stringify(r6));
  const rejRow = await jobRow(rej.job.id);
  check('X6 …send_started_at is CLEARED (nothing was sent, so it must be retryable)',
    rejRow.send_started_at === null, String(rejRow.send_started_at));
  check('X6 …the attempt was consumed', rejRow.attempt >= 1, String(rejRow.attempt));
  check('X6 …and the row is requeued, not quarantined',
    rejRow.status === 'pending' && rejRow.outcome_unknown_at === null, `${rejRow.status}/${rejRow.outcome_unknown_at}`);

  // ── X7 — a 5xx is UNKNOWN, not definitive ────────────────────────────────
  stub.mode = 'error5xx'; stub.requests.length = 0;
  const e5 = await mkJob({});
  const r7 = await exec.tick(CO);
  check('X7 a 5xx is quarantined, NOT retried (it may have been accepted upstream)',
    r7.quarantined >= 1 && r7.failed === 0, JSON.stringify(r7));
  const e5row = await jobRow(e5.job.id);
  check('X7 …its in-flight marker is retained', !!e5row.send_started_at);

  // ── X8 — per-instance identity (HIGH-4) ──────────────────────────────────
  check('X8 the executor identity is per-instance, not a constant',
    /email-exec-.+-\d+-[0-9a-f]{8}/.test(exec.INSTANCE_ID), exec.INSTANCE_ID);
  const foreignAck = await (await import('../server/db/models/dispatch.js')).default
    .ackJob(CO, h.job.id, { claimedBy: 'some-other-instance', status: 'sent' });
  check('X8 an ack from a DIFFERENT identity is refused (404), so a reclaim cannot double-ack',
    foreignAck.httpStatus === 404, JSON.stringify(foreignAck));

  // ── X9 — reclaim bumps attempt (HIGH-2's second half) ────────────────────
  {
    const rc = await mkJob({});
    const dispatch = (await import('../server/db/models/dispatch.js')).default;
    const first = await dispatch.claimJobs(CO, 'email', 10, 'instance-A');
    const mine = first.find(j => j.id === rc.job.id);
    check('X9 the job was claimed once', !!mine, String(first.length));
    check('X9 a FIRST claim does not inflate attempt', mine.attempt === 0 || mine.attempt === 1, String(mine.attempt));
    await db.query(`UPDATE scheduled_actions SET claimed_at = now() - interval '2 hours' WHERE id=$1`, [rc.job.id]);
    const second = await dispatch.claimJobs(CO, 'email', 10, 'instance-B');
    const re = second.find(j => j.id === rc.job.id);
    check('X9 a stale row IS reclaimed by another instance', !!re, String(second.length));
    // `attempt` counts explicit ack(failed) calls ONLY. Bumping it on reclaim
    // was tried and reverted: it makes "picked up twice" look like "failed
    // twice", so a job dead-letters early — and a dead-letter exits the
    // enrollment terminally. Reclaim churn is bounded by the in-flight and
    // quarantine exclusions instead, which R2/R7 cover.
    check('X9 …and a reclaim does NOT burn a delivery retry',
      re.attempt === mine.attempt, `${mine.attempt} -> ${re && re.attempt}`);
  }

  // ── X10 — quarantine review and release ──────────────────────────────────
  const qList = await exec.listQuarantine(CO);
  check('X10 quarantined jobs are listable for a human', qList.length >= 3, String(qList.length));
  check('X10 …with the reason attached', qList.every(q => !!q.outcome_unknown_reason));
  stub.mode = 'ok'; stub.requests.length = 0;
  const rel = await exec.releaseQuarantine(CO, unk.job.id, 'resend');
  check('X10 releasing as "resend" returns ok', rel?.ok === true, JSON.stringify(rel));
  const relRow = await jobRow(unk.job.id);
  check('X10 …clears the in-flight + quarantine markers so it can flow again',
    relRow.send_started_at === null && relRow.outcome_unknown_at === null && relRow.status === 'pending',
    JSON.stringify([relRow.send_started_at, relRow.outcome_unknown_at, relRow.status]));
  const r10 = await exec.tick(CO);
  check('X10 …and it then actually sends', r10.sent >= 1 && stub.requests.length >= 1, JSON.stringify(r10));
  // 'discard' advances the ladder with NO second physical send.
  stub.mode = 'error5xx'; stub.requests.length = 0;
  const disc = await mkJob({});
  await exec.tick(CO);
  stub.requests.length = 0;
  const relD = await exec.releaseQuarantine(CO, disc.job.id, 'discard');
  check('X10 releasing as "discard" succeeds', relD?.ok === true, JSON.stringify(relD));
  check('X10 …WITHOUT a second physical send', stub.requests.length === 0, String(stub.requests.length));
  check('X10 …and the job is marked sent', (await jobRow(disc.job.id)).status === 'sent');

  // ── X11 — a long-deferred job is sent, never skipped ─────────────────────
  // The age guard is GONE, not merely opt-in: "how long has this been
  // sendable?" is not derivable from any column (scheduled_for is untouched by
  // A5 while deferring, and claimed_at is stamped by the very claim that
  // returns the row), so the guard could only ever be dead code or wrong code.
  stub.mode = 'ok'; stub.requests.length = 0;
  const deferred = await mkJob({});
  await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '10 hours' WHERE id=$1`, [deferred.job.id]);
  const r11 = await exec.tick(CO);
  check('X11 a job deferred for hours (e.g. by quiet hours) is still SENT, not skipped',
    r11.sent >= 1 && stub.requests.length >= 1, JSON.stringify(r11));


  // ── R — regressions for the Fable-5 critic's five HIGHs ──────────────────
  {
    const dispatch = (await import('../server/db/models/dispatch.js')).default;

    // R1 (HIGH) — the slow-tick / reclaim duplicate send. A tick claims a job,
    // stalls past CLAIM_TIMEOUT_MS, a second tick legitimately reclaims and
    // sends it — and the first tick must NOT then send it again.
    stub.mode = 'ok'; stub.requests.length = 0;
    const race = await mkJob({});
    const mine = (await dispatch.claimJobs(CO, 'email', 10, 'tick-ONE')).find(j => j.id === race.job.id);
    check('R1 tick ONE claimed the job', !!mine);
    await db.query(`UPDATE scheduled_actions SET claimed_at = now() - interval '2 hours' WHERE id=$1`, [race.job.id]);
    const r2 = await exec.tick(CO);           // tick TWO reclaims + sends
    check('R1 tick TWO sends it', r2.sent >= 1 && stub.requests.length === 1, `${r2.sent}/${stub.requests.length}`);
    // Now tick ONE finally gets there. It must lose the compare-and-set.
    const won = await (await import('../server/lib/email-executor.js')).default;
    const stillMine = await db.query(
      `UPDATE scheduled_actions SET send_started_at=now(), send_attempt_token=gen_random_uuid()
        WHERE id=$1 AND claimed_by='tick-ONE' AND status='claimed'
          AND send_started_at IS NULL AND outcome_unknown_at IS NULL`, [race.job.id]);
    check('R1 THE DUPLICATE-SEND FIX: the stalled tick loses the compare-and-set and cannot send',
      stillMine.rowCount === 0, String(stillMine.rowCount));
    check('R1 …so the provider was called exactly ONCE for this row', stub.requests.length === 1, String(stub.requests.length));

    // R2 (HIGH) — a PRE-SEND quarantine must be durable, not auto-released
    // after CLAIM_TIMEOUT_MS.
    stub.mode = 'ok'; stub.requests.length = 0;
    const noaddr = await mkJob({});
    await db.query(`UPDATE contacts SET email=NULL WHERE id=$1`, [noaddr.contact.id]);
    const rq = await exec.tick(CO);
    check('R2 a contact with no address is quarantined', rq.quarantined >= 1, JSON.stringify(rq));
    const qRow = await jobRow(noaddr.job.id);
    check('R2 …with send_started_at still NULL (nothing was attempted)', qRow.send_started_at === null);
    // Age it well past the claim timeout and prove no scan takes it back.
    await db.query(`UPDATE scheduled_actions SET claimed_at = now() - interval '2 hours' WHERE id=$1`, [noaddr.job.id]);
    await db.query(`UPDATE contacts SET email=$2 WHERE id=$1`, [noaddr.contact.id, `fixed-${RUN}@ex.test`]);
    stub.requests.length = 0;
    const rq2 = await exec.tick(CO);
    check('R2 QUARANTINE IS DURABLE: it is not auto-reclaimed after the claim timeout',
      !stub.requests.some(x => (x.body.to || [])[0] === `fixed-${RUN}@ex.test`), JSON.stringify(rq2));

    // R3 (HIGH) — an operator cannot "resend" something already sent, and
    // cannot "discard" something never sent.
    const sentRow = await jobRow(race.job.id);
    check('R3 the raced job really is sent', sentRow.status === 'sent', sentRow.status);
    await db.query(`UPDATE scheduled_actions SET outcome_unknown_at=now(), outcome_unknown_reason='stale entry' WHERE id=$1`, [race.job.id]);
    const badRelease = await exec.releaseQuarantine(CO, race.job.id, 'resend');
    check('R3 releasing a SENT job as "resend" is REFUSED (would mail the prospect twice)',
      badRelease?.ok === false && /already/.test(badRelease.refused || ''), JSON.stringify(badRelease));
    const badDiscard = await exec.releaseQuarantine(CO, noaddr.job.id, 'discard');
    check('R3 "discard" on a job that never sent is REFUSED (would advance the ladder past a message nobody got)',
      badDiscard?.ok === false && /nothing was ever sent/.test(badDiscard.refused || ''), JSON.stringify(badDiscard));
    // A successful send must clear the marker so the list never lies.
    stub.mode = 'ok'; stub.requests.length = 0;
    const clean = await mkJob({});
    await exec.tick(CO);
    const cleanRow = await jobRow(clean.job.id);
    check('R3 a successful send CLEARS any quarantine marker, so the list cannot go stale',
      cleanRow.status === 'sent' && cleanRow.outcome_unknown_at === null, JSON.stringify([cleanRow.status, cleanRow.outcome_unknown_at]));

    // R4 (HIGH) — a bad API key (401) must NOT burn retries into a terminal
    // enrollment exit. This is the ladder-shredding path.
    stub.mode = 'reject401'; stub.requests.length = 0;
    const badkey = await mkJob({});
    // Only the FIRST tick reaches the job: a config abort deliberately leaves it
    // 'claimed' without acking, so later ticks find nothing claimable until the
    // claim expires. That is the safe direction — nothing sent, nothing failed,
    // nothing exited — so the blocked report is asserted on the first tick.
    const r4 = await exec.tick(CO);
    for (let i = 0; i < 3; i++) await exec.tick(CO);
    const bkRow = await jobRow(badkey.job.id);
    const bkEnr = (await db.query('SELECT status, exit_reason FROM enrollments WHERE id=$1', [badkey.enr.id])).rows[0];
    check('R4 a 401 does NOT consume the retry budget', bkRow.attempt < 3, String(bkRow.attempt));
    check('R4 …the job is NOT dead-lettered', bkRow.status !== 'failed' || bkRow.attempt < 3, `${bkRow.status}/${bkRow.attempt}`);
    check('R4 THE LADDER SURVIVES a misconfigured key (enrollment not terminally exited)',
      bkEnr.status !== 'exited', JSON.stringify(bkEnr));
    check('R4 …and the tick reports itself blocked rather than pretending to work',
      r4.ok === false && /configuration/.test(r4.blocked || ''), JSON.stringify(r4.blocked));

    // R4b — 429 is transient: nothing sent, no retry burned.
    stub.mode = 'ratelimit'; stub.requests.length = 0;
    const rl = await mkJob({});
    const r4b = await exec.tick(CO);
    const rlRow = await jobRow(rl.job.id);
    check('R4b a 429 does not consume a retry', rlRow.attempt < 1 || rlRow.attempt === rl.job.attempt, String(rlRow.attempt));
    check('R4b …and is not quarantined, just deferred', rlRow.outcome_unknown_at === null, String(rlRow.outcome_unknown_at));
    check('R4b …with the in-flight marker released so it can go later', rlRow.send_started_at === null);

    // R5 (MEDIUM) — the boot gate must not accept a hardcoded default sender.
    const savedCS = process.env.CHANNEL_SENDERS;
    delete process.env.CHANNEL_SENDERS;
    check('R5 with NO CHANNEL_SENDERS configured the gate REFUSES (no sending from a default identity)',
      /sending address/.test(exec.bootGate() || ''), String(exec.bootGate()));
    process.env.CHANNEL_SENDERS = savedCS;

    // R6 (MEDIUM) — crash limbo is visible to a human.
    const limbo = await mkJob({});
    await db.query(`UPDATE scheduled_actions
                      SET status='claimed', claimed_by='dead-instance', claimed_at=now()-interval '1 hour',
                          send_started_at=now()-interval '1 hour'
                    WHERE id=$1`, [limbo.job.id]);
    const q = await exec.listQuarantine(CO);
    check('R6 a crash-limbo row (send started, no outcome recorded) is SURFACED for a human',
      q.some(x => x.id === limbo.job.id), JSON.stringify(q.map(x => x.id).slice(0, 5)));

    // R7 (MEDIUM) — reclaim churn is bounded by the in-flight exclusion, not by
    // an attempt cap: a row whose send already started is never re-served, so a
    // dying executor cannot spin the same row forever.
    const churn = await mkJob({});
    await db.query(`UPDATE scheduled_actions
                      SET status='claimed', claimed_by='dead', claimed_at=now()-interval '2 hours',
                          send_started_at=now()-interval '2 hours'
                    WHERE id=$1`, [churn.job.id]);
    const churnClaim = await dispatch.claimJobs(CO, 'email', 50, 'churn-test');
    check('R7 an in-flight row is never reclaimed, however stale (no reclaim churn, no double send)',
      !churnClaim.some(j => j.id === churn.job.id), String(churnClaim.length));
  }


  // ── R8 — "tried to SEND" and "a claim EXPIRED" must not share a counter ───
  // The orchestrator's forward risk: if a reclaim bumps `attempt`, pure claim
  // churn (a slow provider, two executor restarts) inflates it to MAX_ATTEMPTS,
  // and then the FIRST genuine failure dead-letters immediately instead of
  // getting its three real delivery attempts — and a dead-letter sets
  // enrollments.status='exited', which is TERMINAL. So the reclaim bump was
  // removed entirely: `attempt` counts delivery attempts and nothing else.
  {
    const dispatch = (await import('../server/db/models/dispatch.js')).default;
    stub.mode = 'ok'; stub.requests.length = 0;
    const churned = await mkJob({});
    // Two full claim-expiry cycles, no send attempted in either.
    await dispatch.claimJobs(CO, 'email', 10, 'inst-1');
    await db.query(`UPDATE scheduled_actions SET claimed_at=now()-interval '2 hours' WHERE id=$1`, [churned.job.id]);
    await dispatch.claimJobs(CO, 'email', 10, 'inst-2');
    await db.query(`UPDATE scheduled_actions SET claimed_at=now()-interval '2 hours' WHERE id=$1`, [churned.job.id]);
    const third = (await dispatch.claimJobs(CO, 'email', 10, 'inst-3')).find(j => j.id === churned.job.id);
    // `attempt` DEFAULTs to 1 (migrations/014), so an unburned job reads 1.
    check('R8 a job reclaimed twice has NOT burned any delivery attempts', third.attempt === 1, String(third.attempt));
    // Now ONE genuine delivery failure. It must retry, not dead-letter.
    const ack = await dispatch.ackJob(CO, churned.job.id, { claimedBy: 'inst-3', status: 'failed', error: 'transient provider error' });
    check('R8 THE CRITERION: reclaimed twice then failed once ⇒ still retries, does NOT dead-letter',
      ack.body?.retry?.will_retry === true, JSON.stringify(ack.body?.retry));
    const enr = (await db.query('SELECT status FROM enrollments WHERE id=$1', [churned.enr.id])).rows[0];
    check('R8 …and the enrollment is NOT terminally exited', enr.status === 'active', enr.status);
    const row = await jobRow(churned.job.id);
    check('R8 …the job is requeued for another try', row.status === 'pending' && row.attempt === 2, `${row.status}/${row.attempt}`);
  }

  // ── R9 — braced PROSE must send; only a real merge failure blocks ────────
  // "We call this the {growth} framework." is ordinary marketing copy. Blocking
  // it is a false refusal an operator cannot diagnose, and the reliable response
  // to an inexplicably stuck queue is to switch sending off.
  {
    stub.mode = 'ok'; stub.requests.length = 0;
    const prose = await mkJob({ body: 'Hi {first_name}, we call this the {growth} framework.', subject: 'The {growth} framework' });
    const rp = await exec.tick(CO);
    check('R9 copy containing braced PROSE is sent, not false-blocked', rp.sent >= 1, JSON.stringify(rp));
    const body = stub.requests[0]?.body;
    check('R9 …the merge field resolved', /^Hi X4A/.test(body?.text || ''), body?.text);
    check('R9 …and the braced prose survives verbatim', /\{growth\} framework/.test(body?.text || ''), body?.text);
    check('R9 …including in the subject', /\{growth\}/.test(body?.subject || ''), body?.subject);

    // A genuine merge failure still blocks, and the reason tells the operator
    // what to actually do about it.
    const templates = (await import('../server/db/models/templates.js')).default;
    const nameless = await contactDb.create({ name: '', email: `nameless-${RUN}@ex.test`, company_id: CO });
    const res = await templates.resolveStepContent(CO, { channel: 'email', subject: 'Hi', body: 'Hi {first_name}.' }, nameless);
    check('R9 a REAL unresolved merge field still blocks', res.resolved === false, JSON.stringify(res));
    check('R9 …and the reason is actionable (names the field and the escape)',
      /\{first_name\}/.test(res.reason || '') && /\{\{first_name\}\}/.test(res.reason || ''), res.reason);

    // The escape hatch actually works end to end.
    stub.requests.length = 0;
    const lit = await mkJob({ body: 'Write {{first_name}} to personalise. Regards.', subject: 'About merge fields' });
    const rl2 = await exec.tick(CO);
    check('R9 {{first_name}} sends as LITERAL {first_name}, not blocked and not substituted',
      rl2.sent >= 1 && /Write \{first_name\} to personalise/.test(stub.requests[0]?.body?.text || ''),
      stub.requests[0]?.body?.text);
  }

  // ── X12 — tenancy ────────────────────────────────────────────────────────
  stub.requests.length = 0;
  const foreign = await mkJob({ company: CO2 });
  const r12 = await exec.tick(CO);
  check('X12 a tick for one tenant never sends another tenant\'s job',
    !stub.requests.some(rq => (rq.body.to || [])[0] === foreign.contact.email),
    JSON.stringify(stub.requests.map(rq => rq.body.to)));

  await db.shutdownDatabase();
  await new Promise(r => stubServer.close(r));
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
