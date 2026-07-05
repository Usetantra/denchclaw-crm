-- DenchClaw CRM — Migration 012: real tenant entity (GOAL A2)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/012_tenants.sql
--
-- Registers tenants as real rows instead of the hardcoded nginx
-- `X-Company-Id: tantra` + auth.js's env-parsed LEGACY_COMPANY_IDS fold.
-- `aliases` replaces that env var going forward: a request's incoming company
-- id is canonicalized to whichever tenant row has it as `id` OR in `aliases`.
-- Not a FK target yet — contacts.company_id etc. stay TEXT (migration 011's
-- consolidation already made 'tantra' the sole real-data tenant); a future
-- migration adds the FK once every table's company_id is provably a tenants.id.
--
-- Distinct from the existing `companies` table (migration 008): that table is
-- per-tenant CRM data (an employer/account row inside one tenant's contacts);
-- `tenants` is the tenant registry itself, one row per customer of DenchClaw.

BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  plan       TEXT NOT NULL DEFAULT 'standard',
  aliases    TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants (slug);
-- Alias lookups (canonicalization) are point-reads on a tiny table — a GIN
-- index isn't warranted at this scale; a plain seq scan is fine.

-- Guard against an alias colliding with another tenant's id or another
-- tenant's alias — without this, two tenants' aliases (or a tenant's alias
-- vs. a different tenant's id) could resolve ambiguously. app-level
-- resolve() also orders exact-id-match first as a second line of defense,
-- but the invariant belongs at the data layer, not just the query.
-- pg_advisory_xact_lock serializes concurrent alias-mutating transactions:
-- without it, two concurrent txns each adding the SAME NEW alias to two
-- DIFFERENT tenants would both pass the EXISTS check under READ COMMITTED
-- (each sees the other's row as not-yet-committed) and both commit — the
-- exact ambiguity this trigger exists to prevent. The lock is table-scoped
-- (one fixed key), not per-row, which is fine: alias edits are rare admin
-- operations on a tiny table, not a hot path worth finer-grained locking.
CREATE OR REPLACE FUNCTION tenants_check_alias_collision() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tenants_aliases'));
  IF EXISTS (
    SELECT 1 FROM tenants t
    WHERE t.id <> NEW.id
      AND (t.id = ANY(NEW.aliases) OR t.aliases && NEW.aliases)
  ) THEN
    RAISE EXCEPTION 'tenant alias collision: one or more aliases in % already belong to another tenant', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenants_check_alias_collision ON tenants;
CREATE TRIGGER trg_tenants_check_alias_collision
  BEFORE INSERT OR UPDATE OF aliases ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_check_alias_collision();

-- Backfill the single real tenant (migration 011's consolidation target),
-- carrying over today's env-default legacy fold as its aliases so behavior
-- is unchanged the moment auth.js switches from env-parsed to DB-backed
-- canonicalization.
--
-- ON CONFLICT DO NOTHING is deliberate, not an oversight: this is a one-time
-- bootstrap seed. A blind DO UPDATE here would silently clobber any alias an
-- operator later added/removed via the tenants model on every re-run of this
-- file (e.g. a fresh environment re-applying migrations in order) — seed
-- migrations must not fight later, real edits. Changing tantra's aliases
-- after this migration has run is tenants.js's job (or a future migration),
-- not a re-run of this INSERT.
INSERT INTO tenants (id, name, slug, status, plan, aliases)
VALUES ('tantra', 'Tantra', 'tantra', 'active', 'standard', ARRAY['growthclub','dev_company'])
ON CONFLICT (id) DO NOTHING;

COMMIT;
