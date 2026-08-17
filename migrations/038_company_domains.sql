-- DenchClaw CRM — migration 038: per-tenant custom sending/receiving domains
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/038_company_domains.sql
--
-- Self-serve "connect your own domain" (the multi-tenant SaaS requirement —
-- DenchClaw CRM is not single-tenant software). A domain here is a resource
-- REGISTERED IN OUR Resend ACCOUNT on the tenant's behalf via the Resend
-- domains API (POST /domains) — we never touch the tenant's actual DNS
-- ourselves, we only hand back the DKIM/SPF/MX records Resend generates for
-- them to paste into whatever DNS provider they use. resend_domain_id is the
-- join key back to Resend for every subsequent call (verify/update/delete).
--
-- One domain can only ever belong to one tenant (UNIQUE on domain) — Resend
-- itself would reject a literal duplicate anyway, but the unique index gives
-- a clear in-app error instead of a raw upstream 409.

CREATE TABLE IF NOT EXISTS company_domains (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain            TEXT NOT NULL,
  resend_domain_id  TEXT NOT NULL,
  region            TEXT NOT NULL DEFAULT 'us-east-1',
  -- Resend's own status vocabulary: not_started | pending | verified | failed | temporary_failure
  status            TEXT NOT NULL DEFAULT 'pending',
  receiving_enabled BOOLEAN NOT NULL DEFAULT false,
  records           JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_domains_domain ON company_domains (lower(domain));
CREATE INDEX IF NOT EXISTS idx_company_domains_company ON company_domains (company_id);
