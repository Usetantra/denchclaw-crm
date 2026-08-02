-- DenchClaw CRM — Migration 015: per-tenant limits/quotas/suppression (GOAL A5)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/015_tenant_limits.sql
--
-- Two tables, both FK'd to tenants(id):
--   suppressions           — global do-not-contact list. `channel` NULL means
--                             "suppressed on every channel"; a specific
--                             channel value means "just that one" (same
--                             NULL-as-broadcast idiom as prospect_inbox,
--                             migration 002).
--   tenant_channel_limits  — one row per (company_id, channel): rate caps +
--                             quiet hours. Absent row / NULL fields mean "no
--                             limit configured" (permissive default) — B3's
--                             dispatcher checks this table, doesn't assume it
--                             exists for every tenant.

BEGIN;

CREATE TABLE IF NOT EXISTS suppressions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel    TEXT CHECK (channel IS NULL OR channel IN ('email','sms','whatsapp','ai_call','linkedin')),
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two partial unique indexes, same idiom as prospect_inbox (migration 002):
-- NULLs aren't unique by default, so the "all channels" case needs its own
-- arbiter keyed on contact_id alone.
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppressions_contact_channel
  ON suppressions (contact_id, channel) WHERE channel IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppressions_contact_all_channels
  ON suppressions (contact_id) WHERE channel IS NULL;

CREATE INDEX IF NOT EXISTS idx_suppressions_company ON suppressions (company_id);
CREATE INDEX IF NOT EXISTS idx_suppressions_contact ON suppressions (contact_id);

CREATE TABLE IF NOT EXISTS tenant_channel_limits (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  channel            TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp','ai_call','linkedin')),
  max_per_hour       INTEGER CHECK (max_per_hour IS NULL OR max_per_hour > 0),
  max_per_day        INTEGER CHECK (max_per_day IS NULL OR max_per_day > 0),
  quiet_hours_start  SMALLINT CHECK (quiet_hours_start IS NULL OR quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end    SMALLINT CHECK (quiet_hours_end IS NULL OR quiet_hours_end BETWEEN 0 AND 23),
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_tenant_channel_limits_company ON tenant_channel_limits (company_id);

COMMIT;
