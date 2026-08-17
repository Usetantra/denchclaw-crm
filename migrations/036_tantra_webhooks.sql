-- DenchClaw CRM — migration 036: Tantra outbound webhook receiver
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/036_tantra_webhooks.sql
--
-- Tantra (usetantra.com) pushes typed events (email.sent, email.replied,
-- email.bounced, email.unsubscribed, lead.stage.changed, ...) to a webhook URL
-- configured in its own dashboard. Tantra's webhook has NO signature/API-key
-- auth of its own (confirmed against its docs: only User-Agent, X-Tantra-Event
-- and X-Webhook-Test headers are sent) — so, same as lead_webhooks, the
-- per-company token embedded in the URL path IS the entire auth story.
--
-- stage_map: Tantra's lead.stage.changed event names its OWN stage, which has
-- no documented fixed vocabulary (it's whatever stages the operator built in
-- Tantra). Rather than guess a mapping, the operator defines it here —
-- {"<tantra stage name>": "<our marketing_stage>"} — and an unmapped incoming
-- stage name is logged as an activity note instead of applied, so nothing
-- moves a contact based on a guess.

CREATE TABLE IF NOT EXISTS tantra_webhooks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  token         TEXT UNIQUE NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  stage_map     JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_count INT NOT NULL DEFAULT 0,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
