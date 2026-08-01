-- DenchClaw CRM — Migration 023: marketing stage ingestion (CP-B)
-- Additive/idempotent (applies cleanly twice). Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/023_marketing_ingestion.sql
--
-- WHY THIS EXISTS:
--
-- Migration 018 declared the webinar marketing pipeline — `prospects` (manual),
-- then `invitees`, `visits`, `registrants`, `auto_registrants`, `attendees`, all
-- five marked "automated". A goal-conformance audit then found that those five
-- stage keys appeared in ZERO server files. Nothing observed the world, so
-- nothing ever moved a contact into them. The funnel above `prospects` was a
-- diagram, not a mechanism.
--
-- The operator's definitions are what this schema has to make possible:
--   "Visits — invitees that have visited the landing pages FROM THE INVITES or
--    invite emails."
-- That is an ATTRIBUTION requirement, not a page-view counter. An anonymous hit
-- on the landing page is not a Visit, because it cannot be tied to an invitee.
-- So an invite is not merely "an email we sent" — it is a durable, per-contact,
-- per-channel link that a later hit can be traced back to. That is
-- `crm_invite_links`, and without it "Visits" is unimplementable rather than
-- merely unimplemented.
--
-- THREE TABLES, ONE JOB EACH:
--   crm_webinars         — the object the marketing funnel is ABOUT. The spec is
--                          explicit that these stages "are specifically for
--                          webinars"; registration and attendance are meaningless
--                          without knowing WHICH webinar.
--   crm_invite_links     — attribution. Turns a landing-page hit into a named
--                          invitee, per channel.
--   crm_marketing_events — the append-only observation log, and the ONLY place
--                          idempotency is enforced.
--
-- BORROWED (per the operator's instruction to reuse the engines rather than
-- reinvent): the event-log + dedupe-key shape is the nurturing engine's
-- `campaign_events` / `app/events.py` design — one canonical ingest, a
-- `dedupe_key` unique per tenant, and the rule that a dedupe conflict skips
-- EVERY side-effect rather than just the insert.

BEGIN;

-- ─── 1. Webinars ─────────────────────────────────────────────────────────────
-- Deliberately thin. This is not a webinar platform; it is the minimum identity
-- an event needs so that "registered" and "attended" mean something specific.
CREATE TABLE IF NOT EXISTS crm_webinars (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  key              TEXT NOT NULL CHECK (btrim(key, E' \t\r\n') <> ''),
  name             TEXT NOT NULL CHECK (btrim(name, E' \t\r\n') <> ''),
  scheduled_at     TIMESTAMPTZ,
  -- Where an invite link sends someone when no per-link destination is given.
  landing_page_url TEXT,
  status           TEXT NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','live','completed','cancelled')),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One webinar per (tenant, key) so `webinar_key` in an ingest payload resolves
-- deterministically instead of "whichever row came back first".
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_webinars_company_key
  ON crm_webinars (company_id, key);

-- ─── 2. Invite links — the attribution primitive ─────────────────────────────
-- Minted when an invite is recorded; redeemed by GET /m/i/:token. The token is
-- the ONLY thing that makes a later landing-page hit attributable to an invitee.
CREATE TABLE IF NOT EXISTS crm_invite_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  webinar_id      UUID NOT NULL REFERENCES crm_webinars(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Which invite channel this link went out on. The operator's spec says
  -- invitees are "sent invites on DIFFERENT CHANNELS", and Auto-Registrants are
  -- per-channel too — so the same person on the same webinar legitimately holds
  -- one link per channel, and a visit knows which invite earned it.
  channel         TEXT NOT NULL
                    CHECK (channel IN ('email','sms','whatsapp','linkedin','ai_call','calendar','content')),
  token           TEXT NOT NULL CHECK (length(token) >= 16),
  destination_url TEXT NOT NULL,
  visit_count     INTEGER NOT NULL DEFAULT 0,
  first_visited_at TIMESTAMPTZ,
  last_visited_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global, not per-tenant: the token arrives on a public URL with no tenant
-- context at all, so it must resolve on its own. A per-tenant unique index
-- would allow the same token to exist twice and make that lookup ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_invite_links_token
  ON crm_invite_links (token);
-- Re-recording the same invite is an update, not a second link — otherwise a
-- resend would mint a new token and the old (already-delivered) one would keep
-- pointing at a stale row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_invite_links_target
  ON crm_invite_links (company_id, webinar_id, contact_id, channel);
CREATE INDEX IF NOT EXISTS idx_crm_invite_links_contact
  ON crm_invite_links (company_id, contact_id);

-- ─── 3. Marketing events — the observation log ───────────────────────────────
CREATE TABLE IF NOT EXISTS crm_marketing_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  webinar_id  UUID REFERENCES crm_webinars(id) ON DELETE SET NULL,
  -- NULLABLE on purpose: an anonymous landing-page hit is a real observation we
  -- want to keep, and it is precisely the one that must NOT move a stage. If
  -- this column were NOT NULL we would have to either drop the event or invent
  -- a contact for it, and inventing one is how an unattributable hit turns into
  -- a fake Visit.
  contact_id  UUID REFERENCES contacts(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'invite_sent','landing_page_visit','registration',
                'calendar_rsvp','email_reply','content_comment',
                'attendance','no_show')),
  channel     TEXT CHECK (channel IS NULL OR channel IN (
                'email','sms','whatsapp','linkedin','ai_call','calendar','content','web')),
  dedupe_key  TEXT NOT NULL CHECK (btrim(dedupe_key, E' \t\r\n') <> ''),

  -- WHAT THE CRM DID ABOUT IT. NOT NULL, and there is no 'unknown' member.
  -- An event that moved nobody has to say WHY, or "the stage didn't move"
  -- becomes unexplainable from the data and every support question turns into a
  -- log grep. This column is the difference between an audit trail and a
  -- shrug — and it is what the tests assert, so a green test cannot mean
  -- "a row was written" while the funnel stood still.
  --   advanced       — the contact's stage actually changed
  --   no_change      — already at the target stage (idempotent re-observation)
  --   not_attributed — real observation, no identifiable contact (anonymous hit)
  --   not_interested — a reply/comment carrying no interest signal
  --   suppressed     — opt-out/suppression won; deliberately not advanced
  --   refused        — the stage authority said no (illegal transition, manual
  --                    stage, entry rule, suppression). `detail` carries which.
  --   error          — the ingest itself failed
  outcome     TEXT NOT NULL DEFAULT 'no_change' CHECK (outcome IN (
                'advanced','no_change','not_attributed','not_interested',
                'suppressed','refused','error')),
  from_stage  TEXT,
  to_stage    TEXT,
  detail      TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IDEMPOTENCY LIVES HERE, at the door, not in the callers (C3). Every adapter
-- derives a dedupe key; the unique index is what actually makes a replayed
-- provider delivery a no-op. Scoped per tenant like the outreach engine's
-- inbound namespace, so two tenants' provider ids can never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_marketing_events_dedupe
  ON crm_marketing_events (company_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_crm_marketing_events_contact
  ON crm_marketing_events (company_id, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_marketing_events_webinar
  ON crm_marketing_events (company_id, webinar_id, event_type);

COMMIT;
