-- DenchClaw CRM — migration 033: user accounts (agency + team members)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/033_users_auth.sql
--
-- Before this, "auth" meant one shared X-Internal-Key + a client-supplied
-- X-Company-Id header — fine for server-to-server/automation callers, but it
-- has no notion of a PERSON: no login, no per-user profile, no way to have
-- several people work the same company's data under their own identity. This
-- adds that layer ON TOP of the existing header-based trust, not instead of
-- it — see server/middleware/auth.js's session-cookie handling. The internal
-- key remains the infrastructure-level gate (is this caller allowed to talk
-- to the API at all — tests, webhooks, and automation never get a session);
-- a session identifies WHO within that, and its company_id overrides whatever
-- X-Company-Id a browser might also send, so a logged-in user can never hop
-- into another tenant's data by editing a header.
--
--   users          — one company_id per person (agency + team members "in the
--                    same company", per the operator's own framing — not
--                    cross-tenant accounts).
--   user_invites   — email-scoped, single-use, expiring. Only an
--                    owner/admin can create one (server/routes/auth.js).
--   user_sessions  — server-side revocable sessions. token_hash only, same
--                    pattern as tenant_api_keys (server/db/models/apiKeys.js)
--                    — the raw token exists only in the cookie, never at rest.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email          TEXT NOT NULL,
  -- scrypt, not a fast hash — this is a user-CHOSEN password (low entropy,
  -- guessable), the same reasoning server/db/models/apiKeys.js's own header
  -- comment gives for why IT deliberately does NOT use scrypt for API keys
  -- (system-generated, high entropy — sha256 is enough there). Format mirrors
  -- crypto-box.js's versioned string: "v1:<salt b64>:<hash b64>".
  password_hash  TEXT NOT NULL,
  name           TEXT,
  role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One account per email, globally — a person logs into exactly one company's
-- workspace under this model (the operator's own framing: "agency account and
-- user accounts for different users... in the same company"), not a
-- multi-tenant identity spanning several companies.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_company ON users (company_id);

CREATE TABLE IF NOT EXISTS user_invites (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  token_hash   TEXT NOT NULL UNIQUE,
  invited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_invites_company ON user_invites (company_id);
-- A pending (unaccepted, unexpired) invite for the same email+company is a
-- resend, not a new row — re-inviting must not silently multiply tokens where
-- only the newest one would work but old links still look unexpired-shaped.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_invites_pending
  ON user_invites (company_id, lower(email)) WHERE accepted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);
-- The claim-scan-shaped index every other "find the live ones" query in this
-- codebase has (e.g. idx_scheduled_actions_claimable) — session validation
-- runs on every authenticated request, so this is hot.
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions (token_hash, expires_at);

COMMIT;
