-- DenchClaw CRM — migration 005: Analytics — campaign_events + rollup table
-- Part 5 data model. The outreach engine emits events; the CRM aggregates.
-- Apply against `denchclaw`. Agent never runs on a live DB.

CREATE TABLE IF NOT EXISTS campaign_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT NOT NULL,
  campaign_id TEXT,
  contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel     TEXT,
  segment     TEXT,
  type        TEXT NOT NULL CHECK (type IN ('send','deliver','open','click','reply','bounce','unsub','suppressed')),
  metadata    JSONB DEFAULT '{}',
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_events_company  ON campaign_events (company_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_events_campaign ON campaign_events (company_id, campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_contact  ON campaign_events (contact_id);
CREATE INDEX IF NOT EXISTS idx_campaign_events_type     ON campaign_events (company_id, type);

-- Rollup table: keyed by (company_id, campaign_id, channel, segment, day).
-- Empty-string sentinel instead of NULL lets us use a simple UNIQUE constraint
-- (expression indexes can't be used as ON CONFLICT targets in PG < 15).
CREATE TABLE IF NOT EXISTS campaign_event_rollups (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT NOT NULL,
  campaign_id TEXT NOT NULL DEFAULT '',
  channel     TEXT NOT NULL DEFAULT '',
  segment     TEXT NOT NULL DEFAULT '',
  day         DATE NOT NULL,
  sends       INTEGER NOT NULL DEFAULT 0,
  delivers    INTEGER NOT NULL DEFAULT 0,
  opens       INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  replies     INTEGER NOT NULL DEFAULT 0,
  bounces     INTEGER NOT NULL DEFAULT 0,
  unsubs      INTEGER NOT NULL DEFAULT 0,
  mql_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company_id, campaign_id, channel, segment, day)
);

CREATE INDEX IF NOT EXISTS idx_rollups_company ON campaign_event_rollups (company_id, day DESC);
