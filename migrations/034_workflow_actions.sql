-- DenchClaw CRM — migration 034: workflow actions + tag-triggered sequences
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/034_workflow_actions.sql
--
-- GHL-style "workflows" (trigger → ordered actions), built as an EXTENSION of
-- the existing sequence engine rather than a second execution system — a
-- workflow IS a sequence; what's new is (a) a non-message action a step can
-- perform instead of sending, and (b) a tag as an alternative enrollment
-- trigger alongside the existing pipeline-stage one. Reusing sequences means
-- every hard-won property of that engine (claim/reserve/ack, delay-from-
-- previous-step for a "wait" step, anchored/relative scheduling) applies to
-- workflow actions for free, instead of being re-earned by a parallel engine.
--
--   sequence_steps.action_type / action_config — set together, and only when
--   channel='action'. The dispatcher's 'action' provider performs the DB
--   write itself (add/remove tag, change stage, create a task, POST an
--   outbound webhook) instead of calling a message provider.
--
--   sequences.trigger_tag — an alternative to trigger_stage. A sequence has
--   AT MOST ONE of the two set, enforced below: a workflow means one thing,
--   not "fires on a stage AND independently on a tag".

BEGIN;

ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS action_type TEXT
  CHECK (action_type IS NULL OR action_type IN ('add_tag','remove_tag','change_stage','create_task','webhook_out'));
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS action_config JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_steps_channel_action_type') THEN
    ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_channel_action_type
      CHECK ((channel = 'action') = (action_type IS NOT NULL));
  END IF;
END $$;

-- Widen the channel vocabulary on both tables that gate it — sequence_steps
-- (authoring) and scheduled_actions (the dispatcher's queue) must agree, or a
-- step could be authored that the claim door then refuses to ever hand out.
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_channel_check;
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_channel_check
  CHECK (channel IN ('email','sms','whatsapp','ai_call','linkedin','action'));
ALTER TABLE scheduled_actions DROP CONSTRAINT IF EXISTS scheduled_actions_channel_check;
ALTER TABLE scheduled_actions ADD CONSTRAINT scheduled_actions_channel_check
  CHECK (channel IN ('email','sms','whatsapp','ai_call','linkedin','action'));

ALTER TABLE sequences ADD COLUMN IF NOT EXISTS trigger_tag TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequences_one_trigger') THEN
    ALTER TABLE sequences ADD CONSTRAINT sequences_one_trigger
      CHECK (trigger_stage IS NULL OR trigger_tag IS NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sequences_trigger_tag
  ON sequences (company_id, trigger_tag) WHERE trigger_tag IS NOT NULL;

COMMIT;
