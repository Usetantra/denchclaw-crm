#!/usr/bin/env node
// DenchClaw CRM — apply migrate.sql + migrations/0*.sql to a LOCAL scratch DB.
//
// WHY THIS EXISTS. `test/run-local.sh` applied the schema with `psql`, and a
// machine without psql installed could not run the suite at all — which meant
// the 19 suites every verdict rests on were runnable only through an
// uncommitted local mirror, on one machine, by hand. A green number nobody else
// can reproduce is a claim, not a result.
//
// `pg` is already a dependency, so no psql and no new package: the driver's
// simple query protocol runs a multi-statement file exactly as psql would.
//
// THE STAGING GUARD IS NOT RELAXED HERE, and it is deliberately duplicated
// rather than trusted from the caller. This file can be run directly, and the
// one thing it must never do is apply DDL to something that is not a local
// scratch database.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const { Client } = require('pg');

const url = process.env.DATABASE_URL_TEST;
if (!url) {
  console.error('FATAL: DATABASE_URL_TEST is required');
  process.exit(2);
}
// Same rule, same wording as run-local.sh's own check. A URL that merely
// CONTAINS 'localhost' somewhere (a password, a database name) is not enough —
// the HOST has to be local, so it is parsed rather than pattern-matched.
let host;
try {
  host = new URL(url).hostname;
} catch {
  console.error('FATAL: DATABASE_URL_TEST is not a parseable URL. Refusing.');
  process.exit(2);
}
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`FATAL: DATABASE_URL_TEST must be a local scratch DB (host is '${host}'). Refusing.`);
  process.exit(2);
}

const root = new URL('..', import.meta.url).pathname;
const files = [
  'migrate.sql',
  ...readdirSync(`${root}migrations`).filter(f => /^0.*\.sql$/.test(f)).sort().map(f => `migrations/${f}`),
];

const client = new Client({ connectionString: url });
await client.connect();
for (const f of files) {
  process.stdout.write(`[schema]   ${f}\n`);
  try {
    await client.query(readFileSync(`${root}${f}`, 'utf8'));
  } catch (err) {
    console.error(`FATAL: ${f} failed to apply: ${err.message}`);
    await client.end();
    process.exit(1);
  }
}
await client.end();
console.log(`[schema] applied ${files.length} files`);
