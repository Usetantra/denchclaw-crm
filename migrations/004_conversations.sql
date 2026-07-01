-- DenchClaw CRM — migration 004: Unified AI Inbox — conversations + messages
-- Part 4 data model. Apply against `denchclaw`. Agent never runs on a live DB.

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      TEXT NOT NULL,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMPTZ,
  assignee        TEXT DEFAULT 'ai',
  intent          TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_company  ON conversations (company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact  ON conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status   ON conversations (company_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_channel  ON conversations (company_id, channel);
-- At most one open conversation per contact+channel (a new one opens after close)
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_contact_channel
  ON conversations (contact_id, channel) WHERE status != 'closed';

CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  company_id          TEXT NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel             TEXT NOT NULL,
  body                TEXT,
  ai_generated        BOOLEAN DEFAULT false,
  intent              TEXT,
  provider_message_id TEXT,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_company      ON messages (company_id, created_at DESC);
-- Dedup inbound provider events delivered more than once
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_provider_id
  ON messages (company_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
