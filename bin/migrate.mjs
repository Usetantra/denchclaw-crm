#!/usr/bin/env node
// ─── Migration runner ────────────────────────────────────────────────────────
// Until now, migrations were applied by hand and NOTHING recorded which had
// run. Two boxes could silently diverge, and the only way to know what state a
// database was in was to go and look at its columns.
//
//   node bin/migrate.mjs status              # what is applied, what is pending
//   node bin/migrate.mjs up                  # apply everything pending, in order
//   node bin/migrate.mjs up --dry-run        # show what up WOULD do
//   node bin/migrate.mjs baseline            # record existing files as applied
//   node bin/migrate.mjs baseline --through=044_clerk_identity.sql
//
// ── READ THIS BEFORE RUNNING `up` ON AN EXISTING DATABASE ────────────────────
//
// Production already has 002-044 applied by hand, and `migrate.sql` is NOT
// idempotent (four bare CREATE TABLEs). Running `up` against it with no
// bookkeeping would try to re-run everything and fail — or worse, partially
// succeed on the idempotent ones.
//
// So on any database that predates this runner, the FIRST command is
// `baseline`, which records the existing files as applied WITHOUT executing
// them. `up` refuses to touch a non-empty database that has never been
// baselined, rather than guessing.
//
// The app itself still never auto-migrates. This is an operator tool, run
// deliberately — that property was a deliberate design choice and this does not
// change it.
import { readFileSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const dotenv = (await import('dotenv')).default;
dotenv.config({ path: process.env.DOTENV_PATH || path.join(ROOT, '.env') });

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('--')) || 'status';
const flag = (n) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const DRY = argv.includes('--dry-run');
const YES = argv.includes('--yes');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// The base schema counts as migration #1. It lives at the repo root rather
// than in migrations/ (historical), but it is the first thing that must run on
// an empty database, so the runner owns it too — otherwise `up` on a fresh DB
// would be half a job and the operator would still need the README.
const BASE = 'migrate.sql';
const fileBody = (f) => readFileSync(f === BASE ? path.join(ROOT, BASE) : path.join(MIGRATIONS_DIR, f), 'utf8');

// Numeric sort, not lexicographic: "10" must come after "9", and a plain
// .sort() would put 010 before 002 only by luck of zero-padding.
function migrationFiles() {
  const rest = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));
  return [BASE, ...rest];
}

const db = (await import('../server/db/index.js')).default;
await db.initDatabase();

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by  TEXT,
      baselined   BOOLEAN NOT NULL DEFAULT false
    )`);
}

async function applied() {
  const r = await db.query(`SELECT * FROM schema_migrations`);
  return new Map(r.rows.map(x => [x.filename, x]));
}

// "Does this database already have schema?" — if ANY application table exists
// but nothing is recorded, the DB predates this runner and must be baselined
// rather than migrated. An empty database is the only one `up` may build from
// scratch.
//
// Deliberately checks for any of several tables, not just `contacts`: a
// database halfway through a hand-applied sequence still needs the refusal.
async function looksPopulated() {
  const r = await db.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('contacts','tenants','conversations','messages') LIMIT 1`);
  return r.rows.length > 0;
}

async function status() {
  await ensureTable();
  const done = await applied();
  const files = migrationFiles();
  let pending = 0, drifted = 0;
  console.log(`\nmigrations in ${path.relative(ROOT, MIGRATIONS_DIR)}/ — ${files.length} file(s)\n`);
  for (const f of files) {
    const rec = done.get(f);
    const sum = sha(fileBody(f));
    if (!rec) { pending++; console.log(`  PENDING   ${f}`); continue; }
    if (rec.checksum !== sum) {
      drifted++;
      console.log(`  CHANGED   ${f}  — applied ${rec.applied_at.toISOString().slice(0, 10)}, but the file has been EDITED since`);
    } else {
      console.log(`  applied   ${f}${rec.baselined ? '  (baselined)' : ''}`);
    }
  }
  console.log(`\n${files.length - pending} applied, ${pending} pending${drifted ? `, ${drifted} CHANGED AFTER APPLYING` : ''}`);
  if (drifted) {
    console.log('\nA changed file means the database no longer matches the migration that');
    console.log('produced it. Never "fix" this by editing the checksum — write a NEW migration.');
  }
  if (pending && !(await looksPopulated())) console.log('\nThis database is empty — `up` will build it from scratch, starting with migrate.sql.');
  else if (pending) console.log('\nRun: node bin/migrate.mjs up --dry-run');
  return drifted ? 1 : 0;
}

