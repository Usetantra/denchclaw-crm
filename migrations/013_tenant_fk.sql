-- DenchClaw CRM — Migration 013: enforce tenants FK (completes GOAL A2)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/013_tenant_fk.sql
--
-- Migration 012 introduced `tenants` as a registry but explicitly deferred
-- making it an FK target ("contacts.company_id etc. stay TEXT"). This
-- migration adds that FK to every company_id-bearing table, so an insert
-- with an unprovisioned tenant id fails loudly at the DB layer instead of
-- silently creating orphaned per-tenant data no tenant row describes.
--
-- Uses the standard low-lock-window pattern: ADD CONSTRAINT ... NOT VALID
-- (instant, no full-table scan) then VALIDATE CONSTRAINT (checks existing
-- rows under a lighter lock, does not block concurrent writes) — safe to run
-- against a live table with existing data, not just an empty scratch DB.
-- IDEMPOTENT: `ADD CONSTRAINT IF NOT EXISTS` is not supported for FKs in
-- Postgres, so each block checks pg_constraint first.
--
-- crm_pipeline_configs.company_id is nullable (global default configs have
-- company_id IS NULL) — a NULL always satisfies an FK regardless of matching
-- rows, so no special-casing is needed there.

BEGIN;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('contacts',               'fk_contacts_company'),
    ('contact_activity',       'fk_contact_activity_company'),
    ('deals',                  'fk_deals_company'),
    ('crm_pipeline_configs',   'fk_crm_pipeline_configs_company'),
    ('prospect_inbox',         'fk_prospect_inbox_company'),
    ('conversations',          'fk_conversations_company'),
    ('messages',               'fk_messages_company'),
    ('campaign_events',        'fk_campaign_events_company'),
    ('campaign_event_rollups', 'fk_campaign_event_rollups_company'),
    ('companies',              'fk_companies_company')
  ) AS x(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t.constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID',
        t.table_name, t.constraint_name
      );
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t.table_name, t.constraint_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
