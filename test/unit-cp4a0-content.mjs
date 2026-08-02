#!/usr/bin/env node
// DenchClaw CRM — CP4a-0 (message content store) verification.
//
// The checkpoint exists because there was NOTHING TO SEND: payload was
// '{}'::jsonb, sequence_steps carried only a template_ref pointing at nothing,
// and sendEmail defaults subject to '(no subject)' and text to ''. An executor
// built on that would have mailed real prospects blank email while a suite
// asserting only `pending → sent` went green.
//
// So these checks assert CONTENT, not status. The central contract:
//   a queued job either carries resolved content, or it is explicitly flagged
//   as carrying none — never an empty string masquerading as a message.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cp4a0-content.mjs

import { readFileSync } from 'node:fs';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import templatesDb from '../server/db/models/templates.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'c40_co_' + RUN;
const CO2 = 'c40_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
};

async function req(method, path, body, company = CO) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

const mkContact = (name, company = CO, extra = {}) =>
  contactDb.create({ name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${RUN}@ex.test`, company_id: company, ...extra });
const jobsFor = async (enrollmentId) =>
  (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at ASC', [enrollmentId])).rows;
const jobRowOf = async (id) => (await db.query('SELECT * FROM scheduled_actions WHERE id=$1',[id])).rows[0];
const payloadOf = (job) => (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) || {};

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ── C1 — migration 021 ────────────────────────────────────────────────────
  const mig = readFileSync(new URL('../migrations/021_message_content.sql', import.meta.url), 'utf8');
  await db.query(mig); await db.query(mig);
  check('C1 migration 021 re-applies twice with no error', true);
  const cols = await db.query(`SELECT column_name, is_nullable FROM information_schema.columns
                                WHERE table_name='message_templates' ORDER BY column_name`);
  check('C1 message_templates exists with a NOT NULL body',
    cols.rows.find(c => c.column_name === 'body')?.is_nullable === 'NO', JSON.stringify(cols.rows.map(c => c.column_name)));
  const stepCols = await db.query(`SELECT column_name FROM information_schema.columns
                                    WHERE table_name='sequence_steps' AND column_name IN ('subject','body')`);
  check('C1 sequence_steps gained inline subject + body', stepCols.rows.length === 2, JSON.stringify(stepCols.rows));
  // A blank body must be impossible to store — that is the hazard this migration exists to close.
  let blankRejected = false;
  try {
    await db.query(`INSERT INTO message_templates (company_id, ref, body) VALUES ($1,'blank','   ')`, [CO]);
  } catch { blankRejected = true; }
  check('C1 the DB itself refuses a blank template body', blankRejected);
  // Pre-existing rows survive: a step created before a re-apply keeps NULL content.
  const legacySeq = await seqDb.createSequence({ companyId: CO, name: `C1 legacy ${RUN}`, pipelineKey: 'webinar_sales' });
  const legacyStep = await seqDb.addStep(legacySeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'legacy_ref' });
  await db.query(mig);
  const reStep = await db.query('SELECT subject, body FROM sequence_steps WHERE id=$1', [legacyStep.id]);
  check('C1 a pre-existing step is untouched by a re-apply (NULL content)',
    reStep.rows[0].subject === null && reStep.rows[0].body === null, JSON.stringify(reStep.rows[0]));

  // ── C2 — templates are tenant-scoped ──────────────────────────────────────
  const made = await req('POST', '/api/crm/templates', {
    ref: 'noshow_fu1', channel: 'email',
    subject: 'Sorry we missed you, {first_name}',
    body: 'Hi {first_name} at {company} — we missed you. Shall we rebook?',
  });
  check('C2 a template can be authored', made.status === 201, JSON.stringify(made.json));
  const mine = await req('GET', '/api/crm/templates/noshow_fu1');
  check('C2 the owning tenant can read it', mine.status === 200 && mine.json?.ref === 'noshow_fu1');
  const theirs = await req('GET', '/api/crm/templates/noshow_fu1', undefined, CO2);
  check('C2 another tenant gets 404, not the content', theirs.status === 404, String(theirs.status));
  const blank = await req('POST', '/api/crm/templates', { ref: 'blanky', body: '   ' });
  check('C2 a blank body is refused at the API door (400)', blank.status === 400, JSON.stringify(blank.json));
  const noBody = await req('POST', '/api/crm/templates', { ref: 'nobody' });
  check('C2 a missing body is refused (400)', noBody.status === 400, String(noBody.status));
  // Same ref twice edits rather than creating a second row the resolver would
  // have to choose between.
  await req('POST', '/api/crm/templates', { ref: 'noshow_fu1', channel: 'email', subject: 'v2', body: 'v2 body {first_name}' });
  const dupes = await db.query('SELECT count(*)::int n FROM message_templates WHERE company_id=$1 AND ref=$2', [CO, 'noshow_fu1']);
  check('C2 authoring the same ref twice upserts (exactly one row)', dupes.rows[0].n === 1, String(dupes.rows[0].n));
  await req('POST', '/api/crm/templates', { ref: 'noshow_fu1', channel: 'email',
    subject: 'Sorry we missed you, {first_name}', body: 'Hi {first_name} at {company} — we missed you.' });

  // ── C3 — precedence: inline step content beats the template ───────────────
  const contact = await mkContact('C3 Dana', CO, { company_name: 'Acme Corp' });
  const seq = await seqDb.createSequence({ companyId: CO, name: `C3 seq ${RUN}`, pipelineKey: 'webinar_sales' });
  const stepTpl = await seqDb.addStep(seq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'noshow_fu1' });
  const stepInline = await seqDb.addStep(seq.id, CO, {
    stepOrder: 2, channel: 'email', templateRef: 'noshow_fu1',
    subject: 'Inline subject for {first_name}', body: 'Inline body for {first_name}', delaySeconds: 60,
  });
  const rTpl = await templatesDb.resolveStepContent(CO, stepTpl, contact);
  const rInline = await templatesDb.resolveStepContent(CO, stepInline, contact);
  check('C3 a step with only a template_ref resolves from the template',
    rTpl.source === 'template' && /we missed you/.test(rTpl.body), JSON.stringify(rTpl));
  check('C3 inline content WINS over the template ref',
    rInline.source === 'step' && /Inline body/.test(rInline.body), JSON.stringify(rInline));
  check('C3 the subject follows its body\'s source (no mixing)',
    /Inline subject/.test(rInline.subject), rInline.subject);

  // ── C4 — tokens resolve against THIS contact ──────────────────────────────
  check('C4 {first_name} resolves', rTpl.body.startsWith('Hi C3'), rTpl.body);
  check('C4 {company} resolves', /Acme Corp/.test(rTpl.body), rTpl.body);
  check('C4 the subject resolves too', /C3/.test(rTpl.subject), rTpl.subject);
  const other = await mkContact('C4 Eli', CO, { company_name: 'Globex' });
  const rOther = await templatesDb.resolveStepContent(CO, stepTpl, other);
  check('C4 the SAME step resolves differently for a different contact',
    /Globex/.test(rOther.body) && !/Acme/.test(rOther.body), rOther.body);

  // ── C5 — THE CENTRAL CONTRACT: enroll freezes resolved content into payload ─
  const enr = await seqDb.enroll(CO, { sequenceId: seq.id, contactId: contact.id });
  const jobs = await jobsFor(enr.id);
  check('C5 enrolling queued step 1', jobs.length === 1, String(jobs.length));
  const p1 = payloadOf(jobs[0]);
  check('C5 the payload is NO LONGER empty', Object.keys(p1).length > 0, JSON.stringify(p1));
  check('C5 it declares content_resolved = true', p1.content_resolved === true, JSON.stringify(p1));
  check('C5 it carries a non-blank body', typeof p1.body === 'string' && p1.body.trim().length > 0, JSON.stringify(p1.body));
  check('C5 it carries a subject for an email step', typeof p1.subject === 'string' && p1.subject.length > 0, JSON.stringify(p1.subject));
  check('C5 the body is RESOLVED, not raw tokens', !/\{first_name\}/.test(p1.body) && /C3/.test(p1.body), p1.body);
  check('C5 the payload records where the content came from', p1.content_source === 'template', p1.content_source);

  // ── C6 — unresolvable content: flagged, never blank, never blocking ───────
  const orphanSeq = await seqDb.createSequence({ companyId: CO, name: `C6 orphan ${RUN}`, pipelineKey: 'webinar_sales' });
  await seqDb.addStep(orphanSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'does_not_exist' });
  const orphanContact = await mkContact('C6 Orphan');
  const orphanEnr = await seqDb.enroll(CO, { sequenceId: orphanSeq.id, contactId: orphanContact.id });
  check('C6 an unresolvable step does NOT block enrolment', !!orphanEnr, JSON.stringify(orphanEnr));
  const oJobs = await jobsFor(orphanEnr.id);
  const op = payloadOf(oJobs[0]);
  check('C6 the job is still queued', oJobs.length === 1, String(oJobs.length));
  check('C6 but it is flagged content_resolved = false', op.content_resolved === false, JSON.stringify(op));
  check('C6 it carries NO body at all (null, never "")', op.body === null, JSON.stringify(op.body));
  check('C6 and it says exactly why, naming the missing ref',
    /does_not_exist/.test(op.content_error || ''), op.content_error);
  const noRefSeq = await seqDb.createSequence({ companyId: CO, name: `C6 noref ${RUN}`, pipelineKey: 'webinar_sales' });
  await seqDb.addStep(noRefSeq.id, CO, { stepOrder: 1, channel: 'email' });
  const noRefEnr = await seqDb.enroll(CO, { sequenceId: noRefSeq.id, contactId: (await mkContact('C6 NoRef')).id });
  const nrp = payloadOf((await jobsFor(noRefEnr.id))[0]);
  check('C6 a step with neither inline body nor template_ref is also flagged',
    nrp.content_resolved === false && nrp.body === null, JSON.stringify(nrp));

  // A template belonging to ANOTHER tenant must not resolve — content must never
  // cross a tenant boundary, which is why there is no global template fallback.
  await req('POST', '/api/crm/templates', { ref: 'cross_tenant', body: 'other tenant copy' }, CO2);
  const crossSeq = await seqDb.createSequence({ companyId: CO, name: `C6 cross ${RUN}`, pipelineKey: 'webinar_sales' });
  const crossStep = await seqDb.addStep(crossSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'cross_tenant' });
  const rCross = await templatesDb.resolveStepContent(CO, crossStep, contact);
  check("C6 another tenant's template does NOT resolve (no cross-tenant content)",
    rCross.resolved === false && rCross.body === null, JSON.stringify(rCross));

  // ── C7 — the ack-driven next step also carries content ────────────────────
  const job1 = (await jobsFor(enr.id))[0];
  const claim = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 25, claimed_by: 'c40-test' });
  const claimed = (claim.json?.jobs || []).find(j => j.job_id === job1.id);
  check('C7 step 1 is claimable', !!claimed, JSON.stringify((claim.json?.jobs || []).length));
  // The claim response is the executor's ONLY view of the work — content must be on it.
  check('C7 the CLAIM RESPONSE itself carries the resolved body (the executor never reaches around the contract)',
    typeof claimed?.payload?.body === 'string' && claimed.payload.body.includes('C3'), JSON.stringify(claimed?.payload));
  const ack = await req('POST', `/api/crm/channel-jobs/${job1.id}/ack`, { status: 'sent', claimed_by: 'c40-test' });
  check('C7 ack(sent) still returns 200 — CP2 ack path unchanged', ack.status === 200, JSON.stringify(ack.json));
  const jobs2 = await jobsFor(enr.id);
  const step2Job = jobs2.find(j => j.step_id === stepInline.id);
  check('C7 step 2 was materialised by the ack', !!step2Job, JSON.stringify(jobs2.map(j => j.step_id)));
  const p2 = payloadOf(step2Job);
  check('C7 the ack-materialised step 2 ALSO carries resolved content',
    p2.content_resolved === true && /Inline body for C3/.test(p2.body || ''), JSON.stringify(p2));

  // ── C8 — scheduleAction's UPSERT carries content too ──────────────────────
  const reSched = await seqDb.scheduleAction(CO, {
    enrollmentId: enr.id, stepId: stepInline.id,
    payload: { note: 'caller metadata' }, scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
  });
  const p3 = payloadOf(reSched);
  check('C8 scheduleAction freezes content on re-timing', p3.content_resolved === true && !!p3.body, JSON.stringify(p3));
  check('C8 caller metadata survives alongside it', p3.note === 'caller metadata', JSON.stringify(p3.note));
  // A caller must not be able to hand-write content and bypass the store.
  const forged = await seqDb.scheduleAction(CO, {
    enrollmentId: enr.id, stepId: stepInline.id,
    payload: { body: 'FORGED BODY', subject: 'FORGED', content_resolved: true },
    scheduledFor: new Date(Date.now() + 7200_000).toISOString(),
  });
  const pf = payloadOf(forged);
  check('C8 a caller CANNOT inject its own body — the store wins',
    pf.body !== 'FORGED BODY' && /Inline body/.test(pf.body || ''), JSON.stringify(pf.body));
  check('C8 …nor forge the resolved flag', pf.subject !== 'FORGED', JSON.stringify(pf.subject));

  // ── C9 — readiness: "is this sequence safe to switch on?" ─────────────────
  const ready = await req('GET', `/api/crm/sequences/${seq.id}/content`);
  check('C9 readiness reports the sequence sendable', ready.status === 200 && ready.json?.sendable === true, JSON.stringify(ready.json?.sendable));
  check('C9 it reports zero unresolved steps', ready.json?.unresolved_steps === 0, String(ready.json?.unresolved_steps));
  const notReady = await req('GET', `/api/crm/sequences/${orphanSeq.id}/content`);
  check('C9 a sequence with missing copy is NOT sendable', notReady.json?.sendable === false, JSON.stringify(notReady.json?.sendable));
  check('C9 it names the offending step and why',
    notReady.json?.steps?.[0]?.resolved === false && /does_not_exist/.test(notReady.json.steps[0].reason || ''),
    JSON.stringify(notReady.json?.steps?.[0]));
  const emptySeq = await seqDb.createSequence({ companyId: CO, name: `C9 empty ${RUN}`, pipelineKey: 'webinar_sales' });
  const emptyReady = await req('GET', `/api/crm/sequences/${emptySeq.id}/content`);
  check('C9 a sequence with NO steps is not sendable either', emptyReady.json?.sendable === false, JSON.stringify(emptyReady.json));
  const xReady = await req('GET', `/api/crm/sequences/${seq.id}/content`, undefined, CO2);
  check('C9 readiness is tenant-scoped (cross-tenant 404)', xReady.status === 404, String(xReady.status));

  // ── C10 — copy that would embarrass us is BLOCKING, not advisory ──────────
  // These were warnings in the first cut. A warning that nothing downstream is
  // required to read is just a send with extra steps, so both now refuse.
  await req('POST', '/api/crm/templates', { ref: 'tokentest', channel: 'email',
    subject: 'Re: {first_name}', body: 'Hello {first_name}, about {nonexistent_token}.' });
  const rWarn = await templatesDb.resolveStepContent(CO, { channel: 'email', template_ref: 'tokentest' }, contact);
  // A brace-shaped word that is NOT a personalisation token is ordinary prose —
  // "we call this the {growth} framework" — and refusing it would be a false
  // block on good copy that an operator cannot diagnose. It sends, with an
  // advisory. Only a KNOWN token left unresolved blocks (asserted just below).
  check('C10 braced NON-token prose is allowed through, not false-blocked',
    rWarn.resolved === true, JSON.stringify(rWarn));
  check('C10 …the literal text survives verbatim',
    /about \{nonexistent_token\}/.test(rWarn.body || ''), rWarn.body);
  check('C10 …and it is flagged advisorily, in case it was a typo',
    (rWarn.warnings || []).some(w => /nonexistent_token/.test(w)), JSON.stringify(rWarn.warnings));
  // A contact missing the data a token needs is the same hazard from the other side.
  await req('POST', '/api/crm/templates', { ref: 'needs_company', channel: 'email',
    subject: 'Hi {first_name}', body: 'About {company}.' });
  const nameless = await mkContact('C10 Nocompany');
  const rNameless = await templatesDb.resolveStepContent(CO, { channel: 'email', template_ref: 'needs_company' }, nameless);
  check('C10 a KNOWN token the contact cannot satisfy DOES block (never "About {company}.")',
    rNameless.resolved === false && /company/.test(rNameless.reason || ''), JSON.stringify(rNameless));
  check('C10 …and the reason tells the operator how to fix it (fill it, remove it, or escape it)',
    /\{\{company\}\}/.test(rNameless.reason || ''), rNameless.reason);
  // Subject rules.
  await req('POST', '/api/crm/templates', { ref: 'nosubject', channel: 'email', body: 'Body only.' });
  const noSubj = await templatesDb.resolveStepContent(CO, { channel: 'email', template_ref: 'nosubject' }, contact);
  check('C10 an EMAIL step with no subject is refused (provider would send "(no subject)")',
    noSubj.resolved === false && /subject/.test(noSubj.reason || ''), JSON.stringify(noSubj));
  await req('POST', '/api/crm/templates', { ref: 'wssubject', channel: 'email', subject: '   ', body: 'Body only.' });
  const wsSubj = await templatesDb.resolveStepContent(CO, { channel: 'email', template_ref: 'wssubject' }, contact);
  check('C10 a WHITESPACE-only subject is treated as no subject, not as a subject',
    wsSubj.resolved === false, JSON.stringify(wsSubj));
  const chatOk = await templatesDb.resolveStepContent(CO, { channel: 'whatsapp', template_ref: 'nosubject' }, contact);
  check('C10 …but a chat channel needs no subject and still resolves',
    chatOk.resolved === true && chatOk.body === 'Body only.', JSON.stringify(chatOk));

  // ── C13 — THE ENFORCEMENT POINT: the claim door never hands out a blank ───
  // Before this, refusal lived only in comments and in an executor nobody had
  // written yet, so claimJobs served a body-less job indistinguishably from a
  // real one.
  {
    const cSeq = await seqDb.createSequence({ companyId: CO, name: `C13 seq ${RUN}`, pipelineKey: 'webinar_sales' });
    await seqDb.addStep(cSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'no_such_template' });
    const cContact = await mkContact('C13 Blank');
    const cEnr = await seqDb.enroll(CO, { sequenceId: cSeq.id, contactId: cContact.id });
    const cJob = (await jobsFor(cEnr.id))[0];
    check('C13 the unresolved job IS queued', !!cJob);
    const claimRes = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'c13' });
    check('C13 …but the claim door REFUSES to hand it to an executor',
      !(claimRes.json?.jobs || []).some(j => j.job_id === cJob.id),
      JSON.stringify((claimRes.json?.jobs || []).map(j => j.job_id)));
    const stillPending = (await db.query('SELECT status FROM scheduled_actions WHERE id=$1', [cJob.id])).rows[0];
    check('C13 …and leaves it PENDING, not skipped (a skip would advance the ladder past a step nobody received)',
      stillPending.status === 'pending', stillPending.status);
    // Author the copy — the same job must now flow, with no re-enrolment.
    await req('POST', '/api/crm/templates', { ref: 'no_such_template', channel: 'email', subject: 'Now it exists', body: 'Real copy for {first_name}.' });
    await seqDb.scheduleAction(CO, { enrollmentId: cEnr.id, stepId: cJob.step_id, scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    const claim2 = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'c13b' });
    const now = (claim2.json?.jobs || []).find(j => j.job_id === cJob.id);
    check('C13 once the copy is authored the SAME job becomes claimable', !!now, JSON.stringify(claim2.json?.jobs?.length));
    check('C13 …and arrives carrying the real body', /Real copy for C13/.test(now?.payload?.body || ''), JSON.stringify(now?.payload));
  }

  // ── C14 — legacy rows (queued before the content store) are not sendable ──
  {
    const lSeq = await seqDb.createSequence({ companyId: CO, name: `C14 legacy ${RUN}`, pipelineKey: 'webinar_sales' });
    await seqDb.addStep(lSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'noshow_fu1' });
    const lContact = await mkContact('C14 Legacy');
    const lEnr = await seqDb.enroll(CO, { sequenceId: lSeq.id, contactId: lContact.id });
    const lJob = (await jobsFor(lEnr.id))[0];
    // Simulate a row queued before migration 021: payload '{}' with NO content key.
    await db.query(`UPDATE scheduled_actions SET payload='{}'::jsonb, status='pending', scheduled_for=now()-interval '1 minute' WHERE id=$1`, [lJob.id]);
    const claimL = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'c14' });
    check('C14 a row with NO content_resolved key at all is NOT claimable (absent ≠ fine)',
      !(claimL.json?.jobs || []).some(j => j.job_id === lJob.id), JSON.stringify(claimL.json?.jobs?.length));
    // …and the migration's backfill marks such rows explicitly.
    await db.query(mig);
    const backfilled = (await db.query('SELECT payload FROM scheduled_actions WHERE id=$1', [lJob.id])).rows[0];
    const bp = typeof backfilled.payload === 'string' ? JSON.parse(backfilled.payload) : backfilled.payload;
    check('C14 re-running migration 021 BACKFILLS the legacy row to content_resolved=false',
      bp.content_resolved === false, JSON.stringify(bp));
    check('C14 …with a reason naming the migration', /migration 021/.test(bp.content_error || ''), bp.content_error);
  }

  // ── C11 — preview renders without sending ─────────────────────────────────
  const preview = await req('POST', '/api/crm/templates/preview', { ref: 'noshow_fu1', contact_id: contact.id });
  check('C11 preview resolves against a real contact', preview.status === 200 && /C3/.test(preview.json?.body || ''), JSON.stringify(preview.json));
  check('C11 preview sends nothing', preview.json?.sent === false, JSON.stringify(preview.json?.sent));
  const msgsBefore = (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n;
  await req('POST', '/api/crm/templates/preview', { body: 'ad hoc {first_name}', contact_id: contact.id });
  const msgsAfter = (await db.query('SELECT count(*)::int n FROM messages')).rows[0].n;
  check('C11 preview creates no messages rows', msgsBefore === msgsAfter, `${msgsBefore} -> ${msgsAfter}`);


  // ── C15 — the legacy-queue interaction, end to end ────────────────────────
  // The orchestrator's specific worry: jobs materialised BEFORE this migration
  // carry payload '{}' with no content key at all, and they are the FIRST thing
  // an executor meets. "Send blank mail" must not re-enter through the back door
  // of the migration written to stop it. Proven WITHOUT calling any sender.
  {
    const lSeq = await seqDb.createSequence({ companyId: CO, name: `C15 legacy ${RUN}`, pipelineKey: 'webinar_sales' });
    const lStep = await seqDb.addStep(lSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'ghost_ref_c15' });
    const lContact = await mkContact('C15 OldProspect');
    const lEnr = await seqDb.enroll(CO, { sequenceId: lSeq.id, contactId: lContact.id });
    const lJob = (await jobsFor(lEnr.id))[0];
    // Exactly the pre-021 shape: pending, DUE, payload '{}'.
    await db.query(`UPDATE scheduled_actions SET payload='{}'::jsonb, status='pending',
                    scheduled_for=now()-interval '1 hour' WHERE id=$1`, [lJob.id]);
    const raw = payloadOf((await db.query('SELECT payload FROM scheduled_actions WHERE id=$1', [lJob.id])).rows[0]);
    check('C15 the legacy job genuinely has NO content_resolved key (the third state)',
      !Object.prototype.hasOwnProperty.call(raw, 'content_resolved'), JSON.stringify(raw));
    // 1. Identifiable as content-less WITHOUT calling the sender.
    const res = await templatesDb.resolveStepContent(CO, lStep, lContact);
    check('C15 resolveStepContent has a DEFINED content-less outcome (not an exception)',
      res.resolved === false && res.body === null && typeof res.reason === 'string', JSON.stringify(res));
    check('C15 …naming the ref that resolves to nothing', /ghost_ref_c15/.test(res.reason), res.reason);
    // 2. The claim door refuses it even though it is due.
    const claimed = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'c15' });
    check('C15 a DUE legacy job is never handed to an executor',
      !(claimed.json?.jobs || []).some(j => j.job_id === lJob.id), JSON.stringify(claimed.json?.jobs?.length));
    const still = (await db.query('SELECT status FROM scheduled_actions WHERE id=$1', [lJob.id])).rows[0];
    check('C15 …and stays PENDING, so the ladder is not advanced past a step nobody received',
      still.status === 'pending', still.status);
    // 3. The migration marks it, so "no third state" holds for pre-021 rows too.
    await db.query(mig);
    const marked = payloadOf((await db.query('SELECT payload FROM scheduled_actions WHERE id=$1', [lJob.id])).rows[0]);
    check('C15 migration 021 marks the legacy job content_resolved=false',
      marked.content_resolved === false && marked.body === null, JSON.stringify(marked));
    // 4. Readiness reports it before anything fires.
    const ready = await req('GET', `/api/crm/sequences/${lSeq.id}/content`);
    check('C15 readiness reports the sequence NOT sendable, without touching a sender',
      ready.json?.sendable === false && ready.json?.unresolved_steps === 1, JSON.stringify(ready.json?.sendable));
  }

  // ── C16 — a template pinned to another channel is a CONFIG-TIME 400 ───────
  // CP2's stage_writeback precedent: catch an authoring error while the human is
  // authoring, not when the ladder fires at a prospect.
  {
    const cSeq = await req('POST', '/api/crm/sequences', { name: `C16 ${RUN}`, pipeline_key: 'webinar_sales' });
    await req('POST', '/api/crm/templates', { ref: 'sms_only', channel: 'sms', body: 'SMS copy.' });
    const bad = await req('POST', `/api/crm/sequences/${cSeq.json.id}/steps`,
      { step_order: 1, channel: 'email', template_ref: 'sms_only' });
    check('C16 an email step using an SMS-pinned template is refused at config time (400)',
      bad.status === 400, `${bad.status} ${JSON.stringify(bad.json)}`);
    check('C16 …and the 400 names both channels', /sms/.test(bad.json?.error || '') && /email/.test(bad.json?.error || ''), bad.json?.error);
    const good = await req('POST', `/api/crm/sequences/${cSeq.json.id}/steps`,
      { step_order: 1, channel: 'sms', template_ref: 'sms_only' });
    check('C16 the matching channel is accepted', good.status === 201, JSON.stringify(good.json));
    // channel NULL means ANY channel — the decision, made explicit and tested.
    await req('POST', '/api/crm/templates', { ref: 'any_channel', body: 'Works anywhere.' });
    const anyEmail = await req('POST', `/api/crm/sequences/${cSeq.json.id}/steps`,
      { step_order: 2, channel: 'email', template_ref: 'any_channel' });
    check('C16 a template with channel NULL is usable on ANY channel', anyEmail.status === 201, JSON.stringify(anyEmail.json));
    const anyWhatsapp = await req('POST', `/api/crm/sequences/${cSeq.json.id}/steps`,
      { step_order: 3, channel: 'whatsapp', template_ref: 'any_channel' });
    check('C16 …including a different one on the same sequence', anyWhatsapp.status === 201, JSON.stringify(anyWhatsapp.json));
    // A ref that does not exist YET is not a config error — copy is often
    // authored after the ladder is laid out; readiness is what reports that.
    const later = await req('POST', `/api/crm/sequences/${cSeq.json.id}/steps`,
      { step_order: 4, channel: 'email', template_ref: 'not_written_yet' });
    check('C16 a not-yet-authored ref is ACCEPTED at config time (readiness reports it instead)',
      later.status === 201, JSON.stringify(later.json));
  }


  // ── F1/F2 — authoring the copy must ACTUALLY un-stick the ladder ──────────
  // A second orchestrator pass reproduced this: materializeNextStep FREEZES
  // content_resolved into the payload, the claim door reads that frozen flag,
  // and nothing re-resolved it — so the operator authored the missing template,
  // got a 201, and the job stayed unclaimable. My own C13 only passed because it
  // re-SCHEDULED the job (which re-resolves); authoring alone did not.
  {
    const fSeq = await seqDb.createSequence({ companyId: CO, name: `F1 ${RUN}`, pipelineKey: 'webinar_sales' });
    await seqDb.addStep(fSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: `f1_ref_${RUN}` });
    const fc = await mkContact('F1 Stuck');
    const fEnr = await seqDb.enroll(CO, { sequenceId: fSeq.id, contactId: fc.id });
    const fJob = (await jobsFor(fEnr.id))[0];
    await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [fJob.id]);
    check('F1 the job is frozen content-less', payloadOf(await jobRowOf(fJob.id)).content_resolved === false);

    // F2: readiness must NOT claim the sequence is sendable while that row is stuck.
    await req('POST', '/api/crm/templates', { ref: `f1_ref_${RUN}`, channel: 'email',
      subject: 'Now authored', body: 'Real copy for {first_name}.' });
    const ready = await req('GET', `/api/crm/sequences/${fSeq.id}/content`);
    check('F2 readiness counts the QUEUED unresolved job, not just the step',
      ready.json?.unresolved_queued_jobs >= 1, JSON.stringify(ready.json?.unresolved_queued_jobs));
    check('F2 …so sendable does NOT lie while a queued row is still stuck',
      ready.json?.sendable === false, JSON.stringify(ready.json?.sendable));

    // F1: the claim door re-resolves, so authoring alone un-sticks it.
    const claim = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'f1-exec' });
    const got = (claim.json?.jobs || []).find(j => j.job_id === fJob.id);
    check('F1 AUTHORING THE COPY ALONE makes the job claimable — no re-schedule, no DB surgery',
      !!got, JSON.stringify((claim.json?.jobs || []).length));
    check('F1 …and it arrives carrying the real, token-resolved body',
      /Real copy for F1/.test(got?.payload?.body || ''), JSON.stringify(got?.payload?.body));
    const after = payloadOf(await jobRowOf(fJob.id));
    check('F1 …the row was rewritten in place, and says when', after.content_resolved === true && !!after.content_reresolved_at,
      JSON.stringify([after.content_resolved, after.content_reresolved_at]));
    const ready2 = await req('GET', `/api/crm/sequences/${fSeq.id}/content`);
    check('F2 …after which readiness agrees it is sendable', ready2.json?.sendable === true, JSON.stringify(ready2.json?.sendable));

    // A job whose copy STILL does not exist must be left exactly as it was.
    const gSeq = await seqDb.createSequence({ companyId: CO, name: `F1 never ${RUN}`, pipelineKey: 'webinar_sales' });
    await seqDb.addStep(gSeq.id, CO, { stepOrder: 1, channel: 'email', templateRef: `never_authored_${RUN}` });
    const gEnr = await seqDb.enroll(CO, { sequenceId: gSeq.id, contactId: (await mkContact('F1 NeverCopy')).id });
    const gJob = (await jobsFor(gEnr.id))[0];
    await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [gJob.id]);
    const claim2 = await req('POST', '/api/crm/channel-jobs/claim', { channel: 'email', limit: 100, claimed_by: 'f1-exec2' });
    check('F1 a job with STILL no copy stays unclaimable (the re-resolve is not a bypass)',
      !(claim2.json?.jobs || []).some(j => j.job_id === gJob.id));
    check('F1 …and is left pending, untouched', (await jobRowOf(gJob.id)).status === 'pending');
  }

  // ── C12 — model guards ────────────────────────────────────────────────────
  const throws = async fn => { try { await fn(); return false; } catch { return true; } };
  check('C12 unscoped listTemplates throws', await throws(() => templatesDb.listTemplates(null)));
  check('C12 unscoped resolveStepContent throws', await throws(() => templatesDb.resolveStepContent(null, {}, null)));
  check('C12 upsertTemplate refuses a blank body', await throws(() => templatesDb.upsertTemplate(CO, { ref: 'x', body: '  ' })));
  check('C12 upsertTemplate refuses a missing ref', await throws(() => templatesDb.upsertTemplate(CO, { ref: '', body: 'hi' })));

  await db.shutdownDatabase();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
