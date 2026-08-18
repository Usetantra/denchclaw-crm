'use strict';
// ─── DAL: operational health ─────────────────────────────────────────────────
// The surface that answers, for an operator: is the engine running, how deep is
// the queue, what is stuck, and which integrations are broken.
//
// Almost everything here is DERIVED from tables that already exist — queue depth
// and quarantine from `scheduled_actions`, integrations from
// `channel_connections`, the mirror from `tantra_sync_state`. Only the tick
// heartbeat needed storage (migration 043), because "nothing is reading the
// queue" and "the queue is empty" look identical from every other angle.
const { query } = require('../index');

// How long a channel may go without a tick before it is called stale. The
// executors are cron-driven at whatever interval the deployment chooses, so this
// is a deliberately loose default: it is meant to catch "cron was never
// installed" and "the scheduler died", not to police a few minutes of jitter.
const STALE_AFTER_MS = Number(process.env.OPS_STALE_AFTER_MS || 30 * 60 * 1000);

const CHANNELS = ['email', 'sms', 'whatsapp', 'linkedin', 'action'];

// ─── recording ───────────────────────────────────────────────────────────────
// Called after every tick, including blocked ones. Never throws into the caller:
// a failure to record health must not fail the send batch it was observing.
async function recordTick(companyId, channel, report = {}) {
  if (!companyId || !channel) return;
  const blocked = report.blocked || report.reason || null;
  const err = report.error || null;
  try {
    await query(
      `INSERT INTO ops_channel_state
         (company_id, channel, last_tick_at, last_ok_at, last_blocked_reason,
          last_error, last_error_at, ticks_total, sent_total, failed_total, updated_at)
       VALUES ($1,$2, now(), CASE WHEN $3::text IS NULL THEN now() END, $3,
               $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, 1, $5, $6, now())
       ON CONFLICT (company_id, channel) DO UPDATE SET
         last_tick_at = now(),
         -- COALESCE, not overwrite: a later blocked tick must not erase the
         -- record of when the channel last actually worked, which is the only
         -- way to tell "blocked for a minute" from "blocked for a fortnight".
         last_ok_at   = CASE WHEN $3::text IS NULL THEN now() ELSE ops_channel_state.last_ok_at END,
         last_blocked_reason = $3,
         last_error    = COALESCE($4, ops_channel_state.last_error),
         last_error_at = CASE WHEN $4::text IS NULL THEN ops_channel_state.last_error_at ELSE now() END,
         ticks_total  = ops_channel_state.ticks_total + 1,
         sent_total   = ops_channel_state.sent_total + $5,
         failed_total = ops_channel_state.failed_total + $6,
         updated_at   = now()`,
      [companyId, channel, blocked, err, Number(report.sent) || 0, Number(report.failed) || 0]
    );
  } catch (e) {
    console.error('[ops] recordTick failed (non-fatal):', e.message);
  }
}

