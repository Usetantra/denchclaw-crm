-- DenchClaw CRM — migration 007: no_show → booked transition
-- The docs specify no_show.transitions = ["contacted","booked","lost"].
-- Migration 006 dropped "booked" based on Codex loop-safety concern, but the
-- authoritative spec requires it: a no-show can be directly rebooked without
-- forcing another contacted cycle. Apply against `denchclaw` DB.

UPDATE crm_pipeline_configs
SET stages = (
  SELECT jsonb_agg(
    CASE
      WHEN s->>'key' = 'no_show'
        THEN jsonb_set(s, '{transitions}', '["contacted","booked","lost"]')
      ELSE s
    END
  )
  FROM jsonb_array_elements(stages) AS s
)
WHERE key = 'sales' AND company_id IS NULL;
