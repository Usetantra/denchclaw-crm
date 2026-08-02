'use strict';
// ─── CP-C2: the LinkedIn safety spine, ported not reinvented ─────────────────
//
// This is a port of outreach-engine/backend/app/linkedin_gate.py PLUS the
// orchestration order in its dispatcher.py:355-429 — which is not a reusable
// function there, and is the reason the adapter alone was never safe to wrap.
//
// The one thing that outranks everything in this file: a rate mistake on email
// is an apology, a rate mistake on LinkedIn gets the account restricted, and
// that is not recoverable. So every limit here is UPSTREAM'S, and every
// deviation is a tightening, never a loosening.
//
// FOUR CONCERNS, IN UPSTREAM'S ORDER:
//   1. ACCOUNT   — resolve the tenant's connected identity; refuse if paused.
//   2. WINDOW    — the account's active hours AND days, in the account's own tz.
//   3. CAPS      — daily per-type + daily total + weekly invite + pending-invite
//                  ceiling + intra-window pacing, all under the advisory lock.
//   4. RESERVE   — claimed BEFORE the provider call, so two ticks cannot both
//                  send. Upstream needed a lease table; the CRM already has one
//                  (the claim itself + migration 022's send_started_at), so this
//                  port deliberately does NOT add a second.
//
// WHERE IT RUNS, and why that is the point: at the CLAIM DOOR, not in the
// executor. A job claimed at 17:59 and sent at 18:05 has left the window — the
// only way the window can actually mean something is to refuse to hand the job
// out in the first place. That is the same place A5's quiet hours and rate
// limits already live, so LinkedIn is not a special path; it is one more gate on
// the existing one.
const { query } = require('../db/index');
const { killSwitchOn, liveSendAllowed } = require('./send-safety');

// The lease TTL upstream needed becomes "how long a claim counts as in flight",
// which the CRM already defines. Kept in sync rather than reinvented.
const CLAIM_TIMEOUT_MS = parseInt(process.env.CHANNEL_JOB_CLAIM_TIMEOUT_MS, 10) || 300_000;
const ABANDON_DAYS = parseInt(process.env.LINKEDIN_INVITE_ABANDON_DAYS, 10) || 14;

// Verdicts. Named exactly as upstream so the two systems' logs read alike.
const OK = 'ok';
const V = {
  NO_ACCOUNT: 'no_linkedin_account',
  ACCOUNT_PAUSED: 'account_paused',
  KILL_SWITCH: 'kill_switch',
  OUT_OF_WINDOW: 'out_of_window',
  PACED: 'paced',
  DAILY_CAPPED: 'daily_capped',
  WEEKLY_CAPPED: 'weekly_invite_capped',
  PENDING_CAPPED: 'pending_invite_capped',
  AWAITING_ACCEPT: 'awaiting_acceptance',
  ABANDONED: 'invite_abandoned',
  NO_EVIDENCE: 'no_connection_evidence',
  INELIGIBLE: 'ineligible',
  NO_IDENTIFIER: 'no_linkedin_identifier',
  // Set until an operator confirms the outreach engine is NOT also dispatching
  // LinkedIn on this connected account. Two ledgers, one account, double caps.
  ENGINE_NOT_FENCED: 'engine_dispatch_not_confirmed_disabled',
  ALREADY_CONNECTED: 'already_connected',
  INVITE_PENDING: 'invite_already_pending',
};

// The kill switch and the live allowlist are NOT LinkedIn features — they are
// `automation_core/channels/base.py` rails that apply to every channel, so they
// live in lib/send-safety.js and every executor gets them. Re-exported here
// because this gate is where LinkedIn's safety story is meant to be readable in
// one place.

