-- DenchClaw CRM — Migration 024: the LinkedIn safety spine (CP-C2)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/024_linkedin_safety.sql
--
-- WHY THIS IS A MIGRATION AT ALL, when CP-C needed none.
--
-- SMS and WhatsApp needed no schema because their only real constraint is "did
-- the send leave?", which migration 022 already answers. LinkedIn is different
-- in kind: LinkedIn restricts ACCOUNTS, not messages, and the limits it enforces
-- are per connected identity, per day, per week, per outstanding invite, inside
-- a working window, in that identity's own timezone. None of that is derivable
-- from `scheduled_actions` as it stands, so the caps have nowhere to be counted
-- and the window has nowhere to be defined.
--
-- The shapes below are PORTED from the outreach engine's own migrations
-- (038-linkedin-accounts.sql, 039-linkedin-eligibility.sql), including its
-- reference caps, because those numbers were derived from a real SOP sheet and
-- an account restriction is not recoverable. Inventing our own would be exactly
-- the mistake the brief warned against.
--
-- WHAT IS DELIBERATELY *NOT* PORTED: upstream's `linkedin_send_log`. That table
-- is two things at once — a rate-limit ledger AND a reserve-before-send lease.
-- The CRM already has a reserve: the claim (`status='claimed'`/`claimed_by`) and
-- `send_started_at` from migration 022. Adding a second lease would mean two
-- independent reservations for one send, which is a duplicate-send bug waiting
-- for the two to disagree. So the ledger is `scheduled_actions` itself, and the
-- two columns added at the bottom are what make it countable per account.

BEGIN;

-- ─── 1. The connected LinkedIn identities ────────────────────────────────────
-- Per tenant, because caps are per ACCOUNT: two tenants sharing one account
-- share one daily allowance, and the schema has to be able to say so.
-- Ported from outreach-engine 038-linkedin-accounts.sql.
CREATE TABLE IF NOT EXISTS linkedin_accounts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account_id          TEXT NOT NULL,                       -- the Unipile account id
  provider            TEXT NOT NULL DEFAULT 'linkedin',
  dsn                 TEXT,                                -- per-account provider host, discovered post-connect
  display_name        TEXT,
  provider_id         TEXT,                                -- OUR member's own provider_id (filters webhook echoes)
  -- 'connected' is the ONLY status that may send. Anything else — paused by an
  -- operator, disconnected by LinkedIn, errored — stops sending at the claim
  -- door within one tick, which is the whole point of checking it per tick
  -- rather than at boot.
  status              TEXT NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected','disconnected','errored','paused')),
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  -- Reference caps from the engine's SOP sheet. Not guesses, and not ours to
  -- raise casually: 30 invite / 40 message / 20 InMail / 100 total per day.
  daily_invite_limit  INTEGER NOT NULL DEFAULT 30  CHECK (daily_invite_limit  >= 0),
  daily_message_limit INTEGER NOT NULL DEFAULT 40  CHECK (daily_message_limit >= 0),
  daily_inmail_limit  INTEGER NOT NULL DEFAULT 20  CHECK (daily_inmail_limit  >= 0),
  daily_total_limit   INTEGER NOT NULL DEFAULT 100 CHECK (daily_total_limit   >= 0),
  -- LinkedIn also enforces a weekly invite ceiling and punishes a large pile of
  -- outstanding unaccepted invites.
  weekly_invite_limit INTEGER NOT NULL DEFAULT 100 CHECK (weekly_invite_limit >= 0),
  max_pending_invites INTEGER NOT NULL DEFAULT 400 CHECK (max_pending_invites >= 0),
  active_start        TEXT NOT NULL DEFAULT '07:00',       -- HH:MM in `timezone`
  active_end          TEXT NOT NULL DEFAULT '18:00',
  -- A CORRECTION TO THE BRIEF, made explicit in the schema: the engine has TWO
  -- windows, not one. The 07:00–18:00 account window above is real, but the
  -- channel default (Tue/Wed/Thu 09:00–10:30) is narrower and is what actually
  -- binds. Both must pass, so the day-of-week half needs somewhere to live.
  -- The default here is weekdays, NOT Tue/Wed/Thu: shipping the narrow default
  -- would silently refuse to send on four days out of seven, which presents as
  -- a bug rather than as a safety limit. Operators narrow it deliberately.
  active_days         TEXT[] NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri'],
  -- Default-deny escape hatch for the connection-evidence gate below. Off by
  -- default; see server/lib/linkedin-gate.js for what turning it on gives up.
  allow_unverified_message BOOLEAN NOT NULL DEFAULT false,
  -- THE OPERATOR'S ASSERTION, and the gate refuses to send until it is true.
  -- The consolidation is phased, so the outreach engine may still be dispatching
  -- LinkedIn on this SAME identity — and it counts its sends in its own
  -- `linkedin_send_log`, which this system cannot read and which cannot read
  -- ours. Two systems each allowing 100 actions and 100 invites a week on one
  -- human's account is 200 of each, with both believing they are compliant, and
  -- that makes every other cap in this table worthless. No query answers it from
  -- inside the CRM, so it fails CLOSED until a human says so.
  engine_dispatch_disabled BOOLEAN NOT NULL DEFAULT false,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_linkedin_accounts_account
  ON linkedin_accounts (account_id);
