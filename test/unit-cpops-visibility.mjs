#!/usr/bin/env node
// DenchClaw CRM — CP-OPS: operational visibility (migration 043).
//
// The product is fail-closed everywhere and its executors are cron-driven rather
// than daemons, which produces one failure mode: THE SERVICE LOOKS HEALTHY AND
// DOES NOTHING. On a fresh deployment that is the *expected* state, because
// nobody has installed the cron yet.
//
// So the assertion that matters most is OPS-1: a tenant that has never ticked
// reports `never_ran` rather than anything that could be mistaken for health.
// Everything else exists to keep that signal trustworthy — a blocked tick still
// counts as a heartbeat (the scheduler IS alive), and a due backlog with no
// reader is called out explicitly.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpops-visibility.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import opsDb from '../server/db/models/ops.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpops_co_' + RUN;
const CO2 = 'cpops_other_' + RUN;
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

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ══ 1. The day-one state ══════════════════════════════════════════════════
  const fresh = await req('GET', '/api/crm/ops/health');
  check('OPS-1 a tenant that has never ticked reports never_ran, not "healthy"',
    fresh.status === 200 && fresh.json.engine.status === 'never_ran', JSON.stringify(fresh.json?.engine));
  check('OPS-2 ...and every channel is listed as never having run',
    (fresh.json.channels || []).length >= 4 && fresh.json.channels.every(c => c.ever_ticked === false),
    JSON.stringify((fresh.json.channels || []).map(c => c.channel)));
  check('OPS-3 ...and the report names the staleness threshold it is judging against',
    typeof fresh.json.engine.stale_after_minutes === 'number', JSON.stringify(fresh.json?.engine));

  // ══ 2. A tick is a heartbeat, even a blocked one ══════════════════════════
  // Sending is off by default, so almost every early tick is blocked. Treating
  // that as "not running" would make the alarm cry wolf on every new tenant and
  // it would be ignored by the time it mattered.
  await opsDb.recordTick(CO, 'email', { ok: false, blocked: 'email executor disabled', sent: 0, failed: 0 });
  const blocked = await req('GET', '/api/crm/ops/health');
  const em = blocked.json.channels.find(c => c.channel === 'email');
  check('OPS-4 a BLOCKED tick still counts as a heartbeat', em.ever_ticked === true, JSON.stringify(em));
  check('OPS-5 ...and the engine now reads as running', blocked.json.engine.status === 'running', JSON.stringify(blocked.json.engine));
  check('OPS-6 ...while the block itself is reported, not hidden',
    em.blocked_reason === 'email executor disabled', JSON.stringify(em.blocked_reason));
  check('OPS-7 ...and last_ok_at stays empty, so "blocked" is distinguishable from "working"',
    em.last_ok_at === null, JSON.stringify(em.last_ok_at));

  await opsDb.recordTick(CO, 'email', { ok: true, sent: 3, failed: 1 });
  const worked = await req('GET', '/api/crm/ops/health');
  const em2 = worked.json.channels.find(c => c.channel === 'email');
  check('OPS-8 a successful tick sets last_ok_at and clears the block',
    !!em2.last_ok_at && em2.blocked_reason === null, JSON.stringify(em2));
  check('OPS-9 ...and counters accumulate across ticks',
    em2.sent_total === 3 && em2.failed_total === 1, JSON.stringify({ s: em2.sent_total, f: em2.failed_total }));

  // A later block must not erase the record of when it last worked.
  await opsDb.recordTick(CO, 'email', { ok: false, blocked: 'no connected sender' });
  const reblocked = await req('GET', '/api/crm/ops/health');
  const em3 = reblocked.json.channels.find(c => c.channel === 'email');
  check('OPS-10 a later block does not erase when the channel last worked',
    !!em3.last_ok_at && em3.blocked_reason === 'no connected sender', JSON.stringify(em3));

  // ══ 3. Staleness ══════════════════════════════════════════════════════════
  await db.query(
    `UPDATE ops_channel_state SET last_tick_at = now() - interval '10 days' WHERE company_id=$1`, [CO]);
  const stale = await req('GET', '/api/crm/ops/health');
  check('OPS-11 an engine that stopped reports stale, distinct from never_ran',
    stale.json.engine.status === 'stale', JSON.stringify(stale.json.engine));

  // ══ 4. The backlog signal ═════════════════════════════════════════════════
  // A queue is only alarming when something is supposed to be draining it, and
  // only jobs that are actually DUE count — a ladder legitimately holds work
  // scheduled for next week.
  const contact = await contactDb.create({ company_id: CO, name: 'Q', email: `q-${RUN}@ex.test` });
  const seq = await req('POST', '/api/crm/sequences', { name: `ops-${RUN}`, trigger_tag: `ops-${RUN}` });
  // Two steps, because scheduled_actions is uniquely indexed on
  // (enrollment, step) — that index is the dedupe stopping a re-enrolled
  // contact being messaged twice, so a fixture must respect it rather than
  // stack two jobs on one step.
  const step = await req('POST', `/api/crm/sequences/${seq.json.id}/steps`,
    { step_order: 1, channel: 'email', subject: 's', body: 'b', delay_seconds: 0 });
  const step2 = await req('POST', `/api/crm/sequences/${seq.json.id}/steps`,
    { step_order: 2, channel: 'email', subject: 's2', body: 'b2', delay_seconds: 0 });
  const step3 = await req('POST', `/api/crm/sequences/${seq.json.id}/steps`,
    { step_order: 3, channel: 'email', subject: 's3', body: 'b3', delay_seconds: 0 });
  const enr = await db.query(
    `INSERT INTO enrollments (company_id, sequence_id, contact_id, status) VALUES ($1,$2,$3,'active') RETURNING id`,
    [CO, seq.json.id, contact.id]);
  await db.query(
    `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, scheduled_for, status)
     VALUES ($1,$2,$3,$4,'email', now() - interval '1 hour', 'pending')`,
    [CO, enr.rows[0].id, step.json.id, contact.id]);
  await db.query(
    `INSERT INTO scheduled_actions (company_id, enrollment_id, step_id, contact_id, channel, scheduled_for, status)
     VALUES ($1,$2,$3,$4,'email', now() + interval '7 days', 'pending')`,
    [CO, enr.rows[0].id, step2.json.id, contact.id]);

  const backlog = await req('GET', '/api/crm/ops/health');
  const bem = backlog.json.channels.find(c => c.channel === 'email');
  check('OPS-12 the queue counts pending work', bem.pending === 2, JSON.stringify(bem.pending));
  check('OPS-13 ...but only OVERDUE work counts as due',
    bem.due === 1, JSON.stringify({ due: bem.due, pending: bem.pending }));
  check('OPS-14 a due backlog with a stopped engine is flagged as stuck',
    backlog.json.backlog_stuck === true, JSON.stringify(backlog.json.backlog_stuck));

  await db.query(`UPDATE ops_channel_state SET last_tick_at=now() WHERE company_id=$1`, [CO]);
  const healthy = await req('GET', '/api/crm/ops/health');
  check('OPS-15 ...and NOT flagged once the engine is running again',
    healthy.json.backlog_stuck === false, JSON.stringify(healthy.json.backlog_stuck));

  // ══ 5. Stuck sends ════════════════════════════════════════════════════════
  await db.query(
    `INSERT INTO scheduled_actions
       (company_id, enrollment_id, step_id, contact_id, channel, scheduled_for, status,
        send_started_at, outcome_unknown_at, outcome_unknown_reason)
     VALUES ($1,$2,$3,$4,'email', now(), 'claimed', now(), now(), 'provider timed out')`,
    [CO, enr.rows[0].id, step3.json.id, contact.id]);
  const quar = await req('GET', '/api/crm/ops/quarantine');
  check('OPS-16 stuck sends are listed across channels in one place',
    quar.json.total === 1 && quar.json.quarantined[0].outcome_unknown_reason === 'provider timed out',
    JSON.stringify(quar.json).slice(0, 200));
  check('OPS-17 ...and carry the contact, so the operator knows who is affected',
    quar.json.quarantined[0].contact_email === `q-${RUN}@ex.test`, JSON.stringify(quar.json.quarantined[0]?.contact_email));
  const withQuar = await req('GET', '/api/crm/ops/health');
  check('OPS-18 ...and are counted on the channel row',
    withQuar.json.channels.find(c => c.channel === 'email').quarantined === 1, 'quarantine count');

  // ══ 6. Integrations ═══════════════════════════════════════════════════════
  await db.query(
    `INSERT INTO channel_connections (company_id, provider, account_ref, status, last_error)
     VALUES ($1,'twilio','AC123','connected',NULL)`, [CO]);
  await db.query(
    `INSERT INTO channel_connections (company_id, provider, account_ref, status, last_error)
     VALUES ($1,'webinargeek','acct','error','key rejected')`, [CO]);
  const ints = await req('GET', '/api/crm/ops/health');
  const tw = ints.json.integrations.find(i => i.provider === 'twilio');
  const wg = ints.json.integrations.find(i => i.provider === 'webinargeek');
  check('OPS-19 a healthy integration reads healthy', tw && tw.healthy === true, JSON.stringify(tw));
  check('OPS-20 a broken one reports its error rather than just "connected"',
    wg && wg.healthy === false && wg.last_error === 'key rejected', JSON.stringify(wg));

  // ══ 7. Tenancy ════════════════════════════════════════════════════════════
  const other = await req('GET', '/api/crm/ops/health', undefined, CO2);
  check('OPS-21 another tenant sees its own engine state, not this one\'s',
    other.json.engine.status === 'never_ran' && other.json.totals.due === 0, JSON.stringify(other.json.engine));
  check('OPS-22 ...and none of this tenant\'s stuck sends',
    (await req('GET', '/api/crm/ops/quarantine', undefined, CO2)).json.total === 0, 'cross-tenant quarantine leak');
  const noAuth = await fetch(`${BASE}/api/crm/ops/health`);
  check('OPS-23 the ops surface requires auth', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));

  // ══ 8. Fleet ══════════════════════════════════════════════════════════════
  const fleet = await req('GET', '/api/crm/ops/fleet');
  const mine = (fleet.json.tenants || []).find(t => t.company_id === CO);
  const theirs = (fleet.json.tenants || []).find(t => t.company_id === CO2);
  check('OPS-24 the fleet view lists every tenant, including ones that never ran',
    !!mine && !!theirs, JSON.stringify({ mine: !!mine, theirs: !!theirs }));
  check('OPS-25 ...with per-tenant status, so a silent tenant is visible without being chosen',
    mine.status === 'running' && theirs.status === 'never_ran',
    JSON.stringify({ mine: mine?.status, theirs: theirs?.status }));

  // ══ 9. Recording must never break the thing it observes ═══════════════════
  let threw = false;
  try { await opsDb.recordTick('no-such-tenant-' + RUN, 'email', { ok: true, sent: 1 }); }
  catch { threw = true; }
  check('OPS-26 a failure to record health never throws into the send batch',
    threw === false, 'recordTick threw');

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
