-- DenchClaw CRM — migration 010: 'mql' campaign-event type
-- The rollup table has carried mql_count since 005 and /analytics reports
-- mqls + mql_rate, but no event type could increment it — the analytics MQL
-- metrics were stuck at 0. Engines now report an MQL conversion as a
-- campaign event of type 'mql'.
-- Apply against the `denchclaw` database. The agent never runs this on a live DB.

ALTER TABLE campaign_events DROP CONSTRAINT IF EXISTS campaign_events_type_check;
ALTER TABLE campaign_events ADD CONSTRAINT campaign_events_type_check
  CHECK (type IN ('send','deliver','open','click','reply','bounce','unsub','suppressed','mql'));
