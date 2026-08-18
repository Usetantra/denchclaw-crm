-- DenchClaw CRM — migration 043: operational visibility
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/043_ops_visibility.sql
--
-- WHY THIS EXISTS
--
-- This codebase is deliberately fail-closed everywhere: a missing secret
-- disables the endpoint, an unresolvable sender refuses the send, an unmapped
-- inbound recipient is rejected, a job whose content has unresolved tokens is
-- never claimed. Each of those is the right call on its own. Together, and with
-- no surface reporting them, they produce one failure mode:
--
--     THE SERVICE LOOKS HEALTHY AND DOES NOTHING.
--
-- And that is the EXPECTED state on day one, because the executors are not
-- daemons — "one tick = one batch, driven by cron or an operator" — so until
-- someone installs the cron entries, nothing runs at all while every screen
-- reports success.
--
-- Everything else needed for an ops view can already be derived from live
-- tables: queue depth and quarantine from `scheduled_actions`, integration
-- health from `channel_connections`, mirror state from `tantra_sync_state`. The
-- ONE thing nowhere records is "did a tick actually happen, and when" — so that
-- is all this table stores. It is the single fact that distinguishes "the queue
-- is empty because everything is delivered" from "the queue is empty because
-- nothing is reading it".
--
-- One row per (tenant, channel), updated in place rather than a row per tick:
-- the staleness question only needs the LAST one, and an append-only log of
-- every tick on every channel for every tenant would grow without bound to
-- answer a question nobody asks.

CREATE TABLE IF NOT EXISTS ops_channel_state (
  company_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,

  -- The heartbeat. `last_tick_at` moves on EVERY tick, including a blocked one:
  -- a tick that ran and correctly refused to send is proof the scheduler is
  -- alive, and conflating it with "never ran" would raise a false alarm on a
  -- tenant that simply has sending switched off.
  last_tick_at    TIMESTAMPTZ,
  -- ...whereas this only moves when a tick was actually able to work, which is
  -- what distinguishes "running but permanently blocked" from "running fine".
  last_ok_at      TIMESTAMPTZ,

  last_blocked_reason TEXT,
  last_error          TEXT,
  last_error_at       TIMESTAMPTZ,

  ticks_total     BIGINT NOT NULL DEFAULT 0,
  sent_total      BIGINT NOT NULL DEFAULT 0,
  failed_total    BIGINT NOT NULL DEFAULT 0,

  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, channel)
);

-- The fleet view answers "is the engine running anywhere" by taking the newest
-- tick across every tenant, so it sorts on this rather than scanning.
CREATE INDEX IF NOT EXISTS idx_ops_channel_state_last_tick
  ON ops_channel_state (last_tick_at DESC NULLS LAST);
