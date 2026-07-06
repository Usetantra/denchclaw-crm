-- DenchClaw CRM — Migration 016: harden A5 (limits/quotas/suppression)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/016_limits_hardening.sql
--
-- Two fixes surfaced by critic review of migration 015:
--   1. scheduled_actions had no dedicated "when did this actually send"
--      timestamp — rate-limit counting used `updated_at`, a generic
--      last-touched column with no contract that it changes ONLY at the
--      sent transition. A future retry/backfill/admin-edit touching
--      updated_at on an already-sent row would silently corrupt the count.
--   2. tenant_channel_limits allowed quiet_hours_start = quiet_hours_end,
--      which the app's wraparound logic silently resolves to "never quiet"
--      — very likely NOT what an admin configuring equal start/end intended
--      (plausibly "quiet all day"). Reject the ambiguous config at write
--      time instead of silently doing the opposite of what was meant.

BEGIN;

ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_sent_at ON scheduled_actions (company_id, channel, sent_at) WHERE sent_at IS NOT NULL;

-- NOT VALID + VALIDATE CONSTRAINT (same low-lock-window pattern as migration
-- 013): ADD CONSTRAINT ... NOT VALID is instant and doesn't scan existing
-- rows, so a pre-existing violating row (there shouldn't be one yet on this
-- branch, but this migration must stay correct if ever applied against a
-- live table that already has data) can't abort the whole migration
-- transaction outright — VALIDATE CONSTRAINT checks separately and would
-- surface a clear, targeted error instead. conrelid-scoped so a same-named
-- constraint on an unrelated table can't cause a false "already exists" skip.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_tenant_channel_limits_quiet_hours_distinct'
      AND conrelid = 'tenant_channel_limits'::regclass
  ) THEN
    ALTER TABLE tenant_channel_limits
      ADD CONSTRAINT chk_tenant_channel_limits_quiet_hours_distinct
      CHECK (quiet_hours_start IS NULL OR quiet_hours_end IS NULL OR quiet_hours_start <> quiet_hours_end)
      NOT VALID;
    ALTER TABLE tenant_channel_limits VALIDATE CONSTRAINT chk_tenant_channel_limits_quiet_hours_distinct;
  END IF;
END $$;

COMMIT;
