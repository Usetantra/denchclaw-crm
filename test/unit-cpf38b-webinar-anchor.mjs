#!/usr/bin/env node
// DenchClaw CRM — F38b: a real webinar registration drives an ANCHORED
// reminder ladder. F38 built the scheduling primitive (enrollments.anchor_at
// + sequence_steps.anchor_offset_seconds); this proves the actual wiring the
// operator asked for — "when somebody registers for the webinar, send
// reminder emails" — by threading the webinar's scheduled_at through
// POST /marketing/events (event_type: registration) -> advanceContactStage ->
// enrollForTriggerStage -> enroll(), all the way to a real scheduled_actions
// row with the right scheduled_for.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpf38b-webinar-anchor.mjs
import db from '../server/db/index.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpf38b_co_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}
async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': CO },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function main() {
  await db.initDatabase();
  await db.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`, [CO, CO]);

  // A webinar starting in 2 hours — a real registrant right now, mid-ladder.
  const startsAt = new Date(Date.now() + 2 * 3600 * 1000);
  const wKey = 'wf38b_' + RUN;
  const webinar = await req('POST', '/api/crm/marketing/webinars', { key: wKey, name: 'F38b Test Webinar', scheduled_at: startsAt.toISOString() });
  check('setup: webinar created', webinar.status === 201, JSON.stringify(webinar));

  // The reminder ladder: "1 day before" (already past for a 2h-out webinar —
  // must SKIP, not send late) and "1 hour before" (also just past for someone
  // registering with 2h to go... use -30min instead so it's still ahead).
  const seq = await req('POST', '/api/crm/sequences', { name: `F38b ladder ${RUN}`, pipeline_key: 'webinar_marketing', trigger_stage: 'registrants' });
  check('setup: anchored sequence created', seq.status === 201, JSON.stringify(seq));
  const stepPast = await req('POST', `/api/crm/sequences/${seq.json.id}/steps`, {
    step_order: 1, channel: 'email', anchor_offset_seconds: -86400, subject: '1 day left', body: 'See you soon',
  });
  check('setup: "1 day before" step created', stepPast.status === 201, JSON.stringify(stepPast));
  const stepFuture = await req('POST', `/api/crm/sequences/${seq.json.id}/steps`, {
    step_order: 2, channel: 'email', anchor_offset_seconds: -1800, subject: '30 minutes left!', body: 'Join now: {webinar_link}',
  });
  check('setup: "30 min before" step created', stepFuture.status === 201, JSON.stringify(stepFuture));

  // CP1 decision 5: a contact may only ENTER a funnel-typed pipeline at its
  // first stage ('prospects' here, explicitly manual-entry-only — "a human
  // must place this contact" per the entry-rule's own refusal message). A
  // registration event alone cannot originate a brand-new contact straight
  // into 'registrants' — the realistic flow is prospects (placed by a human/
  // import) -> invitees (an invite_sent event) -> registrants (registration).
  const email = `f38b-${RUN}@ex.test`;
  const cRes = await req('POST', '/api/crm/contacts', { name: 'F38b Registrant', email, source: 'webinar' });
  check('setup: contact created', cRes.status === 201 || cRes.status === 200, JSON.stringify(cRes));
  await db.query(`UPDATE contacts SET marketing_stage='prospects', deal_stage='prospects' WHERE id=$1`, [cRes.json.id]);

  const invite = await req('POST', '/api/crm/marketing/events', { event_type: 'invite_sent', webinar_key: wKey, contact_id: cRes.json.id });
  check('setup: invite_sent moves prospects -> invitees', invite.status === 200 && invite.json.to_stage === 'invitees', JSON.stringify(invite));

  const reg = await req('POST', '/api/crm/marketing/events', {
    event_type: 'registration', webinar_key: wKey, contact_id: cRes.json.id,
  });
  check('registration event succeeds', reg.status === 200 && reg.json.ok !== false, JSON.stringify(reg));
  check('…the contact advanced to the registrants stage', reg.json.outcome === 'advanced' && reg.json.to_stage === 'registrants', JSON.stringify(reg.json));

  await new Promise(r => setTimeout(r, 300)); // enrollment side-effects are fire-and-forget from advanceContactStage's own caller

  const enrRes = await req('GET', `/api/crm/sequences/${seq.json.id}/enrollments`);
  const enr = enrRes.json.enrollments && enrRes.json.enrollments[0];
  check('the registrant is enrolled in the anchored ladder', !!enr, JSON.stringify(enrRes.json));

  const enrollmentRow = (await db.query('SELECT * FROM enrollments WHERE id=$1', [enr.id])).rows[0];
  check('THE ACTUAL FIX: enrollment.anchor_at was set from the webinar\'s scheduled_at, not left null',
    enrollmentRow.anchor_at && Math.abs(new Date(enrollmentRow.anchor_at).getTime() - startsAt.getTime()) < 2000,
    JSON.stringify({ got: enrollmentRow.anchor_at, expected: startsAt.toISOString() }));

  // NOT ordered by created_at: skipAnchoredStep's chained recursion into the
  // next materializeNextStep can run inside the same transaction, and
  // Postgres's now() is frozen for the whole transaction — so both rows can
  // land with an IDENTICAL created_at, and ORDER BY created_at has no stable
  // tiebreaker for a tie. Joined against sequence_steps.step_order instead,
  // which is the real, deterministic identity of "which rung is this".
  const jobs = (await db.query(
    `SELECT sa.*, st.step_order FROM scheduled_actions sa
       JOIN sequence_steps st ON st.id = sa.step_id
      WHERE sa.enrollment_id=$1 ORDER BY st.step_order`, [enr.id])).rows;
  const dayBefore = jobs.find(j => j.step_order === 1), minBefore = jobs.find(j => j.step_order === 2);
  check('the "1 day before" rung is SKIPPED (already past for a 2h-out webinar), not sent late',
    dayBefore?.status === 'skipped', JSON.stringify(jobs.map(j => ({ step_order: j.step_order, status: j.status, scheduled_for: j.scheduled_for }))));
  check('the "30 min before" rung is QUEUED (still ahead) at the right real timestamp',
    minBefore?.status === 'pending' &&
    Math.abs(new Date(minBefore.scheduled_for).getTime() - (startsAt.getTime() - 1800000)) < 2000,
    JSON.stringify(minBefore));

  await db.shutdownDatabase();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
