#!/usr/bin/env node
// ─── The crank ───────────────────────────────────────────────────────────────
// Nothing in this service sends anything on its own. The executors are
// deliberately NOT daemons — "one tick = one batch, driven by cron or an
// operator" (server/routes/executors.js) — which means that until something
// calls the tick endpoints on a schedule, the CRM looks perfectly healthy and
// does nothing at all. This script is that something.
//
//   node bin/tick.mjs                    # every active tenant, every enabled channel
//   node bin/tick.mjs --channels=email   # just one channel
//   node bin/tick.mjs --tenant=tantra    # just one tenant
//   node bin/tick.mjs --dry-run          # show what it WOULD call, call nothing
//
// WHY A SCRIPT AND NOT A DAEMON, OR AN IN-PROCESS setInterval:
//
//   - A daemon adds a process lifecycle to keep alive, and "stop the world"
//     stops being `EMAIL_EXECUTOR_ENABLED=0` and starts being a deploy.
//   - An in-process timer ties sending to the API process: two pm2 instances
//     would double-send, and a restart mid-batch has no supervisor to retry.
//   - cron already solves scheduling, logging, overlap and alerting, and the
//     endpoints were designed for exactly this caller.
//
// It talks to the API over loopback with the INTERNAL key — the machine path,
// untouched by Clerk. It is a MACHINE caller, so it deliberately sends no
// Authorization header (see the note in middleware/auth.js: a present-but-
// invalid Bearer is terminal).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotenv = (await import('dotenv')).default;
dotenv.config({ path: process.env.DOTENV_PATH || path.join(ROOT, '.env') });

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY = argv.includes('--dry-run');
const BASE = (process.env.TICK_API_BASE || `http://127.0.0.1:${process.env.PORT || 3100}`).replace(/\/+$/, '');
const KEY = process.env.INTERNAL_API_KEY;
// Per-request ceiling. A tick that outlives its own cron interval is the
// classic overlap bug; the lock below is the real guard, this is the backstop.
const TIMEOUT_MS = parseInt(process.env.TICK_TIMEOUT_MS, 10) || 120000;

// Only channels whose kill switch is ON. Ticking a disabled channel is a
// wasted round trip that reports "sending is off" — harmless but noisy, and it
// makes a real outage harder to spot in the log.
const ALL_CHANNELS = ['email', 'sms', 'whatsapp', 'linkedin', 'action'];
const enabledChannels = () => ALL_CHANNELS.filter(c => process.env[`${c.toUpperCase()}_EXECUTOR_ENABLED`] === '1');

if (!KEY) {
  console.error('[tick] FATAL: INTERNAL_API_KEY is not set — cannot authenticate to the API.');
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString(), '[tick]', ...a);

async function call(pathAndQuery, companyId, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE + pathAndQuery, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': KEY,
        'X-Company-Id': companyId,
      },
      body: JSON.stringify(body || {}),
      signal: ctl.signal,
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: { error: e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : e.message } };
  } finally { clearTimeout(timer); }
}

// Which tenants? Read straight from the tenants table rather than an endpoint —
// listing tenants needs a wildcard-bound admin key, and this script should work
// with a narrowly-scoped one too.
async function activeTenants() {
  const only = arg('tenant');
  if (only) return [only];
  const db = (await import('../server/db/index.js')).default;
  await db.initDatabase();
  try {
    const r = await db.query(`SELECT id FROM tenants WHERE status = 'active' ORDER BY id`);
    return r.rows.map(x => x.id);
  } finally { await db.closePool?.(); }
}

async function main() {
  // `--channels=` (present but empty) means NO channels — Tantra only. An
  // `||` fallback here would treat that empty string as "unset" and silently
  // tick every channel, which is how the mirror-only cron entry would end up
  // double-ticking sends.
  const rawChannels = arg('channels', null);
  const channels = (rawChannels === null ? enabledChannels().join(',') : rawChannels)
    .split(',').map(s => s.trim()).filter(Boolean);
  const doTantra = process.env.TANTRA_TICK_ENABLED !== '0';

  if (!channels.length && !doTantra) {
    log('nothing to do: no *_EXECUTOR_ENABLED channel is on and Tantra ticking is disabled.');
    log('This is the "healthy service that sends nothing" state — set EMAIL_EXECUTOR_ENABLED=1 etc.');
    return 0;
  }

  let tenants;
  try { tenants = await activeTenants(); }
  catch (e) { log('FATAL: could not list tenants -', e.message); return 2; }
  if (!tenants.length) { log('no active tenants'); return 0; }

  log(`${DRY ? '[dry-run] ' : ''}${tenants.length} tenant(s) × [${channels.join(', ') || 'no channels'}]${doTantra ? ' + tantra' : ''}`);

  let failures = 0, sent = 0;
  for (const companyId of tenants) {
    for (const channel of channels) {
      const p = `/api/crm/executors/${channel}/tick`;
      if (DRY) { log(`would POST ${p} (${companyId})`); continue; }
      const { status, json } = await call(p, companyId);
      if (status !== 200) {
        failures++;
        log(`FAIL ${companyId}/${channel}: HTTP ${status} ${JSON.stringify(json)}`);
      } else {
        // A blocked tick is a 200 with ok:false — the house convention. That is
        // an expected state (channel off, nothing due), not a failure.
        const n = json?.sent ?? json?.processed ?? 0;
        sent += Number(n) || 0;
        if (json?.ok === false) log(`skip ${companyId}/${channel}: ${json.reason || json.blocked_reason || 'blocked'}`);
        else if (n) log(`ok   ${companyId}/${channel}: ${n} processed`);
      }
    }
    if (doTantra) {
      const p = '/api/crm/tantra/tick';
      if (DRY) { log(`would POST ${p} (${companyId})`); continue; }
      const { status, json } = await call(p, companyId, { max_pages: parseInt(process.env.TANTRA_TICK_PAGES, 10) || 3 });
      // "Not connected" is the normal state for a tenant that never set Tantra
      // up, so it must not be counted as a failure or every cron run alerts.
      if (status !== 200) { failures++; log(`FAIL ${companyId}/tantra: HTTP ${status} ${JSON.stringify(json)}`); }
      else if (json?.ok === false) { /* not connected — silent by design */ }
      else if (json?.messages || json?.synced) log(`ok   ${companyId}/tantra: ${json.messages ?? json.synced} mirrored`);
    }
  }

  log(`done — ${sent} item(s) processed, ${failures} failure(s)`);
  // Non-zero on failure so cron's MAILTO (or whatever wraps this) actually
  // fires. A crank that silently fails is the thing this script exists to stop.
  return failures ? 1 : 0;
}

// Overlap guard. A long tick plus a short cron interval otherwise means two
// runs競 for the same jobs; the dispatch layer's claim/ack makes that safe but
// wasteful, and it muddies the log. An advisory lock costs one round trip.
async function withLock(fn) {
  if (process.env.TICK_SKIP_LOCK === '1' || DRY) return fn();
  const db = (await import('../server/db/index.js')).default;
  await db.initDatabase();
  const LOCK_ID = 8675309; // arbitrary, stable, this script's alone
  const got = await db.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
  if (!got.rows[0]?.ok) {
    log('another tick run holds the lock — exiting rather than piling up');
    await db.closePool?.();
    return 0;
  }
  try { return await fn(); }
  finally {
    try { await db.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch {}
    await db.closePool?.();
  }
}

withLock(main)
  .then(code => process.exit(code))
  .catch(e => { log('FATAL', e.message); process.exit(2); });
