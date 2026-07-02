-- DenchClaw CRM — migration 006: Pipeline stage-map corrections
-- Corrects the JSONB transition maps seeded by migration 003.
-- Uses UPDATE (not WHERE NOT EXISTS) because the rows already exist.
-- Apply against the `denchclaw` database. The agent never runs this on a live DB.
--
-- Changes vs 003:
--   Marketing: sourced gains direct →segmented path; nurture drops →sourced (no re-enrichment)
--   Sales: add booked stage; accepted drops unqualified early-exit; contacted routes to booked first;
--          no_show loses direct →booked (must go through contacted); unqualified gains →nurture;
--          nurture declared as a proper stage (→contacted, lost) — not a dangling reference

UPDATE crm_pipeline_configs
SET stages = '[
  {"key":"sourced",   "label":"Sourced",   "transitions":["enriched","segmented","suppressed"]},
  {"key":"enriched",  "label":"Enriched",  "transitions":["segmented","suppressed"]},
  {"key":"segmented", "label":"Segmented", "transitions":["queued","nurture","suppressed"]},
  {"key":"queued",    "label":"Queued",    "transitions":["engaged","nurture","suppressed"]},
  {"key":"engaged",   "label":"Engaged",   "transitions":["responded","nurture","suppressed"]},
  {"key":"responded", "label":"Responded", "transitions":["mql","nurture","suppressed"]},
  {"key":"mql",       "label":"MQL",       "transitions":["nurture","suppressed"]},
  {"key":"nurture",   "label":"Nurture",   "transitions":["segmented","suppressed"]},
  {"key":"suppressed","label":"Suppressed","transitions":[]}
]'::jsonb
WHERE key = 'marketing' AND company_id IS NULL;

UPDATE crm_pipeline_configs
SET stages = '[
  {"key":"accepted",    "label":"Accepted",    "transitions":["contacted","lost"]},
  {"key":"contacted",   "label":"Contacted",   "transitions":["booked","unqualified","nurture","lost"]},
  {"key":"booked",      "label":"Booked",      "transitions":["qualified","no_show","contacted"]},
  {"key":"qualified",   "label":"Qualified",   "transitions":["proposal","unqualified","nurture","lost"]},
  {"key":"proposal",    "label":"Proposal",    "transitions":["negotiation","nurture","lost"]},
  {"key":"negotiation", "label":"Negotiation", "transitions":["onboarding","lost"]},
  {"key":"onboarding",  "label":"Onboarding",  "transitions":["won","lost"]},
  {"key":"won",         "label":"Won",         "transitions":[]},
  {"key":"lost",        "label":"Lost",        "transitions":["accepted"]},
  {"key":"no_show",     "label":"No Show",     "transitions":["contacted","lost"]},
  {"key":"unqualified", "label":"Unqualified", "transitions":["nurture","lost"]},
  {"key":"nurture",     "label":"Nurture",     "transitions":["contacted","lost"]}
]'::jsonb
WHERE key = 'sales' AND company_id IS NULL;
