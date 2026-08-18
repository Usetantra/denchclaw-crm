#!/usr/bin/env node
// DenchClaw CRM — CP-SE: editable workflow steps (migration 042).
//
// A saved workflow was view-only, and the reason was a real hazard:
//   scheduled_actions.step_id ... ON DELETE CASCADE   (migration 014)
// so DELETing a step also deleted every job it ever produced — including
// status='sent' rows. That is not removing a step from a ladder, it is erasing
// the record of messages already delivered to real people.
//
// The whole point of these checks is that removal NEVER destroys history. SE-9
// is the one that matters most: a step with a sent job is archived, and the sent
// row is still there afterwards.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpse-step-editing.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpse_co_' + RUN;
const CO2 = 'cpse_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}
async function req(method, p, body, company = CO) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function makeSeq(name, steps) {
  const seq = await req('POST', '/api/crm/sequences', { name: `${name}-${RUN}`, trigger_tag: `t-${name}-${RUN}` });
  const made = [];
  for (let i = 0; i < steps.length; i++) {
    const r = await req('POST', `/api/crm/sequences/${seq.json.id}/steps`,
      { step_order: i + 1, channel: 'email', subject: steps[i], body: steps[i], delay_seconds: 0 });
    made.push(r.json);
  }
  return { id: seq.json.id, steps: made };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ══ 1. Editing content ════════════════════════════════════════════════════
  const a = await makeSeq('edit', ['one', 'two', 'three']);
  const patched = await req('PATCH', `/api/crm/sequences/${a.id}/steps/${a.steps[1].id}`,
    { subject: 'two revised', body: 'new body', delay_seconds: 3600 });
  check('SE-1 a step\'s content and delay can be edited',
    patched.status === 200 && patched.json.subject === 'two revised' && patched.json.delay_seconds === 3600,
    JSON.stringify(patched.json).slice(0, 160));

  const immutable = await req('PATCH', `/api/crm/sequences/${a.id}/steps/${a.steps[1].id}`, { channel: 'sms' });
  check('SE-2 channel is refused with a reason, not silently ignored',
    immutable.status === 400 && /cannot be changed/.test(immutable.json?.error || ''), JSON.stringify(immutable.json));

  const badDelay = await req('PATCH', `/api/crm/sequences/${a.id}/steps/${a.steps[1].id}`, { delay_seconds: -5 });
  check('SE-3 a negative delay is rejected', badDelay.status === 400, JSON.stringify(badDelay.json));

  // ══ 2. Reordering ═════════════════════════════════════════════════════════
  const rev = [a.steps[2].id, a.steps[1].id, a.steps[0].id];
  const reordered = await req('POST', `/api/crm/sequences/${a.id}/steps/reorder`, { step_ids: rev });
  check('SE-4 steps can be reordered',
    reordered.status === 200 && reordered.json.steps.map(s => s.id).join() === rev.join(),
    JSON.stringify((reordered.json?.steps || []).map(s => s.step_order)));
  check('SE-5 ...and the orders are a clean 1..n with no gaps or collisions',
    (reordered.json?.steps || []).map(s => s.step_order).join() === '1,2,3',
    JSON.stringify((reordered.json?.steps || []).map(s => s.step_order)));

  const partial = await req('POST', `/api/crm/sequences/${a.id}/steps/reorder`, { step_ids: [a.steps[0].id] });
  check('SE-6 a partial reorder is refused rather than silently reshuffling the rest',
    partial.status === 400, JSON.stringify(partial.json));

  // ══ 3. Deleting a step that never ran ═════════════════════════════════════
  const b = await makeSeq('hard', ['x', 'y']);
  const hard = await req('DELETE', `/api/crm/sequences/${b.id}/steps/${b.steps[1].id}`);
  check('SE-7 a step that never ran is deleted outright', hard.json?.mode === 'hard', JSON.stringify(hard.json));
  const gone = await db.query('SELECT count(*)::int AS n FROM sequence_steps WHERE id=$1', [b.steps[1].id]);
  check('SE-8 ...and is really gone, not left as a tombstone', gone.rows[0].n === 0, JSON.stringify(gone.rows[0]));

  // ══ 4. THE ONE THAT MATTERS — history survives removal ════════════════════
  const c = await makeSeq('hist', ['first', 'second']);
  const contact = await contactDb.create({ company_id: CO, name: 'Hist', email: `hist-${RUN}@ex.test` });
  const enr = await seqDb.enroll(CO, { sequenceId: c.id, contactId: contact.id });
  // enroll() already queued step 1 (there is a unique index on
  // (enrollment, step), which is itself the dedupe that stops a re-enrolled
  // contact being messaged twice). Settle that REAL row rather than inserting a
  // synthetic one — a sent job is exactly what a cascade delete would erase.
  const settled = await db.query(
    `UPDATE scheduled_actions SET status='sent', updated_at=now()
      WHERE enrollment_id=$1 AND step_id=$2 RETURNING id`,
    [enr.id, c.steps[0].id]);
  check('SE-8b enrolment queued the first step, and it is now marked sent',
    settled.rows.length === 1, JSON.stringify(settled.rows));

  const soft = await req('DELETE', `/api/crm/sequences/${c.id}/steps/${c.steps[0].id}`);
  check('SE-9 a step WITH history is archived, not deleted',
    soft.json?.mode === 'archived' && soft.json?.history_preserved === 1, JSON.stringify(soft.json));

  const kept = await db.query(
    `SELECT count(*)::int AS n FROM scheduled_actions WHERE step_id=$1 AND status='sent'`, [c.steps[0].id]);
  check('SE-10 ...and the SENT job still exists — history was not erased',
    kept.rows[0].n === 1, JSON.stringify(kept.rows[0]));

  const listed = await req('GET', `/api/crm/sequences/${c.id}`);
  const liveIds = (listed.json?.steps || []).map(s => s.id);
  check('SE-11 the archived step no longer appears in the workflow',
    !liveIds.includes(c.steps[0].id) && liveIds.includes(c.steps[1].id), JSON.stringify(liveIds.length));

  // Nobody is stranded on a removed step.
  const moved = await db.query('SELECT current_step_id, status FROM enrollments WHERE id=$1', [enr.id]);
  check('SE-12 an enrollment sitting on the removed step is moved to the next live one',
    moved.rows[0].current_step_id === c.steps[1].id, JSON.stringify(moved.rows[0]));

  // Removing the LAST live step completes the enrollment rather than stranding it.
  await req('DELETE', `/api/crm/sequences/${c.id}/steps/${c.steps[1].id}`);
  const done = await db.query('SELECT status, current_step_id FROM enrollments WHERE id=$1', [enr.id]);
  check('SE-13 removing the last step completes the enrollment instead of stranding it',
    done.rows[0].status === 'completed', JSON.stringify(done.rows[0]));

  // ══ 4b. Removal closes the gap it leaves ═════════════════════════════════
  // Without renumbering, removing step 1 of three leaves orders (2,3) — and any
  // caller computing "next order = count + 1" then produces 3, which already
  // exists. That is a duplicate-order conflict when adding a step to a workflow
  // that has ever been edited, which is exactly what the builder does.
  const g0 = await makeSeq('gap', ['a', 'b', 'c']);
  await req('DELETE', `/api/crm/sequences/${g0.id}/steps/${g0.steps[0].id}`);
  const after = await db.query(
    `SELECT step_order FROM sequence_steps WHERE sequence_id=$1 AND archived_at IS NULL ORDER BY step_order`,
    [g0.id]);
  check('SE-13b removing a step renumbers the rest to a contiguous 1..n',
    after.rows.map(r => r.step_order).join() === '1,2', JSON.stringify(after.rows.map(r => r.step_order)));

  const appended = await req('POST', `/api/crm/sequences/${g0.id}/steps`,
    { step_order: 3, channel: 'email', subject: 'appended', body: 'x', delay_seconds: 0 });
  check('SE-13c ...so appending at count+1 succeeds instead of colliding',
    appended.status === 201, JSON.stringify(appended.json).slice(0, 140));

  // ══ 5. Archived steps are inert in the ladder ═════════════════════════════
  const d = await makeSeq('inert', ['keep', 'drop']);
  await db.query(`UPDATE sequence_steps SET archived_at=now() WHERE id=$1`, [d.steps[1].id]);
  const steps = await seqDb.listSteps(d.id, CO);
  check('SE-14 listSteps excludes archived steps', steps.every(s => s.id !== d.steps[1].id), String(steps.length));
  const patchArchived = await req('PATCH', `/api/crm/sequences/${d.id}/steps/${d.steps[1].id}`, { subject: 'nope' });
  check('SE-15 an archived step cannot be edited back to life', patchArchived.status === 409, JSON.stringify(patchArchived.json));

  // A freed step_order is reusable — the partial unique index is what allows it.
  const reuse = await req('POST', `/api/crm/sequences/${d.id}/steps`,
    { step_order: 2, channel: 'email', subject: 'replacement', body: 'r', delay_seconds: 0 });
  check('SE-16 the archived step\'s order can be reused by a new step', reuse.status === 201, JSON.stringify(reuse.json).slice(0, 140));

  // The pre-existing 409 on a genuine duplicate must still work (the index
  // rename in 042 nearly broke this — the handler matches the constraint NAME).
  const dupe = await req('POST', `/api/crm/sequences/${d.id}/steps`,
    { step_order: 1, channel: 'email', subject: 'clash', body: 'c', delay_seconds: 0 });
  check('SE-17 a duplicate live step_order is still a clean 409, not a 500',
    dupe.status === 409, JSON.stringify(dupe.json));

  // ══ 6. Deleting a workflow ════════════════════════════════════════════════
  const e = await makeSeq('wfhard', ['only']);
  const wfHard = await req('DELETE', `/api/crm/sequences/${e.id}`);
  check('SE-18 a workflow nobody was enrolled in is deleted outright',
    wfHard.json?.mode === 'hard', JSON.stringify(wfHard.json));
  check('SE-19 ...and is gone', (await req('GET', `/api/crm/sequences/${e.id}`)).status === 404, 'still present');

  const f = await makeSeq('wfsoft', ['only']);
  const c2 = await contactDb.create({ company_id: CO, name: 'Enrolled', email: `enr-${RUN}@ex.test` });
  await seqDb.enroll(CO, { sequenceId: f.id, contactId: c2.id });
  const wfSoft = await req('DELETE', `/api/crm/sequences/${f.id}`);
  check('SE-20 a workflow that has run is archived, keeping its history',
    wfSoft.json?.mode === 'archived' && wfSoft.json?.enrollments === 1, JSON.stringify(wfSoft.json));
  const stillThere = await db.query('SELECT status FROM sequences WHERE id=$1', [f.id]);
  check('SE-21 ...and it is archived, so it enqueues nothing further',
    stillThere.rows[0]?.status === 'archived', JSON.stringify(stillThere.rows[0]));

  // ══ 7. Tenancy ════════════════════════════════════════════════════════════
  const g = await makeSeq('tenancy', ['a']);
  check('SE-22 another tenant cannot edit this workflow\'s step',
    (await req('PATCH', `/api/crm/sequences/${g.id}/steps/${g.steps[0].id}`, { subject: 'x' }, CO2)).status === 404, 'cross-tenant edit');
  check('SE-23 another tenant cannot delete this workflow\'s step',
    (await req('DELETE', `/api/crm/sequences/${g.id}/steps/${g.steps[0].id}`, undefined, CO2)).status === 404, 'cross-tenant delete');
  check('SE-24 another tenant cannot delete this workflow',
    (await req('DELETE', `/api/crm/sequences/${g.id}`, undefined, CO2)).status === 404, 'cross-tenant wf delete');
  const survived = await db.query('SELECT count(*)::int AS n FROM sequence_steps WHERE id=$1 AND archived_at IS NULL', [g.steps[0].id]);
  check('SE-25 ...and none of that touched the real tenant\'s data', survived.rows[0].n === 1, JSON.stringify(survived.rows[0]));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
