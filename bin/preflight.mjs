#!/usr/bin/env node
// ─── Pre-hosting preflight ───────────────────────────────────────────────────
// Run this ON THE BOX before flipping nginx, and again after. It checks the
// things that are silently wrong rather than loudly wrong — the failures that
// look like a healthy service doing nothing.
//
//   node bin/preflight.mjs
//
// Read-only: it opens the DB and reads env. It changes nothing, so it is safe
// to run against production at any time.
//
// Exit 0 = nothing blocking. Exit 1 = at least one BLOCK. Warnings never fail
// the run, because "not ideal" and "will not work" deserve different exit codes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DOTENV_PATH ||= path.join(ROOT, '.env');
const dotenv = (await import('dotenv')).default;
dotenv.config({ path: process.env.DOTENV_PATH });

const results = [];
const ok    = (m, d) => results.push({ level: 'ok',    m, d });
const warn  = (m, d) => results.push({ level: 'warn',  m, d });
const block = (m, d) => results.push({ level: 'block', m, d });

// ── 1. Runtime ───────────────────────────────────────────────────────────────
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 20 || (maj === 20 && min >= 9)) ok(`Node ${process.versions.node}`, '@clerk/backend v3 needs >=20.9');
else block(`Node ${process.versions.node} is too old`, '@clerk/backend v3 requires >=20.9 — it will fail at require time');

// ── 2. Clerk configuration ───────────────────────────────────────────────────
const hasSecret = Boolean(process.env.CLERK_SECRET_KEY);
const hasJwtKey = Boolean(process.env.CLERK_JWT_KEY);
if (hasSecret || hasJwtKey) {
  ok('Clerk is configured', hasJwtKey ? 'CLERK_JWT_KEY set (networkless verification)' : 'CLERK_SECRET_KEY only');
  if (!hasJwtKey) warn('CLERK_JWT_KEY is unset', 'every verification may hit Clerk\'s JWKS endpoint — a network blip becomes a 401 storm');
  if (!process.env.CLERK_PUBLISHABLE_KEY) block('CLERK_PUBLISHABLE_KEY is unset', 'the browser cannot boot Clerk — the login page will say sign-in is not configured');
  else {
    // A publishable key is base64 of "<frontend-host>$". A typo here fails
    // SILENTLY in the browser: the script loads but window.Clerk is never set.
    const pk = process.env.CLERK_PUBLISHABLE_KEY;
    const b64 = pk.replace(/^pk_(test|live)_/, '');
    let decoded = '';
    try { decoded = Buffer.from(b64, 'base64').toString('utf8'); } catch {}
    if (/^pk_(test|live)_/.test(pk) && /\.(clerk\.accounts\.dev|[a-z0-9.-]+)\$$/.test(decoded)) {
      ok('CLERK_PUBLISHABLE_KEY looks well-formed', `frontend host: ${decoded.replace(/\$$/, '')}`);
      if (pk.startsWith('pk_test_')) warn('using a Clerk DEVELOPMENT key', 'pk_test_ is a dev instance — use the production instance for a public host');
    } else {
      block('CLERK_PUBLISHABLE_KEY is malformed', `expected pk_test_/pk_live_ + base64("host$"), got ${pk.slice(0, 16)}… — the login page will fail with no useful error`);
    }
  }
  if (!process.env.CLERK_AUTHORIZED_PARTIES) block('CLERK_AUTHORIZED_PARTIES is unset', 'the azp claim is unchecked — a token minted for another app on this Clerk instance would be accepted');
  else ok('CLERK_AUTHORIZED_PARTIES set', process.env.CLERK_AUTHORIZED_PARTIES);
} else {
  warn('Clerk is NOT configured', 'the Clerk branch never engages; browsers can only authenticate if the proxy still injects a key');
}

