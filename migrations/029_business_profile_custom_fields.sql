-- DenchClaw CRM — migration 029: business profile + custom field definitions
-- Two independent, additive pieces for the Settings area:
--
--   1. business_profile — one row per company_id. Distinct from `tenants`
--      (migration 012, DenchClaw's own customer registry, admin-only) and from
--      `companies` (migration 008, an employer/account row INSIDE a tenant's
--      contacts) — this is "who we are" for the operator's own business
--      (name/industry/website/phone/timezone/currency/address), editable by
--      the tenant itself through a normal requireAuth route, not requireAdmin.
--
--   2. custom_field_definitions — named, typed fields an operator defines once
--      in Settings so the Contacts drawer can render a proper typed input
--      (select/date/number/checkbox) instead of every custom field being a
--      free-text key/value pair. Existing ad-hoc contacts.metadata.custom_fields
--      entries (CP-M2 UX pass) are NOT migrated into this table — they keep
--      working as free-text fallback rows for anything with no definition, so
--      nothing a user already typed is lost or silently reinterpreted.
--
-- Operator-applied by design — the app never auto-migrates. Idempotent.

CREATE TABLE IF NOT EXISTS business_profile (
  company_id  TEXT PRIMARY KEY,
  name        TEXT,
  industry    TEXT,
  website     TEXT,
  phone       TEXT,
  timezone    TEXT,
  currency    TEXT NOT NULL DEFAULT 'USD',
  address     JSONB NOT NULL DEFAULT '{}',   -- {street, city, state, postal_code, country}
  logo_url    TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- entity_type is forward-looking (contact today; company/deal are plausible
-- next targets) so the key namespace doesn't need renaming when that lands.
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'contact',
  key         TEXT NOT NULL,                  -- stored under metadata.custom_fields[key]
  label       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','number','date','select','checkbox')),
  options     JSONB NOT NULL DEFAULT '[]',    -- ["a","b"] — only meaningful for type='select'
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_field_company_entity_key
  ON custom_field_definitions (company_id, entity_type, key);
CREATE INDEX IF NOT EXISTS idx_custom_field_company
  ON custom_field_definitions (company_id, entity_type, position);