// ─── window ──────────────────────────────────────────────────────────────────
// Upstream's `_in_window` + `_hhmm`, with the day-of-week half added, because
// the binding LinkedIn window in that codebase is the CHANNEL default
// (Tue/Wed/Thu 09:00–10:30 in channels/linkedin.py:14) and not only the account
// hours. A port that kept the hours and dropped the days would be a loosening.
function hhmm(v, fallback) {
  const m = /^(\d{1,2}):?(\d{2})?$/.exec(String(v || '').trim());
  if (!m) return fallback;
  return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

// Minutes-since-midnight and weekday, in the ACCOUNT's timezone. An account in
// Asia/Kolkata must not be gated on the server's clock.
function accountClock(timezone, at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Kolkata', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at);
  } catch {
    // An unknown tz string must not crash a send path, so this falls back to
    // UTC — but SILENTLY falling back means an account configured 'Asia/Kolkata '
    // with a stray space is gated on the wrong clock and nothing ever says so.
    console.error(`[CRM][linkedin-gate] unknown timezone '${timezone}' — the send window is being evaluated in UTC, which is almost certainly not what was intended`);
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at);
  }
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  // 'en-US' with hour12:false renders midnight as '24' in some ICU versions.
  const hour = parseInt(get('hour'), 10) % 24;
  return { minutes: hour * 60 + parseInt(get('minute'), 10), day: get('weekday') };
}

function windowVerdict(account, at = new Date()) {
  const clock = accountClock(account.timezone, at);
  // An EMPTY array is "no days", and it fails CLOSED — the same discipline as the
  // inverted window below. Treating [] as "every day" would hand an operator who
  // emptied the list weekend sending: exactly the non-human pattern the day gate
  // exists to prevent. NULL (column absent) is the only "unset" that opens.
  const days = Array.isArray(account.active_days)
    ? account.active_days.map(d => String(d).slice(0, 3).toLowerCase())
    : null;
  if (days && !days.includes(clock.day.slice(0, 3).toLowerCase())) return V.OUT_OF_WINDOW;
  const start = hhmm(account.active_start, 7 * 60);
  const end = hhmm(account.active_end, 18 * 60);
  // A window that does not wrap midnight is the only shape LinkedIn hours take;
  // treating start >= end as "always open" (upstream's `if e <= s: return True`
  // in the pacer) would turn a misconfiguration into unlimited sending, so it is
  // treated as CLOSED here instead. Failing closed is the whole discipline.
  if (end <= start) return V.OUT_OF_WINDOW;
  return (clock.minutes >= start && clock.minutes <= end) ? OK : V.OUT_OF_WINDOW;
}

// Upstream's `_window_pace_ok`: spread the daily allowance across the window so
// one tick at window-open cannot burn the whole day in a burst — which is what a
// human never does and a platform notices.
function pacedAllowance(account, at = new Date()) {
  const clock = accountClock(account.timezone, at);
  const start = hhmm(account.active_start, 7 * 60);
  const end = hhmm(account.active_end, 18 * 60);
  if (end <= start) return 0;
  const frac = Math.max(0, Math.min(1, (clock.minutes - start) / (end - start)));
  return Math.floor((account.daily_total_limit || 100) * frac) + 1;
}

// ─── account ─────────────────────────────────────────────────────────────────
async function getActiveAccount(companyId, run = query) {
  const r = await run(
    `SELECT * FROM linkedin_accounts
      WHERE company_id = $1 AND status = 'connected'
      ORDER BY connected_at ASC LIMIT 1`, [companyId]);
  if (r.rows[0]) return r.rows[0];
  // Distinguish "no identity at all" from "an identity that is switched off" —
  // an operator who paused an account needs to see that, not a blank "no
  // account" that reads like a setup they never finished.
  const any = await run(
    `SELECT * FROM linkedin_accounts WHERE company_id = $1 ORDER BY connected_at ASC LIMIT 1`,
    [companyId]);
  return any.rows[0] || null;
}

// ─── counting: the ledger is scheduled_actions, not a second table ───────────
// Counts, for one account, in the ACCOUNT'S calendar day:
//   * anything whose physical send left (send_started_at / sent_at), and
//   * any live, non-stale claim — an in-flight reservation consumes a slot too,
//     which is exactly why upstream counted status IN ('reserved','sent').
// A stale claim stops counting on its own, so a crashed tick cannot permanently
// eat a day's allowance; that is upstream's LEASE_TTL, for free.
async function countsToday(accountId, timezone, run = query) {
  const r = await run(
    `SELECT COALESCE(linkedin_action, 'message') AS action, COUNT(*)::int AS n
       FROM scheduled_actions
      WHERE linkedin_account_id = $1
        AND ((COALESCE(sent_at, send_started_at) IS NOT NULL
              AND (COALESCE(sent_at, send_started_at) AT TIME ZONE $2)::date
                  = (now() AT TIME ZONE $2)::date)
          OR (status = 'claimed'
              AND claimed_at >= now() - ($3 || ' milliseconds')::interval))
      GROUP BY 1`,
    [accountId, timezone || 'Asia/Kolkata', String(CLAIM_TIMEOUT_MS)]);
  const byType = {};
  let total = 0;
  for (const row of r.rows) { byType[row.action] = row.n; total += row.n; }
  return { byType, total };
}

