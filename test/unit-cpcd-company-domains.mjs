#!/usr/bin/env node
// DenchClaw CRM — CP-CD: self-serve custom domain connection.
// A tenant's own domain is registered in OUR Resend account on their behalf
// (server/lib/resend-domains-client.js), and we hand back the DNS records for
// them to paste into their own DNS provider — we never touch tenant DNS.
//
// NO REAL RESEND CALL IS EVER MADE (same rule as unit-cp4a-executor documents
// for the sender side): layer 1 exercises the client against a local stub;
// layer 2 exercises the DAL directly against the real test DB; layer 3
// exercises the settings.js routes' validation paths that never need a
// network call — including the "RESEND_API_KEY unset" 503, which is true by
// construction here since test/run-local.sh boots the shared test server
// with RESEND_API_KEY="".
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpcd-company-domains.mjs

import http from 'node:http';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import companyDomainsDb from '../server/db/models/company-domains.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpcd_co_' + RUN;
const CO2 = 'cpcd_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body, company = CO) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// ─── stub Resend domains API ────────────────────────────────────────────────
const domainSeq = { n: 0 };
const stubDb = new Map(); // resend_domain_id -> domain record
const stub = { requests: [] };
const stubServer = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', c => chunks.push(c));
  request.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString();
    let body = null; try { body = bodyStr ? JSON.parse(bodyStr) : null; } catch {}
    stub.requests.push({ method: request.method, url: request.url, body, headers: request.headers });

    if (request.headers['authorization'] !== 'Bearer stub-resend-key') {
      response.writeHead(401, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ message: 'Invalid API key' }));
    }

    const m = request.url.match(/^\/domains\/([^/]+)(\/verify)?$/);
    if (request.method === 'POST' && request.url === '/domains') {
      if (body && body.name === 'taken-upstream.test') {
        response.writeHead(409, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ message: 'Domain already exists' }));
      }
      const id = 'stub-domain-' + (++domainSeq.n);
      const rec = {
        id, name: body.name, created_at: new Date().toISOString(), status: 'not_started',
        region: body.region || 'us-east-1', capabilities: { sending: 'enabled', receiving: 'disabled' },
        records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', ttl: 'Auto', status: 'pending', value: 'p=stubkey' }],
      };
      stubDb.set(id, rec);
      response.writeHead(201, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(rec));
    }
    if (m && request.method === 'GET') {
      const rec = stubDb.get(m[1]);
      if (!rec) { response.writeHead(404, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ message: 'not found' })); }
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(rec));
    }
    if (m && m[2] === '/verify' && request.method === 'POST') {
      const rec = stubDb.get(m[1]);
      if (!rec) { response.writeHead(404, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ message: 'not found' })); }
      rec.status = 'verified';
      rec.records = rec.records.map(r => ({ ...r, status: 'verified' }));
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ object: 'domain', id: rec.id }));
    }
    if (m && request.method === 'PATCH') {
      const rec = stubDb.get(m[1]);
      if (!rec) { response.writeHead(404, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ message: 'not found' })); }
      if (body && body.capabilities && body.capabilities.receiving) rec.capabilities.receiving = body.capabilities.receiving;
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ object: 'domain', id: rec.id }));
    }
    if (m && request.method === 'DELETE') {
      const existed = stubDb.delete(m[1]);
      response.writeHead(existed ? 200 : 404, { 'content-type': 'application/json' });
      return response.end(JSON.stringify(existed ? { object: 'domain', id: m[1], deleted: true } : { message: 'not found' }));
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'no stub route' }));
  });
});

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });
  await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
  process.env.RESEND_API_BASE = `http://127.0.0.1:${stubServer.address().port}`;

  // ── layer 1: the Resend domains client against the stub ─────────────────
  const client = await import('../server/lib/resend-domains-client.js');
  const created = await client.createDomain('stub-resend-key', { name: `layer1-${RUN}.test` });
  check('client.createDomain returns a domain with records', created.id && Array.isArray(created.records), JSON.stringify(created));

  const fetched = await client.getDomain('stub-resend-key', created.id);
  check('client.getDomain round-trips the same domain', fetched.name === `layer1-${RUN}.test`, JSON.stringify(fetched));

  await client.verifyDomain('stub-resend-key', created.id);
  const afterVerify = await client.getDomain('stub-resend-key', created.id);
  check('client.verifyDomain + a re-fetch shows verified', afterVerify.status === 'verified', JSON.stringify(afterVerify));

  await client.updateDomain('stub-resend-key', created.id, { receiving: true });
  const afterUpdate = await client.getDomain('stub-resend-key', created.id);
  check('client.updateDomain(receiving:true) flips the capability', afterUpdate.capabilities.receiving === 'enabled', JSON.stringify(afterUpdate));

  await client.deleteDomain('stub-resend-key', created.id);
  let deletedErr = null;
  try { await client.getDomain('stub-resend-key', created.id); } catch (e) { deletedErr = e; }
  check('client.deleteDomain actually removes it (subsequent get 404s)', !!deletedErr && deletedErr.status === 404, String(deletedErr));

  let authErr = null;
  try { await client.getDomain('wrong-key', 'whatever'); } catch (e) { authErr = e; }
  check('a wrong API key is refused (401)', !!authErr && authErr.status === 401, String(authErr));

  // ── layer 2: the DAL against the real test DB ────────────────────────────
  const d1 = await companyDomainsDb.create(CO, { domain: `dal-${RUN}.test`, resendDomainId: 'rd-1', region: 'us-east-1', status: 'pending', records: [{ record: 'DKIM' }] });
  check('DAL.create stores a domain row', d1.domain === `dal-${RUN}.test` && d1.status === 'pending', JSON.stringify(d1));

  const byDomain = await companyDomainsDb.getByDomain(`DAL-${RUN}.TEST`); // case-insensitive
  check('DAL.getByDomain is case-insensitive', byDomain && byDomain.id === d1.id, JSON.stringify(byDomain));

  const listed = await companyDomainsDb.list(CO);
  check('DAL.list returns it for its own company', listed.some(x => x.id === d1.id), JSON.stringify(listed));
  const listedOther = await companyDomainsDb.list(CO2);
  check('...and NOT for another company', !listedOther.some(x => x.id === d1.id), JSON.stringify(listedOther));

  const updated = await companyDomainsDb.updateFromResend(CO, d1.id, { status: 'verified', records: [{ record: 'DKIM', status: 'verified' }], receivingEnabled: true });
  check('DAL.updateFromResend applies status/records/receiving', updated.status === 'verified' && updated.receiving_enabled === true, JSON.stringify(updated));

  const removed = await companyDomainsDb.remove(CO, d1.id);
  check('DAL.remove deletes the row', !!removed, JSON.stringify(removed));
  check('...and it is really gone', (await companyDomainsDb.get(CO, d1.id)) === null, 'still present');

  // ── layer 3: settings.js routes — validation paths, no network needed ───
  const noAuth = await fetch(`${BASE}/api/crm/settings/domains`);
  check('GET domains without auth is refused', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));

  const empty = await req('GET', '/api/crm/settings/domains');
  check('GET domains starts empty for a fresh tenant', empty.status === 200 && Array.isArray(empty.json.domains) && empty.json.domains.length === 0, JSON.stringify(empty.json));

  // The shared test server boots with RESEND_API_KEY="" (test/run-local.sh) —
  // so POST here proves the fail-closed 503, same posture as inbound email.
  const notConfigured = await req('POST', '/api/crm/settings/domains', { domain: 'whatever.test' });
  check('POST domains without RESEND_API_KEY configured fails closed (503)', notConfigured.status === 503, JSON.stringify(notConfigured.json));

  const badFormat = await req('POST', '/api/crm/settings/domains', { domain: 'not a domain' });
  check('POST domains with an invalid domain format is refused', badFormat.status === 400 || badFormat.status === 503, JSON.stringify(badFormat.json));
  // (400 if key were configured; 503 here since it isn't — either way, never 201.)

  const missingDomain = await req('POST', '/api/crm/settings/domains', {});
  check('POST domains with no domain field at all never succeeds', missingDomain.status !== 201, JSON.stringify(missingDomain.json));

  const verifyMissing = await req('POST', '/api/crm/settings/domains/00000000-0000-0000-0000-000000000000/verify');
  check('POST verify on an unknown id is refused (404 or 503, never a crash)', [404, 503].includes(verifyMissing.status), JSON.stringify(verifyMissing.json));

  const patchMissing = await req('PATCH', '/api/crm/settings/domains/00000000-0000-0000-0000-000000000000', { receiving: true });
  check('PATCH on an unknown id is refused (404 or 503)', [404, 503].includes(patchMissing.status), JSON.stringify(patchMissing.json));

  const deleteMissing = await req('DELETE', '/api/crm/settings/domains/00000000-0000-0000-0000-000000000000');
  check('DELETE on an unknown id is refused (404 or 503)', [404, 503].includes(deleteMissing.status), JSON.stringify(deleteMissing.json));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  stubServer.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
