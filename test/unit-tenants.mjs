#!/usr/bin/env node
// DenchClaw CRM — unit tests for the tenants model (GOAL A2: real tenant
// entity + resolution, migration 012). No HTTP route calls this directly
// (auth.js's requireAuth middleware consumes it internally), so this talks
// to Postgres directly the same way test/unit-tenancy.mjs does.
//
// Usage: DATABASE_URL=postgres://... node test/unit-tenants.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';

const RUN = process.env.RUN || String(Date.now());

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function main() {
  await db.initDatabase();

  const tantra = await tenantDb.getById('tantra');
  check('migration 012 backfilled the tantra tenant row', tantra?.id === 'tantra', JSON.stringify(tantra));
  check('tantra tenant is active by default', tantra?.status === 'active', tantra?.status);
  check('tantra tenant carries the legacy env-fold ids as aliases',
    Array.isArray(tantra?.aliases) && tantra.aliases.includes('growthclub') && tantra.aliases.includes('dev_company'),
    JSON.stringify(tantra?.aliases));

  check('getBySlug resolves the same row as getById', (await tenantDb.getBySlug('tantra'))?.id === 'tantra', 'expected tantra');

  const resolvedAlias = await tenantDb.resolve('growthclub');
  check('resolve() folds a legacy alias to its canonical tenant',
    resolvedAlias?.id === 'tantra', JSON.stringify(resolvedAlias));

  const resolvedCanonical = await tenantDb.resolve('tantra');
  check('resolve() on the canonical id returns itself',
    resolvedCanonical?.id === 'tantra', JSON.stringify(resolvedCanonical));

  const resolvedUnknown = await tenantDb.resolve(`unprovisioned_${RUN}`);
  check('resolve() on an unprovisioned id returns null (caller falls back to pass-through)',
    resolvedUnknown === null, JSON.stringify(resolvedUnknown));

  const slug = `unit_tenant_${RUN}`;
  const created = await tenantDb.create({ id: slug, name: 'Unit Test Tenant', slug, aliases: [`${slug}_legacy`] });
  check('create() inserts a new tenant row', created?.id === slug, JSON.stringify(created));
  check('resolve() finds a newly created tenant by its own alias',
    (await tenantDb.resolve(`${slug}_legacy`))?.id === slug, 'expected new tenant via alias');

  const listed = await tenantDb.list();
  check('list() includes both the backfilled and newly created tenants',
    listed.some(t => t.id === 'tantra') && listed.some(t => t.id === slug),
    `count=${listed.length}`);

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM unit-tenants test — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
