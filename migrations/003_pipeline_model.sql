-- DenchClaw CRM — migration 003: Named marketing+sales pipeline model (Option B)
-- Option B: contacts always live in the marketing pipeline; a Sales deal is a
-- separate `deals` row. A contact can simultaneously be "in nurture (marketing)"
-- and "in an open deal (sales)."
-- Apply against the `denchclaw` database. The agent never runs this on a live DB.

-- ── 1. Add stable key to crm_pipeline_configs ─────────────────────────────────
ALTER TABLE crm_pipeline_configs ADD COLUMN IF NOT EXISTS key TEXT;

-- Company-scoped overrides
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_configs_company_key
  ON crm_pipeline_configs (company_id, key) WHERE company_id IS NOT NULL;
-- Global defaults (company_id IS NULL — applies to all tenants without a custom config)
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_configs_global_key
  ON crm_pipeline_configs (key) WHERE company_id IS NULL;

-- ── 2. Add marketing_stage to contacts ────────────────────────────────────────
-- deal_stage keeps mirroring marketing_stage for backward-compat with verify_cp4.py.
-- Once the engine fully cuts over to POST /advance, deal_stage can be dropped.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marketing_stage TEXT NOT NULL DEFAULT 'sourced';

CREATE INDEX IF NOT EXISTS idx_contacts_marketing_stage
  ON contacts (company_id, marketing_stage) WHERE deleted_at IS NULL;

-- ── 3. Backfill existing contacts ─────────────────────────────────────────────
--   lead → sourced   (scrape/import, no enrichment yet)
--   contacted → engaged  (first outbound touch)
--   everything deeper → mql  (they reached sales consideration)
UPDATE contacts SET marketing_stage = CASE
  WHEN deal_stage = 'lead'      THEN 'sourced'
  WHEN deal_stage = 'contacted' THEN 'engaged'
  ELSE 'mql'
END;

-- ── 4. Seed global default pipeline configs ───────────────────────────────────
-- INSERT WHERE NOT EXISTS is idempotent on repeated runs.

INSERT INTO crm_pipeline_configs (company_id, key, name, is_default, stages, automations)
SELECT NULL, 'marketing', 'Marketing Pipeline', true,
  '[
    {"key":"sourced",   "label":"Sourced",   "transitions":["enriched","suppressed"]},
    {"key":"enriched",  "label":"Enriched",  "transitions":["segmented","suppressed"]},
    {"key":"segmented", "label":"Segmented", "transitions":["queued","nurture","suppressed"]},
    {"key":"queued",    "label":"Queued",    "transitions":["engaged","nurture","suppressed"]},
    {"key":"engaged",   "label":"Engaged",   "transitions":["responded","nurture","suppressed"]},
    {"key":"responded", "label":"Responded", "transitions":["mql","nurture","suppressed"]},
    {"key":"mql",       "label":"MQL",       "transitions":["nurture","suppressed"]},
    {"key":"nurture",   "label":"Nurture",   "transitions":["sourced","segmented","suppressed"]},
    {"key":"suppressed","label":"Suppressed","transitions":[]}
  ]'::jsonb,
  '[]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM crm_pipeline_configs WHERE key = 'marketing' AND company_id IS NULL
);

INSERT INTO crm_pipeline_configs (company_id, key, name, is_default, stages, automations)
SELECT NULL, 'sales', 'Sales Pipeline', true,
  '[
    {"key":"accepted",   "label":"Accepted",   "transitions":["contacted","unqualified","lost"]},
    {"key":"contacted",  "label":"Contacted",  "transitions":["qualified","no_show","unqualified","lost"]},
    {"key":"qualified",  "label":"Qualified",  "transitions":["proposal","unqualified","lost"]},
    {"key":"proposal",   "label":"Proposal",   "transitions":["negotiation","lost"]},
    {"key":"negotiation","label":"Negotiation","transitions":["onboarding","lost"]},
    {"key":"onboarding", "label":"Onboarding", "transitions":["won","lost"]},
    {"key":"won",        "label":"Won",        "transitions":[]},
    {"key":"lost",       "label":"Lost",       "transitions":["accepted"]},
    {"key":"no_show",    "label":"No Show",    "transitions":["contacted","lost"]},
    {"key":"unqualified","label":"Unqualified","transitions":["lost"]}
  ]'::jsonb,
  '[]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM crm_pipeline_configs WHERE key = 'sales' AND company_id IS NULL
);