async function baseline() {
  await ensureTable();
  const done = await applied();
  const through = flag('through');
  const files = migrationFiles();
  const cut = through ? files.indexOf(through) : files.length - 1;
  if (through && cut === -1) { console.error(`FATAL: no such migration: ${through}`); return 2; }
  const target = files.slice(0, cut + 1).filter(f => !done.has(f));
  if (!target.length) { console.log('nothing to baseline — every file up to the cutoff is already recorded'); return 0; }

  console.log(`\nThis will RECORD ${target.length} migration(s) as applied WITHOUT RUNNING THEM:\n`);
  for (const f of target) console.log(`  ${f}`);
  console.log('\nOnly correct if this database already has that schema (i.e. they were applied by hand).');
  if (DRY) { console.log('\n[dry-run] nothing written'); return 0; }
  if (!YES) { console.log('\nRe-run with --yes to confirm.'); return 0; }

  for (const f of target) {
    await db.query(
      `INSERT INTO schema_migrations (filename, checksum, applied_by, baselined) VALUES ($1,$2,$3,true)
       ON CONFLICT (filename) DO NOTHING`,
      [f, sha(fileBody(f)), process.env.USER || 'baseline']
    );
  }
  console.log(`\nbaselined ${target.length} migration(s). \`status\` should now show them applied.`);
  return 0;
}

async function up() {
  await ensureTable();
  const done = await applied();
  const files = migrationFiles();
  const pending = files.filter(f => !done.has(f));

  if (!pending.length) { console.log('nothing pending — the database is up to date'); return 0; }

  // The guard that stops this from wrecking production on its first run.
  if (done.size === 0 && await looksPopulated()) {
    console.error('\nREFUSING: this database already has application tables but no migration');
    console.error('records, so it predates this runner. Re-running these files could fail');
    console.error('halfway or corrupt state.\n');
    console.error('If the schema is already up to date, record it without executing:');
    console.error('  node bin/migrate.mjs baseline --yes\n');
    return 2;
  }

  console.log(`\n${pending.length} pending migration(s):\n`);
  for (const f of pending) console.log(`  ${f}`);
  if (DRY) { console.log('\n[dry-run] nothing applied'); return 0; }

  for (const f of pending) {
    const sql = fileBody(f);
    process.stdout.write(`\napplying ${f} ... `);
    // Each migration is its own transaction. Most files already contain
    // BEGIN/COMMIT; Postgres treats the inner pair as a no-op inside an open
    // transaction, so wrapping is safe and makes a file that FORGOT them
    // atomic too. A failure rolls back that migration alone — earlier ones stay
    // applied and recorded, so a re-run resumes rather than restarting.
    try {
      await db.query('BEGIN');
      await db.query(sql);
      await db.query(
        `INSERT INTO schema_migrations (filename, checksum, applied_by) VALUES ($1,$2,$3)`,
        [f, sha(sql), process.env.USER || 'migrate']
      );
      await db.query('COMMIT');
      console.log('ok');
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch {}
      console.log('FAILED');
      console.error(`\n${f} failed and was rolled back:\n  ${e.message}\n`);
      console.error('Nothing after it was attempted. Fix the migration and re-run `up`.');
      return 1;
    }
  }
  console.log('\nall pending migrations applied');
  return 0;
}

let code = 0;
try {
  if (cmd === 'status') code = await status();
  else if (cmd === 'up') code = await up();
  else if (cmd === 'baseline') code = await baseline();
  else { console.error(`unknown command: ${cmd}\nuse: status | up | baseline`); code = 2; }
} finally {
  await db.closePool?.();
}
process.exit(code);
