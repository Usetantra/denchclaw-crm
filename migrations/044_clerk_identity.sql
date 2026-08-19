-- DenchClaw CRM — migration 044: Clerk identity linkage
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/044_clerk_identity.sql
--
-- WHY THIS EXISTS
--
-- Migration 033 built a complete password-based auth system that was never
-- mounted, because the decision had already been made that Clerk would replace
-- it wholesale rather than layer on top of it. This migration is that swap —
-- but only of the CREDENTIAL half.
--
-- The split is the whole point:
--
--   Clerk owns    — the password, MFA, reset flows, session lifetime, and the
--                   proof that a human is who they say they are.
--   THIS TABLE    — which tenant that human belongs to, what role they hold,
--     owns          and whether they are suspended.
--
-- Clerk has no idea what a `tenants.id` is, and it never will. And `users.status`
-- is a business rule (server/db/models/users.js) that Clerk's session validity
-- does NOT replicate: revoking a Clerk session is asynchronous and best-effort,
-- so a suspended person's already-issued token stays cryptographically valid
-- until it expires. That is why the auth path re-reads this row on EVERY
-- request rather than trusting the token alone — the DB is the guarantee, the
-- Clerk revocation is a courtesy.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
--
-- `password_hash` is made nullable but NOT dropped, and `user_sessions` is left
-- entirely alone. Two reasons. First, server/routes/auth.js still calls
-- destroyAllSessions() on suspend/delete, and those calls survive this change
-- as harmless no-ops against an empty table. Second, and mainly: until Clerk is
-- proven in production, the 033 login path must stay one revert away. Dropping
-- a column is not reversible; leaving it costs nothing. A follow-up migration
-- removes both once burn-in is done.

BEGIN;

-- Clerk user ids are opaque strings (`user_2abc...`), not UUIDs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT;

-- A Clerk-provisioned row has no password to hash. See above for why the
-- column stays.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- One CRM user row per Clerk identity, and the hot-path index: every
-- authenticated request is one lookup on this.
--
-- PARTIAL rather than a plain unique index. Postgres already treats NULLs as
-- distinct, so a plain index would not collide the pre-Clerk rows either — but
-- the WHERE clause states the intent out loud ("only linked rows participate")
-- and keeps the index to just the rows that are actually looked up.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_clerk_user_id
  ON users (clerk_user_id) WHERE clerk_user_id IS NOT NULL;

COMMIT;

-- ─── A note on uq_users_email, for whoever reads this next ───────────────────
--
-- Migration 033 made email globally unique (`uq_users_email` on lower(email)),
-- so one person belongs to exactly one tenant. That still holds after this
-- change and matches production reality: one real tenant, `tantra`.
--
-- It does foreclose the consultant case — one human working for two tenants
-- needs two rows with different roles, and the global index refuses the second.
-- The resolver in server/db/models/users.js is therefore written to treat a
-- multi-row result as a MEMBERSHIP SET rather than as an impossibility, even
-- though that branch is unreachable today. That way the eventual migration is
-- DB-only:
--
--   DROP INDEX uq_users_email;
--   CREATE UNIQUE INDEX uq_users_company_email ON users (company_id, lower(email));
--   DROP INDEX uq_users_clerk_user_id;
--   CREATE UNIQUE INDEX uq_users_clerk_company ON users (clerk_user_id, company_id)
--     WHERE clerk_user_id IS NOT NULL;
--
-- ...plus relaxing the 409 pre-check in POST /invite to be company-scoped. No
-- change to the auth middleware and no change to the ~40 getUserCompanyId()
-- call sites. Buying that option cost about fifteen lines in one function.
--
-- The one rule that must survive intact if that day comes: in the multi-row
-- branch, X-Company-Id may only SELECT AMONG rows that already exist. It must
-- never be able to widen access to a tenant the person is not already a member
-- of. That is the cross-tenant-hop property the test suite asserts.
