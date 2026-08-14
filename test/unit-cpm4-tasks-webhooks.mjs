#!/usr/bin/env node
// DenchClaw CRM — CP-M4: Tasks (human follow-up reminders, incl. stage-linked
// auto-creation for both contact- and deal-entity pipelines) and Inbound Lead
// Webhooks (external "add a prospect" integrations).
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpm4-tasks-webhooks.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import tasksDb from '../server/db/models/tasks.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpm4_co_' + RUN;
const CO2 = 'cpm4_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body, company = CO, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
// Public webhook calls carry NO internal key at all — that's the whole point.
async function pub(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ══ Tasks ══════════════════════════════════════════════════════════════
  const contact = await contactDb.create({ name: 'M4 Contact', email: `m4-${RUN}@ex.test`, company_id: CO });

  // ── M4-1 — manual task CRUD ────────────────────────────────────────────
  const noContact = await req('POST', '/api/crm/tasks', { title: 'x', due_at: new Date().toISOString() });
  check('M4-1 create without contact_id is refused with 400', noContact.status === 400, JSON.stringify(noContact.json));
  const created = await req('POST', '/api/crm/tasks', { contact_id: contact.id, title: 'Call about proposal', due_at: new Date(Date.now() + 86400000).toISOString() });
  check('M4-1 manual task creates (201)', created.status === 201 && created.json?.task?.status === 'pending', JSON.stringify(created.json));
  const tid = created.json.task.id;
  const list1 = await req('GET', `/api/crm/tasks?contact_id=${contact.id}`);
  check('M4-1 it appears in the list, joined with the contact\'s name', (list1.json?.tasks || []).some(t => t.id === tid && t.contact_name === 'M4 Contact'), JSON.stringify(list1.json));
  const done = await req('PATCH', `/api/crm/tasks/${tid}`, { status: 'done' });
  check('M4-1 marking done stamps completed_at', done.status === 200 && !!done.json?.task?.completed_at, JSON.stringify(done.json));
  const badStatus = await req('PATCH', `/api/crm/tasks/${tid}`, { status: 'archived' });
  check('M4-1 an invalid status is refused with 400', badStatus.status === 400, JSON.stringify(badStatus.json));
  const del1 = await req('DELETE', `/api/crm/tasks/${tid}`);
  check('M4-1 delete succeeds', del1.status === 200, JSON.stringify(del1.json));
  const del2 = await req('DELETE', `/api/crm/tasks/${tid}`);
  check('M4-1 deleting again is a 404, not a silent success', del2.status === 404, JSON.stringify(del2.json));

  // ── M4-2 — summary counts (overdue vs due-today vs total) ──────────────
  const overdueContact = await contactDb.create({ name: 'M4 Overdue', email: `m4od-${RUN}@ex.test`, company_id: CO });
  await req('POST', '/api/crm/tasks', { contact_id: overdueContact.id, title: 'Overdue thing', due_at: new Date(Date.now() - 86400000).toISOString() });
  const summary = await req('GET', '/api/crm/tasks/summary');
  check('M4-2 summary counts an overdue pending task', summary.status === 200 && summary.json?.overdue >= 1, JSON.stringify(summary.json));

  // ── M4-3 — tasks are tenant-scoped ──────────────────────────────────────
  const otherList = await req('GET', '/api/crm/tasks', undefined, CO2);
  check('M4-3 another tenant never sees this tenant\'s tasks', !(otherList.json?.tasks || []).some(t => t.contact_id === overdueContact.id), JSON.stringify(otherList.json));
  const crossPatch = await req('PATCH', `/api/crm/tasks/${created.json.task.id}`, { status: 'pending' }, CO2);
  check('M4-3 patching another tenant\'s task id is a 404', crossPatch.status === 404, JSON.stringify(crossPatch.json));

  // ══ Stage-linked auto-reminders ══════════════════════════════════════════
  // ── M4-4 — contact-entity pipeline (marketing): reminder_days on a stage
  //          auto-creates a task when a contact lands on it, and is idempotent.
  const pipeGet = await req('GET', '/api/crm/pipelines');
  const marketing = pipeGet.json.pipelines.find(p => p.key === 'marketing');
  const stagesWithReminder = marketing.stages.map(s => s.key === 'segmented' ? { ...s, reminder_days: 3 } : s);
  const pipePatch = await req('PATCH', '/api/crm/pipelines/marketing', { name: marketing.name, stages: stagesWithReminder });
  check('M4-4 reminder_days round-trips through the pipeline PATCH', pipePatch.json?.stages?.find(s => s.key === 'segmented')?.reminder_days === 3, JSON.stringify(pipePatch.json?.stages?.find(s => s.key === 'segmented')));

  const rc = await contactDb.create({ name: 'M4 Reminder', email: `m4rem-${RUN}@ex.test`, company_id: CO });
  await req('POST', `/api/crm/contacts/${rc.id}/advance`, { pipeline_key: 'marketing', stage: 'enriched' });
  await req('POST', `/api/crm/contacts/${rc.id}/advance`, { pipeline_key: 'marketing', stage: 'segmented' });
  const autoTasks = await req('GET', `/api/crm/tasks?contact_id=${rc.id}`);
  const autoTask = (autoTasks.json?.tasks || []).find(t => t.auto_generated && t.source_stage_key === 'segmented');
  check('M4-4 landing on a stage with reminder_days auto-creates a pending task', !!autoTask, JSON.stringify(autoTasks.json));
  check('M4-4 the auto task is due ~3 days out', autoTask && Math.abs(new Date(autoTask.due_at) - Date.now() - 3 * 86400000) < 60000, autoTask?.due_at);

  // Recycle back to segmented via nurture->segmented is out of scope; instead
  // prove idempotency the direct way: re-entering is blocked by the state
  // machine on a real pipeline, so we exercise the DAL guarantee directly.
  const dup = await tasksDb.createAutoIfAbsent(CO, { contactId: rc.id, title: 'dup', dueAt: new Date(), sourcePipelineKey: 'marketing', sourceStageKey: 'segmented' });
  check('M4-4 a second auto-reminder for the same (contact, stage) while one is pending is a no-op, not a duplicate', dup === null, JSON.stringify(dup));

  // Clean up the reminder_days config so it doesn't leak into other suites
  // sharing this scratch DB run (each suite uses its own company_id, so this
  // is defense-in-depth, not strictly required).
  await req('PATCH', '/api/crm/pipelines/marketing', { name: marketing.name, stages: marketing.stages });

  // ── M4-5 — deal-entity pipeline (webinar_sales): same mechanism, deal_id set
  const pipeGet2 = await req('GET', '/api/crm/pipelines');
  const webinarSales = pipeGet2.json.pipelines.find(p => p.key === 'webinar_sales');
  const wsStages = webinarSales.stages.map(s => s.key === 'scheduled_call' ? { ...s, reminder_days: 1 } : s);
  await req('PATCH', '/api/crm/pipelines/webinar_sales', { name: webinarSales.name, stages: wsStages });

  const dc = await contactDb.create({ name: 'M4 Deal Reminder', email: `m4deal-${RUN}@ex.test`, company_id: CO });
  const deal = await req('POST', '/api/crm/deals', { title: 'M4 Webinar Deal', contact_id: dc.id, pipeline_key: 'webinar_sales' });
  await req('POST', `/api/crm/contacts/${dc.id}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
  const dealTasks = await req('GET', `/api/crm/tasks?contact_id=${dc.id}`);
  const dealTask = (dealTasks.json?.tasks || []).find(t => t.auto_generated);
  check('M4-5 a deal-entity pipeline stage with reminder_days also auto-creates a task', !!dealTask, JSON.stringify(dealTasks.json));
  check('M4-5 …carrying the deal_id and deal_title', dealTask && dealTask.deal_id === deal.json.id && dealTask.deal_title === 'M4 Webinar Deal', JSON.stringify(dealTask));

  await req('PATCH', '/api/crm/pipelines/webinar_sales', { name: webinarSales.name, stages: webinarSales.stages });

  // ══ Inbound lead webhooks ════════════════════════════════════════════════
  // ── M4-6 — create, list, and the public endpoint needs NO internal key ────
  const hookCreate = await req('POST', '/api/crm/settings/lead-webhooks', { label: 'Website Form', default_source: 'website', default_tags: ['site-lead'] });
  check('M4-6 webhook creates with a token', hookCreate.status === 201 && !!hookCreate.json?.webhook?.token, JSON.stringify(hookCreate.json));
  const token = hookCreate.json.webhook.token;
  const hookId = hookCreate.json.webhook.id;

  const badLead = await pub('POST', `/webhooks/leads/${token}`, {});
  check('M4-6 a payload with no name/email/phone is refused with 400', badLead.status === 400, JSON.stringify(badLead.json));

  const leadRes = await pub('POST', `/webhooks/leads/${token}`, { full_name: 'Jordan Lee', email: `jordan-${RUN}@ex.test`, company: 'Lee Consulting', tags: ['hot-lead'] });
  check('M4-6 a valid lead creates a contact — no X-Internal-Key header sent at all', leadRes.status === 201 && !!leadRes.json?.contact_id, JSON.stringify(leadRes.json));

  const madeContact = await req('GET', `/api/crm/contacts/${leadRes.json.contact_id}`);
  check('M4-6 the contact carries the webhook\'s default_source', madeContact.json?.source === 'website', JSON.stringify(madeContact.json?.source));
  check('M4-6 tags MERGE the webhook\'s default_tags with the payload\'s own tags', ['site-lead', 'hot-lead'].every(t => (madeContact.json?.tags || []).includes(t)), JSON.stringify(madeContact.json?.tags));
  check('M4-6 metadata attributes the contact back to the webhook', madeContact.json?.metadata?.lead_webhook_id === hookId, JSON.stringify(madeContact.json?.metadata));

  const listAfter = await req('GET', '/api/crm/settings/lead-webhooks');
  const rowAfter = (listAfter.json?.webhooks || []).find(w => w.id === hookId);
  check('M4-6 request_count/last_used_at update after a real delivery', rowAfter?.request_count === 1 && !!rowAfter?.last_used_at, JSON.stringify(rowAfter));

  // ── M4-7 — unknown token, disabled webhook, token rotation ─────────────
  const unknownToken = await pub('POST', '/webhooks/leads/not-a-real-token', { email: 'x@y.test' });
  check('M4-7 an unrecognised token is a 404', unknownToken.status === 404, JSON.stringify(unknownToken.json));

  await req('PATCH', `/api/crm/settings/lead-webhooks/${hookId}`, { enabled: false });
  const disabledPost = await pub('POST', `/webhooks/leads/${token}`, { email: 'still@ex.test' });
  check('M4-7 a disabled webhook refuses with 403, distinct from unknown-token\'s 404', disabledPost.status === 403, JSON.stringify(disabledPost.json));

  await req('PATCH', `/api/crm/settings/lead-webhooks/${hookId}`, { enabled: true });
  const rotate = await req('POST', `/api/crm/settings/lead-webhooks/${hookId}/regenerate`, {});
  const newToken = rotate.json?.webhook?.token;
  check('M4-7 rotating issues a genuinely different token', !!newToken && newToken !== token, JSON.stringify(rotate.json));
  const oldTokenPost = await pub('POST', `/webhooks/leads/${token}`, { email: 'stale@ex.test' });
  check('M4-7 the OLD token stops working immediately after rotation', oldTokenPost.status === 404, JSON.stringify(oldTokenPost.json));
  const newTokenPost = await pub('POST', `/webhooks/leads/${newToken}`, { email: `newtok-${RUN}@ex.test` });
  check('M4-7 the NEW token works', newTokenPost.status === 201, JSON.stringify(newTokenPost.json));

  // ── M4-8 — lead webhooks are tenant-scoped ──────────────────────────────
  const otherHooks = await req('GET', '/api/crm/settings/lead-webhooks', undefined, CO2);
  check('M4-8 another tenant never sees this tenant\'s webhooks', !(otherHooks.json?.webhooks || []).some(w => w.id === hookId), JSON.stringify(otherHooks.json));
  const crossDeleteHook = await req('DELETE', `/api/crm/settings/lead-webhooks/${hookId}`, undefined, CO2);
  check('M4-8 deleting another tenant\'s webhook id is a 404', crossDeleteHook.status === 404, JSON.stringify(crossDeleteHook.json));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
