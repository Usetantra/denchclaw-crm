#!/usr/bin/env node
// ─── Re-encrypt stored provider credentials under a new key ──────────────────
// Setting CREDENTIALS_KEY on a database that ALREADY holds credentials is the
// exact thing that breaks them. Until it is set, server/lib/crypto-box.js
// derives a key from INTERNAL_API_KEY via scrypt; the moment CREDENTIALS_KEY
// appears, every existing row was encrypted under a key nothing will use again.
//
// And the failure is silent: server/db/models/channels.js swallows the decrypt
// error, so the channel still reports "connected" while every send fails with a
// config error and nothing in the log says why.
//
// So this script exists to make "set CREDENTIALS_KEY" a safe operation:
//
//   node bin/rekey-credentials.mjs --new=<64-hex> --dry-run   # prove it works
//   node bin/rekey-credentials.mjs --new=<64-hex>             # then do it
//
// By default the OLD key is the derived one (what you have now, if
// CREDENTIALS_KEY was never set). Rotating an already-explicit key:
//
//   node bin/rekey-credentials.mjs --old=<64-hex> --new=<64-hex>
//
// AFTER a successful run, put the new value in .env as CREDENTIALS_KEY and
// restart. The script deliberately does NOT edit .env: a half-applied re-key
// where the file changed but the rows did not is the worst possible outcome,
// so the write stays a separate, deliberate act.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotenv = (await import('dotenv')).default;
dotenv.config({ path: process.env.DOTENV_PATH || path.join(ROOT, '.env') });

const argv = process.argv.slice(2);
const arg = (n) => { const h = argv.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const DRY = argv.includes('--dry-run');

const hexKey = (h) => Buffer.from(h, 'hex');
const derivedKey = (seed) => crypto.scryptSync(seed || 'denchclaw-dev-fallback', 'denchclaw-cred-salt', 32);

// Mirrors crypto-box.js exactly. Duplicated on purpose rather than imported:
// that module reads process.env at call time and can only ever hold ONE key,
// and this script needs two at once.
function decryptWith(k, blob) {
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad ciphertext format');
  const [, iv, tag, ct] = parts;
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function encryptWith(k, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

const newHex = arg('new');
if (!newHex || !/^[0-9a-fA-F]{64}$/.test(newHex)) {
  console.error('FATAL: --new=<64 hex chars> is required. Generate one with: openssl rand -hex 32');
  process.exit(2);
}
const oldHex = arg('old');
if (oldHex && !/^[0-9a-fA-F]{64}$/.test(oldHex)) {
  console.error('FATAL: --old must also be 64 hex chars.');
  process.exit(2);
}
if (oldHex && oldHex.toLowerCase() === newHex.toLowerCase()) {
  console.error('FATAL: --old and --new are the same key. Nothing to do.');
  process.exit(2);
}

const OLD = oldHex ? hexKey(oldHex) : derivedKey(process.env.INTERNAL_API_KEY);
const NEW = hexKey(newHex);

if (!oldHex && process.env.CREDENTIALS_KEY) {
  console.error('FATAL: CREDENTIALS_KEY is already set in the environment, so the current');
  console.error('       ciphertext is NOT under the derived key. Pass the current value as');
  console.error('       --old=<64-hex> to rotate it explicitly.');
  process.exit(2);
}

const db = (await import('../server/db/index.js')).default;
await db.initDatabase();

// Every table holding crypto-box ciphertext. If a future migration adds
// another, add it here — a missed table is a silently-broken integration.
const TARGETS = [
  { table: 'channel_connections', col: 'credentials_enc', label: r => `${r.company_id}/${r.provider}` },
];

let total = 0, done = 0, failed = 0;
try {
  for (const t of TARGETS) {
    const exists = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [t.table]);
    if (!exists.rows.length) { console.log(`- ${t.table}: table not present, skipping`); continue; }

    const rows = (await db.query(
      `SELECT * FROM ${t.table} WHERE ${t.col} IS NOT NULL ORDER BY created_at`)).rows;
    console.log(`\n${t.table}: ${rows.length} row(s) with ciphertext`);
    total += rows.length;

    for (const row of rows) {
      const label = t.label(row);
      let plain;
      try {
        plain = decryptWith(OLD, row[t.col]);
      } catch (e) {
        // Already under a different key, or corrupt. Never guess — re-encrypting
        // garbage would destroy the only copy.
        failed++;
        console.log(`  SKIP ${label}: cannot decrypt with the old key (${e.message}). Left untouched.`);
        continue;
      }
      const reblob = encryptWith(NEW, plain);
      // Round-trip before writing. A row that cannot be read back under the new
      // key must never replace one that is currently readable.
      if (decryptWith(NEW, reblob) !== plain) {
        failed++;
        console.log(`  FAIL ${label}: round-trip verification failed. Left untouched.`);
        continue;
      }
      if (DRY) { console.log(`  would re-key ${label} (${plain.length} bytes of secret)`); done++; continue; }
      await db.query(`UPDATE ${t.table} SET ${t.col} = $1, updated_at = now() WHERE id = $2`, [reblob, row.id]);
      console.log(`  ok   ${label}`);
      done++;
    }
  }
} finally {
  await db.closePool?.();
}

console.log(`\n${DRY ? '[dry-run] ' : ''}${done}/${total} re-keyed, ${failed} skipped/failed`);
if (failed) {
  console.log('\nRows that could not be decrypted were LEFT AS THEY WERE. Investigate before');
  console.log('setting CREDENTIALS_KEY — if they are stale test rows, delete them; if they are');
  console.log('real, whatever key encrypted them is the one you need.');
}
if (!DRY && done) {
  console.log('\nNEXT — and not before this script succeeded:');
  console.log(`  1. set CREDENTIALS_KEY=${newHex} in the environment`);
  console.log('  2. restart the service');
  console.log('  3. node bin/preflight.mjs   # confirms the key is set and well-formed');
  console.log('\nUntil step 1, the app still reads the OLD key and every row above will fail');
  console.log('to decrypt. The window between this script and the restart is the risky one:');
  console.log('keep it short, and do it when nothing is sending.');
}
process.exit(failed && !done ? 1 : 0);
