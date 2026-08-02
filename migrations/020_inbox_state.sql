-- DenchClaw CRM — Migration 020: inbox read/star state (CP-I)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/020_inbox_state.sql
--
-- CP-I turns `conversations` into an operator-facing Inbox. Two pieces of state
-- do not exist anywhere in the schema today and cannot be derived:
--
--   1. conversations.last_read_at — how far the operator has actually read.
--      NULL (the default, and every pre-CP-I row) means "never opened", so a
--      contact with any inbound message reads as unread on day one. That is the
--      correct default for an inbox nobody has triaged yet.
--
--      IMPORTANT, and the reason this is a per-CONVERSATION column rather than
--      a per-contact one: a contact holds one conversation PER CHANNEL, and
--      `uq_conversations_contact_channel` is a PARTIAL unique index
--      (`WHERE status <> 'closed'`, migrations/004), so a contact can also hold
--      many CLOSED email conversations alongside one open one. Unread is
--      computed across all of them, and opening a contact's thread stamps every
--      one of that contact's conversations — closed ones included, or their
--      messages would never clear.
--
--   2. conversations.starred — the one list filter that is genuinely user state
--      rather than derived. `Your turn`/`Their turn` are derived from the newest
--      message's direction and deliberately get NO column.
--
-- NOT NULL DEFAULT false on `starred` is safe on a populated table: Postgres 11+
-- stores the default in the catalog rather than rewriting every row.

BEGIN;

-- 1. How far the operator has read this conversation. NULL = never opened.
--    Stamped to max(created_at) of the messages actually returned by a thread
--    fetch — never to now(), which would swallow a message that arrived between
--    the fetch and the stamp and mark it read having never been rendered.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

-- 2. Operator-pinned conversations.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;

-- 3. The unread scan is "newest INBOUND message per conversation vs last_read_at",
--    evaluated across every conversation of a contact on every inbox load, so it
--    is the hottest query CP-I adds. This index serves it directly; the existing
--    idx_messages_conversation is (conversation_id, created_at DESC) with no
--    direction, so it cannot.
CREATE INDEX IF NOT EXISTS idx_messages_conv_direction_created
  ON messages (conversation_id, direction, created_at DESC);

-- 4. The list is contact-grouped and tenant-scoped, and joins conversations by
--    (company_id, contact_id) — the existing indexes cover each column alone.
CREATE INDEX IF NOT EXISTS idx_conversations_company_contact
  ON conversations (company_id, contact_id);

COMMIT;
