# SESSION HANDOFF — DenchClaw CRM: Two-Pipeline (Marketing + Sales) Build
**Date:** 2026-07-01
**Repo for THIS session:** `/Users/adithyamurali/denchclaw-crm` (`github.com/adisuja/denchclaw-crm`, branch `main`, Node/Express + Postgres)
**Sibling (separate session):** `/Users/adithyamurali/outreach-engine` — `SESSION_HANDOFF_2026_07_01_DENCHCLAW_PIPELINES_OUTREACH.md`. **The CRM owns the schema + API contract — build this side first; the engine consumes it.**

---

## 0. Source of truth

Deck "Process Evaluation Call Deck V2" slides **28–32** define the Omni-Channel Outreach Engine as a 5-part data flow (Prospecting → Segmentation/Messaging → Automation Engine → Unified AI Inbox → Analytics). This session turns that flow into **two first-class CRM pipelines** and gives the CRM the API surface, conversations model, and analytics rollups the engine needs.

### The two pipelines and their stages (map to the data-flow parts)

**MARKETING pipeline** (top-of-funnel → MQL; driven by engine Parts 1–4):
| Stage key | Meaning | Data-flow origin |
|---|---|---|
| `sourced` | Prospect scraped/imported, raw | Part 1 (scraping) |
| `enriched` | Enrichment pipeline complete (social/email/phone/sales-intent verified) | Part 1 (enrichment) |
| `segmented` | Assigned buyer-persona segment + tags | Part 2 |
| `queued` | Scored + per-channel message generated + queued to campaign | Part 2 → 3 |
| `engaged` | First outbound touch sent | Part 3 |
| `responded` | Reply captured in unified inbox | Part 4 |
| `mql` | Marketing-qualified → **handoff to Sales** | Part 4 |
| `nurture` *(off-ramp)* | Not ready; recycle to nurturing engine | — |
| `suppressed` *(off-ramp)* | Bounced/unsub/invalid/DNC | — |

