-- DenchClaw CRM — migration 035: webhook capture (for building real connectors)
-- Additive/idempotent. Apply with:
--   psql "$DENCHCLAW_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/035_webhook_captures.sql
--
-- A scratch table for the "point a real tool at this URL, see exactly what
-- it sends" step of building a dedicated connector (WebinarGeek, Zoom,
-- Instantly, ...) — the alternative to guessing at a payload shape from
-- possibly-stale documentation. Rows are pruned to the most recent N per
-- tool (see server/db/models/webhook-captures.js) — this is a debugging aid,
-- not a permanent record, and payloads may contain a real prospect's PII, so
-- it should not accumulate forever.
--
-- Deliberately NOT company-scoped: the capture endpoint is hit before any
-- tenant routing exists (that's the whole problem it's solving — we don't
-- yet know the tool's payload shape well enough to extract a company from
-- it), so captures are global and the operator reads them from Settings.

CREATE TABLE IF NOT EXISTS webhook_captures (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tool        TEXT NOT NULL,
  method      TEXT NOT NULL,
  headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
  body        JSONB,
  raw_body    TEXT,          -- kept when body isn't valid JSON (form-encoded, XML, etc.)
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_captures_tool ON webhook_captures (tool, received_at DESC);
