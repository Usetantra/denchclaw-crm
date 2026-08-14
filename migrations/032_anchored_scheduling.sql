-- DenchClaw CRM — migration 032: anchored scheduling (F38)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/032_anchored_scheduling.sql
--
-- The scheduler has only ever known "delay from enrolment / previous step"
-- (migration 014's sequence_steps.delay_seconds). A reminder ladder anchored
-- to an external event — a webinar's start time, with rungs like "one week
-- before" and "one hour before" — cannot be expressed as a relative delay: the
-- gap between enrolling a late registrant and the event is shorter than the
-- ladder, and firing every already-past rung at once on the next tick would
-- blast several messages at a real prospect in one minute (see
-- .loop/DECISIONS_PENDING.md, F38).
--
-- enrollments.anchor_at is the external timestamp this ONE enrollment is
-- anchored to (e.g. the specific webinar occurrence the contact registered
-- for) — NULL for every ordinary sequence, unaffected by this migration.
-- sequence_steps.anchor_offset_seconds is signed: negative means "before the
-- anchor" (a reminder), positive means "after" (a post-event follow-up). A
-- step with anchor_offset_seconds NULL keeps behaving exactly as before —
-- delay_seconds from the previous step's fire time. A step cannot sensibly
-- mean both at once, enforced below.

BEGIN;

ALTER TABLE enrollments ADD COLUMN IF NOT EXISTS anchor_at TIMESTAMPTZ;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS anchor_offset_seconds INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sequence_steps_anchor_xor_delay'
  ) THEN
    -- Not "one or the other must be set" (delay_seconds defaults to 0, so an
    -- anchored step naturally has both a real anchor_offset_seconds AND the
    -- default 0 delay) — the real invariant is that a RELATIVE step's delay
    -- must never be silently ignored because it also carries a stray anchor
    -- offset. So: anchor_offset_seconds and a non-zero delay_seconds cannot
    -- coexist on one step.
    ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_anchor_xor_delay
      CHECK (anchor_offset_seconds IS NULL OR delay_seconds = 0);
  END IF;
END $$;

COMMIT;
