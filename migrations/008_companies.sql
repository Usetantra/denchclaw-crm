-- DenchClaw CRM — Migration 008: companies entity
-- Additive and idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -f migrations/008_companies.sql
--
-- A real employer/account entity. company_id is the TENANT id (same as every
-- other table); `name` is the account name, matched case-insensitively to
-- contacts.company_name to roll up contact_count + pipeline_value.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS companies (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  domain      TEXT,
  industry    TEXT,
  website     TEXT,
  size        TEXT,
  location    TEXT,
  notes       TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_companies_company ON companies (company_id);
CREATE INDEX IF NOT EXISTS idx_companies_name    ON companies (company_id, lower(name));
