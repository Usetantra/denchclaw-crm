#!/usr/bin/env node
// DenchClaw CRM — CP-EV: workflow event triggers (migration 041).
//
// Migration 034 gave workflows two starts: a pipeline stage or a tag. The tag
// was meant to be a UNIVERSAL entry point, and the builder's help text says so —
// but `enrollForTriggerTag` was called from the bulk-tag action and from PATCH
// /contacts/:id only, NOT from contact creation. So a contact born WITH a tag —
// which is exactly the lead-webhook path — never started a tag-triggered
// workflow. EV-1..EV-3 pin that fix.
//
// The rest pin the new event triggers. The rule they enforce throughout: a
// trigger the UI offers must have a REAL firing site. A workflow that silently
// never runs is indistinguishable, to the operator who built it, from a broken
// one — so every event offered here is proven to fire from the actual product
// path, not from a synthetic call to the enrolment function.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpev-event-triggers.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import suppressionDb from '../server/db/models/suppression.js';
import workflowTriggers from '../server/lib/workflow-triggers.js';
import marketing from '../server/lib/marketing-events.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpev_co_' + RUN;
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Enrolment is fire-and-forget by design (a workflow must not add latency to,
// or fail, the request that triggered it), so assertions poll briefly rather
// than assuming the write has landed by the time the response returns.
async function enrolledIn(sequenceId, contactId, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const r = await db.query(
      `SELECT id FROM enrollments WHERE sequence_id=$1 AND contact_id=$2 LIMIT 1`,
      [sequenceId, contactId]
    );
    if (r.rows[0]) return true;
    await sleep(60);
  }
  return false;
}

