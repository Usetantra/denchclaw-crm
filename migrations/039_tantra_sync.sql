-- DenchClaw CRM — migration 039: Tantra mirror (external identity + sync state)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/039_tantra_sync.sql
--
-- Decision C is "consume only": we cannot change tantra-backend-v2. Tantra emits
-- ONLY *.replied-shaped webhooks, so a webhook can never be the source of truth
-- for a mirror — it cannot tell us about our own sends, a second inbound in the
-- same thread, or a thread that opens without a reply. The mirror is therefore
-- POLL-driven and a webhook is only a hint to poll now. `tantra_sync_state` is
-- what makes that poll resumable and bounded.
--
-- external_identities is NOT a column on contacts, for two reasons:
--   1. One contact holds several external refs at once — a Tantra contactId AND
--      a per-channel handle (whatsapp/linkedin/telegram) — so it is 1:N.
--   2. Tantra resolves WhatsApp by the LAST 10 DIGITS of a free-form phone
--      (tantra.md §3). That will eventually match two different people. We
--      record HOW a link was made (`confidence`) so a heuristic match can be
--      reviewed rather than silently merging two CRM contacts. Tantra's own
--      contactId is stored as a hint, never used as a join key.

CREATE TABLE IF NOT EXISTS external_identities (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  system         TEXT NOT NULL,                                    -- 'tantra'
  kind           TEXT NOT NULL,                                    -- 'contact'|'email'|'whatsapp'|'linkedin'|'telegram'
  value          TEXT NOT NULL,                                    -- normalised id/handle
  confidence     TEXT NOT NULL DEFAULT 'exact'
                 CHECK (confidence IN ('exact','heuristic')),
  linked_by      TEXT NOT NULL DEFAULT 'sync'
                 CHECK (linked_by IN ('sync','operator')),
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One owner per external identity per tenant. This is also the mirror's
-- contact-resolution index, so it must stay UNIQUE: two contacts claiming one
-- Tantra handle is the exact mis-merge this table exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_identities
  ON external_identities (company_id, system, kind, value);
CREATE INDEX IF NOT EXISTS idx_external_identities_contact
  ON external_identities (company_id, contact_id);

-- ── Sweep watermark + resumable backfill cursor, one row per tenant ──────────
-- `threads_synced_through` is the stopping rule for the incremental sweep: read
-- newest-first until a page's newest activity predates it. `backfill_*` is the
-- separate, operator-triggered cold-start walk, which is resumable because a
-- large tenant will not finish in one tick.
CREATE TABLE IF NOT EXISTS tantra_sync_state (
  company_id              TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  threads_synced_through  TIMESTAMPTZ,
  backfill_cursor_page    INT,
  backfill_complete       BOOLEAN NOT NULL DEFAULT false,
  last_sweep_at           TIMESTAMPTZ,
  last_error              TEXT,
  stats                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Webhook nudge queue ─────────────────────────────────────────────────────
-- A webhook body is untrusted (Tantra does not sign outbound payloads), so we
-- never write domain state from it. We extract at most a thread reference and
-- park it here; the executor re-reads that thread from the API, which IS
-- authoritative. A forged event therefore costs one wasted API call and nothing
-- else. `event_id` is Tantra's X-Tantra-Event-Id (sha256 of eventType+dedupeKey)
-- and is what makes a redelivery a no-op — Tantra retries with backoff and runs
-- a recovery cron for orphans, so redelivery is expected, not exceptional.
CREATE TABLE IF NOT EXISTS tantra_nudges (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id      TEXT,
  event_type    TEXT,
  thread_ref    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','failed')),
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

-- Partial-unique on event_id: the SAME event delivered twice enqueues once.
-- NULL event_id is allowed and never deduped (a delivery with no id header is
-- still worth polling, it just cannot be recognised as a repeat).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tantra_nudges_event
  ON tantra_nudges (company_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tantra_nudges_pending
  ON tantra_nudges (company_id, created_at) WHERE status = 'pending';

-- ── Two-way contact sync ledger ─────────────────────────────────────────────
-- Decision D is two-way sync. Without a record of what we just PULLED, the next
-- push sends that same value straight back, Tantra emits a change, and the two
-- systems oscillate indefinitely. Before pushing field f we check for a recent
-- `pull` of the same (contact, field, value_hash) and skip if it matches.
CREATE TABLE IF NOT EXISTS contact_sync_log (
  id           BIGSERIAL PRIMARY KEY,
  company_id   TEXT NOT NULL,
  contact_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  system       TEXT NOT NULL DEFAULT 'tantra',
  direction    TEXT NOT NULL CHECK (direction IN ('push','pull')),
  field        TEXT NOT NULL,
  value_hash   TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_sync_log_lookup
  ON contact_sync_log (company_id, contact_id, field, at DESC);
