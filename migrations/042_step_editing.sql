-- DenchClaw CRM — migration 042: editable workflow steps
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/042_step_editing.sql
--
-- A saved workflow has been view-only since it shipped, and the reason was a
-- real hazard rather than missing time:
--
--     scheduled_actions.step_id UUID NOT NULL REFERENCES sequence_steps(id)
--       ON DELETE CASCADE                                    (migration 014)
--
-- So DELETing a step deletes every scheduled_action that ever pointed at it —
-- including rows with status='sent'. That is not "removing a step from a
-- ladder", it is erasing the record of messages already delivered to real
-- people: the audit trail, the per-contact history, and the dedupe that stops a
-- re-enrolled contact being messaged twice. The safe edit was therefore no edit.
--
-- THE FIX IS SOFT DELETE, NOT A WEAKER FOREIGN KEY.
--
-- `archived_at` retires a step from the ladder while its rows stay addressable,
-- so history survives by construction rather than by remembering to be careful.
-- The FK is deliberately left as CASCADE: a hard DELETE remains available for
-- the one case where it is genuinely correct (a step that has never fired, so
-- there is no history to lose), and the API refuses it otherwise.
--
-- The UNIQUE constraint has to move with it. `UNIQUE (sequence_id, step_order)`
-- counted archived rows, so archiving step 2 and renumbering the rest would
-- collide with the archived row still holding order 2. Making it partial means
-- retired steps keep their historical position without blocking the live ladder.

BEGIN;

ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- 014 declared this inline as UNIQUE (sequence_id, step_order), which Postgres
-- materialises as a constraint named sequence_steps_sequence_id_step_order_key.
ALTER TABLE sequence_steps DROP CONSTRAINT IF EXISTS sequence_steps_sequence_id_step_order_key;
DROP INDEX IF EXISTS sequence_steps_sequence_id_step_order_key;

-- The name MUST contain "step_order": routes/sequences.js maps a 23505 on this
-- table to a clean 409 by matching the CONSTRAINT NAME rather than the bare
-- error code (deliberately, so an unrelated future unique constraint here isn't
-- mislabelled as a step_order conflict). An index named anything else turns that
-- 409 back into a raw 500.
DROP INDEX IF EXISTS uq_sequence_steps_live_order;  -- interim name, never shipped
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequence_steps_live_step_order
  ON sequence_steps (sequence_id, step_order) WHERE archived_at IS NULL;

-- Every ladder query filters `archived_at IS NULL`; this keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_sequence_steps_live
  ON sequence_steps (sequence_id, step_order) WHERE archived_at IS NULL;

COMMIT;