async function makeWorkflow(body) {
  const seq = await req('POST', '/api/crm/sequences', { name: `wf-${RUN}-${Math.random().toString(36).slice(2, 7)}`, ...body });
  if (seq.status !== 201) return { error: seq };
  await req('POST', `/api/crm/sequences/${seq.json.id}/steps`,
    { step_order: 1, channel: 'action', action_type: 'add_tag', action_config: { tag: 'touched' }, delay_seconds: 0 });
  return { id: seq.json.id };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  // ══ 1. The tag-on-creation gap ════════════════════════════════════════════
  const tagWf = await makeWorkflow({ trigger_tag: 'lead_in' });
  check('EV-1 a tag-triggered workflow can be created', !!tagWf.id, JSON.stringify(tagWf.error));

  const born = await req('POST', '/api/crm/contacts',
    { name: 'Born Tagged', email: `born-${RUN}@ex.test`, tags: ['lead_in'], source: 'lead_webhook' });
  check('EV-2 creating a contact WITH the tag succeeds', born.status === 201, JSON.stringify(born.json).slice(0, 140));
  check('EV-3 ...and now enrols it — the lead-webhook path the help text promises',
    await enrolledIn(tagWf.id, born.json.id), 'not enrolled on create');

  // Regression guard: tagging an EXISTING contact already worked and must still.
  const later = await req('POST', '/api/crm/contacts', { name: 'Tagged Later', email: `later-${RUN}@ex.test` });
  await req('PATCH', `/api/crm/contacts/${later.json.id}`, { tags: ['lead_in'] });
  check('EV-4 tagging an existing contact still enrols (unchanged path)',
    await enrolledIn(tagWf.id, later.json.id), 'patch path broke');

  // ══ 2. The catalogue is served, not hardcoded ═════════════════════════════
  const cat = await req('GET', '/api/crm/sequences/trigger-events');
  const keys = (cat.json?.events || []).map(e => e.key);
  check('EV-5 the trigger catalogue is served to the client',
    cat.status === 200 && keys.length >= 6, JSON.stringify(keys));
  check('EV-6 ...and every entry names where it fires, so the operator can tell what runs it',
    (cat.json?.events || []).every(e => e.label && e.fires_at), JSON.stringify(cat.json?.events?.[0]));
  check('EV-7 the served catalogue matches what the server actually fires',
    JSON.stringify(keys.slice().sort()) === JSON.stringify(workflowTriggers.EVENT_KEYS.slice().sort()),
    `${keys} vs ${workflowTriggers.EVENT_KEYS}`);

  const bogus = await req('POST', '/api/crm/sequences', { name: 'nope', trigger_event: 'when_i_feel_like_it' });
  check('EV-8 an event with no firing site is refused rather than silently never running',
    bogus.status === 400 && Array.isArray(bogus.json?.allowed_events), JSON.stringify(bogus.json));

  const twoTriggers = await req('POST', '/api/crm/sequences',
    { name: 'both', trigger_tag: 'x', trigger_event: 'contact_created' });
  check('EV-9 a workflow cannot have two triggers at once', twoTriggers.status === 400, JSON.stringify(twoTriggers.json));

  // ══ 3. contact_created ════════════════════════════════════════════════════
  const createdWf = await makeWorkflow({ trigger_event: 'contact_created' });
  check('EV-10 an event-triggered workflow can be created', !!createdWf.id, JSON.stringify(createdWf.error));
  const fresh = await req('POST', '/api/crm/contacts', { name: 'Fresh', email: `fresh-${RUN}@ex.test` });
  check('EV-11 contact_created fires on a new contact',
    await enrolledIn(createdWf.id, fresh.json.id), 'contact_created did not fire');

  // ══ 4. reply_received, and its channel narrowing ══════════════════════════
  const anyReplyWf = await makeWorkflow({ trigger_event: 'reply_received' });
  const waOnlyWf = await makeWorkflow({ trigger_event: 'reply_received', trigger_config: { channel: 'whatsapp' } });

  const replier = await req('POST', '/api/crm/contacts', { name: 'Replier', email: `rep-${RUN}@ex.test` });
  const conv = await req('POST', '/api/crm/conversations', { contact_id: replier.json.id, channel: 'email' });
  await req('POST', `/api/crm/conversations/${conv.json.id}/messages`,
    { direction: 'inbound', channel: 'email', body: 'hello', provider_message_id: `pm-${RUN}-1` });

  check('EV-12 reply_received fires on an inbound message',
    await enrolledIn(anyReplyWf.id, replier.json.id), 'reply trigger did not fire');
  check('EV-13 ...and a workflow narrowed to WhatsApp does NOT fire on an email reply',
    !(await enrolledIn(waOnlyWf.id, replier.json.id, 3)), 'channel narrowing leaked');

  // Redelivery must not re-enrol: the same provider_message_id is deduped by the
  // messages table, and the trigger sits behind that same guard.
  const before = (await db.query(
    `SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND contact_id=$2`,
    [anyReplyWf.id, replier.json.id])).rows[0].n;
  await req('POST', `/api/crm/conversations/${conv.json.id}/messages`,
    { direction: 'inbound', channel: 'email', body: 'hello', provider_message_id: `pm-${RUN}-1` });
  await sleep(300);
  const after = (await db.query(
    `SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND contact_id=$2`,
    [anyReplyWf.id, replier.json.id])).rows[0].n;
  check('EV-14 a redelivered inbound message does not re-enrol', after === before, `${before} → ${after}`);

  // An OUTBOUND message is not a reply.
  const outWf = await makeWorkflow({ trigger_event: 'reply_received' });
  await req('POST', `/api/crm/conversations/${conv.json.id}/messages`,
    { direction: 'outbound', channel: 'email', body: 'ours', provider_message_id: `pm-${RUN}-out` });
  check('EV-15 an outbound message does not fire reply_received',
    !(await enrolledIn(outWf.id, replier.json.id, 3)), 'outbound fired a reply trigger');

  // ══ 4b. Webinar events — proven through the REAL ingest door ═════════════
  // ingestMarketingEvent is the single path every marketing event takes (public
  // webhook, WebinarGeek sync, manual entry), so driving it here exercises the
  // production path rather than a synthetic call to the enrolment function.
  const regWf = await makeWorkflow({ trigger_event: 'webinar_registered' });
  const attWf = await makeWorkflow({ trigger_event: 'webinar_attended' });
  const nsWf  = await makeWorkflow({ trigger_event: 'webinar_no_show' });

  await marketing.upsertWebinar(CO, { key: `w-${RUN}`, name: 'Test Webinar' });

  const reg = await marketing.ingestMarketingEvent(CO, {
    event_type: 'registration', webinar_key: `w-${RUN}`,
    email: `reg-${RUN}@ex.test`, name: 'Reggie',
  });
  check('EV-21 a registration is ingested', reg.ok === true, JSON.stringify(reg).slice(0, 160));
  check('EV-22 webinar_registered fires from the real ingest path',
    await enrolledIn(regWf.id, reg.contact_id), 'registration trigger did not fire');
  check('EV-23 ...and does not fire the ATTENDED workflow',
    !(await enrolledIn(attWf.id, reg.contact_id, 3)), 'wrong event fired');

  const att = await marketing.ingestMarketingEvent(CO, {
    event_type: 'attendance', webinar_key: `w-${RUN}`, email: `reg-${RUN}@ex.test`,
  });
  check('EV-24 webinar_attended fires on attendance',
    att.ok === true && await enrolledIn(attWf.id, reg.contact_id), JSON.stringify(att).slice(0, 140));

  // A no_show does NOT create a contact — unlike a registration, which does.
  // That is correct domain behaviour (you cannot no-show an event you never
  // registered for), and it means an unattributed no_show has contact_id null
  // and must fire nothing. Register first, then no-show that person.
  const nsReg = await marketing.ingestMarketingEvent(CO, {
    event_type: 'registration', webinar_key: `w-${RUN}`, email: `ns-${RUN}@ex.test`, name: 'Nora',
  });
  const ns = await marketing.ingestMarketingEvent(CO, {
    event_type: 'no_show', webinar_key: `w-${RUN}`, email: `ns-${RUN}@ex.test`,
  });
  check('EV-25 webinar_no_show fires even though no_show maps to NO pipeline stage',
    ns.ok === true && ns.contact_id === nsReg.contact_id && await enrolledIn(nsWf.id, ns.contact_id),
    JSON.stringify(ns).slice(0, 200));

  // An event that resolves to nobody must enrol nobody rather than throwing.
  const orphan = await marketing.ingestMarketingEvent(CO, {
    event_type: 'no_show', webinar_key: `w-${RUN}`,
  });
  check('EV-25b an unattributed event resolves to no contact and fires nothing',
    orphan.contact_id === null, JSON.stringify(orphan).slice(0, 160));

  // Marketing ingest dedupes by design; the trigger must inherit that.
  const rBefore = (await db.query(
    `SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND contact_id=$2`,
    [regWf.id, reg.contact_id])).rows[0].n;
  await marketing.ingestMarketingEvent(CO, {
    event_type: 'registration', webinar_key: `w-${RUN}`, email: `reg-${RUN}@ex.test`,
  });
  await sleep(300);
  const rAfter = (await db.query(
    `SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND contact_id=$2`,
    [regWf.id, reg.contact_id])).rows[0].n;
  check('EV-26 a duplicate provider event does not re-enrol', rAfter === rBefore, `${rBefore} → ${rAfter}`);

  // ══ 5. unsubscribed — fired from the MODEL, so every caller is covered ════
  const unsubWf = await makeWorkflow({ trigger_event: 'unsubscribed' });
  const quitter = await contactDb.create({ company_id: CO, name: 'Quitter', email: `quit-${RUN}@ex.test`, phone: '+14155559911' });

  // No contactId passed — the identifier must resolve it, which is the real
  // shape of the Twilio STOP path.
  await suppressionDb.add(CO, 'email', `quit-${RUN}@ex.test`, { reason: 'opt_out' });
  check('EV-16 unsubscribed fires even when the caller knows only an identifier',
    await enrolledIn(unsubWf.id, quitter.id), 'unsubscribe trigger did not fire');

  const uBefore = (await db.query(
    `SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND contact_id=$2`,
    [unsubWf.id, quitter.id])).rows[0].n;
  await suppressionDb.add(CO, 'email', `quit-${RUN}@ex.test`, { reason: 'opt_out' });
  await sleep(300);
  const uAfter = (await db.query(
    `SELECT count(*)::int AS n FROM enrollments WHERE sequence_id=$1 AND contact_id=$2`,
    [unsubWf.id, quitter.id])).rows[0].n;
  check('EV-17 re-recording an existing opt-out does not re-enrol', uAfter === uBefore, `${uBefore} → ${uAfter}`);

  // ══ 6. Failure containment ═══════════════════════════════════════════════
  // A paused workflow enrols nobody, and the triggering request still succeeds.
  const paused = await makeWorkflow({ trigger_event: 'contact_created' });
  await db.query(`UPDATE sequences SET status='paused' WHERE id=$1`, [paused.id]);
  const stillOk = await req('POST', '/api/crm/contacts', { name: 'Unaffected', email: `un-${RUN}@ex.test` });
  check('EV-18 a paused workflow does not enrol', !(await enrolledIn(paused.id, stillOk.json.id, 3)), 'paused enrolled');
  check('EV-19 ...and the triggering request still succeeded', stillOk.status === 201, String(stillOk.status));

  // ══ 7. Tenancy ═══════════════════════════════════════════════════════════
  const CO2 = 'cpev_other_' + RUN;
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });
  const otherContact = await req('POST', '/api/crm/contacts', { name: 'Other Co', email: `oc-${RUN}@ex.test` }, CO2);
  check('EV-20 an event in another tenant does not enrol into this tenant\'s workflow',
    !(await enrolledIn(createdWf.id, otherContact.json.id, 3)), 'cross-tenant enrolment');

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
