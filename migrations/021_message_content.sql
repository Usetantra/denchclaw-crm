-- DenchClaw CRM — Migration 021: message content store (CP4a-0)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/021_message_content.sql
--
-- WHY THIS EXISTS, and why it blocks the email executor:
--
-- Until now there was nothing to send. `sequence_steps` carried only
-- `template_ref TEXT` — a bare label pointing at nothing — and
-- `sequences.scheduleAction`/`materializeNextStep` wrote `payload` as literally
-- '{}'::jsonb. No subject and no body existed anywhere in the schema. An
-- executor built on that would call Resend with subject defaulting to
-- '(no subject)' and text defaulting to '' (server/lib/email-resend.js), i.e.
-- deliver blank mail to real prospects — and a test suite asserting only that
-- `status` flipped pending → sent would go green while it happened.
--
-- So content comes first, and it comes with a hard rule the executor can rely
-- on: a queued job either carries resolved content, or it is explicitly marked
-- as carrying none. There is no third state, and no path where "" is mistaken
-- for a message.
--
-- TWO SOURCES, ONE PRECEDENCE (both are useful, ambiguity is not):
--   1. `sequence_steps.subject/body` — inline content for a one-off step.
--   2. `message_templates` — reusable content that `sequence_steps.template_ref`
--      resolves against, per tenant.
-- Inline content WINS when present. That order is enforced in exactly one place
-- (server/db/models/templates.js resolveStepContent) so the two can never
-- disagree, and it is asserted by test/unit-cp4a0-content.mjs.
--
-- TENANCY: templates are strictly per-tenant. Unlike crm_pipeline_configs there
-- is deliberately NO global (company_id IS NULL) fallback — a pipeline shape is
-- structural and safe to share, but message copy is tenant-authored content and
-- a shared default would be a cross-tenant content leak waiting to happen, and
-- would let one tenant's words go out under another's name.

BEGIN;

-- 1. Reusable message content, resolved by (company_id, ref).
--    `subject` is nullable because it is meaningless on chat-shaped channels
--    (WhatsApp/SMS/LinkedIn); `body` is NOT NULL because a message without a
--    body is the exact hazard this migration exists to prevent.
CREATE TABLE IF NOT EXISTS message_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  ref         TEXT NOT NULL,
  channel     TEXT CHECK (channel IS NULL OR channel IN ('email','sms','whatsapp','ai_call','linkedin')),
  subject     TEXT,
  -- btrim() with no arg strips SPACES only, so a body of E'\n\t' would pass a
  -- length(btrim(body)) > 0 check. Strip the real whitespace class instead.
  body        TEXT NOT NULL CHECK (btrim(body, E' \t\r\n') <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One template per (tenant, ref). This is what makes `template_ref` resolvable
-- deterministically instead of "whichever row happened to come back first".
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_templates_company_ref
  ON message_templates (company_id, ref);
CREATE INDEX IF NOT EXISTS idx_message_templates_company
  ON message_templates (company_id);

-- 2. Inline per-step content. Nullable, and NULL on every pre-existing row —
--    so this migration changes the behaviour of exactly nothing that already
--    exists; a step with no inline content simply falls through to its template.
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS body    TEXT;

-- 3. BACKFILL — the reason "additive" is not the same as "safe".
--    Every row queued before this migration has payload '{}' with NO
--    `content_resolved` key at all. That is a THIRD state, and it is the
--    dangerous one: an executor written as `if (payload.content_resolved ===
--    false) refuse` sees `undefined !== false` and SENDS — mailing exactly the
--    blank email this checkpoint exists to prevent, while the readiness index
--    below (which matches only the literal 'false') reports nothing wrong.
--    materializeNextStep's ON CONFLICT DO NOTHING guarantees these rows are
--    never upgraded in place either, so they must be marked here, once.
--    Marked unconditionally rather than only for pending rows, so the invariant
--    "every row states its content status" is absolute and checkable.
UPDATE scheduled_actions
   SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
         'content_resolved', false,
         'subject', NULL,
         'body', NULL,
         'content_error', 'queued before the message content store existed (migration 021); re-schedule this step to resolve its copy'
       )
 WHERE NOT (COALESCE(payload, '{}'::jsonb) ? 'content_resolved');

-- 4. Content is resolved and frozen INTO the job at schedule time, so the
--    executor reads one row and never has to reach around the claim/ack
--    contract to find out what to send. This index serves the operator-facing
--    readiness query ("which queued jobs would go out blank?"), which is the
--    check that has to be cheap enough to run on every dashboard load.
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_unresolved
  ON scheduled_actions (company_id, status)
  WHERE (payload->>'content_resolved') = 'false';

COMMIT;
