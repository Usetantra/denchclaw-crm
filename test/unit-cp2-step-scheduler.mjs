#!/usr/bin/env node
// DenchClaw CRM — CP2 (step scheduler) verification.
//
// CP2 closes the seam between an enrollment and the dispatcher's queue:
// before it, sequences.scheduleAction() had no caller in server/ at all, so an
// enrollment was a dead record and no message could ever fire. These checks
// are numbered against the ticket's E1–E16 and drive the REAL claim/ack HTTP
// routes wherever the behaviour is reachable over HTTP.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cp2-step-scheduler.mjs

import { readFileSync } from 'node:fs';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import limitsDb from '../server/db/models/limits.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cp2_co_' + RUN;
const CO2 = 'cp2_other_' + RUN;

if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body, company = CO) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

const DAY = 86400;
const secondsBetween = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 1000);

async function mkContact(company = CO, name = 'CP2 Contact') {
  return contactDb.create({ name, email: `cp2-${Math.random().toString(36).slice(2)}-${RUN}@example.com`, company_id: company });
}
async function mkDeal(contactId, company = CO, stage = 'qualification_form_fills', pipelineKey = 'webinar_sales') {
  const r = await db.query(
    `INSERT INTO deals (company_id, contact_id, title, stage, pipeline_key, metadata)
     VALUES ($1,$2,$3,$4,$5,'{}'::jsonb) RETURNING *`,
    [company, contactId, 'CP2 Deal', stage, pipelineKey]
  );
  return r.rows[0];
}
// A sequence + its steps. `steps` is [{ channel, delay, writeback }].
// triggerStage defaults to NULL on purpose: every active sequence sharing a
// trigger stage enrols the same contact, so a default trigger here would make
// unrelated fixtures cross-contaminate the stage-triggered blocks below.
async function mkSequence({ company = CO, name, pipelineKey = 'webinar_sales', triggerStage = null, steps = [] }) {
  const seq = await seqDb.createSequence({ companyId: company, name: `${name} ${RUN}`, pipelineKey, triggerStage });
  const made = [];
  for (let i = 0; i < steps.length; i++) {
    made.push(await seqDb.addStep(seq.id, company, {
      stepOrder: i + 1, channel: steps[i].channel || 'email', delaySeconds: steps[i].delay || 0,
      templateRef: steps[i].template || `tpl_${i + 1}`, stageWriteback: steps[i].writeback || null,
    }));
  }
  return { seq, steps: made };
}
const actionsFor = async (enrollmentId) =>
  (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at ASC', [enrollmentId])).rows;
const enrollmentRow = async (id) => (await db.query('SELECT * FROM enrollments WHERE id=$1', [id])).rows[0];
const dealRow = async (id) => (await db.query('SELECT * FROM deals WHERE id=$1', [id])).rows[0];
const activityTypes = async (contactId) =>
  (await db.query('SELECT type, message, data FROM contact_activity WHERE contact_id=$1 ORDER BY created_at ASC', [contactId])).rows;

async function claim(channel = 'email', company = CO, by = 'cp2-exec') {
  return req('POST', '/api/crm/channel-jobs/claim', { channel, limit: 25, claimed_by: by }, company);
}
async function ack(jobId, status, extra = {}, company = CO, by = 'cp2-exec') {
  return req('POST', `/api/crm/channel-jobs/${jobId}/ack`, { status, claimed_by: by, ...extra }, company);
}
// Claim a specific job and ack it — the executor round trip the ladder runs on.
async function claimAndAck(jobId, status = 'sent', extra = {}, company = CO) {
  const c = await claim('email', company);
  const got = (c.json?.jobs || []).find(j => j.job_id === jobId);
  if (!got) return { claimed: false, ack: null };
  const a = await ack(jobId, status, extra, company);
  return { claimed: true, ack: a };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ── E1 — migration 019 is idempotent and the schema is right ──────────────
  const mig = readFileSync(new URL('../migrations/019_step_scheduler.sql', import.meta.url), 'utf8');
  await db.query(mig);
  await db.query(mig);
  check('E1 migration 019 re-applies twice with no error', true);
  const col = await db.query(`SELECT is_nullable, data_type FROM information_schema.columns
                               WHERE table_name='sequence_steps' AND column_name='stage_writeback'`);
  check('E1 stage_writeback exists, TEXT, nullable',
    col.rows[0]?.data_type === 'text' && col.rows[0]?.is_nullable === 'YES', JSON.stringify(col.rows[0]));
  const idx = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname='uq_scheduled_actions_enrollment_step'`);
  check('E1 UNIQUE (enrollment_id, step_id) index present', /UNIQUE/.test(idx.rows[0]?.indexdef || ''), JSON.stringify(idx.rows));
  const legacySteps = await db.query(`SELECT count(*)::int n FROM sequence_steps WHERE stage_writeback IS NOT NULL`);
  check('E1 pre-existing steps are unaffected (no writeback backfilled)', legacySteps.rows[0].n === 0, JSON.stringify(legacySteps.rows));

  // ── E2 — enrolling queues exactly one row for step 1 ──────────────────────
  {
    const contact = await mkContact();
    const { seq, steps } = await mkSequence({ name: 'E2 queue on enroll', steps: [
      { delay: 0, template: 'fu1' }, { delay: 3 * DAY, template: 'fu2' },
    ] });
    const enrollment = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    const rows = await actionsFor(enrollment.id);
    check('E2 enrolling creates exactly one scheduled_action', rows.length === 1, `n=${rows.length}`);
    check('E2 the queued row is for STEP 1', rows[0]?.step_id === steps[0].id, JSON.stringify(rows[0]));
    check('E2 the queued row is pending', rows[0]?.status === 'pending', rows[0]?.status);
    check('E2 scheduled_for = enrolled_at + delay_seconds (±2s)',
      secondsBetween(rows[0].scheduled_for, enrollment.enrolled_at) <= 2,
      `${rows[0]?.scheduled_for} vs ${enrollment.enrolled_at}`);
    check('E2 channel copied from the step', rows[0]?.channel === 'email', rows[0]?.channel);
    check('E2 template_ref copied from the step', rows[0]?.template_ref === 'fu1', rows[0]?.template_ref);
    check('E2 contact_id derived from the enrollment, not a caller', rows[0]?.contact_id === contact.id, rows[0]?.contact_id);

    // a non-zero delay is measured from enrolled_at, not from now()
    const c2 = await mkContact();
    const { seq: s2 } = await mkSequence({ name: 'E2 delayed first step', steps: [{ delay: 2 * DAY }] });
    const e2 = await seqDb.enroll(CO, { sequenceId: s2.id, contactId: c2.id });
    const r2 = await actionsFor(e2.id);
    check('E2 a delayed step 1 lands at enrolled_at + delay (2d, ±2s)',
      Math.abs(secondsBetween(r2[0].scheduled_for, e2.enrolled_at) - 2 * DAY) <= 2,
      `${r2[0]?.scheduled_for} vs ${e2.enrolled_at}`);
  }

  // ── E2b — a zero-step sequence completes instead of dead-ending ───────────
  {
    const contact = await mkContact();
    const { seq } = await mkSequence({ name: 'E2b zero steps', steps: [] });
    const enrollment = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    check('E2b a zero-step enrollment is created', !!enrollment);
    check('E2b it queues nothing', (await actionsFor(enrollment.id)).length === 0);
    check("E2b its status is 'completed', NOT 'active'", enrollment.status === 'completed', enrollment.status);
    check('E2b completed_at is set', !!enrollment.completed_at, String(enrollment.completed_at));
    check('E2b current_step_id is null', enrollment.current_step_id === null, String(enrollment.current_step_id));
  }

  // ── E3 — BOTH enrollment paths queue (manual + stage trigger) ─────────────
  {
    const contact = await mkContact(CO, 'E3 Trigger Path');
    const deal = await mkDeal(contact.id);
    const { seq, steps } = await mkSequence({ name: 'E3 no-show recovery', triggerStage: 'no_show_followup_1', steps: [
      { delay: 0, writeback: 'no_show_followup_1' }, { delay: 3 * DAY, writeback: 'no_show_followup_2' },
    ] });
    // human advance (no `automated` flag) into the manual trigger stage
    let r = await req('POST', `/api/crm/contacts/${contact.id}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
    check('E3 human advance to scheduled_call 200', r.status === 200, JSON.stringify(r.json));
    r = await req('POST', `/api/crm/contacts/${contact.id}/advance`, { pipeline_key: 'webinar_sales', stage: 'no_show_followup_1' });
    check('E3 human advance into the manual trigger stage 200', r.status === 200, JSON.stringify(r.json));
    // Every ACTIVE sequence triggering on this stage enrols, so match on our
    // own sequence_id rather than assuming we are the only one.
    const mine = (r.json?.sequence_enrollments || []).find(e => e.sequence_id === seq.id);
    check('E3 the advance reports an enrollment for THIS sequence', !!mine, JSON.stringify(r.json?.sequence_enrollments));

    const enrollmentId = mine.enrollment_id;
    const rows = await actionsFor(enrollmentId);
    check('E3 enrollForTriggerStage QUEUED step 1 (the seam CP2 closes)', rows.length === 1 && rows[0].step_id === steps[0].id, JSON.stringify(rows));
    check('E3 the queued row is due immediately (delay 0)', secondsBetween(rows[0].scheduled_for, new Date()) <= 5, rows[0]?.scheduled_for);
    // and it is really claimable through the HTTP dispatcher
    const c = await claim();
    check('E3 the queued job is claimable over HTTP', (c.json?.jobs || []).some(j => j.job_id === rows[0].id), JSON.stringify(c.json?.jobs?.length));
    globalThis.__e3 = { contact, deal, seq, steps, enrollmentId, jobId: rows[0].id };
  }

  // ── E4 — idempotent enrollment ───────────────────────────────────────────
  {
    const contact = await mkContact();
    const { seq } = await mkSequence({ name: 'E4 idempotent', steps: [{ delay: 0 }, { delay: DAY }] });
    const first = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    const again = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    check('E4 re-enrolling returns the same enrollment', again.id === first.id, `${first.id} vs ${again.id}`);
    check('E4 re-enrolling leaves exactly one step-1 row', (await actionsFor(first.id)).length === 1);

    const c2 = await mkContact();
    const { seq: s2 } = await mkSequence({ name: 'E4 concurrent', steps: [{ delay: 0 }] });
    const both = await Promise.all([
      seqDb.enroll(CO, { sequenceId: s2.id, contactId: c2.id }),
      seqDb.enroll(CO, { sequenceId: s2.id, contactId: c2.id }),
    ]);
    check('E4 two concurrent enrolls converge on one enrollment', both[0].id === both[1].id, JSON.stringify(both.map(b => b.id)));
    const enrCount = await db.query(`SELECT count(*)::int n FROM enrollments WHERE sequence_id=$1`, [s2.id]);
    check('E4 exactly one enrollment row exists', enrCount.rows[0].n === 1, `n=${enrCount.rows[0].n}`);
    check('E4 exactly one step-1 row exists after the race', (await actionsFor(both[0].id)).length === 1);
  }

  // ── E5 — ack(sent) advances and queues the NEXT step at the ack anchor ────
  {
    const { enrollmentId, jobId, steps } = globalThis.__e3;
    const before = new Date();
    const a = await ack(jobId, 'sent', { provider_message_id: 'pm-e5' });
    check('E5 ack(sent) returns 200', a.status === 200 && a.json?.status === 'sent', JSON.stringify(a.json));
    const enr = await enrollmentRow(enrollmentId);
    check('E5 current_step_id advanced to step 2', enr.current_step_id === steps[1].id, JSON.stringify(enr.current_step_id));
    const rows = await actionsFor(enrollmentId);
    check('E5 exactly one NEW row exists for step 2', rows.filter(r => r.step_id === steps[1].id && r.status === 'pending').length === 1, JSON.stringify(rows.map(r => [r.step_id, r.status])));
    const step2 = rows.find(r => r.step_id === steps[1].id);
    check('E5 step 2 is anchored on the ACK, not on enrollment (+3d ±10s)',
      Math.abs(secondsBetween(step2.scheduled_for, before) - 3 * DAY) <= 10,
      `${step2?.scheduled_for} vs ack≈${before.toISOString()}`);
    check('E5 the step-1 row is terminal (sent)', rows.find(r => r.step_id === steps[0].id)?.status === 'sent');
  }

  // ── E8 — the stage write-back actually moves the deal ────────────────────
  {
    const { deal, enrollmentId, steps } = globalThis.__e3;
    // step 1 wrote back no_show_followup_1 — the deal was ALREADY there (the
    // human put it there), so that is a no-op, not a refusal. Walk step 2,
    // whose write-back is no_show_followup_2 and IS a real move.
    const rows = await actionsFor(enrollmentId);
    const job2 = rows.find(r => r.step_id === steps[1].id);
    await db.query('UPDATE scheduled_actions SET scheduled_for = now() - interval \'1 minute\' WHERE id=$1', [job2.id]);
    const res = await claimAndAck(job2.id, 'sent');
    check('E8 step 2 claimed and acked 200', res.claimed && res.ack?.status === 200, JSON.stringify(res.ack?.json));
    const d = await dealRow(deal.id);
    check('E8 the deal moved to no_show_followup_2 by the write-back', d.stage === 'no_show_followup_2', d.stage);
    const acts = await activityTypes(globalThis.__e3.contact.id);
    check('E8 a stage_change activity records the write-back',
      acts.some(a => a.type === 'stage_change' && a.data?.via === 'sequence_step' && a.data?.to === 'no_show_followup_2'),
      JSON.stringify(acts.map(a => a.type)));
  }

  // ── E7 — replaying an ack changes nothing ────────────────────────────────
  {
    const { enrollmentId, deal, steps } = globalThis.__e3;
    const rows = await actionsFor(enrollmentId);
    const job2 = rows.find(r => r.step_id === steps[1].id);
    const enrBefore = await enrollmentRow(enrollmentId);
    const countBefore = rows.length;
    const replay = await ack(job2.id, 'sent');
    check('E7 replayed ack(sent) is an idempotent 200', replay.status === 200 && replay.json?.status === 'sent', JSON.stringify(replay.json));
    const after = await actionsFor(enrollmentId);
    const enrAfter = await enrollmentRow(enrollmentId);
    check('E7 the replay queued nothing new', after.length === countBefore, `${countBefore} -> ${after.length}`);
    check('E7 the replay did not advance the enrollment', enrAfter.current_step_id === enrBefore.current_step_id);
    check('E7 the replay did not re-write the stage', (await dealRow(deal.id)).stage === 'no_show_followup_2');
  }

  // ── E9 — THE CP1 INVARIANT: never auto-advance a manual stage ────────────
  {
    const contact = await mkContact(CO, 'E9 Manual Guard');
    const deal = await mkDeal(contact.id, CO, 'scheduled_call');
    // scheduled_call -> proposal_sent IS a legal transition, and proposal_sent
    // is MANUAL — so only the mode gate can refuse it.
    const { seq, steps } = await mkSequence({ name: 'E9 manual writeback', triggerStage: null, steps: [{ delay: 0, writeback: 'proposal_sent' }] });
    const enr = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    const job = (await actionsFor(enr.id))[0];
    const res = await claimAndAck(job.id, 'sent');
    check('E9 the ack still returns 200 (the message really was sent)', res.ack?.status === 200 && res.ack?.json?.status === 'sent', JSON.stringify(res.ack?.json));
    check('E9 the job counts as sent', (await db.query('SELECT status FROM scheduled_actions WHERE id=$1', [job.id])).rows[0].status === 'sent');
    check('E9 the deal stage is UNCHANGED — a manual stage was not auto-set', (await dealRow(deal.id)).stage === 'scheduled_call', (await dealRow(deal.id)).stage);
    const acts = await activityTypes(contact.id);
    const refusal = acts.find(a => a.type === 'stage_writeback_refused');
    check('E9 a stage_writeback_refused activity was recorded', !!refusal, JSON.stringify(acts.map(a => a.type)));
    check('E9 the refusal names the stage it WANTED', refusal?.data?.wanted === 'proposal_sent', JSON.stringify(refusal?.data));
    check('E9 the refusal names the stage it FOUND', refusal?.data?.found === 'scheduled_call', JSON.stringify(refusal?.data));
    check('E9 the refusal reason is manual_stage', refusal?.data?.reason === 'manual_stage', JSON.stringify(refusal?.data));

    // ...and the same for an ILLEGAL transition
    const c2 = await mkContact(CO, 'E9 Illegal Guard');
    const d2 = await mkDeal(c2.id, CO, 'scheduled_call');
    const { seq: s2 } = await mkSequence({ name: 'E9 illegal writeback', triggerStage: null, steps: [{ delay: 0, writeback: 'no_show_followup_3' }] });
    const e2 = await seqDb.enroll(CO, { sequenceId: s2.id, contactId: c2.id });
    const j2 = (await actionsFor(e2.id))[0];
    const r2 = await claimAndAck(j2.id, 'sent');
    check('E9 an illegal write-back still acks 200', r2.ack?.status === 200, JSON.stringify(r2.ack?.json));
    check('E9 an illegal write-back leaves the stage unchanged', (await dealRow(d2.id)).stage === 'scheduled_call');
    const ref2 = (await activityTypes(c2.id)).find(a => a.type === 'stage_writeback_refused');
    check('E9 the illegal-transition refusal reason is illegal_transition', ref2?.data?.reason === 'illegal_transition', JSON.stringify(ref2?.data));
  }

  // ── E10 — a failing side-effect must never re-send ───────────────────────
  {
    const contact = await mkContact(CO, 'E10 Poisoned Metadata');
    const deal = await mkDeal(contact.id, CO, 'scheduled_call');
    // 'disqualified' is AUTO and a legal hop from scheduled_call, so the mode
    // and transition gates both pass and execution actually reaches the
    // metadata parse — a manual target would be refused before it got there.
    const { seq } = await mkSequence({ name: 'E10 side-effect throws', triggerStage: null, steps: [
      { delay: 0, writeback: 'disqualified' }, { delay: DAY },
    ] });
    const enr = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    const job = (await actionsFor(enr.id))[0];
    // deals.metadata is JSONB; a bare JSON *string* comes back as a JS string,
    // so the write-back's JSON.parse throws — a real, in-path side-effect failure.
    await db.query(`UPDATE deals SET metadata = '"{{{ not json"'::jsonb WHERE id=$1`, [deal.id]);
    const res = await claimAndAck(job.id, 'sent');
    check('E10 the ack STILL returns 200 despite the side-effect throwing', res.ack?.status === 200 && res.ack?.json?.status === 'sent', JSON.stringify(res.ack?.json));
    const row = (await db.query('SELECT * FROM scheduled_actions WHERE id=$1', [job.id])).rows[0];
    check("E10 the job is committed as 'sent' — the send was NOT rolled back", row.status === 'sent', row.status);
    check('E10 sent_at survived', !!row.sent_at, String(row.sent_at));
    const acts = await activityTypes(contact.id);
    check('E10 the failure is recorded on the timeline',
      acts.some(a => a.type === 'sequence_step_side_effect_failed'), JSON.stringify(acts.map(a => a.type)));
    // The repeated-send loop the critic found: a 'sent' row is neither
    // 'pending' nor a stale 'claimed', so no scan can ever hand it out again.
    await db.query(`UPDATE scheduled_actions SET claimed_at = now() - interval '2 hours' WHERE id=$1`, [job.id]);
    const rescan = await claim();
    check('E10 the row is NOT reclaimed even long past CLAIM_TIMEOUT_MS — no re-send loop',
      !(rescan.json?.jobs || []).some(j => j.job_id === job.id), JSON.stringify((rescan.json?.jobs || []).map(j => j.job_id)));
    // The accepted trade-off of D3: the send is never undone, but a side-effect
    // that throws does stall THAT enrollment's ladder. Stalled-and-visible beats
    // re-sent-forever; the timeline row above is how an operator sees it.
    const stalled = await enrollmentRow(enr.id);
    check('E10 the ladder stalls (does not advance) rather than re-sending', stalled.current_step_id === job.step_id, String(stalled.current_step_id));
    await db.query(`UPDATE deals SET metadata='{}'::jsonb WHERE id=$1`, [deal.id]);
  }

  // ── E10b — only the enrollment's CURRENT step has side-effects ───────────
  {
    const contact = await mkContact(CO, 'E10b Stale Step');
    await mkDeal(contact.id, CO, 'scheduled_call');
    const { seq, steps } = await mkSequence({ name: 'E10b stale step', triggerStage: null, steps: [
      { delay: 0 }, { delay: DAY }, { delay: DAY },
    ] });
    const enr = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    // Hand-queue step 3 while the enrollment still points at step 1, then ack it.
    const stale = await seqDb.scheduleAction(CO, { enrollmentId: enr.id, stepId: steps[2].id, scheduledFor: new Date(Date.now() - 60000).toISOString() });
    const before = await enrollmentRow(enr.id);
    const res = await claimAndAck(stale.id, 'sent');
    check('E10b acking a non-current step returns 200', res.ack?.status === 200, JSON.stringify(res.ack?.json));
    const after = await enrollmentRow(enr.id);
    check('E10b the enrollment did NOT advance', after.current_step_id === before.current_step_id, `${before.current_step_id} -> ${after.current_step_id}`);
    const rows = await actionsFor(enr.id);
    check('E10b no extra row was queued', rows.filter(r => r.step_id === steps[1].id).length === 0, JSON.stringify(rows.map(r => r.step_id)));
  }

  // ── E11 — terminal outcomes (D7), each proven separately ─────────────────
  {
    // (a) GLOBAL suppression exits the enrollment
    const c1 = await mkContact(CO, 'E11 Global Suppression');
    const { seq: s1 } = await mkSequence({ name: 'E11 global supp', triggerStage: null, steps: [{ delay: 0 }, { delay: DAY }] });
    const e1 = await seqDb.enroll(CO, { sequenceId: s1.id, contactId: c1.id });
    await limitsDb.suppress(CO, c1.id, null, 'unsubscribed');
    await claim();
    const enr1 = await enrollmentRow(e1.id);
    check('E11 global suppression EXITS the enrollment', enr1.status === 'exited', enr1.status);
    check("E11 exit_reason is 'suppressed'", enr1.exit_reason === 'suppressed', enr1.exit_reason);
    const rows1 = await actionsFor(e1.id);
    check('E11 the suppressed row is skipped', rows1[0]?.status === 'skipped', rows1[0]?.status);
    check('E11 nothing further was queued after a global suppression', rows1.length === 1, `n=${rows1.length}`);

    // (b) CHANNEL-SPECIFIC suppression advances instead of killing the ladder
    const c2 = await mkContact(CO, 'E11 Channel Suppression');
    const { seq: s2, steps: st2 } = await mkSequence({ name: 'E11 channel supp', triggerStage: null, steps: [
      { channel: 'email', delay: 0 }, { channel: 'sms', delay: 0 },
    ] });
    const e2 = await seqDb.enroll(CO, { sequenceId: s2.id, contactId: c2.id });
    await limitsDb.suppress(CO, c2.id, 'email', 'email only');
    await claim('email');
    const enr2 = await enrollmentRow(e2.id);
    check('E11 a channel-specific suppression does NOT exit the enrollment', enr2.status === 'active', enr2.status);
    check('E11 it advances to the next step instead', enr2.current_step_id === st2[1].id, String(enr2.current_step_id));
    const rows2 = await actionsFor(e2.id);
    check('E11 the next (sms) step was queued', rows2.some(r => r.step_id === st2[1].id && r.status === 'pending'), JSON.stringify(rows2.map(r => [r.channel, r.status])));

    // (c) executor ack(skipped) advances, anchored on the ack
    const c3 = await mkContact(CO, 'E11 Executor Skip');
    const { seq: s3, steps: st3 } = await mkSequence({ name: 'E11 exec skip', triggerStage: null, steps: [{ delay: 0 }, { delay: 3 * DAY }] });
    const e3 = await seqDb.enroll(CO, { sequenceId: s3.id, contactId: c3.id });
    const j3 = (await actionsFor(e3.id))[0];
    const at = new Date();
    const r3 = await claimAndAck(j3.id, 'skipped');
    check('E11 ack(skipped) returns 200', r3.ack?.status === 200, JSON.stringify(r3.ack?.json));
    const enr3 = await enrollmentRow(e3.id);
    check('E11 an executor skip ADVANCES the ladder', enr3.current_step_id === st3[1].id, String(enr3.current_step_id));
    const next3 = (await actionsFor(e3.id)).find(r => r.step_id === st3[1].id);
    check('E11 the skipped step anchors the next one on the ACK time (+3d ±10s)',
      Math.abs(secondsBetween(next3.scheduled_for, at) - 3 * DAY) <= 10, next3?.scheduled_for);

    // (d) retryable failure changes nothing
    const c4 = await mkContact(CO, 'E11 Retryable Failure');
    const { seq: s4, steps: st4 } = await mkSequence({ name: 'E11 retryable', triggerStage: null, steps: [{ delay: 0 }, { delay: DAY }] });
    const e4 = await seqDb.enroll(CO, { sequenceId: s4.id, contactId: c4.id });
    const j4 = (await actionsFor(e4.id))[0];
    const r4 = await claimAndAck(j4.id, 'failed', { error: 'smtp timeout' });
    check('E11 a retryable ack(failed) returns will_retry', r4.ack?.json?.retry?.will_retry === true, JSON.stringify(r4.ack?.json));
    const enr4 = await enrollmentRow(e4.id);
    check('E11 a retryable failure leaves the enrollment untouched', enr4.status === 'active' && enr4.current_step_id === st4[0].id, JSON.stringify([enr4.status, enr4.current_step_id]));
    const rows4 = await actionsFor(e4.id);
    check('E11 the row requeued itself with backoff, and nothing new was queued',
      rows4.length === 1 && rows4[0].status === 'pending' && new Date(rows4[0].scheduled_for) > new Date(), JSON.stringify(rows4.map(r => [r.status, r.scheduled_for])));

    // (e) dead-lettered failure exits
    const c5 = await mkContact(CO, 'E11 Dead Letter');
    const { seq: s5 } = await mkSequence({ name: 'E11 dead letter', triggerStage: null, steps: [{ delay: 0 }, { delay: DAY }] });
    const e5 = await seqDb.enroll(CO, { sequenceId: s5.id, contactId: c5.id });
    const j5 = (await actionsFor(e5.id))[0];
    let last = null;
    for (let i = 0; i < 3; i++) {
      await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [j5.id]);
      last = await claimAndAck(j5.id, 'failed', { error: 'hard bounce' });
    }
    check('E11 the final ack(failed) has dead-lettered', last?.ack?.json?.retry?.will_retry === false, JSON.stringify(last?.ack?.json));
    const enr5 = await enrollmentRow(e5.id);
    check('E11 a dead-lettered failure EXITS the enrollment', enr5.status === 'exited', enr5.status);
    check("E11 exit_reason is 'failed'", enr5.exit_reason === 'failed', enr5.exit_reason);
  }

  // ── E11b — pausing a sequence actually stops it ─────────────────────────
  {
    const contact = await mkContact(CO, 'E11b Pause');
    const { seq } = await mkSequence({ name: 'E11b pause', triggerStage: null, steps: [{ delay: 0 }, { delay: DAY }] });
    const enr = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
    const job = (await actionsFor(enr.id))[0];
    // The row is already DUE — pause must be what stops it, not the clock.
    await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '10 minutes' WHERE id=$1`, [job.id]);
    const p = await req('PATCH', `/api/crm/sequences/${seq.id}`, { status: 'paused' });
    check('E11b pausing the sequence 200', p.status === 200 && p.json?.status === 'paused', JSON.stringify(p.json));
    const c1 = await claim();
    check('E11b a paused sequence\'s DUE row is NOT claimable', !(c1.json?.jobs || []).some(j => j.job_id === job.id), JSON.stringify((c1.json?.jobs || []).map(j => j.job_id)));
    check('E11b the row is still pending (not consumed)', (await db.query('SELECT status FROM scheduled_actions WHERE id=$1', [job.id])).rows[0].status === 'pending');
    await req('PATCH', `/api/crm/sequences/${seq.id}`, { status: 'active' });
    const c2 = await claim();
    check('E11b re-activating makes it claimable again', (c2.json?.jobs || []).some(j => j.job_id === job.id), JSON.stringify((c2.json?.jobs || []).map(j => j.job_id)));

    // and a paused sequence enqueues nothing further on ack
    await req('PATCH', `/api/crm/sequences/${seq.id}`, { status: 'paused' });
    const a = await ack(job.id, 'sent');
    check('E11b acking an in-flight job of a paused sequence still 200s', a.status === 200, JSON.stringify(a.json));
    const rows = await actionsFor(enr.id);
    check('E11b no next step was enqueued while paused', rows.length === 1, JSON.stringify(rows.map(r => r.status)));
    // ...and the skip is VISIBLE, not silent
    check('E11b the skipped enqueue is recorded on the timeline',
      (await activityTypes(contact.id)).some(x => x.type === 'sequence_step_not_queued'),
      JSON.stringify((await activityTypes(contact.id)).map(x => x.type)));

    // THE REGRESSION THAT MATTERS (critic F1): pausing during an in-flight step
    // used to strand the enrollment forever — it advanced past step 1 but no row
    // was ever queued for step 2, and nothing re-drove it. Re-activating must
    // actually resume.
    const strandedBefore = await enrollmentRow(enr.id);
    check('E11b the enrollment advanced past the acked step while paused', strandedBefore.current_step_id !== job.step_id);
    const resumed = await req('PATCH', `/api/crm/sequences/${seq.id}`, { status: 'active' });
    check('E11b re-activating reports the backfilled action', resumed.json?.requeued_actions === 1, JSON.stringify(resumed.json));
    const afterResume = await actionsFor(enr.id);
    check('E11b re-activating QUEUES the stranded step (no permanent silent stall)',
      afterResume.length === 2 && afterResume.some(r => r.step_id === strandedBefore.current_step_id && r.status === 'pending'),
      JSON.stringify(afterResume.map(r => [r.step_id, r.status])));
    // and it really becomes claimable once due
    const stranded = afterResume.find(r => r.step_id === strandedBefore.current_step_id);
    await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [stranded.id]);
    const c3 = await claim();
    check('E11b the resumed step is claimable', (c3.json?.jobs || []).some(j => j.job_id === stranded.id), JSON.stringify((c3.json?.jobs || []).map(j => j.job_id)));
    // resume is idempotent — a second activate must not double-queue
    const again = await req('PATCH', `/api/crm/sequences/${seq.id}`, { status: 'active' });
    check('E11b re-activating again queues nothing extra (idempotent resume)',
      !again.json?.requeued_actions && (await actionsFor(enr.id)).length === 2, JSON.stringify(again.json));
  }

  // ── E12 — stage_writeback chain validation at configuration time ─────────
  {
    const good = await req('POST', '/api/crm/sequences', { name: `E12 valid ${RUN}`, pipeline_key: 'webinar_sales', trigger_stage: 'no_show_followup_1' });
    check('E12 sequence created', good.status === 201, JSON.stringify(good.json));
    const sid = good.json.id;
    const s1 = await req('POST', `/api/crm/sequences/${sid}/steps`, { step_order: 1, channel: 'email', stage_writeback: 'no_show_followup_1' });
    check('E12 a valid first write-back step is accepted', s1.status === 201, JSON.stringify(s1.json));
    check('E12 stage_writeback is persisted', s1.json?.stage_writeback === 'no_show_followup_1', JSON.stringify(s1.json));
    const s2 = await req('POST', `/api/crm/sequences/${sid}/steps`, { step_order: 2, channel: 'email', delay_seconds: 3 * DAY, stage_writeback: 'no_show_followup_2' });
    check('E12 a walkable next link is accepted', s2.status === 201, JSON.stringify(s2.json));
    // fu2 -> fu4 is NOT a legal transition
    const bad = await req('POST', `/api/crm/sequences/${sid}/steps`, { step_order: 3, channel: 'email', stage_writeback: 'no_show_followup_4' });
    check('E12 an UNWALKABLE chain link is rejected 400 at config time', bad.status === 400, JSON.stringify(bad.json));
    check('E12 the 400 explains which hop is impossible', /not walkable/.test(bad.json?.error || ''), JSON.stringify(bad.json));
    const bogus = await req('POST', `/api/crm/sequences/${sid}/steps`, { step_order: 4, channel: 'email', stage_writeback: 'not_a_stage' });
    check('E12/E15 a stage_writeback naming an unknown stage is 400', bogus.status === 400 && /not a stage/.test(bogus.json?.error || ''), JSON.stringify(bogus.json));
    check('E12 the unknown-stage 400 lists the allowed stages', Array.isArray(bogus.json?.allowed_stages), JSON.stringify(bogus.json));
    // a sequence with no pipeline cannot declare a write-back at all
    const nop = await req('POST', '/api/crm/sequences', { name: `E12 nopipe ${RUN}` });
    const nopStep = await req('POST', `/api/crm/sequences/${nop.json.id}/steps`, { step_order: 1, channel: 'email', stage_writeback: 'deals' });
    check('E12 stage_writeback without a pipeline_key is 400', nopStep.status === 400, JSON.stringify(nopStep.json));
  }

  // ── E13 — the full No-Show ladder, end to end ───────────────────────────
  {
    const contact = await mkContact(CO, 'E13 Full Ladder');
    const deal = await mkDeal(contact.id);
    const { seq, steps } = await mkSequence({ name: 'E13 No-show recovery', triggerStage: 'no_show_followup_1', steps: [
      { delay: 0,       writeback: 'no_show_followup_1' },
      { delay: 3 * DAY, writeback: 'no_show_followup_2' },
      { delay: 3 * DAY, writeback: 'no_show_followup_3' },
      { delay: 3 * DAY, writeback: 'no_show_followup_4' },
      { delay: 7 * DAY, writeback: 'no_show_followup_5' },
    ] });
    await req('POST', `/api/crm/contacts/${contact.id}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
    const adv = await req('POST', `/api/crm/contacts/${contact.id}/advance`, { pipeline_key: 'webinar_sales', stage: 'no_show_followup_1' });
    const enrollmentId = (adv.json?.sequence_enrollments || []).find(e => e.sequence_id === seq.id)?.enrollment_id;
    check('E13 the human no-show mark enrolled the contact', !!enrollmentId, JSON.stringify(adv.json));

    const expectedDelays = [0, 3 * DAY, 3 * DAY, 3 * DAY, 7 * DAY];
    const expectedStages = ['no_show_followup_1', 'no_show_followup_2', 'no_show_followup_3', 'no_show_followup_4', 'no_show_followup_5'];
    for (let i = 0; i < 5; i++) {
      const rows = await actionsFor(enrollmentId);
      const job = rows.find(r => r.step_id === steps[i].id);
      check(`E13 step ${i + 1} is queued`, !!job, JSON.stringify(rows.map(r => r.step_id)));
      if (!job) break;
      if (i > 0) {
        // timing asserted as a DELTA, never by waiting
        const prevSent = rows.find(r => r.step_id === steps[i - 1].id)?.sent_at;
        check(`E13 step ${i + 1} is scheduled +${expectedDelays[i] / DAY}d after step ${i} sent (±10s)`,
          Math.abs(secondsBetween(job.scheduled_for, prevSent) - expectedDelays[i]) <= 10,
          `${job.scheduled_for} vs ${prevSent}`);
      }
      await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [job.id]);
      const r = await claimAndAck(job.id, 'sent');
      check(`E13 step ${i + 1} claimed + acked sent`, r.claimed && r.ack?.status === 200, JSON.stringify(r.ack?.json));
      check(`E13 the board mirrors ${expectedStages[i]} after step ${i + 1}`,
        (await dealRow(deal.id)).stage === expectedStages[i], (await dealRow(deal.id)).stage);
    }
    const finalEnr = await enrollmentRow(enrollmentId);
    check('E13 after the last step the enrollment is completed', finalEnr.status === 'completed', finalEnr.status);
    check('E13 completed_at is set', !!finalEnr.completed_at);
    const pending = (await actionsFor(enrollmentId)).filter(r => r.status === 'pending');
    check('E13 nothing is left pending', pending.length === 0, JSON.stringify(pending.map(p => p.step_id)));
    check('E13 exactly 5 rows were ever queued (one per step, no duplicates)',
      (await actionsFor(enrollmentId)).length === 5, String((await actionsFor(enrollmentId)).length));
    globalThis.__e13 = { seq, contact };
  }

  // ── E15 — tenancy ───────────────────────────────────────────────────────
  {
    const { seq, contact } = globalThis.__e13;
    const mine = await req('GET', `/api/crm/sequences/${seq.id}/queue`);
    check('E15 the owning tenant can read its queue', mine.status === 200 && mine.json?.total >= 1, JSON.stringify(mine.json?.total));
    check('E15 the queue names the enrolled CONTACT, not just a count (closes F3)',
      (mine.json?.enrollments || []).some(e => e.contact_name === contact.name), JSON.stringify((mine.json?.enrollments || []).map(e => e.contact_name)));
    check('E15 the queue carries each action\'s absolute scheduled_for + status',
      (mine.json?.enrollments || [])[0]?.actions?.every(a => a.scheduled_for && a.status), JSON.stringify((mine.json?.enrollments || [])[0]?.actions?.length));
    const theirs = await req('GET', `/api/crm/sequences/${seq.id}/queue`, undefined, CO2);
    check('E15 another tenant gets 404, not a leak', theirs.status === 404, JSON.stringify(theirs.json));
    check('E15 the 404 body carries no enrollment data', !theirs.json?.enrollments, JSON.stringify(theirs.json));

    // cross-tenant enroll is still refused at the model layer
    const foreign = await mkContact(CO2, 'E15 Foreign');
    const crossed = await seqDb.enroll(CO2, { sequenceId: seq.id, contactId: foreign.id });
    check('E15 enrolling into another tenant\'s sequence returns null', crossed === null, JSON.stringify(crossed));
    const cross2 = await seqDb.materializeNextStep(CO2, 'ffffffff-ffff-4fff-8fff-ffffffffffff', {});
    check('E15 materializeNextStep for an unknown/foreign enrollment returns null', cross2 === null);
    let threw = false;
    try { await seqDb.materializeNextStep(null, 'x', {}); } catch { threw = true; }
    check('E15 materializeNextStep without companyId throws (fail loud, never unscoped)', threw);
  }

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM CP2 (step scheduler) verification — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  // Print what DID run before dying — a bare stack trace hides which of the
  // E-criteria had already passed, which is exactly what a failure needs to say.
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed (aborted early)\n`);
  console.error('FATAL:', err);
  process.exit(2);
});