// ─── per-tenant health ───────────────────────────────────────────────────────
async function getHealth(companyId) {
  if (!companyId) throw new Error('ops.getHealth requires companyId');

  const [state, queue, quarantine, connections, tantra, workflows, oldest] = await Promise.all([
    query('SELECT * FROM ops_channel_state WHERE company_id=$1', [companyId]),

    // Queue depth per channel, and how long the oldest DUE job has been waiting.
    // "Due" matters: a ladder legitimately holds jobs scheduled for next week,
    // and counting those as backlog would show a permanent false alarm.
    query(
      `SELECT channel,
              count(*) FILTER (WHERE status='pending')::int                        AS pending,
              count(*) FILTER (WHERE status='pending' AND scheduled_for <= now())::int AS due,
              count(*) FILTER (WHERE status='claimed')::int                        AS claimed
         FROM scheduled_actions WHERE company_id=$1 GROUP BY channel`, [companyId]),

    // Same predicate the executors' own listQuarantine uses: an outcome we never
    // learned, or a claim that has been held far too long to still be in flight.
    query(
      `SELECT channel, count(*)::int AS n FROM scheduled_actions
        WHERE company_id=$1
          AND (outcome_unknown_at IS NOT NULL
               OR (send_started_at IS NOT NULL AND status='claimed'
                   AND send_started_at < now() - interval '15 minutes'))
        GROUP BY channel`, [companyId]),

    query(`SELECT provider, status, account_ref, verified_at, last_error
             FROM channel_connections WHERE company_id=$1`, [companyId]),

    query(`SELECT threads_synced_through, last_sweep_at, last_error, backfill_complete
             FROM tantra_sync_state WHERE company_id=$1`, [companyId]),

    query(
      `SELECT count(*) FILTER (WHERE status='active')::int   AS active,
              count(*) FILTER (WHERE status='paused')::int   AS paused,
              count(*) FILTER (WHERE trigger_tag IS NOT NULL OR trigger_stage IS NOT NULL
                               OR trigger_event IS NOT NULL)::int AS triggered
         FROM sequences WHERE company_id=$1`, [companyId]),

    query(
      `SELECT min(scheduled_for) AS oldest_due FROM scheduled_actions
        WHERE company_id=$1 AND status='pending' AND scheduled_for <= now()`, [companyId]),
  ]);

  const byChannel = new Map(state.rows.map(r => [r.channel, r]));
  const queueBy = new Map(queue.rows.map(r => [r.channel, r]));
  const quarBy = new Map(quarantine.rows.map(r => [r.channel, r.n]));
  const now = Date.now();

  const channels = CHANNELS.map((channel) => {
    const s = byChannel.get(channel) || null;
    const q = queueBy.get(channel) || { pending: 0, due: 0, claimed: 0 };
    const lastTick = s && s.last_tick_at ? new Date(s.last_tick_at).getTime() : null;
    const everTicked = !!lastTick;
    const stale = everTicked ? (now - lastTick) > STALE_AFTER_MS : false;
    return {
      channel,
      ever_ticked: everTicked,
      last_tick_at: s ? s.last_tick_at : null,
      last_ok_at: s ? s.last_ok_at : null,
      minutes_since_tick: everTicked ? Math.round((now - lastTick) / 60000) : null,
      stale,
      blocked_reason: s ? s.last_blocked_reason : null,
      last_error: s ? s.last_error : null,
      last_error_at: s ? s.last_error_at : null,
      pending: q.pending, due: q.due, claimed: q.claimed,
      quarantined: quarBy.get(channel) || 0,
      sent_total: s ? Number(s.sent_total) : 0,
      failed_total: s ? Number(s.failed_total) : 0,
    };
  });

  // ── The one alarm that matters on day one ──────────────────────────────────
  // Not "a channel is blocked" — a blocked channel is usually a deliberate
  // config. The dangerous state is that NOTHING has ticked, because the
  // executors are cron-driven and the whole system is silent when the cron is
  // missing. `never_ticked` and `stale` are separated on purpose: the first
  // means the scheduler was never installed, the second that it stopped.
  const ticked = channels.filter(c => c.ever_ticked);
  const newest = ticked.length
    ? Math.max(...ticked.map(c => new Date(c.last_tick_at).getTime())) : null;
  const engine = {
    ever_ticked: ticked.length > 0,
    last_tick_at: newest ? new Date(newest).toISOString() : null,
    minutes_since_tick: newest ? Math.round((now - newest) / 60000) : null,
    stale: newest ? (now - newest) > STALE_AFTER_MS : false,
    stale_after_minutes: Math.round(STALE_AFTER_MS / 60000),
  };
  engine.status = !engine.ever_ticked ? 'never_ran' : engine.stale ? 'stale' : 'running';

  const totals = channels.reduce((a, c) => ({
    due: a.due + c.due, pending: a.pending + c.pending, quarantined: a.quarantined + c.quarantined,
  }), { due: 0, pending: 0, quarantined: 0 });

  // A backlog is only alarming if something is supposed to be reading it.
  const backlogStuck = totals.due > 0 && engine.status !== 'running';

  return {
    engine,
    channels,
    totals,
    backlog_stuck: backlogStuck,
    oldest_due: oldest.rows[0] ? oldest.rows[0].oldest_due : null,
    integrations: connections.rows.map(r => ({
      provider: r.provider, status: r.status, account_ref: r.account_ref,
      verified_at: r.verified_at, last_error: r.last_error,
      healthy: r.status === 'connected' && !r.last_error,
    })),
    tantra: tantra.rows[0] ? {
      connected: true,
      watermark: tantra.rows[0].threads_synced_through,
      last_sweep_at: tantra.rows[0].last_sweep_at,
      last_error: tantra.rows[0].last_error,
      backfill_complete: tantra.rows[0].backfill_complete,
    } : { connected: false },
    workflows: workflows.rows[0] || { active: 0, paused: 0, triggered: 0 },
  };
}

// ─── fleet view ──────────────────────────────────────────────────────────────
// Every tenant at once. Without this, "is anything running?" can only be asked
// one tenant at a time — and the tenant an operator happens to check may be the
// one that is fine.
async function getFleet({ limit = 200 } = {}) {
  const r = await query(
    `SELECT t.id AS company_id, t.name,
            max(o.last_tick_at)                                   AS last_tick_at,
            coalesce(sum(o.sent_total), 0)::bigint                AS sent_total,
            coalesce(sum(o.failed_total), 0)::bigint              AS failed_total,
            count(o.channel) FILTER (WHERE o.last_blocked_reason IS NOT NULL)::int AS blocked_channels
       FROM tenants t
       LEFT JOIN ops_channel_state o ON o.company_id = t.id
      GROUP BY t.id, t.name
      ORDER BY max(o.last_tick_at) DESC NULLS FIRST
      LIMIT $1`,
    [Math.min(limit, 500)]
  );
  const now = Date.now();
  const tenants = r.rows.map(row => {
    const last = row.last_tick_at ? new Date(row.last_tick_at).getTime() : null;
    return {
      company_id: row.company_id, name: row.name,
      last_tick_at: row.last_tick_at,
      minutes_since_tick: last ? Math.round((now - last) / 60000) : null,
      status: !last ? 'never_ran' : (now - last) > STALE_AFTER_MS ? 'stale' : 'running',
      sent_total: Number(row.sent_total), failed_total: Number(row.failed_total),
      blocked_channels: row.blocked_channels,
    };
  });
  return {
    tenants,
    stale_after_minutes: Math.round(STALE_AFTER_MS / 60000),
    // The fleet-level answer to "did anyone install the cron?"
    any_running: tenants.some(t => t.status === 'running'),
  };
}

module.exports = { recordTick, getHealth, getFleet, STALE_AFTER_MS, CHANNELS };
