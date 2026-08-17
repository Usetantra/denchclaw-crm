#!/usr/bin/env node
// DenchClaw CRM — F-WF: GHL-style workflows (trigger -> ordered actions).
//
// A workflow is a sequence (migration 014) with two additions (migration 034):
// a tag as an alternative enrollment trigger alongside the existing
// pipeline-stage one, and an 'action' channel whose steps perform a DB effect
// (tag/stage/task/webhook) instead of sending a message. This suite proves
// the whole path: tag lands on a contact -> workflow enrolls -> action
// executor tick performs the effect -> ladder advances.
//
// NO REAL EXTERNAL ENDPOINT IS CONTACTED for webhook_out — a local stub
// server plays that role, same pattern as unit-cpc-channels.mjs's Twilio stub.
import http from 'node:http';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpwf_co_' + RUN;
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

const stub = { requests: [] };
const stubServer = http.createServer(async (sreq, sres) => {
  const chunks = []; for await (const c of sreq) chunks.push(c);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
  stub.requests.push(body);
  sres.writeHead(200, { 'content-type': 'application/json' });
  sres.end(JSON.stringify({ ok: true }));
});

async function main() {
  await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
  const port = stubServer.address().port;
  const stubUrl = `http://127.0.0.1:${port}/hook`;

  process.env.ACTION_EXECUTOR_ENABLED = '1';
  const { action } = await import('../server/lib/executors.js').then(m => m.default || m);
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  const jobsFor = async (enrollmentId) =>
    (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at', [enrollmentId])).rows;

  // ── WF-1 — a sequence can't trigger on both a stage and a tag ─────────────
  const dual = await req('POST', '/api/crm/sequences', { name: `dual ${RUN}`, pipeline_key: 'sales', trigger_stage: 'accepted', trigger_tag: 'vip' });
  check('WF-1 trigger_stage + trigger_tag together is refused (400)', dual.status === 400, JSON.stringify(dual));

  // ── WF-2 — action steps validate their config at authoring time ───────────
  const wf = await req('POST', '/api/crm/sequences', { name: `WF add-tag ${RUN}`, trigger_tag: 'lead_in' });
  check('WF-2 a tag-triggered sequence is created', wf.status === 201 && wf.json.trigger_tag === 'lead_in', JSON.stringify(wf.json));

  const badStep = await req('POST', `/api/crm/sequences/${wf.json.id}/steps`, { step_order: 1, channel: 'action', action_type: 'add_tag', action_config: {} });
  check('WF-2 add_tag with no config.tag is refused (400)', badStep.status === 400, JSON.stringify(badStep));

  const step1 = await req('POST', `/api/crm/sequences/${wf.json.id}/steps`, {
    step_order: 1, channel: 'action', action_type: 'add_tag', action_config: { tag: 'welcomed' },
  });
  check('WF-2 a valid add_tag step is created', step1.status === 201, JSON.stringify(step1));

  const step2 = await req('POST', `/api/crm/sequences/${wf.json.id}/steps`, {
    step_order: 2, channel: 'action', action_type: 'create_task', action_config: { title: 'Follow up with new lead', due_in_days: 2 },
  });
  check('WF-2 a valid create_task step is created', step2.status === 201, JSON.stringify(step2));

  const step3 = await req('POST', `/api/crm/sequences/${wf.json.id}/steps`, {
    step_order: 3, channel: 'action', action_type: 'webhook_out', action_config: { url: stubUrl, payload: { source: 'denchclaw' } },
  });
  check('WF-2 a valid webhook_out step is created', step3.status === 201, JSON.stringify(step3));

  const wrongChannel = await req('POST', `/api/crm/sequences/${wf.json.id}/steps`, { step_order: 4, channel: 'email', action_type: 'add_tag' });
  check('WF-2 action_type on a non-action channel is refused (400)', wrongChannel.status === 400, JSON.stringify(wrongChannel));

  // ── WF-3 — tagging a contact enrolls it, materializing step 1 ─────────────
  const c1 = await contactDb.create({ name: 'WF Contact', email: `wf-${RUN}@ex.test`, company_id: CO });
  const patch1 = await req('PATCH', `/api/crm/contacts/${c1.id}`, { tags: ['lead_in'] });
  check('WF-3 tagging the contact succeeds', patch1.status === 200, JSON.stringify(patch1));
  await new Promise(r => setTimeout(r, 200)); // enrollment fires fire-and-forget
  const enrollments = await req('GET', `/api/crm/sequences/${wf.json.id}/enrollments`);
  const enr = enrollments.json.enrollments.find(e => e.contact_id === c1.id);
  check('WF-3 the contact is enrolled in the tag-triggered workflow', !!enr, JSON.stringify(enrollments.json));

  const jobs1 = enr ? await jobsFor(enr.id) : [];
  check('WF-3 step 1 (add_tag) is queued as an action job', jobs1.length === 1 && jobs1[0].channel === 'action', JSON.stringify(jobs1));

  // Re-saving the SAME tag must not re-enroll (idempotent on "added", not "present").
  await req('PATCH', `/api/crm/contacts/${c1.id}`, { tags: ['lead_in'] });
  await new Promise(r => setTimeout(r, 150));
  const enrollments2 = await req('GET', `/api/crm/sequences/${wf.json.id}/enrollments`);
  check('WF-3 re-saving the same tag does not create a second enrollment',
    enrollments2.json.enrollments.filter(e => e.contact_id === c1.id).length === 1, JSON.stringify(enrollments2.json));

  // ── WF-4 — the action executor actually performs the effects ──────────────
  const r1 = await action.tick(CO);
  check('WF-4 tick 1 sends (performs) the add_tag action', r1.sent === 1, JSON.stringify(r1));
  const afterTag = await req('GET', `/api/crm/contacts/${c1.id}`);
  check('WF-4 …the contact actually has the new tag', (afterTag.json.tags || []).includes('welcomed'), JSON.stringify(afterTag.json.tags));

  const r2 = await action.tick(CO);
  check('WF-4 tick 2 performs the create_task action', r2.sent === 1, JSON.stringify(r2));
  const tasks = await req('GET', `/api/crm/tasks?contact_id=${c1.id}`);
  check('WF-4 …a real task was created', (tasks.json.tasks || []).some(t => t.title === 'Follow up with new lead'), JSON.stringify(tasks.json));

  const r3 = await action.tick(CO);
  check('WF-4 tick 3 performs the webhook_out action', r3.sent === 1, JSON.stringify(r3));
  check('WF-4 …the stub actually received a POST with contact context',
    stub.requests.length === 1 && stub.requests[0].contact?.id === c1.id && stub.requests[0].source === 'denchclaw',
    JSON.stringify(stub.requests));

  const r4 = await action.tick(CO);
  check('WF-4 the ladder is exhausted — nothing left to send', r4.sent === 0, JSON.stringify(r4));
  const enrAfter = await req('GET', `/api/crm/sequences/${wf.json.id}/enrollments`);
  check('WF-4 …the enrollment completed', enrAfter.json.enrollments.find(e => e.contact_id === c1.id)?.status === 'completed', JSON.stringify(enrAfter.json));

  // ── WF-5 — bulk tag action triggers the same workflow, once per contact ───
  const c2 = await contactDb.create({ name: 'WF Bulk 1', email: `wf-bulk1-${RUN}@ex.test`, company_id: CO });
  const c3 = await contactDb.create({ name: 'WF Bulk 2', email: `wf-bulk2-${RUN}@ex.test`, company_id: CO, tags: ['lead_in'] }); // already tagged
  await req('POST', '/api/crm/contacts/bulk', { action: 'tag', ids: [c2.id, c3.id], value: 'lead_in' });
  await new Promise(r => setTimeout(r, 200));
  const enrollments3 = await req('GET', `/api/crm/sequences/${wf.json.id}/enrollments`);
  check('WF-5 bulk-tag enrolls the contact that was newly tagged',
    enrollments3.json.enrollments.some(e => e.contact_id === c2.id), JSON.stringify(enrollments3.json));
  check('WF-5 …but NOT the one that already had the tag',
    !enrollments3.json.enrollments.some(e => e.contact_id === c3.id), JSON.stringify(enrollments3.json));

  // ── WF-6 — change_stage action, including a refused illegal transition ────
  const wfStage = await req('POST', '/api/crm/sequences', { name: `WF change-stage ${RUN}`, trigger_tag: 'promote_me' });
  await req('POST', `/api/crm/sequences/${wfStage.json.id}/steps`, {
    step_order: 1, channel: 'action', action_type: 'change_stage', action_config: { pipeline_key: 'marketing', stage: 'nonexistent_stage_xyz' },
  });
  const c4 = await contactDb.create({ name: 'WF Stage', email: `wf-stage-${RUN}@ex.test`, company_id: CO });
  await req('PATCH', `/api/crm/contacts/${c4.id}`, { tags: ['promote_me'] });
  await new Promise(r => setTimeout(r, 200));
  const r5 = await action.tick(CO);
  check('WF-6 an illegal/unknown stage transition fails definitively, not silently',
    r5.failed >= 1 || r5.quarantined >= 1, JSON.stringify(r5));

  await db.shutdownDatabase();
  await new Promise(r => stubServer.close(r));
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
