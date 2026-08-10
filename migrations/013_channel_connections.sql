-- DenchClaw CRM — migration 013: per-company channel provider connections
-- Stores a company's connection to a messaging provider (e.g. Twilio) so channels
-- can be connected self-serve from Settings and scale to multi-tenant. Provider
-- secrets are stored ENCRYPTED (AES-256-GCM via server/lib/crypto-box.js) in
-- credentials_enc — never in plaintext. Apply against `denchclaw`. Idempotent.

CREATE TABLE IF NOT EXISTS channel_connections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       TEXT NOT NULL,
  provider         TEXT NOT NULL,                 -- 'twilio' | …
  account_ref      TEXT,                          -- non-secret account identifier (e.g. Twilio Account SID) for display
  credentials_enc  TEXT,                          -- AES-256-GCM ciphertext of the secret bundle
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | connected | invalid | disconnected
  verified_at      TIMESTAMPTZ,
  last_error       TEXT,
  metadata         JSONB DEFAULT '{}',
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_connection
  ON channel_connections (company_id, provider);
