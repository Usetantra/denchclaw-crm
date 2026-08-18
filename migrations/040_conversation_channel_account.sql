-- DenchClaw CRM — migration 040: per-account conversations (Decision B / B3)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/040_conversation_channel_account.sql
--
-- WHY THIS IS NOT OPTIONAL
--
-- Decision B is B3: two WhatsApp numbers, split by purpose — cold outreach on
-- Tantra's Unipile number, webinar reminders and manual follow-up on the CRM's
-- Twilio number. That is not a preference; one number cannot do both. The two
-- systems sit on different WhatsApp platforms (Business Platform registration
-- moves a number OFF the consumer app, which is exactly what Unipile pairs
-- against), Tantra has no cold-start send route to carry our reminders, and a
-- first cold message on the Business Platform needs an approved template that
-- cold prospecting does not get. See docs/TANTRA_INTEGRATION_PLAN.md §2.4.
--
-- The consequence is that ONE CONTACT NOW HAS TWO OPEN WHATSAPP CONVERSATIONS,
-- and migration 004's partial unique index forbids exactly that:
--     UNIQUE (contact_id, channel) WHERE status != 'closed'
-- The second insert fails. So the uniqueness grain has to gain the account.
--
-- WHY A NOT NULL DEFAULT '' COLUMN RATHER THAN A NULLABLE ONE
--
-- Two live code paths create conversations with an inference clause that must
-- match this index EXACTLY (routes/conversations.js, routes/inbox.js):
--     ON CONFLICT (contact_id, channel) WHERE status != 'closed'
-- An expression index over COALESCE(channel_account,'') would force both to
-- restate that expression verbatim, and any drift is not a silent bug — it is
-- "no unique or exclusion constraint matching the ON CONFLICT specification",
-- i.e. a 500 on every conversation create, which would take down the inbox and
-- the existing Tantra webhook path together. A NOT NULL DEFAULT '' column keeps
-- the inference a plain column list. '' means "the CRM's own account", which is
-- what every pre-existing row is.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_account TEXT NOT NULL DEFAULT '';

-- Old rows are all CRM-owned and already carry '' from the DEFAULT, so the new
-- index is strictly wider than the old one and cannot fail on existing data.
DROP INDEX IF EXISTS uq_conversations_contact_channel;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_contact_channel_account
  ON conversations (contact_id, channel, channel_account) WHERE status <> 'closed';

-- The inbox groups by CONTACT, not by conversation, so both accounts' history
-- already collapses into one thread with no query change. This index supports
-- resolving "which conversation does this Tantra thread belong to".
CREATE INDEX IF NOT EXISTS idx_conversations_channel_account
  ON conversations (company_id, channel, channel_account);

-- Which external thread a conversation mirrors. Lets the sweep find the
-- conversation for a Tantra thread without re-resolving the contact every time,
-- and makes "this row is mirrored, do not send on it from here" checkable.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS external_system TEXT;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS external_thread_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_external_thread
  ON conversations (company_id, external_system, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
