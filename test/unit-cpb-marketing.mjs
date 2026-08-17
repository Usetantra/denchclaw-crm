#!/usr/bin/env node
// DenchClaw CRM — CP-B (marketing stage ingestion) verification.
// Numbered against the CP-B ticket's eval criteria B-1 … B-23.
//
// WHAT THIS SUITE IS BUILT TO CATCH (C1 — assert CONTENT, not status flips):
// the failure mode here is not "the endpoint 500'd". It is "the endpoint
// returned 200, a row landed in crm_marketing_events, and the contact did not
// move" — a green ingest over a funnel that is still a diagram. So every
// criterion below asserts the CONTACT'S ACTUAL marketing_stage after the fact,
// and/or the event's recorded `outcome`, never merely that a request succeeded.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpb-marketing.mjs

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import limitsDb from '../server/db/models/limits.js';
import templatesDb from '../server/db/models/templates.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpb_co_' + RUN;
const CO2 = 'cpb_other_' + RUN;
// The public webhooks resolve the tenant FROM THE SECRET, so the runner binds a
// per-run secret to this run's tenant (MARKETING_WEBHOOK_SECRETS). Falling back
// to the single-secret form would land every request in the default tenant,
// where this run's contacts and webinar do not exist.
const SECRET = process.env.MARKETING_WEBHOOK_SECRET || 'cpb-marketing-secret';

