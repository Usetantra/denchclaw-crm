#!/usr/bin/env node
// DenchClaw CRM — CP-TOOL: the operator tooling in bin/.
//
// These scripts were verified by running them against real databases, which is
// how you find out they work once. Nothing stopped them regressing afterwards —
// and two of them can destroy data:
//
//   bin/migrate.mjs           can execute DDL against a production database
//   bin/rekey-credentials.mjs rewrites the only copy of every stored secret
//
// So the assertions that matter most here are the REFUSALS. A migration runner
// that applies migrations is ordinary; one that refuses to re-run migrate.sql
// against a populated database is the difference between a tool and an
// incident. Most of this file tests that the guards hold, not that the happy
// path works.
//
// Each test gets its own throwaway database, because these scripts legitimately
// create and drop schema — sharing the suite's database would be a bad idea in
// exactly the way this suite exists to catch.
//
// Usage: DATABASE_URL=... node test/unit-cptool-tooling.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = (process.env.RUN || String(Date.now())).replace(/\W/g, '');
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('FATAL: DATABASE_URL env required'); process.exit(2); }
const BASE_URL = DB_URL.slice(0, DB_URL.lastIndexOf('/'));

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

// Runs a bin/ script and returns {code, out}. Never throws on a non-zero exit —
// the exit code IS the assertion in most of these tests.
//
// DOTENV_PATH is pointed at an empty file so the child does NOT read the
// developer's real .env. Without this the tests are not hermetic: a local
// CREDENTIALS_KEY makes the re-key tests exercise a refusal path instead of the
// happy path, and local *_EXECUTOR_ENABLED flags change which channels tick.
// Found the hard way — four tests failed for reasons that had nothing to do
// with the code under test.
const EMPTY_ENV_FILE = path.join(ROOT, 'test', '.empty-env');
async function run(script, args = [], env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, DOTENV_PATH: EMPTY_ENV_FILE, CREDENTIALS_KEY: '', ...env },
      timeout: 120000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

