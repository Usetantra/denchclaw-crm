# DenchClaw CRM — API Contract (authoritative)

> Source-of-truth contract for `CRM_BACKEND=api`. automation_core and the future
> Yogi Engine Gateway code against THIS file. It supersedes all earlier contract
> docs (including the pre-two-pipeline revision of this file, which predated
> `/advance`, conversations, campaign-events, and analytics).

## What it is

Node/Express microservice, own isolated `denchclaw` Postgres DB, default `:3100`
(loopback, behind pm2 `denchclaw-crm`). The automation engines reach it over HTTP
via `automation_core/crm.py` when `CRM_BACKEND=api`.

## Auth (two layers + IP gate)

- `X-Internal-Key` — must be a known key. `X-Company-Id` — the acting company
  (defaults to `DEFAULT_COMPANY_ID`, `growthclub`).
- **Key→company binding:** `INTERNAL_API_KEYS` (JSON: `{"<key>": ["co_a"], "<key2>": "*"}`)
  binds each key to the companies it may act for. An `X-Company-Id` outside the key's
  set ⇒ **403**. Back-compat: if unset, the single `INTERNAL_API_KEY` is bound to `*`.
- **IP gate:** caller IP must match `INTERNAL_API_ALLOWED_CIDRS`
  (default loopback only) ⇒ otherwise **403**.
- **Row scoping:** every by-id route additionally checks the row's `company_id`
  matches the caller's; mismatch ⇒ **404** (no existence disclosure).

## Two-pipeline model

Since migrations 003–007 the CRM runs **two named pipelines**, both defined as
data in `crm_pipeline_configs` (JSONB `stages: [{key, label, transitions[]}]`;
global defaults have `company_id IS NULL`, per-company overrides win):

### Marketing pipeline → `contacts.marketing_stage`

```
sourced → enriched → segmented → queued → engaged → responded → mql
off-ramps: nurture (re-entry via segmented), suppressed (terminal)
```

| from | allowed transitions |
|---|---|
| sourced | enriched, segmented, suppressed |
| enriched | segmented, suppressed |
| segmented | queued, nurture, suppressed |
| queued | engaged, nurture, suppressed |
| engaged | responded, nurture, suppressed |
| responded | mql, nurture, suppressed |
| mql | nurture, suppressed |
| nurture | segmented, suppressed |
| suppressed | — (terminal) |

New contacts start at `sourced`. `contacts.deal_stage` **mirrors**
`marketing_stage` on marketing advances (legacy compat — outreach's
`verify_cp4.py` reads it; do not drop yet).

### Sales pipeline → `deals.stage`

A contact's sales journey lives in a separate `deals` row (a contact can be in
marketing `nurture` AND an open deal simultaneously).

```
accepted → contacted → booked → qualified → proposal → negotiation → onboarding → won|lost
```

| from | allowed transitions |
|---|---|
| accepted | contacted, lost |
| contacted | booked, unqualified, nurture, lost |
| booked | qualified, no_show, contacted |
| qualified | proposal, unqualified, nurture, lost |
| proposal | negotiation, nurture, lost |
| negotiation | onboarding, lost |
| onboarding | won, lost |
| won | — (terminal) |
| lost | accepted |
| no_show | contacted, **booked**, lost *(booked restored by migration 007)* |
| unqualified | nurture, lost |
| nurture | contacted, lost |

## Stage changes — one transition authority

`POST /api/crm/contacts/:id/advance` is the **canonical** stage-change endpoint:

```
POST /api/crm/contacts/:id/advance
{ "pipeline_key": "marketing"|"sales", "stage": "<target>", "reason"?: str, "actor"?: str }
```

- Validates against the pipeline's JSONB `transitions`. Illegal jump ⇒
  **409** `{error, current, requested, allowed}`.
- Idempotent: already at `stage` ⇒ **200** `{..., changed: false}`.
- `pipeline_key=marketing` updates `contacts.marketing_stage` (+ `deal_stage` mirror).
- `pipeline_key=sales` updates the contact's most recent open deal
  (no open deal ⇒ **404**); `won|lost` sets `closed_at`.
