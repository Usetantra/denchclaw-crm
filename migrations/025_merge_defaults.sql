-- DenchClaw CRM — Migration 025: per-tenant merge values (CP-D)
-- Additive/idempotent.
--
-- WHY THIS EXISTS, and it is the whole reason CP-D is not a copy-paste job.
--
-- The operator's instruction was to BORROW the automations from the outreach and
-- nurturing engines. Their copy is real and good, and it is full of tokens:
--
--     {{first_name}} {{company}} {{join_url}} {{book_url}}
--     {{webinar_date}} {{webinar_time}} {{unsubscribe_url}}
--
-- Pasting that into this CRM would have been a disaster in two separate ways.
--
-- FIRST: `{{first_name}}` means the OPPOSITE here. Upstream it is a merge field;
-- in this codebase `{{...}}` is the deliberate ESCAPE for writing about a merge
-- field (server/lib/ai-draft.js), so it renders as the literal text
-- `{first_name}`. A direct paste sends "Hi {first_name}," to every prospect —
-- and because the escape is *intentional*, every guard correctly waves it
-- through. The copy has to be converted to single braces, and CP-D's tests
-- assert that conversion rather than trusting it.
--
-- SECOND, and worse: `{book_url}` was not a known token, so `unresolvedTokensIn`
-- returned nothing for it, the claim door's content guard passed, and the
-- executor would have sent "grab a time here: {book_url}" to a real person. A
-- token the system does not know about does not fail loudly — it fails SILENTLY,
-- which is the one failure mode this project has refused at every checkpoint.
--
-- So the token set grows to cover what the borrowed ladders actually use, the
-- send guard grows with it (an unresolved one now BLOCKS), and the values have
-- to come from somewhere. That somewhere is this table.
--
-- Per tenant, not global: `book_url` is a tenant's own booking page and a shared
-- default would put one tenant's link in another tenant's outreach — the same
-- reasoning migration 021 used to refuse a global template fallback.

BEGIN;

CREATE TABLE IF NOT EXISTS crm_merge_defaults (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- The token name WITHOUT braces, e.g. 'book_url'. Constrained to the context
  -- token set in server/lib/ai-draft.js: a value for a token nothing can render
  -- is a silent no-op, and an operator who typed `booking_url` deserves an error
  -- rather than copy that quietly never resolves.
  key        TEXT NOT NULL CHECK (key IN (
               'book_url', 'join_url', 'unsubscribe_url',
               'webinar_date', 'webinar_time', 'sender_name'
             )),
  value      TEXT NOT NULL CHECK (btrim(value, E' \t\r\n') <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_merge_defaults_company_key
  ON crm_merge_defaults (company_id, key);

-- Resolution reads the whole small set for a tenant on every step materialisation,
-- so the lookup is by company alone.
CREATE INDEX IF NOT EXISTS idx_crm_merge_defaults_company
  ON crm_merge_defaults (company_id);

-- ─── Seed identity ───────────────────────────────────────────────────────────
-- A seeded automation was originally matched by its display NAME, which is both
-- mutable and not unique. Two ways that bites: a human renames "No-Show
-- follow-up ladder" and the next seed installs a silent duplicate; or a human
-- creates their OWN sequence with that name and an overwrite-seed clobbers it.
-- The definition key is the stable identity, so it is stored.
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS automation_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequences_automation_key
  ON sequences (company_id, automation_key) WHERE automation_key IS NOT NULL;

COMMIT;
