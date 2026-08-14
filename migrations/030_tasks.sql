-- DenchClaw CRM — migration 030: tasks (human follow-up reminders)
-- Separate from Sequences (automated, multi-channel, bot-sent) — a task is a
-- reminder for a HUMAN to do something, optionally auto-created when a
-- contact/deal LANDS on a pipeline stage configured with a `reminder_days`
-- value in its stage JSONB (crm_pipeline_configs.stages — no migration needed
-- for that half, it's additive JSONB). This is exactly the gap the operator's
-- own GOALS already named: "Deal followups are MANUAL — the 3/7/12-day
-- figures describe when a human should act, not timers" (.loop/GOALS.md) —
-- until now nothing surfaced that a human should act. Tasks does, without
-- ever auto-sending anything itself.
-- Operator-applied by design — the app never auto-migrates. Idempotent.

CREATE TABLE IF NOT EXISTS tasks (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          TEXT NOT NULL,
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id             UUID REFERENCES deals(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  notes               TEXT,
  due_at              TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  auto_generated      BOOLEAN NOT NULL DEFAULT false,
  source_pipeline_key TEXT,
  source_stage_key    TEXT,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_company_due
  ON tasks (company_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_contact
  ON tasks (contact_id, status);

-- At most one PENDING auto-generated task per (contact, deal, source stage) —
-- a contact re-entering the same stage (e.g. recycled) must not pile up
-- duplicate reminders. NULLS are not distinct for this purpose, so deal_id is
-- coalesced to a fixed sentinel UUID for contact-entity stages (no deal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_auto_pending
  ON tasks (contact_id, COALESCE(deal_id, '00000000-0000-0000-0000-000000000000'::uuid), source_stage_key)
  WHERE auto_generated = true AND status = 'pending';