const admin = () => new pg.Client({ connectionString: `${BASE_URL}/postgres` });
const scratchNames = [];
async function makeDb(tag) {
  const name = `cptool_${tag}_${RUN}`.slice(0, 60).toLowerCase();
  const c = admin(); await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name}`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  scratchNames.push(name);
  return `${BASE_URL}/${name}`;
}
async function dropDbs() {
  const c = admin(); await c.connect();
  for (const n of scratchNames) { try { await c.query(`DROP DATABASE IF EXISTS ${n}`); } catch {} }
  await c.end();
}
async function q(url, sql, params) {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

async function main() {
  // ── bin/migrate.mjs ───────────────────────────────────────────────────────

  // M-1 — THE guard. A database with application tables but no migration
  // records predates the runner (this is production's exact state). Re-running
  // migrate.sql there would fail partway, and migrate.sql is not idempotent.
  const popDb = await makeDb('populated');
  await q(popDb, `CREATE TABLE contacts (id int)`); // enough to look "populated"
  let r = await run('bin/migrate.mjs', ['up'], { DATABASE_URL: popDb });
  check('M-1 `up` REFUSES on a populated database with no migration records',
    r.code === 2 && /REFUSING/.test(r.out), `exit ${r.code}`);
  check('M-1b ...and says how to fix it rather than just failing',
    /baseline/.test(r.out), r.out.slice(0, 200));

  // It does create its own (empty) schema_migrations bookkeeping table before
  // deciding to refuse, which is harmless and idempotent. What matters is that
  // it touched no APPLICATION schema and recorded nothing.
  const stub = await q(popDb, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='contacts'`);
  const recs = await q(popDb, `SELECT count(*)::int AS n FROM schema_migrations`);
  check('M-1c ...having applied no migration and touched no application table',
    stub.rows[0].n === 1 && recs.rows[0].n === 0,
    `contacts cols=${stub.rows[0].n}, migration rows=${recs.rows[0].n}`);

  // M-2 — baseline records without executing. If it EXECUTED, the bogus
  // one-column contacts table above would be replaced by the real schema.
  r = await run('bin/migrate.mjs', ['baseline', '--yes'], { DATABASE_URL: popDb });
  check('M-2 `baseline --yes` records the migrations', r.code === 0 && /baselined/.test(r.out), r.out.slice(-200));
  const cols = await q(popDb, `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='contacts'`);
  check('M-2b ...WITHOUT executing them (the stub table is untouched)',
    cols.rows[0].n === 1, `contacts has ${cols.rows[0].n} columns — baseline executed SQL it should not have`);
  const recorded = await q(popDb, `SELECT count(*)::int AS n, bool_and(baselined) AS all_flagged FROM schema_migrations`);
  check('M-2c ...and flags them as baselined, not as applied',
    recorded.rows[0].n > 40 && recorded.rows[0].all_flagged === true, JSON.stringify(recorded.rows[0]));

  r = await run('bin/migrate.mjs', ['status'], { DATABASE_URL: popDb });
  check('M-3 `status` then reports nothing pending', /0 pending/.test(r.out), r.out.slice(-160));

  // M-4 — a genuinely empty database is the ONLY one `up` may build from
  // scratch, and it must include migrate.sql as migration #1.
  const freshDb = await makeDb('fresh');
  r = await run('bin/migrate.mjs', ['up'], { DATABASE_URL: freshDb });
  check('M-4 `up` builds an empty database from scratch', r.code === 0 && /all pending migrations applied/.test(r.out), r.out.slice(-300));
  const built = await q(freshDb, `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`);
  check('M-4b ...producing the real schema', built.rows[0].n > 40, `${built.rows[0].n} tables`);
  const clerkCol = await q(freshDb, `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='clerk_user_id'`);
  check('M-4c ...including the newest migration (044)', clerkCol.rows.length === 1, 'clerk_user_id missing');

  r = await run('bin/migrate.mjs', ['up'], { DATABASE_URL: freshDb });
  check('M-5 `up` is a no-op the second time', r.code === 0 && /nothing pending/.test(r.out), r.out.slice(-160));

  // M-6 — a migration edited after it was applied means the database no longer
  // matches the file that produced it. Silence here would let two boxes drift
  // apart while both reported "applied".
  await q(freshDb, `UPDATE schema_migrations SET checksum = 'deadbeefdeadbeef' WHERE filename = '044_clerk_identity.sql'`);
  r = await run('bin/migrate.mjs', ['status'], { DATABASE_URL: freshDb });
  check('M-6 a migration edited after applying is reported as CHANGED',
    r.code === 1 && /CHANGED/.test(r.out), `exit ${r.code}`);
  check('M-6b ...and says to write a new migration rather than edit the checksum',
    /never .*edit|write a NEW migration/i.test(r.out), 'no guidance given');

  // M-7 — the production path: baseline only what was hand-applied, then `up`
  // genuinely runs the rest.
  const partialDb = await makeDb('partial');
  await q(partialDb, `CREATE TABLE contacts (id int)`);
  r = await run('bin/migrate.mjs', ['baseline', '--through=002_prospect_inbox.sql', '--yes'], { DATABASE_URL: partialDb });
  const partialCount = await q(partialDb, `SELECT count(*)::int AS n FROM schema_migrations`);
  check('M-7 `baseline --through=` stops at the named migration',
    r.code === 0 && partialCount.rows[0].n === 2, `${partialCount.rows[0].n} recorded (expected 2: migrate.sql + 002)`);

  // M-8 — baseline must not write without explicit confirmation.
  const confirmDb = await makeDb('confirm');
  await q(confirmDb, `CREATE TABLE contacts (id int)`);
  r = await run('bin/migrate.mjs', ['baseline'], { DATABASE_URL: confirmDb });
  const unconfirmed = await q(confirmDb, `SELECT count(*)::int AS n FROM schema_migrations`);
  check('M-8 `baseline` without --yes writes nothing',
    unconfirmed.rows[0].n === 0 && /--yes/.test(r.out), `${unconfirmed.rows[0].n} rows written`);

  // ── bin/rekey-credentials.mjs ─────────────────────────────────────────────
  // This one rewrites the only copy of every stored secret, so every test here
  // is about not losing plaintext.
  const OLD_SEED = 'cptool-old-seed-' + RUN;
  const NEW_KEY = crypto.randomBytes(32).toString('hex');
  const derived = crypto.scryptSync(OLD_SEED, 'denchclaw-cred-salt', 32);
  const SECRET = { account_sid: 'AC' + '0'.repeat(32), auth_token: 'tok-' + RUN };

  function encWith(key, plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }
  function decWith(key, blob) {
    const [, iv, tag, ct] = String(blob).split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
  }

  // A fully-built database so channel_connections exists.
  const credDb = freshDb;
  await q(credDb, `INSERT INTO tenants (id,name,slug,status,plan) VALUES ('cptool_t','T','cptool_t','active','standard') ON CONFLICT DO NOTHING`);
  await q(credDb, `INSERT INTO channel_connections (company_id, provider, credentials_enc, status)
                   VALUES ('cptool_t','twilio',$1,'connected')`, [encWith(derived, SECRET)]);

  r = await run('bin/rekey-credentials.mjs', [], { DATABASE_URL: credDb, INTERNAL_API_KEY: OLD_SEED });
  check('R-1 refuses without --new', r.code === 2 && /--new/.test(r.out), `exit ${r.code}`);

  r = await run('bin/rekey-credentials.mjs', [`--new=${NEW_KEY}`, `--old=${NEW_KEY}`], { DATABASE_URL: credDb, INTERNAL_API_KEY: OLD_SEED });
  check('R-2 refuses when the old and new keys are identical', r.code === 2, `exit ${r.code}`);

  // The most dangerous mistake: CREDENTIALS_KEY is already set, so the stored
  // ciphertext is NOT under the derived key — re-keying from the derived key
  // would fail to decrypt everything.
  r = await run('bin/rekey-credentials.mjs', [`--new=${NEW_KEY}`], {
    DATABASE_URL: credDb, INTERNAL_API_KEY: OLD_SEED, CREDENTIALS_KEY: crypto.randomBytes(32).toString('hex'),
  });
  check('R-3 refuses to assume the derived key when CREDENTIALS_KEY is already set',
    r.code === 2 && /--old/.test(r.out), `exit ${r.code}`);

  r = await run('bin/rekey-credentials.mjs', [`--new=${NEW_KEY}`, '--dry-run'], { DATABASE_URL: credDb, INTERNAL_API_KEY: OLD_SEED });
  const afterDry = await q(credDb, `SELECT credentials_enc FROM channel_connections WHERE company_id='cptool_t'`);
  let stillOld = false;
  try { stillOld = decWith(derived, afterDry.rows[0].credentials_enc).auth_token === SECRET.auth_token; } catch {}
  check('R-4 --dry-run reports success but writes nothing', r.code === 0 && stillOld, 'dry run mutated the row');

  r = await run('bin/rekey-credentials.mjs', [`--new=${NEW_KEY}`], { DATABASE_URL: credDb, INTERNAL_API_KEY: OLD_SEED });
  const afterReal = await q(credDb, `SELECT credentials_enc FROM channel_connections WHERE company_id='cptool_t'`);
  let underNew = null;
  try { underNew = decWith(Buffer.from(NEW_KEY, 'hex'), afterReal.rows[0].credentials_enc); } catch (e) { underNew = { err: e.message }; }
  check('R-5 the real run re-encrypts under the new key with the plaintext INTACT',
    r.code === 0 && underNew?.auth_token === SECRET.auth_token && underNew?.account_sid === SECRET.account_sid,
    JSON.stringify(underNew));

  let oldFails = false;
  try { decWith(derived, afterReal.rows[0].credentials_enc); } catch { oldFails = true; }
  check('R-5b ...and the old key no longer decrypts it', oldFails, 'old key still works — nothing was re-keyed');

  // A row under an unknown key must be LEFT ALONE. Re-encrypting garbage would
  // destroy the only copy of whatever it really was.
  const alienKey = crypto.randomBytes(32);
  await q(credDb, `INSERT INTO channel_connections (company_id, provider, credentials_enc, status)
                   VALUES ('cptool_t','unipile',$1,'connected')`, [encWith(alienKey, { k: 'alien' })]);
  const NEWER = crypto.randomBytes(32).toString('hex');
  r = await run('bin/rekey-credentials.mjs', [`--old=${NEW_KEY}`, `--new=${NEWER}`], { DATABASE_URL: credDb, INTERNAL_API_KEY: OLD_SEED });
  const alienRow = await q(credDb, `SELECT credentials_enc FROM channel_connections WHERE provider='unipile'`);
  let alienIntact = false;
  try { alienIntact = decWith(alienKey, alienRow.rows[0].credentials_enc).k === 'alien'; } catch {}
  check('R-6 a row it cannot decrypt is left untouched, not garbled', alienIntact, 'the undecryptable row was overwritten');
  check('R-6b ...and it says so rather than reporting success', /SKIP|skipped/.test(r.out), r.out.slice(-200));

  // ── bin/tick.mjs ──────────────────────────────────────────────────────────
  // The empty-flag bug: `--channels=` must mean NO channels, not "unset, so use
  // all of them". Getting this wrong made the Tantra-only cron entry silently
  // tick every send channel too.
  r = await run('bin/tick.mjs', ['--tenant=cptool_t', '--channels=', '--dry-run'],
    { DATABASE_URL: credDb, INTERNAL_API_KEY: 'x', EMAIL_EXECUTOR_ENABLED: '1' });
  check('T-1 `--channels=` means NO channels, not all of them',
    /\[no channels\]/.test(r.out) && !/executors\/email\/tick/.test(r.out), r.out.slice(-200));

  r = await run('bin/tick.mjs', ['--tenant=cptool_t', '--dry-run'],
    { DATABASE_URL: credDb, INTERNAL_API_KEY: 'x', EMAIL_EXECUTOR_ENABLED: '1' });
  check('T-2 with no flag it uses the ENABLED channels only',
    /executors\/email\/tick/.test(r.out) && !/executors\/sms\/tick/.test(r.out), r.out.slice(-260));
  check('T-3 --dry-run performs no writes', /would POST/.test(r.out) && !/ok +cptool_t/.test(r.out), 'dry run appears to have acted');

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
}

main()
  .then(async () => { await dropDbs(); process.exit(fail ? 1 : 0); })
  .catch(async (e) => { console.error('FATAL', e); await dropDbs().catch(() => {}); process.exit(2); });
