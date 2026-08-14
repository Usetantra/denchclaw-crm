#!/usr/bin/env node
// DenchClaw CRM — F38: anchored scheduling (migration 032).
//
// A step with anchor_offset_seconds fires at enrollments.anchor_at + offset,
// never relative to the previous step. A rung whose anchored time has already
// passed by the time it would be materialized is SKIPPED, never sent late —
// see .loop/DECISIONS_PENDING.md (F38) for why: a half-port that fires every
// already-past reminder at once would blast several messages at a real
// prospect in one minute.
//
// Talks to Postgres directly, same pattern as unit-sequences.mjs.
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';

const RUN = process.env.RUN || String(Date.now());
const CO = 'f38_co_' + RUN;

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
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  const jobsFor = async (enrollmentId) =>
    (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at', [enrollmentId])).rows;
  const enrollmentRow = async (id) => (await db.query('SELECT * FROM enrollments WHERE id=$1', [id])).rows[0];

  // ── F38-1 — an anchored step and a relative delay cannot coexist ──────────
  const seq1 = await seqDb.createSequence({ companyId: CO, name: `F38 xor ${RUN}` });
  check('F38-1 anchor_offset_seconds + non-zero delay_seconds is rejected by the DB constraint',
    await throws(() => seqDb.addStep(seq1.id, CO, { stepOrder: 1, channel: 'email', delaySeconds: 60, anchorOffsetSeconds: -3600 })),
    'expected a constraint violation');
  check('F38-1 anchor_offset_seconds + delay_seconds=0 (the default) is fine',
    !!(await seqDb.addStep(seq1.id, CO, { stepOrder: 2, channel: 'email', anchorOffsetSeconds: -3600 })),
    'expected the step to insert');

  // ── F38-2 — a future anchor: the step queues at anchor_at + offset ────────
  const seq2 = await seqDb.createSequence({ companyId: CO, name: `F38 future ${RUN}` });
  await seqDb.addStep(seq2.id, CO, { stepOrder: 1, channel: 'email', anchorOffsetSeconds: -3600, subject: 'Reminder', body: 'One hour before' });
  await seqDb.addStep(seq2.id, CO, { stepOrder: 2, channel: 'email', anchorOffsetSeconds: -900, subject: 'Reminder', body: 'Fifteen minutes before' });
  const c1 = await contactDb.create({ name: 'F38 Future', email: `f38-future-${RUN}@ex.test`, company_id: CO });
  const anchorAt = new Date(Date.now() + 2 * 3600 * 1000); // webinar 2h from now
  const e1 = await seqDb.enroll(CO, { sequenceId: seq2.id, contactId: c1.id, anchorAt: anchorAt.toISOString() });
  check('F38-2 the enrollment records anchor_at', new Date((await enrollmentRow(e1.id)).anchor_at).getTime() === anchorAt.getTime(), 'expected anchor_at to round-trip');
  const jobs1 = await jobsFor(e1.id);
  check('F38-2 rung 1 is queued (not skipped — its anchor time is in the future)', jobs1.length === 1 && jobs1[0].status === 'pending', JSON.stringify(jobs1));
  const expectedFire = new Date(anchorAt.getTime() - 3600 * 1000);
  check('F38-2 …scheduled_for is anchor_at + offset, not now + delay',
    Math.abs(new Date(jobs1[0].scheduled_for).getTime() - expectedFire.getTime()) < 2000,
    JSON.stringify({ got: jobs1[0].scheduled_for, expected: expectedFire.toISOString() }));

  // ── F38-3 — a PAST anchor: the rung is SKIPPED, never sent late ───────────
  const seq3 = await seqDb.createSequence({ companyId: CO, name: `F38 past ${RUN}` });
  await seqDb.addStep(seq3.id, CO, { stepOrder: 1, channel: 'email', anchorOffsetSeconds: -604800, subject: 'One week before', body: 'x' }); // 7 days before
  await seqDb.addStep(seq3.id, CO, { stepOrder: 2, channel: 'email', anchorOffsetSeconds: -3600, subject: 'One hour before', body: 'x' });   // 1 hour before
  const c2 = await contactDb.create({ name: 'F38 Late Registrant', email: `f38-late-${RUN}@ex.test`, company_id: CO });
  // Registers 30 minutes before the webinar — BOTH rungs (7 days and 1 hour
  // before) have already passed by the time enrollment materializes step 1.
  const nearAnchor = new Date(Date.now() + 30 * 60 * 1000);
  const e2 = await seqDb.enroll(CO, { sequenceId: seq3.id, contactId: c2.id, anchorAt: nearAnchor.toISOString() });
  const jobs2 = await jobsFor(e2.id);
  check('F38-3 BOTH past rungs are recorded skipped, not sent', jobs2.length === 2 && jobs2.every(j => j.status === 'skipped'), JSON.stringify(jobs2));
  check('F38-3 …no provider was ever called for them (no provider_message_id)',
    jobs2.every(j => !j.provider_message_id), JSON.stringify(jobs2.map(j => j.provider_message_id)));
  check('F38-3 …the enrollment completed (ladder exhausted, not stuck)',
    (await enrollmentRow(e2.id)).status === 'completed', JSON.stringify(await enrollmentRow(e2.id)));
  const activity = (await db.query(
    `SELECT * FROM contact_activity WHERE contact_id=$1 AND type='sequence_step_skipped_anchor' ORDER BY created_at`, [c2.id]
  )).rows;
  check('F38-3 …each skip left a timeline entry naming the reason', activity.length === 2 && activity.every(a => /anchor time already passed/.test(a.message)), JSON.stringify(activity));

  // ── F38-4 — no anchor_at set on the enrollment: an anchored step is skipped, not stuck ──
  const seq4 = await seqDb.createSequence({ companyId: CO, name: `F38 noanchor ${RUN}` });
  await seqDb.addStep(seq4.id, CO, { stepOrder: 1, channel: 'email', anchorOffsetSeconds: -3600, subject: 'x', body: 'x' });
  const c3 = await contactDb.create({ name: 'F38 No Anchor', email: `f38-noanchor-${RUN}@ex.test`, company_id: CO });
  const e3 = await seqDb.enroll(CO, { sequenceId: seq4.id, contactId: c3.id }); // anchorAt omitted
  const jobs3 = await jobsFor(e3.id);
  check('F38-4 the step is skipped rather than left unmaterialized forever',
    jobs3.length === 1 && jobs3[0].status === 'skipped', JSON.stringify(jobs3));
  check('F38-4 …the ladder still completes (no dead enrollment)',
    (await enrollmentRow(e3.id)).status === 'completed', JSON.stringify(await enrollmentRow(e3.id)));

  // ── F38-5 — mixed ladder: a relative step is unaffected by anchoring logic ─
  const seq5 = await seqDb.createSequence({ companyId: CO, name: `F38 mixed ${RUN}` });
  await seqDb.addStep(seq5.id, CO, { stepOrder: 1, channel: 'email', delaySeconds: 30, subject: 'x', body: 'x' }); // ordinary relative step
  const c4 = await contactDb.create({ name: 'F38 Mixed', email: `f38-mixed-${RUN}@ex.test`, company_id: CO });
  const e4 = await seqDb.enroll(CO, { sequenceId: seq5.id, contactId: c4.id });
  const jobs4 = await jobsFor(e4.id);
  check('F38-5 a plain relative-delay step (no anchor_offset_seconds) behaves exactly as before',
    jobs4.length === 1 && jobs4[0].status === 'pending', JSON.stringify(jobs4));

  await db.shutdownDatabase();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
