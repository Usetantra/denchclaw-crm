-- DenchClaw CRM — migration 027: channel compliance foundation (Phase A)
-- WhatsApp + SMS compliance-by-default: provable consent, a do-not-contact
-- suppression list, a template registry, connected-sender/registration state,
-- and per-message compliance/billing fields. Apply against `denchclaw`.
-- Operator-applied by design — the app never auto-migrates. Idempotent by structure.

-- ── Consent (per contact × channel × program) ─────────────────────────────────
-- The provable record required by WhatsApp opt-in policy, TCPA (US), GDPR (EU),
-- and India DPDP. consent_type is a one-way ladder: conversational < transactional
-- < marketing (a send may never use a weaker consent than its category requires).
CREATE TABLE IF NOT EXISTS channel_consent (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         TEXT NOT NULL,
  contact_id         UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL,                 -- 'whatsapp' | 'sms' | 'email' | …
  program            TEXT NOT NULL DEFAULT 'default',
  status             TEXT NOT NULL DEFAULT 'granted',  -- 'granted' | 'revoked' | 'pending'
  consent_type       TEXT NOT NULL DEFAULT 'transactional', -- conversational|transactional|marketing
  method             TEXT,                          -- web_form | keyword | checkbox | import | inbound
  source             TEXT,                          -- url / ip / campaign / free text
  disclosure_version TEXT,                          -- which opt-in wording was shown
  business_named     TEXT,                          -- business name disclosed at opt-in
  granted_at         TIMESTAMPTZ DEFAULT now(),
  revoked_at         TIMESTAMPTZ,
  metadata           JSONB DEFAULT '{}',
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_contact_channel_program
  ON channel_consent (contact_id, channel, program);
CREATE INDEX IF NOT EXISTS idx_consent_company ON channel_consent (company_id, channel);

-- ── Suppression / do-not-contact (source of truth) ────────────────────────────
-- Populated by STOP/opt-out webhooks, hard failures, landline/invalid detection,
-- and complaints. Checked as a HARD gate before every send. Keyed by the channel
-- identifier (phone E.164 / wa_id) so it works even without a resolved contact.
CREATE TABLE IF NOT EXISTS channel_suppression (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL,
  channel        TEXT NOT NULL,
  identifier     TEXT NOT NULL,                     -- phone E.164 or wa_id, lowercased/normalized
  contact_id     UUID REFERENCES contacts(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL DEFAULT 'opt_out',   -- opt_out | hard_fail | landline | invalid | complaint | manual
  scope          TEXT NOT NULL DEFAULT 'company',   -- company | sender | program
  suppressed_at  TIMESTAMPTZ DEFAULT now(),
  resubscribed_at TIMESTAMPTZ,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now()
);
-- Active suppression (not resubscribed) is unique per company+channel+identifier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppression_active
  ON channel_suppression (company_id, channel, identifier) WHERE resubscribed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_suppression_lookup ON channel_suppression (company_id, channel, identifier);

-- ── Message templates (WhatsApp via Twilio Content API; India-DLT SMS) ─────────
-- current_category may differ from submitted_category (Meta auto-recategorizes).
-- status gates sending: only APPROVED (and FLAGGED with warning) may send.
CREATE TABLE IF NOT EXISTS channel_message_templates (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  provider            TEXT DEFAULT 'twilio',
  provider_template_id TEXT,                        -- Twilio Content SID / Meta template id
  name                TEXT NOT NULL,
  language            TEXT NOT NULL DEFAULT 'en',
  category            TEXT NOT NULL DEFAULT 'UTILITY', -- MARKETING | UTILITY | AUTHENTICATION
  submitted_category  TEXT,
  current_category    TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT|PENDING|APPROVED|REJECTED|PAUSED|DISABLED|FLAGGED|ARCHIVED
  quality             TEXT,                          -- HIGH|MEDIUM|LOW|PENDING
  header              JSONB,                         -- {type:text|image|video|document|location, text?, example?}
  body                TEXT NOT NULL DEFAULT '',
  footer              TEXT,
  buttons             JSONB DEFAULT '[]',            -- [{type:quick_reply|url|phone_number|copy_code, ...}]
  variables           JSONB DEFAULT '[]',            -- [{name|index, example}]
  components           JSONB DEFAULT '{}',           -- raw provider component payload
  rejection_reason    TEXT,
  appeal_deadline     TIMESTAMPTZ,
  version             INTEGER NOT NULL DEFAULT 1,
  metadata            JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_template_name_lang
  ON channel_message_templates (company_id, channel, name, language);
CREATE INDEX IF NOT EXISTS idx_template_status ON channel_message_templates (company_id, status);

-- Version history — every edit snapshots the prior definition.
CREATE TABLE IF NOT EXISTS channel_message_template_versions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id  UUID NOT NULL REFERENCES channel_message_templates(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  snapshot     JSONB NOT NULL,                       -- full template definition at this version
  status       TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_template_versions ON channel_message_template_versions (template_id, version DESC);

-- ── Connected senders / registration state (per channel) ──────────────────────
-- Replaces the env-only CHANNEL_SENDERS. Holds provider identifiers plus the
-- registration/quality state the pre-send gate needs (WA number status + quality
-- + tier; Twilio Messaging Service + A2P brand/campaign + trust score; India DLT).
CREATE TABLE IF NOT EXISTS channel_senders (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           TEXT NOT NULL,
  channel              TEXT NOT NULL,                -- whatsapp | sms | email | linkedin
  provider             TEXT,                         -- twilio | resend | unipile | …
  identifier           TEXT NOT NULL,                -- E.164 number / wa phone-number-id / from address
  label                TEXT,
  is_default           BOOLEAN DEFAULT false,
  country              TEXT,                         -- ISO-2 the sender serves/registered in
  registration_status  TEXT DEFAULT 'pending',       -- pending|approved|rejected|connected|verified
  quality_rating       TEXT,                         -- WA: GREEN|YELLOW|RED
  messaging_tier       TEXT,                         -- WA portfolio tier
  trust_score          INTEGER,                      -- Twilio A2P trust score
  daily_cap            INTEGER,                      -- e.g. T-Mobile daily cap
  messaging_service_sid TEXT,                        -- Twilio Messaging Service SID
  brand_id             TEXT,                         -- A2P brand
  campaign_id          TEXT,                         -- A2P campaign
  dlt_entity_id        TEXT,                         -- India DLT PE / Entity id
  metadata             JSONB DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sender_identifier
  ON channel_senders (company_id, channel, identifier);
CREATE INDEX IF NOT EXISTS idx_sender_company ON channel_senders (company_id, channel);

-- ── Extend messages with compliance / billing fields ──────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS encoding         TEXT;          -- GSM-7 | UCS-2
ALTER TABLE messages ADD COLUMN IF NOT EXISTS segments         INTEGER;       -- SMS segment count
ALTER TABLE messages ADD COLUMN IF NOT EXISTS billing_category TEXT;          -- WA: marketing|utility|authentication|service
ALTER TABLE messages ADD COLUMN IF NOT EXISTS window_state     TEXT;          -- in_window | out_of_window | free_entry_point
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_send_key  TEXT;          -- app-side idempotency key
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_status  TEXT;          -- queued|sent|delivered|read|failed|undelivered
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_code       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_class      TEXT;          -- retryable|suppress|config_fix|window_expired
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_id      UUID;          -- FK-ish → channel_message_templates.id
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client_send_key
  ON messages (company_id, client_send_key) WHERE client_send_key IS NOT NULL;

-- ── Extend contacts with channel-identity + WhatsApp window fields ─────────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS wa_id                     TEXT;  -- WhatsApp id (from inbound)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS cs_window_expires_at      TIMESTAMPTZ; -- WA 24h customer-service window
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_line_type           TEXT;  -- mobile|landline|voip|… (Twilio Lookup)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_valid               BOOLEAN;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_checked_at          TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS destination_country       TEXT;  -- ISO-2 for regional policy
CREATE INDEX IF NOT EXISTS idx_contacts_wa_id ON contacts (company_id, wa_id) WHERE wa_id IS NOT NULL;