CREATE INDEX IF NOT EXISTS idx_linkedin_accounts_company
  ON linkedin_accounts (company_id, status);

-- ─── 2. Per-prospect connection state — the accept gate's memory ─────────────
-- Ported from 038 + 039, with ONE deliberate change of key. Upstream keys this
-- on (campaign_id, contact_id). Whether we are connected to a person is a fact
-- about the RELATIONSHIP between our account and that person, not about the
-- campaign that happened to ask — so keying it per campaign means a second
-- sequence re-learns (and re-invites) someone we already know. Keyed on
-- (account_id, contact_id), the acceptance is learned once and every sequence
-- benefits.
CREATE TABLE IF NOT EXISTS linkedin_prospect_state (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  account_id        TEXT NOT NULL,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider_id       TEXT,                                  -- cached at invite time; webhook reverse-lookup
  public_identifier TEXT,
  linkedin_url      TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','invited','accepted','replied','abandoned','ineligible')),
  invite_sent_at    TIMESTAMPTZ,
  accepted_at       TIMESTAMPTZ,
  replied_at        TIMESTAMPTZ,
  -- From 039: the live connection facts. Ground truth for whether an action is
  -- LEGAL is the sending account's current relationship, never a CSV column.
  network_distance  TEXT,      -- FIRST_DEGREE | SECOND_DEGREE | THIRD_DEGREE | OUT_OF_NETWORK
  is_open_profile   BOOLEAN,
  can_send_inmail   BOOLEAN,
  ineligible_reason TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lps_account_contact
  ON linkedin_prospect_state (account_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_lps_provider ON linkedin_prospect_state (account_id, provider_id);
CREATE INDEX IF NOT EXISTS idx_lps_status   ON linkedin_prospect_state (company_id, status);
-- The pending-invite ceiling counts this, on every claim scan.
CREATE INDEX IF NOT EXISTS idx_lps_pending
  ON linkedin_prospect_state (account_id) WHERE status = 'invited';

-- ─── 3. The action a step performs ───────────────────────────────────────────
-- invite / message / inmail are three DIFFERENT actions with three different
-- caps and three different legality rules, so the ladder has to say which one a
-- step is. NULL means 'message' — and that default is safe in the one direction
-- that matters: a message to someone we have no evidence of being connected to
-- is REFUSED by the gate, whereas defaulting to 'invite' would have silently
-- fired connection requests at people the operator never meant to invite.
ALTER TABLE sequence_steps
  ADD COLUMN IF NOT EXISTS linkedin_action TEXT;
DO $$ BEGIN
  ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_linkedin_action_chk
    CHECK (linkedin_action IS NULL OR linkedin_action IN ('invite','message','inmail'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 4. What makes `scheduled_actions` a per-account ledger ──────────────────
-- Stamped by the claim door at the moment the job is claimed — which IS the
-- reservation. The gate then counts these rows instead of a second table:
--   * a live claim  = a reservation in flight (counts against the cap),
--   * send_started_at / sent_at = a send that physically left (counts),
--   * a released or stale claim stops counting on its own, which is exactly the
--     lease-TTL behaviour upstream had to implement by hand.
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS linkedin_account_id TEXT;
ALTER TABLE scheduled_actions ADD COLUMN IF NOT EXISTS linkedin_action     TEXT;

-- Cap counting runs on every LinkedIn claim scan and must not seq-scan.
CREATE INDEX IF NOT EXISTS idx_scheduled_actions_linkedin_ledger
  ON scheduled_actions (linkedin_account_id, linkedin_action, claimed_at)
  WHERE linkedin_account_id IS NOT NULL;

COMMIT;
