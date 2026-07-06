#!/usr/bin/env node
// DenchClaw CRM — A3 verification: the ADMIN HTTP routes (server/routes/
// api-keys.js) and, critically, that a freshly-issued DB-backed key actually
// authenticates real requests end-to-end via server/middleware/auth.js's new
// resolution path — with NO X-Company-Id header at all, since a per-tenant
// key IS the tenant identity.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-a3-api-key-auth.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import { requireAuth } from '../server/middleware/auth.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const ADMIN_KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'a3_co_' + RUN;

if (!ADMIN_KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, { key = ADMIN_KEY, company, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (key !== null) h['x-internal-key'] = key;
  if (company !== undefined) h['x-company-id'] = company;
  const r = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  // ── admin gating ──────────────────────────────────────────────────────────
  const unauthed = await req('POST', '/api/crm/api-keys', { key: null, body: { company_id: CO } });
  check('POST /api-keys with no key is 401', unauthed.status === 401, JSON.stringify(unauthed.json));
  const garbageKey = await req('POST', '/api/crm/api-keys', { key: 'not-a-real-key-' + RUN, body: { company_id: CO } });
  check('POST /api-keys with an unrecognized key is 401', garbageKey.status === 401, JSON.stringify(garbageKey.json));

  // ── issue a key ───────────────────────────────────────────────────────────
  const created = await req('POST', '/api/crm/api-keys', { body: { company_id: CO, label: 'ci test key' } });
  check('POST /api-keys (admin) creates a key, returning the plaintext once', created.status === 201 && created.json?.key?.startsWith('dc_live_'), JSON.stringify(created.json));
  const rawKey = created.json?.key;

  const unknownTenant = await req('POST', '/api/crm/api-keys', { body: { company_id: 'unprovisioned_' + RUN } });
  check('POST /api-keys for an unprovisioned tenant is 404', unknownTenant.status === 404, JSON.stringify(unknownTenant.json));

  const list = await req('GET', `/api/crm/api-keys?company_id=${CO}`);
  check('GET /api-keys lists it', list.status === 200 && list.json?.keys?.some(k => k.id === created.json.id), JSON.stringify(list.json));
  check('GET /api-keys never returns the plaintext key or its hash', !JSON.stringify(list.json).includes(rawKey) && !('key_hash' in (list.json.keys?.[0] || {})), JSON.stringify(list.json));

  // ── THE critical proof: the new key authenticates a real request with NO
  // X-Company-Id header at all — the key itself resolves the tenant. ─────────
  const contactViaNewKey = await req('POST', '/api/crm/contacts', {
    key: rawKey, body: { name: 'A3 Test Contact', email: `a3-${RUN}@example.com`, source: 'manual' },
  });
  check('a fresh DB-backed key authenticates a real request with NO X-Company-Id header', contactViaNewKey.status === 201, JSON.stringify(contactViaNewKey.json));
  check('...and the contact lands under the RIGHT tenant (the key\'s own), not some default', contactViaNewKey.json?.company_id === CO, JSON.stringify(contactViaNewKey.json));

  // A DB-backed key ignores X-Company-Id even if one is (wrongly) sent —
  // the key IS the tenant identity, not the header.
  const ignoresHeader = await req('POST', '/api/crm/contacts', {
    key: rawKey, company: 'some_other_company_' + RUN,
    body: { name: 'A3 Test Contact 2', email: `a3-2-${RUN}@example.com`, source: 'manual' },
  });
  check('a DB-backed key ignores a mismatched X-Company-Id header (the key wins)', ignoresHeader.json?.company_id === CO, JSON.stringify(ignoresHeader.json));

  // ── revoke ────────────────────────────────────────────────────────────────
  const revoke = await req('DELETE', `/api/crm/api-keys/${created.json.id}`, { body: { company_id: CO } });
  check('DELETE /api-keys/:id revokes it', revoke.status === 200 && !!revoke.json?.revoked_at, JSON.stringify(revoke.json));
  const afterRevoke = await req('GET', '/api/crm/contacts', { key: rawKey });
  check('the revoked key no longer authenticates (falls through to 401, not silently still-valid)', afterRevoke.status === 401, JSON.stringify(afterRevoke.json));

  const revokeAgain = await req('DELETE', `/api/crm/api-keys/${created.json.id}`, { body: { company_id: CO } });
  check('revoking an already-revoked key returns 404, not a silent 200', revokeAgain.status === 404, JSON.stringify(revokeAgain.json));

  // ── input validation ──────────────────────────────────────────────────────
  const listUnprovisioned = await req('GET', `/api/crm/api-keys?company_id=unprovisioned_${RUN}`);
  check('GET /api-keys for an unprovisioned tenant is 404, not an empty 200', listUnprovisioned.status === 404, JSON.stringify(listUnprovisioned.json));
  const deleteMalformedId = await req('DELETE', '/api/crm/api-keys/not-a-uuid', { body: { company_id: CO } });
  check('DELETE /api-keys/:id with a malformed id is 400, not a raw DB cast error (500)', deleteMalformedId.status === 400, JSON.stringify(deleteMalformedId.json));

  // ── collision guard: a key string valid in BOTH tenant_api_keys AND the
  // env-configured INTERNAL_API_KEYS must be refused outright, not silently
  // resolved via either side. This can only happen via a raw/manual DB
  // insert (createKey() always generates its own random value) — simulating
  // that operator-error scenario directly here. ────────────────────────────
  const collidingKeyString = ADMIN_KEY; // ADMIN_KEY is already a '*'-bound env key (run-local.sh)
  const { createHash } = await import('node:crypto');
  const collisionHash = createHash('sha256').update(collidingKeyString).digest('hex');
  await db.query(
    `INSERT INTO tenant_api_keys (company_id, key_hash, key_prefix, label) VALUES ($1,$2,$3,$4)`,
    [CO, collisionHash, collidingKeyString.slice(0, 12), 'collision-test']
  );
  const collidedReq = await fetch(`${BASE}/api/crm/api-keys?company_id=${CO}`, { headers: { 'x-internal-key': collidingKeyString } });
  check('a key valid in BOTH systems is refused (401), not silently resolved via either side',
    collidedReq.status === 401, `status=${collidedReq.status}`);
  await db.query(`DELETE FROM tenant_api_keys WHERE key_hash = $1`, [collisionHash]); // clean up so it doesn't affect other tests reusing ADMIN_KEY

  // ── DB-error-during-collision-check fail-closed guard ─────────────────────
  // If apiKeysDb.resolveKey() throws (DB blip), the collision check above
  // can't prove this key ISN'T also DB-backed — the fix refuses ANY
  // env-bound key (wildcard or narrow) outright in that window rather than
  // silently trusting the env side. Narrow keys are refused too, not just
  // wildcard ones: a narrow env key's granted tenant comes from the
  // caller-supplied X-Company-Id header, independent of whatever tenant a
  // colliding DB key was actually issued for — an attacker could pick any
  // tenant in that key's narrow set via the header, which is cross-tenant
  // confusion, not merely reduced privilege (an earlier, narrower version of
  // this fix wrongly assumed narrow keys were safe; they aren't). Exercised
  // directly here (not via HTTP — this test process's OWN db singleton is
  // shut down to force the exact error path; the separately-running HTTP
  // server under test is unaffected). This is the LAST use of `db` in this
  // file — nothing after this needs it.
  await db.shutdownDatabase();
  let dbErrorCollisionStatus = null;
  const fakeReq = { headers: { 'x-internal-key': ADMIN_KEY }, ip: '127.0.0.1', socket: {} };
  const fakeRes = { status(code) { dbErrorCollisionStatus = code; return this; }, json() { return this; } };
  await new Promise((resolve) => {
    requireAuth(fakeReq, fakeRes, () => { dbErrorCollisionStatus = 'called-next'; resolve(); });
    // requireAuth's internal .catch() always resolves this promise chain
    // asynchronously; poll briefly since we have no other completion signal
    // for the non-next() (401) path.
    setTimeout(resolve, 500);
  });
  check('an env-bound key (this one happens to be wildcard) is refused (401) when the DB collision-check itself errors (fail-closed, not fail-open)',
    dbErrorCollisionStatus === 401, `result=${dbErrorCollisionStatus}`);

  console.log(`\nDenchClaw CRM A3 API key auth-flow verification — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
