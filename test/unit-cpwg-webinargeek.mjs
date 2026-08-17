#!/usr/bin/env node
// DenchClaw CRM — CP-WG: WebinarGeek connector.
// WebinarGeek's API (webinargeek.docs.apiary.io) is pull-only — no webhooks
// exist anywhere in their spec (confirmed by grepping the full downloaded
// blueprint) — so this is an API-key connection + on-demand sync, not an
// inbound route. Three layers tested separately:
//   1. server/lib/webinargeek-client.js against a local stub (NO real
//      provider is ever contacted — same rule test/unit-cp4a-executor.mjs
//      documents for Resend).
//   2. server/lib/webinargeek-sync-engine.js directly against the real test
//      DB with fake subscription objects — the actual find-or-create /
//      activity / dedupe logic, with zero network involved.
//   3. The settings.js HTTP routes, for the parts that don't require a live
//      WebinarGeek account (validation, connection state, "not connected"
//      guards).
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpwg-webinargeek.mjs

import http from 'node:http';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpwg_co_' + RUN;
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
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// ─── stub WebinarGeek API ───────────────────────────────────────────────────
const stub = { mode: 'ok', requests: [], port: 0 };
const stubServer = http.createServer((request, response) => {
  stub.requests.push({ path: request.url, headers: request.headers });
  const token = request.headers['api-token'];
  if (stub.mode === 'bad_key' || token !== 'good-key') {
    response.writeHead(401, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ code: 'unauthorized', message: 'Invalid API token' }));
  }
  if (request.url === '/account') {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ company: 'Stub Co', email: 'stub@ex.test' }));
  }
  if (request.url.startsWith('/broadcasts')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({
      total_count: 1,
      broadcasts: [{ id: 42, date: 1700000000, has_ended: true, subscriptions_count: 2, webinar: { title: 'Stub Webinar' } }],
      pages: { next: null, page: 1, per_page: 100, total_pages: 1 },
    }));
  }
  if (request.url.startsWith('/subscriptions')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({
      total_count: 1,
      subscriptions: [{ id: 1, email: 'stub-sub@ex.test', firstname: 'Stub', surname: 'Subscriber', watched: false }],
      pages: { next: null, page: 1, per_page: 200, total_pages: 1 },
    }));
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: 'not_found', message: 'no stub route' }));
});

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
  stub.port = stubServer.address().port;
  process.env.WEBINARGEEK_API_BASE = `http://127.0.0.1:${stub.port}`;

  // ── layer 1: the client against the stub ────────────────────────────────
  const client = await import('../server/lib/webinargeek-client.js');
  const account = await client.getAccount('good-key');
  check('client.getAccount returns the stub account', account.company === 'Stub Co', JSON.stringify(account));

  let clientErr = null;
  try { await client.getAccount('wrong-key'); } catch (e) { clientErr = e; }
  check('client.getAccount throws on a rejected key', !!clientErr && /Invalid API token/.test(clientErr.message), String(clientErr));

  const broadcasts = await client.listBroadcasts('good-key');
  check('client.listBroadcasts returns the stub broadcast', broadcasts.broadcasts?.[0]?.id === 42, JSON.stringify(broadcasts));

  const subs = await client.listSubscriptions('good-key', { broadcastId: 42 });
  check('client.listSubscriptions returns the stub subscriber', subs.subscriptions?.[0]?.email === 'stub-sub@ex.test', JSON.stringify(subs));

  // ── layer 2: the sync engine against the real DB, fake data ─────────────
  const engine = await import('../server/lib/webinargeek-sync-engine.js');
  const syncDb = await import('../server/db/models/webinargeek-sync.js');
  const crmRouter = await import('../server/routes/crm.js');
  const deps = {
    findOrCreateContact: crmRouter.default.findOrCreateContact,
    addContactActivity: crmRouter.default.addContactActivity,
    getState: syncDb.getState,
    upsertState: syncDb.upsertState,
  };

  const email1 = `wg1-${RUN}@ex.test`;
  const r1 = await engine.processSubscriptions(CO, [
    { id: 1001, email: email1, firstname: 'Wanda', surname: 'Geek', company: 'Acme', watched: false },
  ], deps);
  check('E1 first sync of a not-yet-watched subscriber: 1 seen, 1 new contact, 0 attendances', r1.seen === 1 && r1.newContacts === 1 && r1.newAttendances === 0, JSON.stringify(r1));

  const c1 = await contactDb.getByEmail(email1, CO);
  check('...the contact was created with source webinargeek and tagged', !!c1 && c1.source === 'webinargeek' && (c1.tags || []).includes('webinargeek'), JSON.stringify(c1));
  const activity1 = await contactDb.getActivity(c1.id, 10, CO);
  check('...and a "registered" activity was logged, no "webinar_attended" yet', activity1.some(a => a.type === 'registered') && !activity1.some(a => a.type === 'webinar_attended'), JSON.stringify(activity1));

  // Re-sync with the SAME (still unwatched) data — must not duplicate anything.
  const r2 = await engine.processSubscriptions(CO, [
    { id: 1001, email: email1, firstname: 'Wanda', surname: 'Geek', watched: false },
  ], deps);
  check('E2 an idempotent re-sync (unchanged watched state) logs 0 new contacts, 0 new attendances', r2.newContacts === 0 && r2.newAttendances === 0, JSON.stringify(r2));
  const activity2 = await contactDb.getActivity(c1.id, 10, CO);
  check('...no duplicate "registered" activity was added', activity2.filter(a => a.type === 'registered').length === 1, JSON.stringify(activity2));

  // Now the SAME subscription flips to watched=true — this is the one case a
  // repeat sync should still log something.
  const r3 = await engine.processSubscriptions(CO, [
    { id: 1001, email: email1, firstname: 'Wanda', surname: 'Geek', watched: true, watch_duration: 1800 },
  ], deps);
  check('E3 the same subscriber flipping to watched logs exactly 1 new attendance', r3.newAttendances === 1 && r3.newContacts === 0, JSON.stringify(r3));
  const activity3 = await contactDb.getActivity(c1.id, 10, CO);
  check('...and "webinar_attended" now appears exactly once', activity3.filter(a => a.type === 'webinar_attended').length === 1, JSON.stringify(activity3));

  // Re-sync again with watched=true, unchanged — still no duplicate.
  const r4 = await engine.processSubscriptions(CO, [
    { id: 1001, email: email1, firstname: 'Wanda', surname: 'Geek', watched: true, watch_duration: 1800 },
  ], deps);
  check('E4 a further re-sync with watched unchanged adds nothing new', r4.newAttendances === 0 && r4.newContacts === 0, JSON.stringify(r4));

  // A subscriber who registered AND already watched on their first sync gets both.
  const email2 = `wg2-${RUN}@ex.test`;
  const r5 = await engine.processSubscriptions(CO, [
    { id: 1002, email: email2, firstname: 'Already', surname: 'Watched', watched: true, watch_duration: 900 },
  ], deps);
  check('E5 a first-seen subscriber who already watched gets both registered + attended', r5.newContacts === 1 && r5.newAttendances === 1, JSON.stringify(r5));

  // A subscription with no email is skipped, not crashed on.
  const r6 = await engine.processSubscriptions(CO, [{ id: 1003, email: null, watched: false }], deps);
  check('E6 a subscription with no email is skipped without error', r6.seen === 1 && r6.newContacts === 0, JSON.stringify(r6));

  // ── layer 3: settings.js HTTP routes, no live account required ──────────
  const noAuth = await fetch(`${BASE}/api/crm/settings/webinargeek`);
  check('GET webinargeek without auth is refused', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));

  const status1 = await req('GET', '/api/crm/settings/webinargeek');
  check('GET webinargeek defaults to disconnected', status1.status === 200 && status1.json.connection.connected === false, JSON.stringify(status1.json));

  const missingKey = await req('POST', '/api/crm/settings/webinargeek/connect', {});
  check('POST connect with no api_key is refused with 400', missingKey.status === 400, JSON.stringify(missingKey.json));

  const broadcastsNotConnected = await req('GET', '/api/crm/settings/webinargeek/broadcasts');
  check('GET broadcasts while not connected is refused with 400', broadcastsNotConnected.status === 400, JSON.stringify(broadcastsNotConnected.json));

  const syncNotConnected = await req('POST', '/api/crm/settings/webinargeek/sync', { broadcast_id: 42 });
  check('POST sync while not connected is refused with 400', syncNotConnected.status === 400, JSON.stringify(syncNotConnected.json));

  const syncNoBroadcast = await req('POST', '/api/crm/settings/webinargeek/sync', {});
  check('POST sync with no broadcast_id is refused with 400', syncNoBroadcast.status === 400, JSON.stringify(syncNoBroadcast.json));

  const disconnectIdempotent = await req('DELETE', '/api/crm/settings/webinargeek');
  check('DELETE webinargeek is a no-op (200) even when never connected', disconnectIdempotent.status === 200, JSON.stringify(disconnectIdempotent.json));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  stubServer.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
