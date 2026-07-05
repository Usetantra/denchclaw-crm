#!/usr/bin/env node
// DenchClaw CRM — unit tests for the sequences model (GOAL B1: sequence data
// model). No HTTP route exists yet (B2/B3/B7 build on this), so this talks to
// Postgres directly the same way test/unit-tenancy.mjs / unit-tenants.mjs do.
//
// Usage: DATABASE_URL=postgres://... node test/unit-sequences.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';

const RUN = process.env.RUN || String(Date.now());
const CO_A = 'seq_co_a_' + RUN;
const CO_B = 'seq_co_b_' + RUN;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  await db.initDatabase();

  await tenantDb.create({ id: CO_A, name: CO_A, slug: CO_A });
  await tenantDb.create({ id: CO_B, name: CO_B, slug: CO_B });
  const contactA = await contactDb.create({ name: 'Seq Contact A', email: `seq-a-${RUN}@example.com`, company_id: CO_A });
  const contactB = await contactDb.create({ name: 'Seq Contact B', email: `seq-b-${RUN}@example.com`, company_id: CO_B });

  // ── sequences: mandatory companyId, scoped reads ──────────────────────────
  check('createSequence with no companyId throws',
    await throws(() => seqDb.createSequence({ name: 'x' })), 'expected a throw');
  check('createSequence under an unprovisioned tenant is rejected by the DB (FK)',
    await throws(() => seqDb.createSequence({ companyId: `unprovisioned_${RUN}`, name: 'x' })),
    'expected a foreign key violation');

  const sequence = await seqDb.createSequence({
    companyId: CO_A, name: 'Welcome Sequence', pipelineKey: 'marketing', triggerStage: 'sourced',
  });
  const sequenceB = await seqDb.createSequence({ companyId: CO_B, name: 'CO_B Sequence' });
  check('createSequence inserts a row', sequence?.name === 'Welcome Sequence', JSON.stringify(sequence));
  check('createSequence defaults to active status', sequence?.status === 'active', sequence?.status);

  check('getSequenceById cross-tenant returns null',
    (await seqDb.getSequenceById(sequence.id, CO_B)) === null, 'expected null');
  check('getSequenceById same-tenant returns the row',
    (await seqDb.getSequenceById(sequence.id, CO_A))?.id === sequence.id, 'expected sequence');
  check('listSequences cross-tenant does not see it',
    !(await seqDb.listSequences(CO_B)).some(s => s.id === sequence.id), 'expected not present');
  check('listSequences same-tenant sees it',
    (await seqDb.listSequences(CO_A)).some(s => s.id === sequence.id), 'expected present');

  const paused = await seqDb.updateSequenceStatus(sequence.id, CO_A, 'paused');
  check('updateSequenceStatus updates status', paused?.status === 'paused', JSON.stringify(paused));
  check('updateSequenceStatus cross-tenant is a no-op (null)',
    (await seqDb.updateSequenceStatus(sequence.id, CO_B, 'archived')) === null, 'expected null');

  // ── sequence_steps: own company_id column + ownership check, both enforced ─
  const step1 = await seqDb.addStep(sequence.id, CO_A, { stepOrder: 1, channel: 'email', delaySeconds: 0, templateRef: 'welcome_email' });
  const step2 = await seqDb.addStep(sequence.id, CO_A, { stepOrder: 2, channel: 'sms', delaySeconds: 86400, templateRef: 'welcome_sms' });
  check('addStep inserts a row', step1?.channel === 'email', JSON.stringify(step1));
  check('addStep stores its own company_id (defense in depth, not just the sequence join)',
    step1?.company_id === CO_A, step1?.company_id);
  check('addStep cross-tenant is rejected (null, no leak)',
    (await seqDb.addStep(sequence.id, CO_B, { stepOrder: 3, channel: 'email' })) === null, 'expected null');
  const steps = await seqDb.listSteps(sequence.id, CO_A);
  check('listSteps returns steps in order', steps.length === 2 && steps[0].id === step1.id && steps[1].id === step2.id,
    JSON.stringify(steps.map(s => s.step_order)));
  check('listSteps cross-tenant returns empty (no leak)',
    (await seqDb.listSteps(sequence.id, CO_B)).length === 0, 'expected empty array');

  // ── enrollments: cross-tenant injection is rejected, not just cross-tenant reads ─
  check('enroll cannot inject a valid companyId with ANOTHER tenant\'s sequence + contact',
    (await seqDb.enroll(CO_B, { sequenceId: sequence.id, contactId: contactA.id })) === null,
    'expected null — sequence and contact both belong to CO_A, not CO_B');
  check('enroll cannot inject another tenant\'s sequence even with the caller\'s OWN contact',
    (await seqDb.enroll(CO_B, { sequenceId: sequence.id, contactId: contactB.id })) === null,
    'expected null — sequence belongs to CO_A');
  check('enroll cannot inject another tenant\'s contact even into the caller\'s OWN sequence',
    (await seqDb.enroll(CO_A, { sequenceId: sequence.id, contactId: contactB.id })) === null,
    'expected null — contact belongs to CO_B');

  const enrollment = await seqDb.enroll(CO_A, { sequenceId: sequence.id, contactId: contactA.id });
  check('enroll inserts a row', enrollment?.contact_id === contactA.id, JSON.stringify(enrollment));
  check('enroll sets current_step_id to the first step', enrollment?.current_step_id === step1.id, enrollment?.current_step_id);
  const reEnroll = await seqDb.enroll(CO_A, { sequenceId: sequence.id, contactId: contactA.id });
  check('re-enrolling while active is idempotent (same row, not a duplicate)',
    reEnroll?.id === enrollment.id, `original=${enrollment.id} reEnroll=${reEnroll?.id}`);

  // Two concurrent enroll() calls for the same (sequence, contact) racing the
  // TOCTOU window between the "check existing active" SELECT and the INSERT —
  // the partial unique index must reject the loser, and enroll() must recover
  // (return the winning row) rather than surface a raw 23505 to the caller.
  const raceContact = await contactDb.create({ name: 'Race Contact', email: `seq-race-${RUN}@example.com`, company_id: CO_A });
  const [raceA, raceB] = await Promise.all([
    seqDb.enroll(CO_A, { sequenceId: sequence.id, contactId: raceContact.id }),
    seqDb.enroll(CO_A, { sequenceId: sequence.id, contactId: raceContact.id }),
  ]);
  check('concurrent enroll() calls both resolve without throwing and agree on one winner',
    raceA?.id && raceA.id === raceB?.id, `raceA=${raceA?.id} raceB=${raceB?.id}`);
  const raceRows = await seqDb.listEnrollments(CO_A, { sequenceId: sequence.id, contactId: raceContact.id });
  check('the race produced exactly one active enrollment row, not two',
    raceRows.filter(r => r.status === 'active').length === 1, `active rows=${raceRows.filter(r => r.status === 'active').length}`);

  check('getEnrollment cross-tenant returns null',
    (await seqDb.getEnrollment(enrollment.id, CO_B)) === null, 'expected null');
  check('listEnrollments cross-tenant does not see it',
    !(await seqDb.listEnrollments(CO_B)).some(e => e.id === enrollment.id), 'expected not present');

  const advanced = await seqDb.updateEnrollment(enrollment.id, CO_A, { currentStepId: step2.id });
  check('updateEnrollment advances current_step_id', advanced?.current_step_id === step2.id, JSON.stringify(advanced));

  // Cross-tenant step injection: a CO_B step id must not attach to a CO_A enrollment.
  const stepB = await seqDb.addStep(sequenceB.id, CO_B, { stepOrder: 1, channel: 'email' });
  check('updateEnrollment cannot point current_step_id at another tenant\'s step',
    (await seqDb.updateEnrollment(enrollment.id, CO_A, { currentStepId: stepB.id })) === null,
    'expected null — stepB belongs to CO_B\'s sequence');

  const completed = await seqDb.updateEnrollment(enrollment.id, CO_A, { status: 'completed' });
  check('updateEnrollment(status: completed) sets completed_at', !!completed?.completed_at, JSON.stringify(completed));
  check('updateEnrollment cross-tenant is a no-op (null)',
    (await seqDb.updateEnrollment(enrollment.id, CO_B, { status: 'exited' })) === null, 'expected null');

  // A completed enrollment isn't "active" anymore, so a fresh enroll() should
  // create a NEW row rather than idempotently returning the completed one.
  const secondRun = await seqDb.enroll(CO_A, { sequenceId: sequence.id, contactId: contactA.id });
  check('enroll after completion creates a new enrollment (not idempotent against a completed one)',
    secondRun?.id !== enrollment.id, `expected a different id, got ${secondRun?.id}`);

  // ── scheduled_actions: the B4 ChannelJob backing store ───────────────────
  const action = await seqDb.scheduleAction(CO_A, {
    enrollmentId: enrollment.id, stepId: step1.id,
    payload: { merge: { first_name: 'A' } },
    scheduledFor: new Date().toISOString(),
  });
  check('scheduleAction inserts a row defaulting to pending', action?.status === 'pending', JSON.stringify(action));
  check('scheduleAction derives contact_id from the enrollment (not caller-supplied)',
    action?.contact_id === contactA.id, action?.contact_id);
  check('scheduleAction derives channel/template_ref from the step itself (not caller-supplied)',
    action?.channel === step1.channel && action?.template_ref === step1.template_ref,
    `action.channel=${action?.channel} step1.channel=${step1.channel} action.template_ref=${action?.template_ref} step1.template_ref=${step1.template_ref}`);
  check('scheduleAction under an unprovisioned tenant returns null (ownership check catches it before any FK)',
    (await seqDb.scheduleAction(`unprovisioned_${RUN}`, {
      enrollmentId: enrollment.id, stepId: step1.id, scheduledFor: new Date().toISOString(),
    })) === null, 'expected null');
  check('scheduleAction cannot inject a valid companyId with another tenant\'s enrollment',
    (await seqDb.scheduleAction(CO_B, {
      enrollmentId: enrollment.id, stepId: step1.id, scheduledFor: new Date().toISOString(),
    })) === null, 'expected null — enrollment belongs to CO_A');
  check('scheduleAction cannot attach a step from a different sequence than the enrollment\'s',
    (await seqDb.scheduleAction(CO_A, {
      enrollmentId: enrollment.id, stepId: stepB.id, scheduledFor: new Date().toISOString(),
    })) === null, 'expected null — stepB belongs to a different sequence');

  const listedActions = await seqDb.listScheduledActions(CO_A, { enrollmentId: enrollment.id });
  check('listScheduledActions returns the scheduled action', listedActions.some(a => a.id === action.id), JSON.stringify(listedActions));
  check('listScheduledActions cross-tenant does not see it',
    !(await seqDb.listScheduledActions(CO_B)).some(a => a.id === action.id), 'expected not present');

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM unit-sequences test — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
