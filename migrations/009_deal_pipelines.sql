-- DenchClaw CRM — Migration 009: custom deal pipelines
-- Additive and idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -f migrations/009_deal_pipelines.sql
--
-- A deal now optionally names the pipeline it belongs to. NULL means the
-- built-in 'sales' pipeline (backward compatible — all existing deals, and the
-- prospect-claim auto-deal, stay on sales). Custom pipelines are stored as
-- company-scoped rows in crm_pipeline_configs (key != 'marketing'/'sales'),
-- reusing the existing getPipelineConfig loader and the (company_id, key)
-- unique index added in migration 003.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_key TEXT;
CREATE INDEX IF NOT EXISTS idx_deals_pipeline_key ON deals (company_id, pipeline_key);
