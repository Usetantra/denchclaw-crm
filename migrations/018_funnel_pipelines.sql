-- DenchClaw CRM — Migration 018: funnel_type dimension + webinar pipeline seeds (CP1)
-- Additive/idempotent (applies cleanly twice). Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/018_funnel_pipelines.sql
--
-- Adds two columns to crm_pipeline_configs and seeds three GLOBAL
-- (company_id IS NULL) funnel-typed pipelines per .loop/PIPELINES_SPEC.md:
--   webinar_marketing (contacts) · webinar_sales (deals) · webinar_delivery (deals)
--
--   funnel_type — NULL for every pre-existing row (legacy 'marketing'/'sales'
--                 and mig-009 custom deal pipelines keep their exact runtime
--                 behavior); 'webinar' on the three seeded rows. The stage
--                 authorities (/advance, PATCH /deals/:id) only apply the new
--                 mode/transition gates to funnel-typed configs.
--   entity_type — which object a pipeline's stage lives on: 'contact'
--                 (contacts.marketing_stage) or 'deal' (deals.stage). Backfill
--                 marks every existing non-'marketing' row 'deal': the global
--                 'sales' row, company-scoped 'sales' overrides, and all
--                 mig-009 custom pipelines are deal pipelines (pipelines.js
--                 creates them deals-only).
--
-- Stage JSONB shape: {"key","label","mode","transitions"} (+"terminal":true).
--   mode 'auto'   = the CRM may set the stage programmatically (a human may too)
--   mode 'manual' = ONLY a human — the CRM must NEVER auto-advance into it.
--   Absent mode (all legacy rows) is treated as 'auto' by the readers.
-- Legacy rows' stages JSONB is NOT touched — byte-identical before/after.

BEGIN;

ALTER TABLE crm_pipeline_configs ADD COLUMN IF NOT EXISTS funnel_type TEXT;
ALTER TABLE crm_pipeline_configs ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'contact'
  CHECK (entity_type IN ('contact', 'deal'));

-- Backfill BEFORE seeding, and only over untyped (funnel_type IS NULL) rows —
-- on a re-run the seeded webinar_marketing row (key <> 'marketing' but
-- entity_type='contact') must NOT be flipped to 'deal'.
UPDATE crm_pipeline_configs SET entity_type = 'deal'
 WHERE key <> 'marketing' AND funnel_type IS NULL AND entity_type <> 'deal';

INSERT INTO crm_pipeline_configs (company_id, key, name, is_default, funnel_type, entity_type, stages, automations)
SELECT NULL, 'webinar_marketing', 'Webinar Marketing', false, 'webinar', 'contact',
  '[
    {"key":"prospects",        "label":"Prospects",        "mode":"manual", "transitions":["invitees"]},
    {"key":"invitees",         "label":"Invitees",         "mode":"auto",   "transitions":["visits","registrants","auto_registrants"]},
    {"key":"visits",           "label":"Visits",           "mode":"auto",   "transitions":["registrants","auto_registrants"]},
    {"key":"registrants",      "label":"Registrants",      "mode":"auto",   "transitions":["attendees"]},
    {"key":"auto_registrants", "label":"Auto-Registrants", "mode":"auto",   "transitions":["attendees"]},
    {"key":"attendees",        "label":"Attendees",        "mode":"auto",   "transitions":[]}
  ]'::jsonb,
  '[]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM crm_pipeline_configs WHERE key = 'webinar_marketing' AND company_id IS NULL
);

INSERT INTO crm_pipeline_configs (company_id, key, name, is_default, funnel_type, entity_type, stages, automations)
SELECT NULL, 'webinar_sales', 'Webinar Sales', false, 'webinar', 'deal',
  '[
    {"key":"qualification_form_fills", "label":"Qualification Form Fills", "mode":"auto",   "transitions":["scheduled_call","disqualified"]},
    {"key":"scheduled_call",           "label":"Scheduled Call",           "mode":"auto",   "transitions":["no_show_followup_1","proposal_sent","deals","disqualified"]},
    {"key":"no_show_followup_1",       "label":"No-Show Follow-up 1",      "mode":"manual", "transitions":["no_show_followup_2","scheduled_call","disqualified"]},
    {"key":"no_show_followup_2",       "label":"No-Show Follow-up 2",      "mode":"auto",   "transitions":["no_show_followup_3","scheduled_call","disqualified"]},
    {"key":"no_show_followup_3",       "label":"No-Show Follow-up 3",      "mode":"auto",   "transitions":["no_show_followup_4","scheduled_call","disqualified"]},
    {"key":"no_show_followup_4",       "label":"No-Show Follow-up 4",      "mode":"auto",   "transitions":["no_show_followup_5","scheduled_call","disqualified"]},
    {"key":"no_show_followup_5",       "label":"No-Show Follow-up 5",      "mode":"auto",   "transitions":["scheduled_call","disqualified"]},
    {"key":"proposal_sent",            "label":"Proposal Sent",            "mode":"manual", "transitions":["deals","disqualified"]},
    {"key":"disqualified",             "label":"Disqualified",             "mode":"auto",   "terminal":true, "transitions":[]},
    {"key":"deals",                    "label":"Deals",                    "mode":"manual", "transitions":["deal_followup_1","disqualified"]},
    {"key":"deal_followup_1",          "label":"Deal Follow-up 1",         "mode":"manual", "transitions":["deal_followup_2","disqualified"]},
    {"key":"deal_followup_2",          "label":"Deal Follow-up 2",         "mode":"manual", "transitions":["deal_followup_3","disqualified"]},
    {"key":"deal_followup_3",          "label":"Deal Follow-up 3",         "mode":"manual", "transitions":["disqualified"]}
  ]'::jsonb,
  '[]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM crm_pipeline_configs WHERE key = 'webinar_sales' AND company_id IS NULL
);

INSERT INTO crm_pipeline_configs (company_id, key, name, is_default, funnel_type, entity_type, stages, automations)
SELECT NULL, 'webinar_delivery', 'Webinar Delivery', false, 'webinar', 'deal',
  '[
    {"key":"onboarding",         "label":"Onboarding",         "mode":"manual", "transitions":["funnel_delivery"]},
    {"key":"funnel_delivery",    "label":"Funnel Delivery",    "mode":"manual", "transitions":["coaching_delivery"]},
    {"key":"coaching_delivery",  "label":"Coaching Delivery",  "mode":"manual", "transitions":["renewed","delivery_completed"]},
    {"key":"renewed",            "label":"Renewed",            "mode":"manual", "transitions":["funnel_delivery","coaching_delivery","delivery_completed"]},
    {"key":"delivery_completed", "label":"Delivery Completed", "mode":"manual", "terminal":true, "transitions":[]}
  ]'::jsonb,
  '[]'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM crm_pipeline_configs WHERE key = 'webinar_delivery' AND company_id IS NULL
);

COMMIT;
