#!/usr/bin/env node
// DenchClaw CRM — unit-level tenancy tests for model/helper functions that have
// no HTTP route of their own (so test/contract.mjs, which only speaks HTTP,
// can't reach them). Talks to Postgres directly via DATABASE_URL.
//
// Covers A1: findContactByPhone (crm.js) must never do an unscoped cross-tenant
// scan, and contacts.getById must never silently fall back to an unscoped read.
//
// Usage: DATABASE_URL=postgres://... node test/unit-tenancy.mjs

import db from '../server/db/index.js';
import contactDb from '../server/db/models/contacts.js';
import crmRouterModule from '../server/routes/crm.js';

const RUN = process.env.RUN || String(Date.now());
const CO_A = 'unit_co_a_' + RUN;
const CO_B = 'unit_co_b_' + RUN;

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

  const contactA = await contactDb.create({
    name: 'Unit Test A', email: `unit-a-${RUN}@example.com`,
    phone: `+1555${RUN}0001`, company_id: CO_A,
  });
  const contactB = await contactDb.create({
    name: 'Unit Test B', email: `unit-b-${RUN}@example.com`,
    phone: `+1555${RUN}0002`, company_id: CO_B,
  });

  // ── getById: no silent unscoped fallback ──────────────────────────────────
  check('getById(id) with no companyId throws (no unscoped fallback)',
    await throws(() => contactDb.getById(contactA.id, undefined)), 'expected a throw');
  check('getById(id) with null companyId throws (no unscoped fallback)',
    await throws(() => contactDb.getById(contactA.id, null)), 'expected a throw');
  check('getById cross-tenant id returns null (not the other tenant\'s row)',
    (await contactDb.getById(contactA.id, CO_B)) === null, 'expected null');
  check('getById same-tenant id returns the row',
    (await contactDb.getById(contactA.id, CO_A))?.id === contactA.id, 'expected contactA');

  // ── findContactByPhone: must be scoped, never a cross-tenant scan ─────────
  const findContactByPhone = crmRouterModule.findContactByPhone;
  check('findContactByPhone with no companyId returns null (not a global scan)',
    (await findContactByPhone(contactA.phone, undefined)) === null, 'expected null');
  check('findContactByPhone cannot find another tenant\'s contact by phone',
    (await findContactByPhone(contactB.phone, CO_A)) === null, 'expected null (cross-tenant)');
  check('findContactByPhone finds the contact within its own tenant',
    (await findContactByPhone(contactA.phone, CO_A))?.id === contactA.id, 'expected contactA');

  // ── list/listPaginated/update/addActivity/getActivity: mandatory companyId ─
  check('list() with no companyId throws (no unscoped scan)',
    await throws(() => contactDb.list(undefined, {})), 'expected a throw');
  check('list() only returns the caller\'s tenant rows',
    (await contactDb.list(CO_A, {})).every(c => c.company_id === CO_A), 'expected only CO_A rows');
  check('listPaginated() with no companyId throws (no unscoped scan)',
    await throws(() => contactDb.listPaginated(undefined, {})), 'expected a throw');
  check('update() with no companyId throws (no unscoped write)',
    await throws(() => contactDb.update(contactA.id, { name: 'x' }, undefined)), 'expected a throw');
  check('update() cannot write another tenant\'s row',
    (await contactDb.update(contactA.id, { name: 'hijacked' }, CO_B)) === null, 'expected null (cross-tenant)');
  check('addActivity() with no companyId throws (no unscoped write)',
    await throws(() => contactDb.addActivity(contactA.id, { type: 'note', message: 'x' }, undefined)), 'expected a throw');
  check('addActivity() cannot write to another tenant\'s contact',
    (await contactDb.addActivity(contactA.id, { type: 'note', message: 'x' }, CO_B)) === false, 'expected false (cross-tenant)');
  check('getActivity() with no companyId throws (no unscoped read)',
    await throws(() => contactDb.getActivity(contactA.id, 50, undefined)), 'expected a throw');

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM unit-tenancy test — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
