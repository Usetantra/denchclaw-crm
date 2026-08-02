-- DenchClaw CRM — Migration 017: per-tenant API keys (GOAL A3)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/017_tenant_api_keys.sql
--
-- Moves key->company binding out of the INTERNAL_API_KEYS env blob into a
-- real table. A key's hash (never the plaintext) is stored; key_prefix is
-- kept in cleartext (first 12 chars) so an operator can identify a key in a
-- UI/list without ever re-deriving or storing the secret itself.
-- Back-compat: auth.js keeps the env-based INTERNAL_API_KEYS path as a
-- fallback during cutover — this table is consulted FIRST, and only an
-- unmatched key falls through to the legacy env map.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_api_keys (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  label        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_company ON tenant_api_keys (company_id);
-- The hot-path lookup (every authenticated request) is by key_hash; UNIQUE
-- above already creates a btree index for it, no separate index needed.

COMMIT;
