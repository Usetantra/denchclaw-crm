-- DenchClaw CRM — Migration 019: step scheduler (CP2)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/019_step_scheduler.sql
--
-- CP2 closes the seam between an enrollment and the dispatcher's work queue:
-- until now nothing in server/ ever called sequences.scheduleAction(), so an
-- enrollment was a dead record and scheduled_actions was only ever written by
-- tests. Two schema changes support that:
--
--   1. sequence_steps.stage_writeback — the reporting stage this step mirrors
--      onto the pipeline when it is acked 'sent' (CP2 decision D4). Nullable
--      and NULL by default: a step that declares nothing writes nothing back,
--      which is every step that exists today. The write-back itself still goes
--      through CP1's mode gate — a manual stage is never set programmatically
--      (see server/db/models/dispatch.js) — so this column grants no authority
--      the stage machine doesn't already enforce.
--
--   2. UNIQUE (enrollment_id, step_id) on scheduled_actions — the idempotency
--      backstop for D8. It is what makes the next-step INSERT's
--      ON CONFLICT (enrollment_id, step_id) DO NOTHING legal, so a replayed
--      ack can never queue the same step twice.
--
-- Duplicate tolerance (D8): this migration is required to survive a database
-- that ALREADY contains duplicate (enrollment_id, step_id) rows. Rather than
-- creating the index concurrently (which cannot run inside this transaction
-- and would leave an INVALID index behind on failure), the duplicates are
-- de-duplicated FIRST, deterministically, keeping the row that represents the
-- most real-world progress: a row that was actually 'sent' outranks a
-- 'claimed' one, which outranks a terminal-but-unsent one, which outranks a
-- row still 'pending'. Ties break on created_at then id, so the outcome does
-- not depend on physical row order.
--
-- HONEST LIMIT: for a mixed pair the loser is the row that never got as far as
-- the winner, so deleting it loses nothing. But for a duplicate pair that BOTH
-- reached 'sent', one real send record IS deleted — the unique constraint
-- leaves no way to keep both. The send itself is still evidenced by the
-- contact_activity row each ack writes, so this costs audit precision in
-- scheduled_actions, not the knowledge that the message went out. The exposure
-- is small in practice: before CP2 nothing in server/ ever wrote this table
-- (sequences.scheduleAction had no server-side caller at all), so duplicate
-- sent pairs can only exist in a database that ran the test suites.

BEGIN;

-- 1. The write-back column. IF NOT EXISTS makes a re-run a no-op and leaves
--    every pre-existing sequence_steps row untouched (NULL = no write-back).
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS stage_writeback TEXT;

-- 2. De-duplicate before constraining. A no-op on a clean DB and on every
--    re-run (after the first pass there is nothing left with rn > 1).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY enrollment_id, step_id
           ORDER BY CASE status
                      WHEN 'sent'    THEN 0
                      WHEN 'claimed' THEN 1
                      WHEN 'failed'  THEN 2
                      WHEN 'skipped' THEN 3
                      ELSE 4              -- 'pending'
                    END,
                    created_at ASC,
                    id ASC
         ) AS rn
    FROM scheduled_actions
)
DELETE FROM scheduled_actions
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. The idempotency guard itself. IF NOT EXISTS keeps the second apply clean.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_actions_enrollment_step
  ON scheduled_actions (enrollment_id, step_id);

COMMIT;