// ── 3. Secrets that fail silently ────────────────────────────────────────────
if (!process.env.CREDENTIALS_KEY) {
  block('CREDENTIALS_KEY is unset', 'stored provider credentials are encrypted with a key DERIVED from INTERNAL_API_KEY — rotating that key makes them permanently undecryptable, and the decrypt failure is swallowed. Generate with: openssl rand -hex 32');
} else if (!/^[0-9a-fA-F]{64}$/.test(process.env.CREDENTIALS_KEY)) {
  block('CREDENTIALS_KEY is malformed', 'must be exactly 64 hex chars, or it silently falls back to the derived key');
} else ok('CREDENTIALS_KEY set', '64 hex chars');

if (!process.env.INTERNAL_API_KEY) block('INTERNAL_API_KEY is unset', 'an ephemeral key is generated per restart — inbound-email and chat self-calls will 401 after the next restart');
else ok('INTERNAL_API_KEY set');

if (process.env.NODE_ENV !== 'production') warn(`NODE_ENV is "${process.env.NODE_ENV || 'unset'}"`, 'production gates (secure cookies, startup warnings) are off');
else ok('NODE_ENV=production');

if (!process.env.INTERNAL_API_KEYS) warn('INTERNAL_API_KEYS is unset', 'the single key is bound to "*", so any X-Company-Id is accepted');
else ok('INTERNAL_API_KEYS set', 'per-tenant key binding active');

// ── 4. Executors: is anything actually going to send? ────────────────────────
const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'LINKEDIN', 'ACTION'];
const on = CHANNELS.filter(c => process.env[`${c}_EXECUTOR_ENABLED`] === '1');
if (process.env.LIVE_SENDS_DISABLED) block('LIVE_SENDS_DISABLED is set', 'the global kill switch is on — nothing sends on any channel');
if (!on.length) block('no executor channel is enabled', 'every *_EXECUTOR_ENABLED is off, so ticks will run and send nothing');
else ok(`executors enabled: ${on.join(', ').toLowerCase()}`);