async function weeklyInvites(accountId, run = query) {
  const r = await run(
    `SELECT COUNT(*)::int AS n FROM scheduled_actions
      WHERE linkedin_account_id = $1 AND linkedin_action = 'invite'
        AND (COALESCE(sent_at, send_started_at) >= now() - interval '7 days'
          OR (status = 'claimed' AND claimed_at >= now() - ($2 || ' milliseconds')::interval))`,
    [accountId, String(CLAIM_TIMEOUT_MS)]);
  return r.rows[0].n;
}

async function pendingInvites(accountId, run = query) {
  const r = await run(
    `SELECT COUNT(*)::int AS n FROM linkedin_prospect_state
      WHERE account_id = $1 AND status = 'invited'`, [accountId]);
  return r.rows[0].n;
}

// ─── the accept gate, deliberately STRICTER than upstream ───────────────────
// Upstream gates a `message` step only when an `invite` precedes it in the same
// sequence (linkedin_gate.py:57-65). That leaves the commonest illegal action
// wide open: a message-only ladder aimed at people we are not connected to.
// Upstream catches those with a live profile resolve per prospect; that costs a
// provider call each and is a checkpoint of its own (see F31), so this port
// closes the hole the cheap way instead — DEFAULT DENY.
//
// A `message` step needs POSITIVE EVIDENCE that we are connected:
//   * an invite we sent was accepted (`accepted_at`, set by the webhook), or
//   * the prospect state already says accepted/replied, or
//   * they have sent US a LinkedIn message, which only a connection can do.
// An operator who genuinely has a list of existing connections turns
// `allow_unverified_message` on for the account and owns that choice.
// `inmail` never gates — InMail needs no connection, which is its point.
async function connectionEvidence(companyId, accountId, contactId, run = query) {
  const st = await run(
    `SELECT status, accepted_at, invite_sent_at, network_distance
       FROM linkedin_prospect_state WHERE account_id = $1 AND contact_id = $2`,
    [accountId, contactId]);
  const row = st.rows[0];
  if (row) {
    if (row.status === 'ineligible') return { connected: false, verdict: V.INELIGIBLE, row };
    if (row.accepted_at || ['accepted', 'replied'].includes(row.status)) return { connected: true, row };
    if (row.network_distance === 'FIRST_DEGREE') return { connected: true, row };
  }
  const inbound = await run(
    `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.company_id = $1 AND c.contact_id = $2
        AND m.channel = 'linkedin' AND m.direction = 'inbound' LIMIT 1`,
    [companyId, contactId]);
  if (inbound.rows.length) return { connected: true, row };
  return { connected: false, verdict: V.AWAITING_ACCEPT, row };
}

// ─── PHASE 1: the whole-scan gate, run once per claim scan ──────────────────
// Returns either a refusal (claim nothing) or an account plus a ceiling on how
// many jobs this scan may hand out.
async function preScan(companyId, run = query) {
  if (killSwitchOn()) return { allow: false, reason: V.KILL_SWITCH };

  const account = await getActiveAccount(companyId, run);
  if (!account) return { allow: false, reason: V.NO_ACCOUNT };
  if (account.status !== 'connected') return { allow: false, reason: V.ACCOUNT_PAUSED, account };

  // THE ONE RISK THIS PORT CANNOT SEE FROM INSIDE THE CRM, so it refuses instead
  // of guessing. The cutover is phased, which means the outreach engine may still
  // be dispatching LinkedIn on this SAME connected identity — and it counts its
  // sends in its own `linkedin_send_log`, which this ledger cannot read and which
  // cannot read this one. Two systems each allowing 100 actions and 100 invites a
  // week on one human's account is 200 of each, with both believing they are
  // compliant. Every other cap here is worth nothing if that is true.
  //
  // There is no query that answers it, so the operator asserts it, once, per
  // account, and it fails CLOSED until they do.
  if (!account.engine_dispatch_disabled) {
    return { allow: false, reason: V.ENGINE_NOT_FENCED, account };
  }

  const w = windowVerdict(account);
  if (w !== OK) return { allow: false, reason: w, account };

  const counts = await countsToday(account.account_id, account.timezone, run);
  const totalCap = account.daily_total_limit;
  if (counts.total >= totalCap) return { allow: false, reason: V.DAILY_CAPPED, account };

  const pacedCap = pacedAllowance(account);
  if (counts.total >= pacedCap) return { allow: false, reason: V.PACED, account };

  const ctx = {
    account,
    counts,
    weekly: await weeklyInvites(account.account_id, run),
    pending: await pendingInvites(account.account_id, run),
  };
  return {
    allow: true,
    account,
    ctx,
    limit: Math.max(0, Math.min(totalCap - counts.total, pacedCap - counts.total)),
  };
}

