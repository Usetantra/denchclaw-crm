-- DenchClaw CRM — migration 041: event triggers for workflows
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/041_workflow_event_triggers.sql
--
-- Migration 034 gave a workflow two ways to start: a pipeline stage, or a tag.
-- The tag was meant as a UNIVERSAL entry point — anything that can apply a tag
-- can start a workflow — which is why the builder's help text names lead
-- webhooks and other workflows as sources. That indirection is real and worth
-- keeping, but it costs the operator a step: to run a workflow when someone
-- registers for a webinar, they must first build something that tags them.
--
-- This adds a THIRD form: fire directly on a domain event the CRM already
-- raises. One column plus a JSONB config, rather than a column per event —
-- `sequences` would otherwise grow a nullable column and a wider CHECK every
-- time a new event is wired.
--
-- WHY A FIXED VOCABULARY IN A CHECK
--
-- Every value below has a REAL firing site in this codebase today; none is
-- aspirational. A trigger the UI offers but nothing ever fires is worse than an
-- absent one — the operator builds a workflow, tests it, sees nothing happen,
-- and has no way to tell a broken workflow from an unwired trigger. The CHECK
-- is what stops that drifting: adding a value here without a firing site is a
-- deliberate act, not an oversight.
--
--   contact_created    routes/crm.js  POST /contacts        (also the lead-webhook path)
--   reply_received     routes/conversations.js               (inbound message, deduped)
--   webinar_registered lib/marketing-events.js  registration
--   webinar_attended   lib/marketing-events.js  attendance
--   webinar_no_show    lib/marketing-events.js  no_show
--   unsubscribed       compliance route, Twilio STOP, Tantra email.unsubscribed
--
-- `trigger_config` is per-event narrowing, e.g. {"channel":"whatsapp"} on
-- reply_received. Empty means "any".

BEGIN;

ALTER TABLE sequences ADD COLUMN IF NOT EXISTS trigger_event  TEXT;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequences_trigger_event_known') THEN
    ALTER TABLE sequences ADD CONSTRAINT sequences_trigger_event_known
      CHECK (trigger_event IS NULL OR trigger_event IN (
        'contact_created','reply_received','webinar_registered',
        'webinar_attended','webinar_no_show','unsubscribed'
      ));
  END IF;
END $$;

-- Replace 034's two-way constraint with a three-way one. A workflow means ONE
-- thing: "fires on a stage AND independently on an event" is not a workflow an
-- operator can reason about, and the enrolment code would double-enrol.
ALTER TABLE sequences DROP CONSTRAINT IF EXISTS sequences_one_trigger;
ALTER TABLE sequences ADD CONSTRAINT sequences_one_trigger
  CHECK (
    (CASE WHEN trigger_stage IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN trigger_tag   IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN trigger_event IS NOT NULL THEN 1 ELSE 0 END) <= 1
  );

-- The lookup the firing sites do on every matching event.
CREATE INDEX IF NOT EXISTS idx_sequences_trigger_event
  ON sequences (company_id, trigger_event) WHERE trigger_event IS NOT NULL;

COMMIT;