// ── 5. Database: schema + tenancy ────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  block('DATABASE_URL is unset', 'the service cannot start at all');
} else {
  const db = (await import('../server/db/index.js')).default;
  try {
    await db.initDatabase();
    const col = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='clerk_user_id'`);
    if (col.rows.length) ok('migration 044 applied', 'users.clerk_user_id exists');
    else block('migration 044 is NOT applied', 'Clerk sign-in cannot store an identity — apply migrations/044_clerk_identity.sql');

    const opsTable = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name='ops_channel_state'`);
    if (opsTable.rows.length) ok('migration 043 applied', 'tick heartbeats are recorded');
    else block('migration 043 is NOT applied', 'ops visibility is missing — /ops/health and /ops/fleet will 500');

    // THE lock-out check. Bootstrap only works while a tenant has zero users,
    // so this single number decides whether you are safe or exposed.
    const target = process.env.CLERK_BOOTSTRAP_COMPANY_ID || process.env.DEFAULT_COMPANY_ID || 'tantra';
    const u = await db.query(`SELECT email, role, status, (clerk_user_id IS NOT NULL) AS linked FROM users WHERE company_id=$1 ORDER BY created_at`, [target]);
    if (!u.rows.length) {
      block(`tenant "${target}" has NO users`,
        'the first person to sign up on your Clerk instance becomes its owner. Restrict Clerk sign-up to invitation-only, or INSERT your own row first');
    } else {
      const linked = u.rows.filter(r => r.linked).length;
      ok(`tenant "${target}" has ${u.rows.length} user(s), ${linked} linked to Clerk`,
        u.rows.map(r => `${r.email} (${r.role}${r.status !== 'active' ? ', ' + r.status : ''}${r.linked ? ', linked' : ''})`).join('; '));
      if (!linked) warn('no user is linked to a Clerk identity yet',
        'sign in once with a Clerk account whose email matches one of the rows above BEFORE flipping nginx — otherwise you lock yourself out');
    }

    // ── Host-dependent config, and who is pointing at the old host ──────────
    // Moving hostnames is the one change this app never complains about: a
    // stale base URL produces dead links and misrouted callbacks with no error
    // anywhere. So compare what is configured against the host we think we are.
    const HOST_VARS = [
      ['APP_URL', 'team invite links emailed to new users'],
      ['MARKETING_PUBLIC_BASE', 'prospect-facing /m/i/<token> links'],
      ['TWILIO_WEBHOOK_BASE_URL', 'Twilio signature validation — a mismatch 403s every inbound SMS/WhatsApp and stops STOP/opt-out being recorded'],
      ['TWILIO_STATUS_CALLBACK', 'delivery receipts — stale means every message stays "queued" forever'],
    ];
    const expectHost = (process.env.CLERK_AUTHORIZED_PARTIES || '').split(',')[0].trim()
      || process.env.APP_URL || '';
    const expectName = (() => { try { return new URL(expectHost).host; } catch { return ''; } })();
    for (const [name, why] of HOST_VARS) {
      const v = process.env[name];
      if (!v) { warn(`${name} is unset`, why); continue; }
      let h = ''; try { h = new URL(v).host; } catch {}
      if (!h) warn(`${name} is not an absolute URL`, `"${v}" — ${why}`);
      else if (expectName && h !== expectName) {
        warn(`${name} points at ${h}, not ${expectName}`, why);
      } else ok(`${name} -> ${h}`);
    }

    // Webhook URLs live in THIRD-PARTY dashboards, not here — but the tokens
    // live in our tables, and request_count tells us which are actually in use.
    // That turns "which integrations are live?" from a memory test into a query.
    for (const [table, label] of [['lead_webhooks', 'lead webhook'], ['tantra_webhooks', 'Tantra webhook']]) {
      const t = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name=$1`, [table]);
      if (!t.rows.length) continue;
      const r = await db.query(
        `SELECT count(*) FILTER (WHERE enabled) AS enabled,
                count(*) FILTER (WHERE request_count > 0) AS used
           FROM ${table}`);
      const { enabled, used } = r.rows[0];
      if (Number(used) > 0) {
        warn(`${used} ${label}(s) have received traffic`,
          'their URL is pasted into a third-party tool and still points at the OLD host — re-paste it there after the move (same token, new hostname)');
      } else if (Number(enabled) > 0) {
        ok(`${enabled} ${label}(s) configured, none used yet`);
      }
    }

    // Is the crank turning? This is the difference between "queue empty because
    // delivered" and "queue empty because nothing reads it".
    if (opsTable.rows.length) {
      const t = await db.query(`SELECT company_id, channel, last_tick_at, EXTRACT(EPOCH FROM (now()-last_tick_at)) AS age FROM ops_channel_state ORDER BY last_tick_at DESC NULLS LAST LIMIT 10`);
      if (!t.rows.length) block('no executor tick has EVER been recorded', 'nothing is driving the queue — install the cron entries (see bin/tick.mjs)');
      else {
        const stale = t.rows.filter(r => Number(r.age) > 3600);
        if (stale.length === t.rows.length) block('every recorded tick is over an hour old', 'cron is not running or is failing — check its log');
        else ok(`most recent tick ${Math.round(Number(t.rows[0].age))}s ago`, `${t.rows[0].company_id}/${t.rows[0].channel}`);
      }
    }
    await db.closePool?.();
  } catch (e) {
    block('database check failed', e.message);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const ICON = { ok: '  ok   ', warn: '  WARN ', block: ' BLOCK ' };
console.log('\nDenchClaw CRM — pre-hosting preflight\n' + '─'.repeat(70));
for (const r of results) {
  console.log(`${ICON[r.level]} ${r.m}`);
  if (r.d) console.log(`         ${r.d}`);
}
const blocks = results.filter(r => r.level === 'block');
const warns = results.filter(r => r.level === 'warn');
console.log('─'.repeat(70));
console.log(`${blocks.length} blocking, ${warns.length} warning, ${results.filter(r => r.level === 'ok').length} ok\n`);
process.exit(blocks.length ? 1 : 0);
