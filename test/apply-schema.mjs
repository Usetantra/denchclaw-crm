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
//
// CP-AB made that guard matter far more than it did. `migrate.sql` is NOT
// idempotent — four bare `CREATE TABLE`, none with IF NOT EXISTS — which never
// showed because the Docker path spins up a fresh container every run. Once
// DATABASE_URL_TEST became the path everyone without Docker uses, and that
// database PERSISTS, a contributor's first `npm test` was green and their second
// was `relation "contacts" already exists`. They would conclude the suite is
// broken rather than that it needs a manual dropdb.
//
// So this file now RESETS the schema before applying. That is a destructive
// statement, and it is placed AFTER the host check with nothing between them —
// the guard exits the process, so the reset is unreachable for a non-local URL
// rather than merely unlikely to run against one.
//
// The alternative — sprinkling IF NOT EXISTS through migrate.sql — was rejected
// deliberately. It would let a PARTIALLY applied schema pass silently as
// complete, which is a worse failure than a loud one, and migrate.sql is the
// production base schema rather than a test fixture.
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

// Everything below this line runs only for a verified-local host.
const root = new URL('..', import.meta.url).pathname;
const files = [
  'migrate.sql',
  ...readdirSync(`${root}migrations`).filter(f => /^0.*\.sql$/.test(f)).sort().map(f => `migrations/${f}`),
];

const client = new Client({ connectionString: url });
await client.connect();

// The reset. Re-guarded against the SERVER the connection actually reached,
// not only against the string that was parsed — a hosts-file entry or a tunnel
// can make 'localhost' resolve somewhere else entirely, and this is the one
// statement where being wrong is unrecoverable.
// `host()` rather than a bare ::text cast — inet_server_addr() is an inet, so
// casting yields '127.0.0.1/32' and a naive string compare rejects the local
// server it was meant to allow. (It did exactly that on the first run, which is
// the good direction for a guard to fail in, but it still has to be right.)
const who = await client.query(
  'SELECT current_database() AS db, host(inet_server_addr()) AS addr');
const addr = who.rows[0].addr;
// A unix-socket connection reports NULL, which is local by construction.
if (addr !== null && !['127.0.0.1', '::1'].includes(addr)) {
  console.error(`FATAL: connected to a NON-LOCAL server (${addr}) despite a local-looking URL. Refusing to reset.`);
  await client.end();
  process.exit(2);
}
process.stdout.write(`[schema] resetting public schema on '${who.rows[0].db}' (${addr || 'unix socket'})\n`);
await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

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
