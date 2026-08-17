-- DenchClaw CRM — migration 037: WebinarGeek sync dedupe state
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/037_webinargeek_sync_state.sql
--
-- WebinarGeek's API v2 (webinargeek.docs.apiary.io) has NO webhooks — it is
-- pull-only, confirmed by grepping the full API Blueprint for "webhook" and
-- finding nothing. So unlike Tantra, there is no inbound route here: an
-- operator triggers "Sync now" (Settings → Integrations → WebinarGeek), which
-- pulls GET /subscriptions for a chosen broadcast using their stored API key
-- (server/db/models/channels.js, provider='webinargeek' — reuses the existing
-- encrypted channel_connections table rather than a new one for the key).
--
-- This table exists purely so a repeat sync doesn't re-log the same
-- registration (or the same attendance) as a fresh activity + re-score it
-- every time the button is clicked — one row per (company, WebinarGeek
-- subscription id), remembering the last known watched state.

CREATE TABLE IF NOT EXISTS webinargeek_synced_subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id BIGINT NOT NULL,
  contact_id      UUID,
  watched         BOOLEAN NOT NULL DEFAULT false,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, subscription_id)
);
