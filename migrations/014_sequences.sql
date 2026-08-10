-- DenchClaw CRM — Migration 014: multi-channel sequences per pipeline stage (Goal B1)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/014_sequences.sql
--
-- The automation backbone: a sequence is an ordered list of channel steps a
-- contact walks through after a trigger (usually entering a pipeline stage). The
-- dispatcher (B3) ticks `sequence_scheduled_actions` and emits one channel job per
-- due step, applying quiet-hours/throttle/suppression centrally. Everything is
-- company_id-scoped (TEXT, matching every other table — a tenants FK arrives with
-- A2). Operator-applied by design; the app never auto-migrates.

-- ── Sequences ─────────────────────────────────────────────────────────────────
-- A named, versioned automation. trigger_pipeline_key + trigger_stage drive
-- stage-triggered enrollment (B2); a NULL trigger means enroll-only-by-API.
CREATE TABLE IF NOT EXISTS sequences (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           TEXT NOT NULL,
  name                 TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'draft',   -- draft | active | paused | archived
  trigger_pipeline_key TEXT,                            -- which pipeline (NULL = built-in sales / marketing)
  trigger_stage        TEXT,                            -- stage whose entry auto-enrolls (NULL = manual/API only)
  quiet_hours          JSONB DEFAULT '{}',              -- { tz, start:"20:00", end:"08:00" } — no sends inside
  entry_conditions     JSONB DEFAULT '{}',              -- optional predicate (tags, source, score) to gate enrollment
  exit_conditions      JSONB DEFAULT '{}',              -- e.g. { on_reply:true, on_stage_change:true }
  allow_reenroll       BOOLEAN NOT NULL DEFAULT false,  -- may a contact enter again after completing/exiting?
  metadata             JSONB DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequences_name ON sequences (company_id, name);
CREATE INDEX IF NOT EXISTS idx_sequences_trigger
  ON sequences (company_id, trigger_pipeline_key, trigger_stage) WHERE status = 'active';

-- ── Sequence steps ────────────────────────────────────────────────────────────
-- Ordered steps. delay_minutes is the wait BEFORE this step fires, measured from
-- the prior step's send (step 1's delay is measured from enrollment). channel
-- 'wait' is a pure delay with no send. template_id references an approved template
-- (required for out-of-window WhatsApp / India SMS — enforced at send by the gate).
CREATE TABLE IF NOT EXISTS sequence_steps (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sequence_id    UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  company_id     TEXT NOT NULL,
  step_order     INTEGER NOT NULL,                      -- 1-based position
  channel        TEXT NOT NULL,                         -- email | whatsapp | sms | linkedin | wait
  delay_minutes  INTEGER NOT NULL DEFAULT 0,            -- wait before this step (from prior step / enrollment)
  template_id    UUID,                                  -- → message_templates.id (optional)
  subject        TEXT,                                  -- email subject / free-form
  body           TEXT,                                  -- free-form body (when no template)
  category       TEXT,                                  -- message category for the compliance gate (marketing/utility/…)
  conditions     JSONB DEFAULT '{}',                    -- optional per-step skip predicate
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_step_order ON sequence_steps (sequence_id, step_order);
CREATE INDEX IF NOT EXISTS idx_sequence_steps_seq ON sequence_steps (company_id, sequence_id);

-- ── Enrollments ───────────────────────────────────────────────────────────────
-- One contact's journey through one sequence. current_step is the last COMPLETED
-- step (0 = not started). next_action_at is when the next step is due (mirrors the
-- head scheduled_action for quick queries). Only one ACTIVE enrollment per
-- (sequence, contact) — re-enrollment is allowed only when the sequence permits.
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL,
  sequence_id    UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active',        -- active | completed | exited | paused
  current_step   INTEGER NOT NULL DEFAULT 0,
  enrolled_at    TIMESTAMPTZ DEFAULT now(),
  next_action_at TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  exit_reason    TEXT,                                  -- replied | stage_changed | suppressed | manual | finished
  enrolled_by    TEXT,                                  -- 'stage_trigger' | 'api' | user id
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollment_active
  ON sequence_enrollments (sequence_id, contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enrollments_contact ON sequence_enrollments (company_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_due
  ON sequence_enrollments (company_id, next_action_at) WHERE status = 'active';

-- ── Scheduled actions (the dispatcher's work queue) ───────────────────────────
-- One row per step that must fire for an enrollment. The dispatcher claims due
-- rows (run_at <= now, status='pending'), sends via the channel adapter behind the
-- compliance gate, and records the outcome. dedupe_key makes enqueue idempotent so
-- a retried tick never double-schedules the same step.
CREATE TABLE IF NOT EXISTS sequence_scheduled_actions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL,
  enrollment_id  UUID NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
  sequence_id    UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_id        UUID REFERENCES sequence_steps(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_order     INTEGER NOT NULL,
  channel        TEXT NOT NULL,
  run_at         TIMESTAMPTZ NOT NULL,                  -- when this step becomes due
  status         TEXT NOT NULL DEFAULT 'pending',       -- pending | sent | failed | skipped | canceled
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  dedupe_key     TEXT,                                  -- company:enrollment:step — idempotent enqueue
  result         JSONB DEFAULT '{}',                    -- provider ids / gate decision / skip reason
  claimed_at     TIMESTAMPTZ,                           -- set when a dispatcher tick takes the row
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_dedupe
  ON sequence_scheduled_actions (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- The dispatcher's hot path: due, pending work in run order.
CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON sequence_scheduled_actions (status, run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_enrollment
  ON sequence_scheduled_actions (company_id, enrollment_id);