**SALES pipeline** (SQL → Won; human/AI SDR; ≈ today's flat list, re-homed):
`accepted → contacted → qualified → proposal → negotiation → onboarding → won | lost`
off-ramps: `no_show`, `unqualified`. Entry point = a `prospect_inbox` handoff with `target_engine='sales'` created when marketing hits `mql`.

---

## 1. Current state of THIS repo (verified 2026-07-01)

- **Schema** (`migrate.sql` + `migrations/`):
  - `contacts` — has a **single flat** `deal_stage TEXT DEFAULT 'lead'` (11-stage), `lead_score`, `tags[]`, `metadata`, `company_id` (multi-tenant), soft-delete `deleted_at`.
  - `contact_activity` — activity feed (type/message/agent/channel/data/engagement_id).
  - `deals` — separate deals table, own `stage`.
  - `crm_pipeline_configs` — `{company_id, name, stages JSONB, automations JSONB, is_default}` — **EXISTS but is NOT wired to contacts/deals.**
  - `prospect_inbox` (`migrations/002`) — cross-engine handoff queue: `{company_id, contact_id, source_engine, target_engine (NULL=broadcast), suggested_campaign, status pending|claimed|enrolled|done, claimed_by, metadata}`, with partial-unique indexes on `(contact_id, target_engine)` and broadcast `(contact_id)`.
- **API** (`server/routes/crm.js`): contacts CRUD + `/activity`, deals CRUD, `/stats`, `/pipeline` (groups contacts by stage), `/pipeline/transitions`, `/prospect-inbox` (+`/claim`, PATCH), `/follow-ups`, `/bulk-import`, `/export`. Hardcoded `DEFAULT_DEAL_STAGES = ['lead','contacted','qualified','no_show','unqualified','proposal','proposal_accepted','negotiation','onboarding','won','lost']`.
- **Frontend:** `web/` is essentially a stub (`web/index.html` only).
- Multi-tenant via `company_id` + `X-Company-Id` header (see `crm-cutover-status` memory: never default this to `growthclub`).

### GAPS this session closes
1. No **named-pipeline separation** — one flat `deal_stage`; marketing vs sales don't exist as distinct pipelines with distinct stage sets.
2. Contacts/deals **not linked** to `crm_pipeline_configs`.
3. No **allowed-transition enforcement** per pipeline (illegal jumps aren't rejected).
4. No **conversations/messages** model for the Unified AI Inbox (Part 4).
5. No **analytics rollups** — `/stats` live-scans `contacts` (won't scale); no channel/campaign/segment dashboard data (Part 5).

---

## 2. Goal for THIS session

Give DenchClaw two real pipelines with enforced stages, a conversations model, and analytics rollups — so the outreach engine can drive a contact `sourced → … → mql`, hand off to Sales, log replies, and feed a dashboard, all over the HTTP API. Keep the existing api-mode cutover green (don't break `verify_cp4.py`).

---

## 3. Tasks (build in order; each is a checkpoint)

### T1 — Pipeline model & seed
- New migration: seed two rows in `crm_pipeline_configs` per company — `key='marketing'` and `key='sales'` — each with its ordered `stages` JSONB (from §0) and an `allowed_transitions` map. Add a `key TEXT` column (unique per `company_id`) so pipelines are addressable by stable key, not just name.
- Add `pipeline_key TEXT` to `contacts` (default `'marketing'`) and a `stage TEXT` that is interpreted **within** that pipeline. Keep the legacy `deal_stage` column temporarily as a mirror for backward-compat with `verify_cp4.py`, then plan its removal.
  - **Alt (cleaner, discuss first):** a contact stays in marketing; its move to Sales is represented by a `deals` row in the sales pipeline while the contact keeps its marketing stage. This lets a contact be simultaneously "in nurture (marketing)" and "in an open deal (sales)". Decide T1 shape before migrating — this is the key architectural fork.
- Backfill existing contacts: map current `deal_stage` values onto the correct pipeline+stage.

### T2 — Stage-advance API with transition enforcement
- `POST /api/crm/contacts/:id/advance` `{ pipeline_key, stage, reason?, actor? }` → validates the transition against the pipeline's `allowed_transitions`; **rejects illegal jumps** (409 + current stage), is **idempotent** (advancing to the same/earlier stage is a no-op or explicit regression flag), writes a `contact_activity` row (`type='stage_change'`), and returns the new state.
- Update `/pipeline` and `/pipeline/transitions` to be **pipeline-aware** (accept `?pipeline_key=`), replacing the hardcoded `DEAL_STAGES`.
- Keep the backend-agnostic client contract stable: the outreach engine calls `crm.advance_stage(contact_id, pipeline, stage)`.

### T3 — Marketing→Sales handoff wiring
- When a contact reaches marketing `mql`, the **engine** calls `enqueue_handoff(target_engine='sales')` (already the `prospect_inbox` producer path). On the CRM side: when a `sales` handoff is **claimed/enrolled**, create/attach the contact into the sales pipeline (or open a `deals` row per the T1 decision) at stage `accepted`, idempotently (partial-unique already prevents dup handoffs).
- Add `GET /api/crm/handoffs?target_engine=sales&status=pending` convenience if not covered by existing `/prospect-inbox` list.

### T4 — Conversations / Unified AI Inbox model (Part 4)
- New tables:
  - `conversations` — `{id, company_id, contact_id, channel, status open|snoozed|closed|escalated, last_message_at, assignee (ai|human|null), intent, metadata}`.
  - `messages` — `{id, conversation_id, company_id, direction inbound|outbound, channel, body, ai_generated BOOL, intent, provider_message_id (dedupe key), created_at}`.
- Endpoints: `POST /conversations/:id/messages` (idempotent on `provider_message_id`), `GET /conversations?status=&assignee=` (human escalation queue + dashboard), `PATCH /conversations/:id` (assign/close/escalate). Writing an inbound message must be safe to call twice.
- On inbound: expose enough for the engine's AI Inbox Handler to (a) record the reply, (b) flag the contact `responded`, (c) suppress competing outbound (return the contact's active campaigns so the engine can halt them), (d) escalate the ~10% AI can't handle.

### T5 — Analytics rollups (Part 5)
- New `campaign_events` rollup strategy: raw events arrive from the engine (channel, campaign_id, segment, company_id, contact_id, type send|deliver|open|click|reply|bounce|unsub, ts). Do **not** live-scan for the dashboard.
- Add rollup tables or **materialized views** keyed by `(company_id, campaign_id, channel, segment, day)` with counts + rates (delivery, reply, bounce, unsub, MQL-conversion). Refresh on a schedule / incrementally.
- Endpoints: `GET /api/crm/analytics/overview`, `/analytics/by-channel`, `/analytics/by-campaign`, `/analytics/funnel?pipeline_key=marketing` (stage counts + conversion between stages). These back the slide-32 reporting dashboard.
- Refactor `/stats` to read rollups, not full-table scans.

### T6 — Dashboard UI (optional this session; can be a follow-up)
- Flesh out `web/` into a real SPA (match the outreach-engine React/Vite stack) with: two Kanban boards (Marketing + Sales) reading `/pipeline?pipeline_key=`, a Unified Inbox view (`/conversations`), and an Analytics dashboard (`/analytics/*`). If time-boxed, ship the API (T1–T5) and stub the UI.

---

## 4. Edge cases you MUST handle

1. **Contact in both pipelines** — resolve the T1 fork so a contact can be nurtured (marketing) while an open deal (sales) exists; queries must not double-count.
2. **Illegal / backward transitions** — enforce `allowed_transitions`; allow explicit regressions only with a `reason` (e.g. reopened deal), logged.
3. **Duplicate handoffs** — partial-unique on `prospect_inbox (contact_id, target_engine)` already guards; the enroll path must be idempotent too.
4. **Recycle loop** — Sales `lost`/`nurture` → marketing → must not instantly re-MQL; honor a `recycled_from` tag + cooldown the engine sets.
5. **Idempotent inbound** — dedupe messages on `provider_message_id`; a webhook delivered twice must not create two messages or two `responded` transitions.
6. **Multi-tenant isolation** — every query filters `company_id`; never default `X-Company-Id`. Pipeline configs, conversations, analytics are all per-tenant.
7. **Suppression is global-per-tenant** — unsub/bounce/DNC moves the contact to `suppressed` and blocks all future enroll/advance except explicit re-consent.
8. **Soft-delete honored** — `deleted_at` contacts excluded from pipelines, inbox, analytics.
9. **Stage config drift** — if a company customizes stages via `crm_pipeline_configs`, the advance API and analytics funnel must read the config, not the hardcoded defaults.
10. **Backward-compat** — `verify_cp4.py` (both `CRM_BACKEND=api` and `postgres`) must stay green through the migration; mirror `deal_stage` until the engine cutover to `pipeline_key/stage` is confirmed.

---

## 5. Verification plan (Layer 2)

- **Migration test:** apply new migrations on a scratch DB from `migrate.sql` baseline; assert seed pipelines, backfill correctness, and that existing `contact_activity`/`deals` still load.
- **Transition tests:** unit-test the advance endpoint — legal path passes, illegal jump → 409, idempotent re-advance is a no-op, regression requires `reason`.
- **Handoff test:** marketing `mql` → `prospect_inbox` sales row → claim → contact enters sales at `accepted`; run twice, assert no duplicate.
- **Inbox test:** POST same inbound message twice → one `messages` row, one `responded` transition; escalation path sets `assignee='human'`.
- **Analytics test:** feed synthetic `campaign_events`, assert rollups + `/analytics/funnel` match hand-computed counts; confirm `/stats` no longer full-scans.
- **Cross-repo:** run the outreach engine's `verify_cp4.py` / `verify_pipelines.py` against this CRM on **staging** (`git pull` + `pm2 restart denchclaw-crm`) under both backends.
- **Codex `critic` subagent** on the T1 architectural fork (contact-dual-pipeline vs deals-based) and the T5 rollup design before committing.

## 6. Ops
- Deploy: `git pull` + `pm2 restart denchclaw-crm` (+ restart engines to pick up client changes). Migrations are applied by an **operator**, never by the agent against a live DB (see `migrations/002` header).
- Keep `crm-cutover-status`, `shared-env` memories in mind; do not touch secrets/`.env`.

## 7. First move for the next session
1. Read this + the outreach handoff to lock the shared `pipeline_key`/`stage`/conversation/analytics contract.
2. `/spec` **T1** first — the dual-pipeline data-model fork is the decision everything else hangs off; get the user to confirm before migrating.
3. Then T2→T5 in order, keeping `verify_cp4.py` green at every checkpoint.
