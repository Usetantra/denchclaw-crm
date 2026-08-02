-- DenchClaw CRM — Migration 014: sequence data model (GOAL B1)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/014_sequences.sql
--
-- Multi-channel sequences per pipeline stage. Four tables, all company_id
-- FK'd to tenants(id) (migration 013 pattern) — sequenced after A2 precisely
-- so that FK exists:
--   sequences        — the template: named, optionally tied to a pipeline
--                       stage that triggers enrollment (B2's job).
--   sequence_steps   — ordered steps within a sequence: channel, delay,
--                       template, entry/exit conditions.
--   enrollments      — one contact's run through one sequence.
--   scheduled_actions — the dispatcher's (B3) work queue: one row per step
--                       due to fire for one enrollment. This is the backing
--                       store for B4's channel-executor contract — a
--                       scheduled_actions row IS a ChannelJob once B3 wires
--                       claim/ack to real routes instead of the reference
--                       mock in examples/mock-channel-jobs-server.mjs.
--
-- This migration is the DATA MODEL only (B1) — no HTTP routes, no dispatcher
-- logic (B3), no stage-triggered enrollment wiring (B2). Those are separate,
-- later roadmap items building on top of these tables.

BEGIN;

CREATE TABLE IF NOT EXISTS sequences (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL,
  pipeline_key  TEXT,   -- 'marketing' | 'sales' | NULL (not tied to a pipeline stage)
  trigger_stage TEXT,   -- the pipeline_key stage that auto-enrolls a contact (B2); NULL = manual-only
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sequences_company ON sequences (company_id);
CREATE INDEX IF NOT EXISTS idx_sequences_trigger
  ON sequences (company_id, pipeline_key, trigger_stage) WHERE trigger_stage IS NOT NULL;

CREATE TABLE IF NOT EXISTS sequence_steps (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Denormalized company_id (derivable via sequence_id -> sequences.company_id)
  -- kept anyway, matching every other tenant-scoped table in this codebase —
  -- a defense-in-depth layer so a future direct query against this table that
  -- forgets to join through sequences still can't cross a tenant boundary.
  company_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sequence_id      UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order       INTEGER NOT NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp','ai_call','linkedin')),
  delay_seconds    INTEGER NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0), -- offset from enrollment (step 1) or previous step's fire time
  template_ref     TEXT,
  entry_conditions JSONB NOT NULL DEFAULT '{}', -- e.g. {"tags_include": ["hot"]}; evaluated before firing
  exit_conditions  JSONB NOT NULL DEFAULT '{}', -- e.g. {"replied": true}; evaluated to skip/exit the sequence
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_order)
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_sequence ON sequence_steps (sequence_id, step_order);
CREATE INDEX IF NOT EXISTS idx_sequence_steps_company ON sequence_steps (company_id);

CREATE TABLE IF NOT EXISTS enrollments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sequence_id     UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_step_id UUID REFERENCES sequence_steps(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','exited')),
  exit_reason     TEXT,
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- One ACTIVE enrollment per (contact, sequence) — re-enrollment after
-- completion/exit is allowed (a new row), concurrent double-enrollment while
-- active is not.
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollments_active_contact_sequence
  ON enrollments (sequence_id, contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_enrollments_company ON enrollments (company_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_contact ON enrollments (contact_id);

CREATE TABLE IF NOT EXISTS scheduled_actions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  enrollment_id  UUID NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  step_id        UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp','ai_call','linkedin')),
  template_ref   TEXT,
  payload        JSONB NOT NULL DEFAULT '{}',
  scheduled_for  TIMESTAMPTZ NOT NULL,
  -- Mirrors docs/contracts/channel-executor.openapi.yaml's JobStatus enum
  -- (sent|failed|skipped) plus the two pre-claim states pending/claimed.
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','sent','failed','skipped')),
  claimed_by     TEXT,
  claimed_at     TIMESTAMPTZ,
  attempt        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_actions_company ON scheduled_actions (company_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_enrollment ON scheduled_actions (enrollment_id);
-- B3's claim query: pending jobs for one channel whose time has come, plus
-- stale 'claimed' rows past the reclaim timeout — this index covers both.
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_claimable
  ON scheduled_actions (channel, status, scheduled_for);

COMMIT;