// ─── PHASE 2: per-job, inside the same transaction and the same lock ────────
// Called for each candidate row. Mutates ctx's running counts so a single batch
// cannot itself overshoot a cap — the bug that makes "we check the limit" and
// "we respect the limit" two different claims.
async function admits(companyId, row, ctx, run = query) {
  const { account } = ctx;

  const step = await run(
    `SELECT linkedin_action FROM sequence_steps WHERE id = $1`, [row.step_id]);
  // NULL means 'message', and that default is safe in the direction that
  // matters: an unverified message is refused below, whereas defaulting to
  // 'invite' would fire connection requests nobody asked for.
  const action = (step.rows[0] && step.rows[0].linkedin_action) || 'message';

  const perTypeCap = { invite: account.daily_invite_limit, message: account.daily_message_limit,
    inmail: account.daily_inmail_limit }[action] ?? account.daily_message_limit;
  if ((ctx.counts.byType[action] || 0) >= perTypeCap) return { ok: false, reason: V.DAILY_CAPPED, action };
  if (ctx.counts.total >= account.daily_total_limit) return { ok: false, reason: V.DAILY_CAPPED, action };

  if (action === 'invite') {
    if (ctx.weekly >= account.weekly_invite_limit) return { ok: false, reason: V.WEEKLY_CAPPED, action };
    if (ctx.pending >= account.max_pending_invites) return { ok: false, reason: V.PENDING_CAPPED, action };
    // Upstream's ALREADY / PARKED verdicts, which the CRM lost when the
    // per-(campaign,contact,step) lease was replaced by the claim. The CRM's own
    // dedupe is UNIQUE (enrollment_id, step_id), so a SECOND enrolment — or a
    // second sequence aimed at the same contact — is a fresh row and would
    // re-invite someone we are already connected to. That is a real illegal
    // action at the provider every time, and the state table keyed
    // (account, contact) exists precisely so it can be refused for free.
    const st = await run(
      `SELECT status, accepted_at, invite_sent_at, network_distance
         FROM linkedin_prospect_state WHERE account_id = $1 AND contact_id = $2`,
      [account.account_id, row.contact_id]);
    const p = st.rows[0];
    if (p) {
      if (p.status === 'ineligible') return { ok: false, reason: V.INELIGIBLE, action };
      if (p.accepted_at || ['accepted', 'replied'].includes(p.status) || p.network_distance === 'FIRST_DEGREE') {
        return { ok: false, reason: V.ALREADY_CONNECTED, action };
      }
      // An invite already out and not yet stale is upstream's ALREADY.
      if (p.status === 'invited' && p.invite_sent_at &&
          (Date.now() - new Date(p.invite_sent_at).getTime()) / 86_400_000 < ABANDON_DAYS) {
        return { ok: false, reason: V.INVITE_PENDING, action };
      }
    }
  }

  if (action === 'message' && !account.allow_unverified_message) {
    const ev = await connectionEvidence(companyId, account.account_id, row.contact_id, run);
    if (!ev.connected) {
      // An invite left pending for too long is abandoned rather than left to sit
      // in the queue forever pretending it is about to fire (upstream's
      // ABANDON_DAYS). The job stays PENDING either way — never 'skipped',
      // because a skipped ack advances the ladder, and advancing past a message
      // the prospect never got is how step 3 reaches someone who never saw
      // step 1.
      const invitedAt = ev.row && ev.row.invite_sent_at;
      const abandoned = invitedAt &&
        (Date.now() - new Date(invitedAt).getTime()) / 86_400_000 >= ABANDON_DAYS;
      if (abandoned) {
        await run(`UPDATE linkedin_prospect_state SET status='abandoned', updated_at=now()
                    WHERE account_id=$1 AND contact_id=$2`, [account.account_id, row.contact_id]);
        return { ok: false, reason: V.ABANDONED, action };
      }
      return { ok: false, reason: ev.verdict || V.NO_EVIDENCE, action };
    }
  }

  ctx.counts.byType[action] = (ctx.counts.byType[action] || 0) + 1;
  ctx.counts.total += 1;
  if (action === 'invite') { ctx.weekly += 1; ctx.pending += 1; }
  return { ok: true, action, accountId: account.account_id };
}