- **Sales `nurture` off-ramp recycles to marketing** (migration-006 spec: the
  nurture return path is *Marketing's nurture queue*): advancing a deal to
  `nurture` (via `/advance` or `PATCH /deals/:id`) also moves the contact's
  `marketing_stage` to `nurture` when the marketing config permits it from the
  contact's current stage (e.g. `mql→nurture`); the `/advance` response then
  carries `marketing_recycled: true|false`. If the marketing transition is not
  legal the contact's marketing stage is left untouched.
- Unknown/unseeded `pipeline_key` ⇒ **404** `Pipeline '<key>' not configured`.
- Success: `{contact_id, [deal_id,] pipeline_key, stage, previous, changed: true}` +
  a `stage_change` activity row.

**Legacy path (still supported):** `PATCH /contacts/:id {deal_stage}` delegates
to the **same** JSONB sales-pipeline checker (plus a static fallback for the
legacy-only stages `lead` and `proposal_accepted`). Illegal ⇒ **400**
`{error, allowed_transitions, current_stage}` — note the legacy path keeps its
historical **400** shape while `/advance` uses **409**. `PATCH /deals/:id {stage}`
enforces the sales JSONB config the same way (**409** + `allowed_transitions`).

`GET /pipeline/transitions` returns the legacy flat map `{stages, transitions}`
(company-scoped config if one exists, else the built-in default). automation_core
mirrors this for its postgres backend and asserts equality in CI (drift test).

## Endpoints (base `/api/crm`, all require auth; `/health` is open)

### Contacts

| Method · Path | Purpose | Notes |
|---|---|---|
| GET `/contacts?search=&score=&source=&stage=&tags=&phone=&limit=&offset=` | list/find | `search` matches name/email/company; `tags`=`a,b` or repeated → array-overlap; `phone` → normalized digit match. Omit `limit` ⇒ ALL rows; explicit `limit` capped at 500 |
| POST `/contacts` | create/upsert | **email is the authoritative dedupe key** — linkedin/phone fallback fires only when the record has NO email (distinct emails never merge); `company`↔`company_name` mapping; starts `deal_stage=lead`, `marketing_stage=sourced` |
| GET `/contacts/:id` | read | scoped (404) |
| PATCH `/contacts/:id` | update / legacy stage change | scoped; `{deal_stage}` ⇒ 400 + `allowed_transitions` on illegal |
| **POST `/contacts/:id/advance`** | **canonical stage change (both pipelines)** | 409 + `allowed` on illegal; idempotent |
| DELETE `/contacts/:id` | delete | scoped |
| GET/POST `/contacts/:id/activity` | activity feed / append | scoped; POST bumps `lead_score_numeric` |
| PATCH `/contacts/:id/follow-up` | record follow-up | scoped |
| GET `/contacts/follow-ups` · `/contacts/export?format=csv` | reporting | |
| POST `/contacts/bulk-import` | bulk upsert `{contacts:[…]}` | **tenant-scoped**: rows + activity land under the caller's `X-Company-Id` |

### Deals

| Method · Path | Purpose | Notes |
|---|---|---|
| GET `/deals?stage=&search=` | list + per-stage pipeline map | |
| POST `/deals` | create | |
| GET/PATCH/DELETE `/deals/:id` | read/update/delete | scoped; PATCH `{stage}` enforces sales JSONB config ⇒ 409 + `allowed_transitions` |
| POST `/deals/:id/activity` | append deal activity | scoped |

### Pipeline / reporting

| Method · Path | Purpose |
|---|---|
| GET `/pipeline?pipeline_key=marketing\|sales` | stage-bucketed view (contacts / deals). No `pipeline_key` ⇒ legacy flat view |
| GET `/pipeline/transitions` | legacy flat state machine (CI drift anchor) |
| GET `/stats` | contact/deal/campaign summary (rollup-backed) |
| GET `/activity/recent?limit=` | latest activity across contacts |

### Prospect inbox (cross-engine handoff)

CRM-owned queue (`prospect_inbox`, migration 002). `target_engine` NULL = broadcast
(claimable by any engine, first-claim-consumes). Status: `pending|claimed|enrolled|done`.

| Method · Path | Purpose | Notes |
|---|---|---|
| POST `/prospect-inbox` | enqueue `{contact_id, target_engine?, source_engine?, suggested_campaign?, metadata?}` | idempotent on `(contact_id, target_engine)`; re-enqueue of a `done` row resets to `pending`; contact must belong to caller ⇒ else 404 |
| POST `/prospect-inbox/claim` | atomic claim `{target_engine?, limit?, claimed_by?}` | `FOR UPDATE SKIP LOCKED` — no double-claim under concurrency. **`target_engine='sales'` auto-creates a `deals` row at stage `accepted`** for each claimed contact (idempotent: skipped if an open deal exists; title `MQL Handoff…`, source `prospect_inbox`) |
| GET `/prospect-inbox?target_engine=&status=&limit=` | list | |
| PATCH `/prospect-inbox/:id` | transition (`enrolled`/`done`; `pending` releases + clears claim) | scoped |

### Conversations + messages (unified AI inbox)

| Method · Path | Purpose | Notes |
|---|---|---|
| POST `/conversations` | find-or-create `{contact_id, channel, metadata?}` | idempotent: one open conversation per (contact, channel); 201 either way |
| GET `/conversations?status=&assignee=&channel=&contact_id=` | escalation queue / dashboard | |
| GET/PATCH `/conversations/:id` | read / assign / close / escalate | scoped |
| POST `/conversations/:id/messages` | append message `{direction, channel, body?, ai_generated?, intent?, provider_message_id?, metadata?}` | idempotent on `(company, provider_message_id)` — a webhook delivered twice yields one row. **Inbound messages auto-advance marketing stage to `responded`** (only if legal from the current stage) and the 201 response includes `active_campaigns` (contact's `campaign:*` tags, prefix stripped) so the engine can halt competing outbound |
| GET `/conversations/:id/messages?limit=` | list messages | |

### Campaign events + analytics

| Method · Path | Purpose | Notes |
|---|---|---|
| POST `/campaign-events` | ingest one event **or an array** | types: `send, deliver, open, click, reply, bounce, unsub, suppressed, mql` (`mql` ⇒ `mql_count`, migration 008); writes raw `campaign_events` + upserts per-`(company, campaign, channel, segment, day)` rollup; ⇒ **202** `{ok, accepted, total}` |
| GET `/analytics/overview` | 30-day totals + open/reply/bounce rates | |
| GET `/analytics/by-channel?days=` | per-channel rollups | |
| GET `/analytics/by-campaign?days=` | per-campaign rollups (incl. `mql_rate`) | |
| GET `/analytics/funnel?pipeline_key=marketing\|sales` | stage counts (marketing: contacts by `marketing_stage`; sales: deals by `stage` + value) | |

### Chat

| Method · Path | Purpose | Notes |
|---|---|---|
| POST `/chat` | NL assistant `{message, history?}` or `{messages}` | READ+WRITE via internal self-calls; stage vocabulary is built from `crm_pipeline_configs` at request time |

### Health

| Method · Path | Purpose | Notes |
|---|---|---|
| GET `/health` (root, not under `/api/crm`) | liveness + DB probe | **200** `{ok:true, service, db:{ok, latency_ms}}`; **503** while the DB is unreachable (the server listens before the DB probe completes and retries with backoff — it never crash-loops on connection pressure) |

## Error semantics summary

| Status | Where | Shape |
|---|---|---|
| 400 | legacy `PATCH /contacts/:id {deal_stage}` illegal transition | `{error, allowed_transitions, current_stage}` |
| 409 | `POST /contacts/:id/advance` illegal transition | `{error, current, requested, allowed}` |
| 409 | `PATCH /deals/:id {stage}` illegal transition | `{error, allowed_transitions, current_stage}` |
| 404 | cross-tenant or missing row; unseeded pipeline; no open deal for sales advance | `{error}` |
| 403 | key not bound to company / IP outside CIDRs | `{error}` |
| 401 | missing/unknown `X-Internal-Key` | `{error}` |

`automation_core.advance_stage` surfaces stage rejections as `CrmStageError`
(carrying `allowed_transitions`) and applies **no** client-side guard — the CRM
is authoritative.

## Client (`automation_core/crm.py`)

Public functions accept an optional `company_id` (thread it so multi-tenant
lookups resolve to the right company; without it requests fall back to
`default_company_id`). The api and postgres backends return the same dict key
sets. Handoff interface: `enqueue_handoff / claim_handoffs / list_handoffs /
complete_handoff`.

## Changelog

- **2026-07-02 (pm)** — Doc-alignment + trial-run fixes: sales `nurture` off-ramp
  now recycles the contact to marketing `nurture` (`marketing_recycled` in the
  `/advance` response); email made the authoritative dedupe key in
  `POST /contacts` + `bulk-import` (phone/linkedin fallback only when email
  absent — BUG-1 class); `GET /contacts/export` un-shadowed from the `:id`
  route; `mql` campaign-event type added (migration **008**) so `mqls`/`mql_rate`
  report; deal listings fall back to the contact's name for display; dashboard
  gained a contact-detail modal (fields + activity feed + notes).
- **2026-07-02** — Rewritten for the two-pipeline model (migrations 003–007):
  documented `POST /contacts/:id/advance` (409 semantics), both pipelines' stage
  maps, conversations/messages (inbound auto-advance + `active_campaigns`),
  campaign-events + analytics, prospect-inbox sales claim auto-deal, tenant-scoped
  bulk-import, and startup resilience (health 503 while DB retries). Removed the
  stale claims that stage change = `PATCH {deal_stage}` only and that
  "there is no POST /contacts/:id/stage"-style advance endpoint.
- **pre-2026-07** — Flat 11-stage era (CP0–CP4): multi-tenant scoping, key→company
  binding, prospect-inbox, tags/phone filters.
