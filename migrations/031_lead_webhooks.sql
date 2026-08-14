-- DenchClaw CRM — migration 031: inbound lead webhooks
-- Lets an external tool (Zapier, Make, a website form, a custom script) create
-- contacts by POSTing to a per-tenant, token-authenticated URL — no
-- INTERNAL_API_KEY required, so a no-code tool that can only send a plain
-- webhook (no custom headers) can still integrate. The token IS the auth
-- (mirrors the marketing public webhooks' shared-secret-in-URL pattern,
-- migrations/023) — long and random, rotatable, revocable per-webhook.
-- Operator-applied by design — the app never auto-migrates. Idempotent.

CREATE TABLE IF NOT EXISTS lead_webhooks (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  label          TEXT,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  default_source TEXT NOT NULL DEFAULT 'webhook',
  default_tags   TEXT[] NOT NULL DEFAULT '{}',
  request_count  INTEGER NOT NULL DEFAULT 0,
  last_used_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_webhooks_company ON lead_webhooks (company_id);
