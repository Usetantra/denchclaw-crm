-- DenchClaw CRM — Migration 022: send-attempt marker (CP4a rev 2)
-- Additive/idempotent.
--
-- This exists to answer ONE question that the schema could not answer before,
-- and on which "did we email a real human twice?" depends:
--
--   A job is sitting in 'claimed' past CLAIM_TIMEOUT_MS. Did the executor crash
--   BEFORE it called the provider (so the message never went out and we must
--   send), or AFTER the provider accepted it (so the mail is already in the
--   prospect's inbox and we must NOT send)?
--
-- Before this migration nothing distinguished those. `scheduled_actions` had no
-- attempt marker, the ack stashed the provider id in `contact_activity.data`
-- where the claim scan cannot see it, and the reclaim UPDATE did not even bump
-- `attempt`. The reclaim therefore re-served the row and the executor sent
-- again — up to MAX_ATTEMPTS physical duplicates for one logical message.
--
-- THE POLICY THIS ENCODES, stated plainly because it is a judgement call:
-- when the outcome of a physical send is UNKNOWN, the job is QUARANTINED, never
-- retried. For outreach, a duplicate email to a real prospect is worse than a
-- late one: the duplicate is irreversible and visibly broken to the recipient,
-- while the miss is recoverable by a human who can see the quarantine. So an
-- unknown outcome stops and asks, rather than guessing.

BEGIN;

-- Set (and COMMITTED) immediately BEFORE the provider call, so its presence on
-- a stale 'claimed' row proves the request left the building. The claim scan
-- treats such a row as untouchable — see dispatch.js.
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ;

-- Identifies ONE physical attempt. Doubles as the provider idempotency key, so
-- a provider that honours one collapses a retried request instead of sending
-- twice. Regenerated per attempt: a genuine second attempt after a definitive
-- rejection is a different message event and must not be deduplicated against
-- the first.
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS send_attempt_token UUID;

-- The provider's own id, on the row rather than only in contact_activity.data,
-- so the claim scan and any reconciliation can see it without a join.
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Quarantine. Set when the outcome could not be determined (timeout, socket
-- reset after the request left). The row stays 'claimed' forever by design —
-- it is deliberately NOT a state a scan will pick up again.
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS outcome_unknown_at TIMESTAMPTZ;
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS outcome_unknown_reason TEXT;

-- Quarantine review is an operator-facing list that must stay cheap.
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_quarantine
  ON scheduled_actions (company_id, outcome_unknown_at)
  WHERE outcome_unknown_at IS NOT NULL;

-- Finding "in-flight" rows during a claim scan must not seq-scan the table.
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_send_started
  ON scheduled_actions (company_id, channel)
  WHERE send_started_at IS NOT NULL;

COMMIT;
