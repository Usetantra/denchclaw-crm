-- DenchClaw CRM Schema
-- Run against the `denchclaw` database as denchclaw_app user

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Contacts (11-stage CRM pipeline)
CREATE TABLE contacts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         TEXT NOT NULL,
  name               TEXT,
  email              TEXT,
  phone              TEXT,
  company_name       TEXT,
  title              TEXT,
  linkedin_url       TEXT,
  source             TEXT,
  lead_score         TEXT,
  lead_score_numeric INTEGER DEFAULT 0,
  deal_stage         TEXT DEFAULT 'lead',
  deal_value         NUMERIC DEFAULT 0,
  tags               TEXT[] DEFAULT '{}',
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  utm_content        TEXT,
  metadata           JSONB DEFAULT '{}',
  last_contacted     TIMESTAMPTZ,
  next_follow_up     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE INDEX idx_contacts_company       ON contacts (company_id);
CREATE INDEX idx_contacts_email         ON contacts (email);
CREATE INDEX idx_contacts_deal_stage    ON contacts (deal_stage);
CREATE INDEX idx_contacts_lead_score    ON contacts (lead_score);
CREATE INDEX idx_contacts_source        ON contacts (source);
CREATE INDEX idx_contacts_tags          ON contacts USING GIN (tags);
CREATE INDEX idx_contacts_stage         ON contacts (company_id, deal_stage);
CREATE INDEX idx_contacts_next_followup ON contacts (next_follow_up) WHERE next_follow_up IS NOT NULL;
CREATE INDEX idx_contacts_deleted_at    ON contacts (deleted_at) WHERE deleted_at IS NOT NULL;

-- Contact activity feed
CREATE TABLE contact_activity (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL,
  type          TEXT NOT NULL,
  message       TEXT,
  agent         TEXT,
  channel       TEXT,
  data          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  engagement_id UUID
);

CREATE INDEX idx_contact_activity_contact ON contact_activity (contact_id);
CREATE INDEX idx_contact_activity_company ON contact_activity (company_id);
CREATE INDEX idx_contact_activity_type    ON contact_activity (type);
CREATE INDEX idx_contact_activity_created ON contact_activity (created_at DESC);

-- Deals (pipeline)
CREATE TABLE deals (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL,
  contact_id     UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title          TEXT,
  value          NUMERIC DEFAULT 0,
  currency       TEXT DEFAULT 'USD',
  stage          TEXT DEFAULT 'lead',
  probability    INTEGER DEFAULT 0,
  source         TEXT,
  expected_close TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ,
  lost_reason    TEXT,
  notes          TEXT,
  metadata       JSONB DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_deals_company ON deals (company_id);
CREATE INDEX idx_deals_contact ON deals (contact_id);
CREATE INDEX idx_deals_stage   ON deals (stage);

-- Pipeline stage config (per company, optional)
CREATE TABLE crm_pipeline_configs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT,
  name        TEXT NOT NULL,
  stages      JSONB NOT NULL DEFAULT '[]',
  automations JSONB DEFAULT '[]',
  is_default  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
