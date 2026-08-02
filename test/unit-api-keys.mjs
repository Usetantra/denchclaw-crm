#!/usr/bin/env node
// DenchClaw CRM — unit tests for the per-tenant API keys model (GOAL A3).
// No HTTP route exercises resolveKey directly (it's consumed by
// server/middleware/auth.js on every request) — this talks to Postgres
// directly the same way the other unit-*.mjs scripts do.
//
// Usage: DATABASE_URL=postgres://... node test/unit-api-keys.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import apiKeysDb from '../server/db/models/apiKeys.js';

const RUN = process.env.RUN || String(Date.now());
const CO_A = 'ak_co_a_' + RUN;
const CO_B = 'ak_co_b_' + RUN;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO_A, name: CO_A, slug: CO_A });
  await tenantDb.create({ id: CO_B, name: CO_B, slug: CO_B });

  check('createKey requires companyId', await throws(() => apiKeysDb.createKey(undefined)), 'expected a throw');
  check('createKey under an unprovisioned tenant is rejected by the DB (FK)',
    await throws(() => apiKeysDb.createKey(`unprovisioned_${RUN}`)), 'expected a foreign key violation');

  const created = await apiKeysDb.createKey(CO_A, 'test key');
  check('createKey returns a plaintext key with the expected prefix', created?.key?.startsWith('dc_live_'), created?.key);
  check('createKey returns the tenant it belongs to', created?.company_id === CO_A, created?.company_id);

  const resolved = await apiKeysDb.resolveKey(created.key);
  check('resolveKey with the real key returns the correct company_id', resolved === CO_A, resolved);
  const resolvedGarbage = await apiKeysDb.resolveKey('dc_live_not_a_real_key');
  check('resolveKey with an unknown key returns null', resolvedGarbage === null, resolvedGarbage);
  const resolvedEmpty = await apiKeysDb.resolveKey('');
  check('resolveKey with an empty string returns null (not a query against an empty hash)', resolvedEmpty === null, resolvedEmpty);

  const listed = await apiKeysDb.listKeys(CO_A);
  check('listKeys returns the key', listed.some(k => k.id === created.id), JSON.stringify(listed));
  check('listKeys never exposes key_hash or the plaintext key', listed.every(k => !('key_hash' in k) && !('key' in k)), JSON.stringify(listed));
  check('listKeys exposes only the key_prefix, not the full key', listed.find(k => k.id === created.id)?.key_prefix === created.key.slice(0, 12), JSON.stringify(listed));
  check('listKeys cross-tenant does not see it', !(await apiKeysDb.listKeys(CO_B)).some(k => k.id === created.id), 'expected not present');

  check('revokeKey cannot revoke another tenant\'s key', (await apiKeysDb.revokeKey(CO_B, created.id)) === null, 'expected null — key belongs to CO_A');
  check('resolveKey still works before revocation', (await apiKeysDb.resolveKey(created.key)) === CO_A, 'expected CO_A');

  const revoked = await apiKeysDb.revokeKey(CO_A, created.id);
  check('revokeKey succeeds for the owning tenant', revoked?.id === created.id && !!revoked.revoked_at, JSON.stringify(revoked));
  const resolvedAfterRevoke = await apiKeysDb.resolveKey(created.key);
  check('resolveKey no longer resolves a revoked key', resolvedAfterRevoke === null, resolvedAfterRevoke);
  const revokedAgain = await apiKeysDb.revokeKey(CO_A, created.id);
  check('revoking an already-revoked key is a no-op (null), not an error', revokedAgain === null, JSON.stringify(revokedAgain));

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM unit-api-keys test — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
