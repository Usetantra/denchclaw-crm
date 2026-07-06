#!/usr/bin/env node
// DenchClaw CRM — B2 (stage-triggered enrollment) verification. Mixes HTTP
// (drives the real /advance and PATCH stage-change routes, matching what
// automation_core actually calls) with direct DB access (to set up a
// sequence and verify the resulting enrollment — sequences/enrollments have
// no HTTP route of their own yet, per B1's data-model-only scope).
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-b2-enrollment.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import seqDb from '../server/db/models/sequences.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'b2_co_' + RUN;

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

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  // A sequence that auto-enrolls on marketing's 'segmented' stage.
  const seq = await seqDb.createSequence({ companyId: CO, name: 'Segmented Welcome', pipelineKey: 'marketing', triggerStage: 'segmented' });
  await seqDb.addStep(seq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'welcome' });
  // A DIFFERENT sequence on a stage this test never reaches — proves the
  // trigger match is stage-specific, not "any active sequence enrolls".
  const decoySeq = await seqDb.createSequence({ companyId: CO, name: 'Never Triggers', pipelineKey: 'marketing', triggerStage: 'mql' });

  const created = await req('POST', '/api/crm/contacts', { name: 'B2 Test', email: `b2-${RUN}@example.com`, source: 'manual' });
  const contactId = created.json?.id;
  check('setup: contact created', created.status === 201 && !!contactId, JSON.stringify(created));

  // sourced -> enriched -> segmented (the trigger stage).
  await req('POST', `/api/crm/contacts/${contactId}/advance`, { pipeline_key: 'marketing', stage: 'enriched' });
  const advance = await req('POST', `/api/crm/contacts/${contactId}/advance`, { pipeline_key: 'marketing', stage: 'segmented' });
  check('advancing into the trigger stage returns 200 changed:true', advance.status === 200 && advance.json?.changed === true, JSON.stringify(advance.json));
  check('advance response reports the sequence_enrollment', advance.json?.sequence_enrollments?.some(e => e.sequence_id === seq.id), JSON.stringify(advance.json?.sequence_enrollments));

  const enrollments = await seqDb.listEnrollments(CO, { contactId });
  check('an enrollment row actually exists for the triggered sequence',
    enrollments.some(e => e.sequence_id === seq.id && e.status === 'active'), JSON.stringify(enrollments));
  check('the contact was NOT enrolled in the decoy sequence (stage-specific match)',
    !enrollments.some(e => e.sequence_id === decoySeq.id), JSON.stringify(enrollments));

  // Idempotent same-stage advance (changed:false) must not create a second enrollment.
  const idempotent = await req('POST', `/api/crm/contacts/${contactId}/advance`, { pipeline_key: 'marketing', stage: 'segmented' });
  check('idempotent same-stage advance reports changed:false', idempotent.json?.changed === false, JSON.stringify(idempotent.json));
  const enrollmentsAfter = await seqDb.listEnrollments(CO, { contactId, sequenceId: seq.id });
  check('idempotent advance does not create a duplicate enrollment', enrollmentsAfter.length === 1, `count=${enrollmentsAfter.length}`);

  // Sales-side: PATCH /deals/:id {stage} also triggers (roadmap explicitly
  // names both /advance and PATCH stage as hook points).
  const salesSeq = await seqDb.createSequence({ companyId: CO, name: 'Contacted Follow-up', pipelineKey: 'sales', triggerStage: 'contacted' });
  await seqDb.addStep(salesSeq.id, CO, { stepOrder: 1, channel: 'sms', templateRef: 'follow_up' });
  const dealContact = await req('POST', '/api/crm/contacts', { name: 'B2 Deal Contact', email: `b2-deal-${RUN}@example.com`, source: 'manual' });
  const deal = await req('POST', '/api/crm/deals', { title: 'B2 Deal', contact_id: dealContact.json?.id, stage: 'accepted' });
  const dealPatch = await req('PATCH', `/api/crm/deals/${deal.json?.id}`, { stage: 'contacted' });
  check('PATCH /deals/:id {stage} transition succeeds', dealPatch.status === 200 && dealPatch.json?.stage === 'contacted', JSON.stringify(dealPatch.json));
  const dealEnrollments = await seqDb.listEnrollments(CO, { contactId: dealContact.json?.id, sequenceId: salesSeq.id });
  check('PATCH /deals/:id {stage} also triggers sequence enrollment', dealEnrollments.some(e => e.status === 'active'), JSON.stringify(dealEnrollments));

  // Sales 'nurture' off-ramp recycles the contact to marketing — that recycle
  // IS a real marketing transition and must trigger marketing/'nurture' sequences.
  const nurtureSeq = await seqDb.createSequence({ companyId: CO, name: 'Nurture Recycled', pipelineKey: 'marketing', triggerStage: 'nurture' });
  await seqDb.addStep(nurtureSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'nurture' });
  const nurtureContact = await req('POST', '/api/crm/contacts', { name: 'B2 Nurture', email: `b2-nurture-${RUN}@example.com`, source: 'manual' });
  const nurtureDeal = await req('POST', '/api/crm/deals', { title: 'B2 Nurture Deal', contact_id: nurtureContact.json?.id, stage: 'accepted' });
  // marketing_stage must be somewhere 'nurture' is reachable from (recycle
  // checks the MARKETING pipeline's own transitions, not just the sales side).
  await req('POST', `/api/crm/contacts/${nurtureContact.json?.id}/advance`, { pipeline_key: 'marketing', stage: 'enriched' });
  await req('POST', `/api/crm/contacts/${nurtureContact.json?.id}/advance`, { pipeline_key: 'marketing', stage: 'segmented' });
  await req('POST', `/api/crm/contacts/${nurtureContact.json?.id}/advance`, { pipeline_key: 'sales', stage: 'contacted' });
  const nurtureAdvance = await req('POST', `/api/crm/contacts/${nurtureContact.json?.id}/advance`, { pipeline_key: 'sales', stage: 'nurture' });
  check('sales nurture off-ramp reports marketing_recycled', nurtureAdvance.json?.marketing_recycled === true, JSON.stringify(nurtureAdvance.json));
  const nurtureEnrollments = await seqDb.listEnrollments(CO, { contactId: nurtureContact.json?.id, sequenceId: nurtureSeq.id });
  check('sales nurture off-ramp ALSO triggers the marketing/nurture sequence (previously missed)',
    nurtureEnrollments.some(e => e.status === 'active'), JSON.stringify(nurtureEnrollments));

  // Same off-ramp, but reached via PATCH /deals/:id specifically (a second
  // call site with its own recycle call, previously firing BEFORE the deals
  // row persisted — fixed to defer until after that UPDATE succeeds).
  const nurtureContact2 = await req('POST', '/api/crm/contacts', { name: 'B2 Nurture 2', email: `b2-nurture2-${RUN}@example.com`, source: 'manual' });
  await req('POST', `/api/crm/contacts/${nurtureContact2.json?.id}/advance`, { pipeline_key: 'marketing', stage: 'enriched' });
  await req('POST', `/api/crm/contacts/${nurtureContact2.json?.id}/advance`, { pipeline_key: 'marketing', stage: 'segmented' });
  const nurtureDeal2 = await req('POST', '/api/crm/deals', { title: 'B2 Nurture Deal 2', contact_id: nurtureContact2.json?.id, stage: 'accepted' });
  await req('PATCH', `/api/crm/deals/${nurtureDeal2.json?.id}`, { stage: 'contacted' });
  const nurturePatch2 = await req('PATCH', `/api/crm/deals/${nurtureDeal2.json?.id}`, { stage: 'nurture' });
  check('PATCH /deals/:id {stage:nurture} transition succeeds', nurturePatch2.status === 200 && nurturePatch2.json?.stage === 'nurture', JSON.stringify(nurturePatch2.json));
  const nurtureEnrollments2 = await seqDb.listEnrollments(CO, { contactId: nurtureContact2.json?.id, sequenceId: nurtureSeq.id });
  check('PATCH /deals/:id nurture off-ramp ALSO triggers the marketing/nurture sequence (this round\'s ordering fix)',
    nurtureEnrollments2.some(e => e.status === 'active'), JSON.stringify(nurtureEnrollments2));

  // Inbound-reply auto-advance (conversations.js) is a fourth stage-authority
  // path outside crm.js entirely — must trigger sequences too.
  const respondedSeq = await seqDb.createSequence({ companyId: CO, name: 'Responded Follow-up', pipelineKey: 'marketing', triggerStage: 'responded' });
  await seqDb.addStep(respondedSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'responded' });
  const replyContact = await req('POST', '/api/crm/contacts', { name: 'B2 Reply', email: `b2-reply-${RUN}@example.com`, source: 'manual' });
  const replyContactId = replyContact.json?.id;
  for (const stage of ['enriched', 'segmented', 'queued', 'engaged']) {
    await req('POST', `/api/crm/contacts/${replyContactId}/advance`, { pipeline_key: 'marketing', stage });
  }
  const conv = await req('POST', '/api/crm/conversations', { contact_id: replyContactId, channel: 'email' });
  await req('POST', `/api/crm/conversations/${conv.json?.id}/messages`, { direction: 'inbound', channel: 'email', body: 'hi' });
  const replyEnrollments = await seqDb.listEnrollments(CO, { contactId: replyContactId, sequenceId: respondedSeq.id });
  check('inbound-reply auto-advance (conversations.js) triggers sequence enrollment (previously missed hook point)',
    replyEnrollments.some(e => e.status === 'active'), JSON.stringify(replyEnrollments));

  // Stage-name collision: contacts.deal_stage is a hybrid/mirrored field, and
  // 'nurture' is a legitimate stage name in BOTH the sales and marketing
  // JSONB configs (migration 006) — no membership check on the stage NAME can
  // reliably tell whether a deal_stage value reflects a real sales
  // transition or a marketing mirror. The legacy PATCH /contacts/:id
  // {deal_stage} path therefore never triggers sequence enrollment at all,
  // regardless of which stage name is written — only /advance and
  // PATCH /deals/:id (which both operate on an unambiguous real deals row)
  // do. This directly covers the exact ambiguous case (a critic-reproduced
  // false trigger): PATCHing deal_stage:'nurture' with no real deal involved.
  const collisionSeq = await seqDb.createSequence({ companyId: CO, name: 'Sales Nurture (decoy)', pipelineKey: 'sales', triggerStage: 'nurture' });
  await seqDb.addStep(collisionSeq.id, CO, { stepOrder: 1, channel: 'email' });
  const collisionPatch = await req('PATCH', `/api/crm/contacts/${contactId}`, { deal_stage: 'nurture' });
  check('legacy PATCH {deal_stage:\'nurture\'} succeeds (unenforced transition, as documented)',
    collisionPatch.status === 200, JSON.stringify(collisionPatch.json));
  const collisionEnrollments = await seqDb.listEnrollments(CO, { contactId, sequenceId: collisionSeq.id });
  check('...but never triggers ANY sequence enrollment from this ambiguous legacy path (fixes the reproduced false-trigger)',
    collisionEnrollments.length === 0, JSON.stringify(collisionEnrollments));

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM B2 (stage-triggered enrollment) verification — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