// Stamps the reservation onto the row. This is what makes the claim countable —
// there is no second ledger, so if this does not run the send is invisible to
// every cap above.
async function stampClaim(jobId, accountId, action, run = query) {
  await run(
    `UPDATE scheduled_actions SET linkedin_account_id = $2, linkedin_action = $3, updated_at = now()
      WHERE id = $1`, [jobId, accountId, action]);
}

// ─── settle: what the executor tells the gate after the provider call ───────
async function recordInvite(companyId, accountId, contactId, { providerId = null, linkedinUrl = null } = {}) {
  await query(
    `INSERT INTO linkedin_prospect_state
       (company_id, account_id, contact_id, provider_id, linkedin_url, status, invite_sent_at)
     VALUES ($1,$2,$3,$4,$5,'invited', now())
     ON CONFLICT (account_id, contact_id) DO UPDATE
       SET status = CASE WHEN linkedin_prospect_state.status IN ('accepted','replied')
                         THEN linkedin_prospect_state.status ELSE 'invited' END,
           invite_sent_at = COALESCE(linkedin_prospect_state.invite_sent_at, now()),
           provider_id = COALESCE(EXCLUDED.provider_id, linkedin_prospect_state.provider_id),
           linkedin_url = COALESCE(EXCLUDED.linkedin_url, linkedin_prospect_state.linkedin_url),
           updated_at = now()`,
    [companyId, accountId, contactId, providerId, linkedinUrl]);
}

// Terminal park for an action that is ILLEGAL for this prospect's connection
// state. Never retried — a doomed retry loop against LinkedIn is precisely the
// account risk being neutralised here.
async function markIneligible(companyId, accountId, contactId, reason) {
  await query(
    `INSERT INTO linkedin_prospect_state (company_id, account_id, contact_id, status, ineligible_reason)
     VALUES ($1,$2,$3,'ineligible',$4)
     ON CONFLICT (account_id, contact_id) DO UPDATE
       SET status='ineligible', ineligible_reason=EXCLUDED.ineligible_reason, updated_at=now()`,
    [companyId, accountId, contactId, String(reason || '').slice(0, 300)]);
}

// The per-job refusal the executor calls immediately before each send. The claim
// door gates the scan; this catches the tail of a slow batch drifting past the
// window's end, and an operator pausing the account mid-batch.
async function admitJobNow(account) {
  if (killSwitchOn()) return V.KILL_SWITCH;
  const fresh = await query(
    'SELECT status, engine_dispatch_disabled FROM linkedin_accounts WHERE account_id = $1',
    [account.account_id]);
  const now = fresh.rows[0];
  if (!now || now.status !== 'connected') return V.ACCOUNT_PAUSED;
  if (!now.engine_dispatch_disabled) return V.ENGINE_NOT_FENCED;
  const w = windowVerdict(account);
  return w === OK ? null : w;
}

module.exports = {
  OK, V, CLAIM_TIMEOUT_MS, ABANDON_DAYS, admitJobNow,
  killSwitchOn, liveSendAllowed, windowVerdict, pacedAllowance, accountClock, hhmm,
  getActiveAccount, countsToday, weeklyInvites, pendingInvites, connectionEvidence,
  preScan, admits, stampClaim, recordInvite, markIneligible,
};