if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail === undefined ? '' : detail}`); }
}

async function req(method, path, body, companyId = CO) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': companyId },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch { /* redirect / empty */ }
  return { status: r.status, json, location: r.headers.get('location') };
}

// Public (unauthenticated) surface — no internal key, marketing secret instead.
async function pub(method, path, body, { secret = SECRET, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (secret !== null) h['x-marketing-secret'] = secret;
  const r = await fetch(BASE + path, {
    method, headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await r.json(); } catch { /* redirect */ }
  return { status: r.status, json, location: r.headers.get('location') };
}

const stageOf = async (id) => (await db.query('SELECT marketing_stage FROM contacts WHERE id=$1', [id])).rows[0]?.marketing_stage;
const eventsFor = async (id) => (await db.query(
  'SELECT * FROM crm_marketing_events WHERE contact_id=$1 ORDER BY created_at', [id])).rows;

(async () => {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ── B-1 — migration 023 ───────────────────────────────────────────────────
  const mig = readFileSync(new URL('../migrations/023_marketing_ingestion.sql', import.meta.url), 'utf8');
  await db.query(mig); await db.query(mig);
  check('B-1 migration 023 re-applies twice with no error', true);
  const tables = (await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('crm_webinars','crm_invite_links','crm_marketing_events')`)).rows;
  check('B-1 the three ingestion tables exist', tables.length === 3, JSON.stringify(tables.map(t => t.table_name)));
  const dedupeIdx = (await db.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname='uq_crm_marketing_events_dedupe'`)).rows[0];
  check('B-1 idempotency is enforced by a UNIQUE index, not by application code',
    !!dedupeIdx && /UNIQUE/i.test(dedupeIdx.indexdef) && /company_id/.test(dedupeIdx.indexdef),
    JSON.stringify(dedupeIdx));

  // A webinar to hang everything off.
  const wres = await req('POST', '/api/crm/marketing/webinars', {
    key: 'wb_' + RUN, name: 'CP-B Test Webinar',
    scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    landing_page_url: 'https://example.test/webinar',
  });
  check('B-1 a webinar can be created', wres.status === 201 && !!wres.json?.webinar?.id, JSON.stringify(wres.json));
  const WKEY = wres.json?.webinar?.key;

  // C9 at config time: a bad landing page is refused while it is being typed.
  const badW = await req('POST', '/api/crm/marketing/webinars', {
    key: 'wb_bad_' + RUN, name: 'bad', landing_page_url: 'javascript:alert(1)',
  });
  check('B-1 a non-http landing_page_url is refused at CONFIG time (400)',
    badW.status === 400 && /invalid/i.test(badW.json?.error || ''), JSON.stringify(badW.json));

  let n = 0;
  const mkContact = async (stage = null, company = CO) => {
    n++;
    const c = await contactDb.create({
      name: `CPB P${n}`, email: `cpb-${RUN}-${n}@ex.test`, company_id: company,
    });
    if (stage) await db.query('UPDATE contacts SET marketing_stage=$1, deal_stage=$1 WHERE id=$2', [stage, c.id]);
    return c;
  };

  // ── B-2 — invite_sent moves prospects → invitees ──────────────────────────
  const p1 = await mkContact('prospects');
  const inv1 = await req('POST', '/api/crm/marketing/invites', {
    webinar_key: WKEY, channel: 'email', contact_id: p1.id,
  });
  check('B-2 recording an invite returns 200 and reports one advance',
    inv1.status === 200 && inv1.json?.advanced === 1, JSON.stringify(inv1.json));
  check('B-2 the CONTACT actually moved prospects → invitees',
    (await stageOf(p1.id)) === 'invitees', await stageOf(p1.id));
  const p1ev = await eventsFor(p1.id);
  check('B-2 the event is recorded with outcome=advanced and both stages',
    p1ev.length === 1 && p1ev[0].outcome === 'advanced' &&
    p1ev[0].from_stage === 'prospects' && p1ev[0].to_stage === 'invitees',
    JSON.stringify(p1ev.map(e => [e.event_type, e.outcome, e.from_stage, e.to_stage])));
  const inviteUrl = inv1.json?.results?.[0]?.invite_url;
  check('B-2 an invite mints a tracked link', typeof inviteUrl === 'string' && /\/m\/i\/.+/.test(inviteUrl), String(inviteUrl));
  const TOKEN = String(inviteUrl || '').split('/m/i/')[1];

  // ── B-3 — the invariant working: no programmatic entry into a MANUAL stage ─
  // `prospects` is manual. A contact outside the pipeline may only enter at the
  // first stage, and the CRM may not place them there — a human must.
  const stranger = await mkContact(); // default marketing_stage, outside the funnel
  const inv2 = await req('POST', '/api/crm/marketing/invites', {
    webinar_key: WKEY, channel: 'linkedin', contact_id: stranger.id,
  });
  const sEv = (await eventsFor(stranger.id))[0];
  check('B-3 an invite for a contact outside the pipeline is REFUSED, not forced',
    sEv?.outcome === 'refused', JSON.stringify(sEv && [sEv.outcome, sEv.detail]));
  check('B-3 …and the refusal explains that a human must place them in Prospects',
    /human/i.test(sEv?.detail || '') && /entry is only allowed at its first stage/i.test(sEv?.detail || ''),
    sEv?.detail);
  check('B-3 …and the contact did NOT move',
    (await stageOf(stranger.id)) !== 'invitees', await stageOf(stranger.id));
  check('B-3 …but the tracking link is still minted, so the invite going out is still attributable',
    typeof inv2.json?.results?.[0]?.invite_url === 'string', JSON.stringify(inv2.json?.results?.[0]));

  // ── B-4 — the tracked link redirects AND moves invitees → visits ──────────
  const hit = await pub('GET', `/m/i/${TOKEN}`, undefined, { secret: null });
  check('B-4 the invite link 302s to the destination',
    hit.status === 302 && hit.location === 'https://example.test/webinar', `${hit.status} ${hit.location}`);
  check('B-4 the CONTACT actually moved invitees → visits',
    (await stageOf(p1.id)) === 'visits', await stageOf(p1.id));
  const visitEv = (await eventsFor(p1.id)).find(e => e.event_type === 'landing_page_visit');
  check('B-4 the visit event records outcome=advanced invitees→visits',
    visitEv?.outcome === 'advanced' && visitEv.from_stage === 'invitees' && visitEv.to_stage === 'visits',
    JSON.stringify(visitEv && [visitEv.outcome, visitEv.from_stage, visitEv.to_stage]));

  // ── B-5 — a second click is the same observation ──────────────────────────
  const hit2 = await pub('GET', `/m/i/${TOKEN}`, undefined, { secret: null });
  check('B-5 a second click still redirects the prospect', hit2.status === 302, String(hit2.status));
  const visitEvents = (await eventsFor(p1.id)).filter(e => e.event_type === 'landing_page_visit');
  check('B-5 …and does not write a second visit event (deduped on the link)',
    visitEvents.length === 1, `count=${visitEvents.length}`);
  check('B-5 …and does not re-advance the contact',
    (await stageOf(p1.id)) === 'visits', await stageOf(p1.id));
  const linkRow = (await db.query('SELECT visit_count FROM crm_invite_links WHERE token=$1', [TOKEN])).rows[0];
  check('B-5 …while the link still counts BOTH clicks (dedupe must not lose the signal)',
    linkRow?.visit_count === 2, JSON.stringify(linkRow));

  // ── B-6 — a forged token moves nobody ────────────────────────────────────
  const forged = await pub('GET', '/m/i/not-a-real-token-abcdefghijklmnop', undefined, { secret: null });
  check('B-6 an unknown invite token is a 404', forged.status === 404, String(forged.status));
  const strayEvents = (await db.query(
    `SELECT COUNT(*)::int c FROM crm_marketing_events WHERE company_id=$1 AND event_type='landing_page_visit'`, [CO])).rows[0];
  check('B-6 …and writes no event at all', strayEvents.c === 1, JSON.stringify(strayEvents));

  // ── B-7 — landing-page registration → registrants ─────────────────────────
  const reg = await pub('POST', '/m/registration', {
    email: p1.email, webinar_key: WKEY, name: 'CP-B P1', company_id: CO,
  });
  check('B-7 the public registration webhook accepts a valid form post',
    reg.status === 200 && reg.json?.ok === true, JSON.stringify(reg.json));
  check('B-7 the CONTACT actually moved visits → registrants',
    (await stageOf(p1.id)) === 'registrants', await stageOf(p1.id));
  check('B-7 the registration event records the advance',
    reg.json?.outcome === 'advanced' && reg.json?.to_stage === 'registrants', JSON.stringify(reg.json));

  // A brand-new person registering is CREATED, not dropped (the engines' D1 rule).
  const freshEmail = `cpb-fresh-${RUN}@ex.test`;
  const regNew = await pub('POST', '/m/registration', { email: freshEmail, webinar_key: WKEY, name: 'Fresh Lead' });
  const freshContact = await contactDb.getByEmail(freshEmail, CO);
  check('B-7 an unknown registrant is created rather than dropped',
    !!freshContact && regNew.status === 200, JSON.stringify(regNew.json));
  check('B-7 …but is NOT force-walked into the funnel (Prospects is manual)',
    regNew.json?.outcome === 'refused', JSON.stringify(regNew.json && [regNew.json.outcome, regNew.json.detail]));

  // ── B-8 — fail closed ─────────────────────────────────────────────────────
  const wrongSecret = await pub('POST', '/m/registration', { email: p1.email, webinar_key: WKEY }, { secret: 'nope' });
  check('B-8 a wrong marketing secret is 401', wrongSecret.status === 401, JSON.stringify(wrongSecret.json));
  const noSecret = await pub('POST', '/m/registration', { email: p1.email, webinar_key: WKEY }, { secret: null });
  check('B-8 a missing marketing secret is 401', noSecret.status === 401, JSON.stringify(noSecret.json));
  const crossTenant = await pub('POST', '/m/registration', { email: p1.email, webinar_key: WKEY, company_id: CO2 });
  check('B-8 a secret bound to one tenant cannot write to another (403)',
    crossTenant.status === 403, JSON.stringify(crossTenant.json));
  check('B-8 …and the tenant comes from the SECRET, not from a caller-supplied header',
    (await pub('POST', '/m/rsvp', { contact_id: 'x', webinar_key: WKEY },
      { headers: { 'x-company-id': CO2 } })).status === 403);

  // The unconfigured case, proven against a REAL server booted without the
  // secret — a comment claiming "it fails closed" is not evidence (C3).
  const failClosed = await bootProbe({ withSecret: false });
  check('B-8 a server with NO MARKETING_WEBHOOK_SECRET disables the webhooks (503), never opens them',
    failClosed === 503, `got ${failClosed}`);

  // ── B-9 — auto-registrant path 1: calendar RSVP ───────────────────────────
  const mkInvitee = async () => {
    const c = await mkContact('prospects');
    await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'calendar', contact_id: c.id });
    return c;
  };
  const rYes = await mkInvitee();
  const rsvpYes = await pub('POST', '/m/rsvp', { contact_id: rYes.id, webinar_key: WKEY, rsvp: 'ACCEPTED' });
  check('B-9 an ACCEPTED calendar RSVP moves invitees → auto_registrants',
    (await stageOf(rYes.id)) === 'auto_registrants', `${await stageOf(rYes.id)} / ${JSON.stringify(rsvpYes.json)}`);

  const rMaybe = await mkInvitee();
  await pub('POST', '/m/rsvp', { contact_id: rMaybe.id, webinar_key: WKEY, rsvp: 'tentativelyAccepted' });
  check('B-9 a MAYBE (tentative) RSVP also auto-registers — the spec says YES/MAYBE',
    (await stageOf(rMaybe.id)) === 'auto_registrants', await stageOf(rMaybe.id));

  const rNo = await mkInvitee();
  const rsvpNo = await pub('POST', '/m/rsvp', { contact_id: rNo.id, webinar_key: WKEY, rsvp: 'declined' });
  check('B-9 a DECLINED RSVP moves nobody',
    (await stageOf(rNo.id)) === 'invitees' && rsvpNo.json?.outcome === 'not_interested',
    `${await stageOf(rNo.id)} / ${JSON.stringify(rsvpNo.json)}`);

  const rJunk = await mkInvitee();
  const rsvpJunk = await pub('POST', '/m/rsvp', { contact_id: rJunk.id, webinar_key: WKEY, rsvp: 'wibble' });
  check('B-9 an UNRECOGNISED RSVP value is never treated as acceptance',
    (await stageOf(rJunk.id)) === 'invitees' && rsvpJunk.json?.outcome === 'not_interested',
    `${await stageOf(rJunk.id)} / ${JSON.stringify(rsvpJunk.json)}`);

  // ── B-10..B-13 — auto-registrant path 2: interested email reply ───────────
  // Driven through the ingest with the same payload the inbound-email webhook
  // builds, so the classification rules are exercised exactly as they will run.
  const replyCase = async (body, label) => {
    const c = await mkContact('prospects');
    await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'email', contact_id: c.id });
    const out = await req('POST', '/api/crm/marketing/events', {
      event_type: 'email_reply', channel: 'email', contact_id: c.id, webinar_key: WKEY, body,
    });
    return { contact: c, out: out.json, stage: await stageOf(c.id), label };
  };

  const yes = await replyCase('This looks great — count me in for the webinar!', 'interested');
  check('B-10 an interested email reply moves invitees → auto_registrants',
    yes.stage === 'auto_registrants' && yes.out?.outcome === 'advanced',
    `${yes.stage} / ${JSON.stringify(yes.out)}`);

  const no = await replyCase('Thanks but not interested, please remove me from your list.', 'negative');
  check('B-11 a "not interested / remove me" reply registers NOBODY',
    no.stage === 'invitees', no.stage);
  check('B-11 …and is recorded as a suppression, not a silent no-op',
    no.out?.outcome === 'suppressed', JSON.stringify(no.out));
  check('B-11 …and an actual suppression row now exists for that contact',
    (await limitsDb.isSuppressed(CO, no.contact.id, 'email')) === true);

  const ooo = await replyCase('I am out of the office until Monday and will reply then.', 'ooo');
  check('B-12 an out-of-office auto-reply is never mistaken for interest',
    ooo.stage === 'invitees' && ooo.out?.outcome === 'not_interested',
    `${ooo.stage} / ${JSON.stringify(ooo.out)}`);
  check('B-12 …and does NOT suppress the contact (an OOO is not an opt-out)',
    (await limitsDb.isSuppressed(CO, ooo.contact.id, 'email')) === false);

  const meh = await replyCase('Got it, thanks for sending this over.', 'ambiguous');
  check('B-13 a reply with no explicit interest signal moves nobody (absent is not a yes)',
    meh.stage === 'invitees' && meh.out?.outcome === 'not_interested',
    `${meh.stage} / ${JSON.stringify(meh.out)}`);
  check('B-13 …and the reason is recorded so "it did not move" is explainable',
    /no explicit interest signal/.test(meh.out?.detail || ''), meh.out?.detail);

  // The caller may override the classifier — but an opt-out still wins.
  const forced = await mkContact('prospects');
  await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'email', contact_id: forced.id });
  const forcedOut = await req('POST', '/api/crm/marketing/events', {
    event_type: 'email_reply', channel: 'email', contact_id: forced.id, webinar_key: WKEY,
    body: 'unsubscribe', interested: true,
  });
  check('B-11 an explicit interested:true does NOT override an opt-out',
    forcedOut.json?.outcome === 'suppressed' && (await stageOf(forced.id)) === 'invitees',
    `${await stageOf(forced.id)} / ${JSON.stringify(forcedOut.json)}`);

  // ── B-14 — auto-registrant path 3: content-post comment ───────────────────
  const commenter = await mkContact('prospects');
  await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'content', contact_id: commenter.id });
  const cm = await pub('POST', '/m/comment', {
    contact_id: commenter.id, webinar_key: WKEY, post_ref: 'li_post_123',
    body: 'How do I register for this?',
  });
  check('B-14 an interested comment under a content post moves → auto_registrants',
    (await stageOf(commenter.id)) === 'auto_registrants' && cm.json?.outcome === 'advanced',
    `${await stageOf(commenter.id)} / ${JSON.stringify(cm.json)}`);

  const lurker = await mkContact('prospects');
  await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'content', contact_id: lurker.id });
  const cm2 = await pub('POST', '/m/comment', {
    contact_id: lurker.id, webinar_key: WKEY, post_ref: 'li_post_123', body: 'Nice post 👏',
  });
  check('B-14 a comment with no interest signal registers nobody',
    (await stageOf(lurker.id)) === 'invitees' && cm2.json?.outcome === 'not_interested',
    `${await stageOf(lurker.id)} / ${JSON.stringify(cm2.json)}`);

  // ── B-15 — attendance ─────────────────────────────────────────────────────
  const att = await req('POST', '/api/crm/marketing/attendance', {
    webinar_key: WKEY,
    attended: [{ contact_id: p1.id }, { contact_id: rYes.id }],
  });
  check('B-15 attendance moves registrants → attendees',
    (await stageOf(p1.id)) === 'attendees', await stageOf(p1.id));
  check('B-15 attendance also moves auto_registrants → attendees',
    (await stageOf(rYes.id)) === 'attendees', await stageOf(rYes.id));
  check('B-15 the roster response reports both advances', att.json?.advanced === 2, JSON.stringify(att.json?.advanced));

  // ── B-16 — attended but never registered ──────────────────────────────────
  const gatecrasher = await mkContact('prospects');
  await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'email', contact_id: gatecrasher.id });
  const att2 = await req('POST', '/api/crm/marketing/attendance', {
    webinar_key: WKEY, attended: [{ contact_id: gatecrasher.id }],
  });
  check('B-16 an attendee who never registered is NOT force-walked up the funnel',
    (await stageOf(gatecrasher.id)) === 'invitees', await stageOf(gatecrasher.id));
  check('B-16 …the refusal is surfaced to the operator rather than buried',
    Array.isArray(att2.json?.refused) && att2.json.refused.length === 1 &&
    /Illegal stage transition/i.test(att2.json.refused[0].detail || ''),
    JSON.stringify(att2.json?.refused));

  // ── B-17 — no_show is a label, not a stage ────────────────────────────────
  const noShow = await req('POST', '/api/crm/marketing/attendance', {
    webinar_key: WKEY, no_show: [{ contact_id: gatecrasher.id }],
  });
  check('B-17 a no_show is recorded and moves nobody',
    noShow.json?.results?.[0]?.outcome === 'no_change' &&
    (await stageOf(gatecrasher.id)) === 'invitees',
    `${await stageOf(gatecrasher.id)} / ${JSON.stringify(noShow.json?.results?.[0])}`);

  // ── B-18 — dedupe skips EVERY side-effect ─────────────────────────────────
  const dupContact = await mkContact('prospects');
  await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'email', contact_id: dupContact.id });
  const payload = {
    event_type: 'registration', channel: 'web', contact_id: dupContact.id, webinar_key: WKEY,
    provider: 'landing_page', provider_event_id: 'dup-test-' + RUN,
  };
  const first = await req('POST', '/api/crm/marketing/events', payload);
  // Move them BACK by hand, then replay. If the replay ran its side-effects it
  // would advance them again — which is exactly how a re-delivered webhook
  // re-fires a sequence enrolment at a real prospect.
  await db.query(`UPDATE contacts SET marketing_stage='invitees', deal_stage='invitees' WHERE id=$1`, [dupContact.id]);
  const second = await req('POST', '/api/crm/marketing/events', payload);
  check('B-18 a replayed event reports duplicate:true', second.json?.duplicate === true, JSON.stringify(second.json));
  check('B-18 …and runs ZERO side-effects (the hand-reset stage stays put)',
    (await stageOf(dupContact.id)) === 'invitees', await stageOf(dupContact.id));
  const dupRows = (await db.query(
    `SELECT COUNT(*)::int c FROM crm_marketing_events WHERE company_id=$1 AND dedupe_key=$2`,
    [CO, first.json?.dedupe_key])).rows[0];
  check('B-18 …and exactly one row exists for that dedupe key', dupRows.c === 1, JSON.stringify(dupRows));

  // ── B-19 — ingestion fires sequence enrollment like a human advance ───────
  await templatesDb.upsertTemplate(CO, {
    ref: 'cpb_ref_' + RUN, channel: 'email',
    subject: 'You are registered', body: 'Thanks for registering, see you there.',
  });
  const seq = await seqDb.createSequence({
    companyId: CO, name: 'cpb reg seq ' + RUN,
    pipelineKey: 'webinar_marketing', triggerStage: 'registrants',
  });
  await seqDb.addStep(seq.id, CO, { stepOrder: 1, channel: 'email', templateRef: 'cpb_ref_' + RUN });
  await db.query(`UPDATE sequences SET status='active' WHERE id=$1`, [seq.id]);
  const enrollee = await mkContact('prospects');
  await req('POST', '/api/crm/marketing/invites', { webinar_key: WKEY, channel: 'email', contact_id: enrollee.id });
  const regEnrol = await req('POST', '/api/crm/marketing/events', {
    event_type: 'registration', channel: 'web', contact_id: enrollee.id, webinar_key: WKEY,
  });
  const enrolments = (await db.query(
    'SELECT * FROM enrollments WHERE contact_id=$1 AND sequence_id=$2', [enrollee.id, seq.id])).rows;
  check('B-19 an OBSERVED registration starts the follow-up ladder, exactly as a typed one does',
    enrolments.length === 1, `${enrolments.length} / ${JSON.stringify(regEnrol.json)}`);
  check('B-19 …and the ingest reports the enrolment it caused',
    Array.isArray(regEnrol.json?.sequence_enrollments) && regEnrol.json.sequence_enrollments.length === 1,
    JSON.stringify(regEnrol.json?.sequence_enrollments));

  // ── B-20 — THE INVARIANT: ingestion may not auto-advance a manual stage ────
  // Re-mark `registrants` manual on a tenant-local override and prove the very
  // same ingest that just worked now refuses.
  await db.query(
    `INSERT INTO crm_pipeline_configs (company_id, key, name, is_default, funnel_type, entity_type, stages, automations)
     VALUES ($1,'webinar_marketing','Webinar Marketing (manual registrants)',false,'webinar','contact',$2::jsonb,'[]'::jsonb)`,
    [CO2, JSON.stringify([
      { key: 'prospects', label: 'Prospects', mode: 'manual', transitions: ['invitees'] },
      { key: 'invitees', label: 'Invitees', mode: 'auto', transitions: ['visits', 'registrants'] },
      { key: 'visits', label: 'Visits', mode: 'auto', transitions: ['registrants'] },
      { key: 'registrants', label: 'Registrants', mode: 'manual', transitions: [] },
    ])]
  );
  const w2 = await req('POST', '/api/crm/marketing/webinars',
    { key: 'wb2_' + RUN, name: 'Other tenant webinar', landing_page_url: 'https://example.test/w2' }, CO2);
  const manualTarget = await mkContact('invitees', CO2);
  const refused = await req('POST', '/api/crm/marketing/events', {
    event_type: 'registration', channel: 'web', contact_id: manualTarget.id, webinar_key: w2.json?.webinar?.key,
  }, CO2);
  check('B-20 THE INVARIANT HOLDS: ingestion refuses to auto-advance a MANUAL stage',
    refused.json?.outcome === 'refused' && /manual — only a human may set it/.test(refused.json?.detail || ''),
    JSON.stringify(refused.json));
  check('B-20 …and the contact did not move',
    (await stageOf(manualTarget.id)) === 'invitees', await stageOf(manualTarget.id));

  // ── B-21 — a suppressed contact is not dragged into the pipeline ──────────
  const suppressed = await mkContact();
  await limitsDb.suppress(CO, suppressed.id, null, 'test global suppression');
  const supOut = await req('POST', '/api/crm/marketing/events', {
    event_type: 'registration', channel: 'web', contact_id: suppressed.id, webinar_key: WKEY,
  });
  check('B-21 an all-channel-suppressed contact is refused entry by ingestion',
    supOut.json?.outcome === 'refused' && /suppress/i.test(supOut.json?.detail || ''),
    JSON.stringify(supOut.json));

  // ── B-22 — cross-tenant isolation ─────────────────────────────────────────
  const other = await mkContact('invitees', CO2);
  const cross = await req('POST', '/api/crm/marketing/events', {
    event_type: 'registration', channel: 'web', contact_id: other.id, webinar_key: WKEY,
  }, CO); // tenant CO asking about tenant CO2's contact
  check('B-22 tenant A cannot move tenant B\'s contact — it is simply not resolvable',
    cross.json?.outcome === 'not_attributed', JSON.stringify(cross.json));
  check('B-22 …and tenant B\'s contact is untouched',
    (await stageOf(other.id)) === 'invitees', await stageOf(other.id));

  // ── The funnel view: the visible proof the stages are no longer inert ─────
  const funnel = await req('GET', '/api/crm/marketing/funnel');
  const byKey = Object.fromEntries((funnel.json?.stages || []).map(s => [s.key, s]));
  check('B-23 the funnel view reports every automated stage as DRIVEN by an event type',
    ['invitees', 'visits', 'registrants', 'auto_registrants', 'attendees']
      .every(k => byKey[k] && byKey[k].driven_by.length > 0),
    JSON.stringify(Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.driven_by]))));
  check('B-23 the funnel view shows real, non-zero population above `prospects`',
    (byKey.attendees?.count || 0) >= 2 && (byKey.auto_registrants?.count || 0) >= 1,
    JSON.stringify(Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.count]))));

  console.log('\n─── CP-B marketing ingestion ───');
  results.forEach(r => console.log(r));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  await db.shutdownDatabase();
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(2);
});

// Boot a REAL second server without MARKETING_WEBHOOK_SECRET and probe it.
// A fail-closed claim is only worth what an actual unconfigured process does —
// a comment saying "unset ⇒ 503" is exactly the kind of evidence that has gone
// green over a broken system before.
//
// The child gets a DELIBERATELY CLEAN env rather than an inherited one. A
// developer shell here really does carry a stale `INTERNAL_API_KEYS` that is not
// valid JSON, and auth.js refuses to start on it — which showed up as a bare
// ECONNREFUSED with no clue attached. So: pin the handshake vars, and on failure
// report the child's OWN stderr instead of a connection error.
function bootProbe({ withSecret }) {
  const port = Number(process.env.TEST_PORT || 3101) + 57;
  const key = 'cpb-probe-key';
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: process.env.NODE_ENV || 'test',
    PORT: String(port),
    DATABASE_URL: process.env.DATABASE_URL,
    INTERNAL_API_KEY: key,
    INTERNAL_API_KEYS: JSON.stringify({ [key]: '*' }),
    AUTOMATION_ENV_FILE: '/nonexistent',
    // A real developer ./.env can (and, since MARKETING_WEBHOOK_SECRET was
    // enabled for real, now DOES) carry its own MARKETING_WEBHOOK_SECRET —
    // dotenv.config() would fill that into this "unconfigured" child from the
    // real file otherwise, since it only skips vars ALREADY set, and this
    // probe's whole point is a server that has genuinely never heard of one.
    DOTENV_PATH: '/nonexistent',
    RESEND_API_KEY: '', CLOUDFLARE_AI_TOKEN: '',
  };
  if (withSecret) env.MARKETING_WEBHOOK_SECRET = SECRET;

  const child = spawn(process.execPath, ['server/server.js'], {
    env, cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  return (async () => {
    try {
      let up = false;
      for (let i = 0; i < 60; i++) {
        try {
          const h = await fetch(`http://127.0.0.1:${port}/health`);
          if (h.ok) { up = true; break; }
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 250));
      }
      if (!up) return `child never became healthy on :${port} — ${log.trim().slice(-400) || '(no output)'}`;
      const r = await fetch(`http://127.0.0.1:${port}/m/registration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-marketing-secret': SECRET },
        body: JSON.stringify({ email: 'x@ex.test' }),
      });
      return r.status;
    } catch (e) {
      return `probe failed: ${e.message} — ${log.trim().slice(-400)}`;
    } finally {
      child.kill('SIGKILL');
    }
  })();
}
