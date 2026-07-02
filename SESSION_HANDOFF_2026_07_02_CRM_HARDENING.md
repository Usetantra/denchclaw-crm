# SESSION HANDOFF — 2026-07-02 — DenchClaw CRM hardening (Terminal E)

Branch: `fix/crm-hardening-2026-07-02` → merged to `main`.
Commits: `f93b297` (E1–E4), `51c387d` (E5 docs), `03f6961` (critic-pass fixes).
Mission brief: `pro-workflows/SUITE_FIX_PLAN_2026_07_02/TERMINAL_E_denchclaw_crm.md`.

## Status by task

| Task | Status | Summary |
|---|---|---|
| E1 startup resilience + pool | **DONE** | Retry+backoff+jitter, no exit-loop; deployed + verified live |
| E2 migrations 003–007 verify | **DONE** | All applied — read-only receipts below; nothing to apply, no backup needed |
| E3.1 bulk-import tenancy | **DONE** | company threaded through both calls + CP5 regression tests |
| E3.2 chat stage drift | **DONE** | stage vocab built from `crm_pipeline_configs` per request |
| E3.3 one transition authority | **DONE** | PATCH delegates to the `/advance` JSONB checker; shapes unchanged |
| E4 CP5 contract tests | **DONE** | `npm test` → Docker postgres:16 scratch DB; **39/39 green** |
| E5 API_CONTRACT rewrite | **DONE** | Full route table, 400-vs-409, both stage maps, claim contract, changelog |

## E1 — Startup resilience + pool sizing

- `server/db/index.js`: `initDatabase()` now retries the initial probe **forever**
  with exponential backoff + jitter (1s→2s→4s… cap 30s; `DB_RETRY_BASE_MS`/`DB_RETRY_CAP_MS`).
  Pool `error` events logged, never fatal. `DB_POOL_MAX` default **10** (explicit).
- `server/server.js`: listens **before** the DB probe (health answers 503 while
  retrying); exits only on config errors (missing `DATABASE_URL`, `err.fatal`);
  `unhandledRejection`/`uncaughtException` guards.
- `README.md` (new): box-wide budget rule — **sum of all pools + workers < 150**
  (max_connections=200).
- Local proof: booted against a dead port — `attempt 1 … retrying in 807ms / 1812 / 3118 / 7511ms`,
  process alive, `/health` 503; missing DATABASE_URL exits code 1.
- Staging proof: rsync + `pm2 reload` (restarts 28→29), listen-first visible in out log,
  `/health` 200 `{db:{ok:true}}`; `kill -9` of the node pid → pm2 revived (→30),
  `/health` 200, error log clean. Second reload after critic fixes (→31), clean.

## E2 — Migration receipts (staging `denchclaw` DB, read-only)

Run 2026-07-02 ~11:15Z via the CRM's own `DATABASE_URL` from `/home/yogi/denchclaw-crm/.env`
(value never printed):

| Check | SQL | Result |
|---|---|---|
| `contacts.marketing_stage` | `information_schema.columns` | ✅ `marketing_stage` present (003) |
| Tables | `information_schema.tables IN (…)` | ✅ all 5: `crm_pipeline_configs, conversations, messages, campaign_events, campaign_event_rollups` (003/004/005) |
| Seeded global configs | `SELECT key, company_id, jsonb_array_length(stages)` | ✅ `marketing‖9`, `sales‖12` |
| 006 applied | marketing `sourced` transitions | ✅ `["enriched","segmented","suppressed"]` |
| 007 applied | sales `no_show` transitions | ✅ `["contacted","booked","lost"]` |
| Connections | `pg_stat_activity` | 42/200 (healthy) |

**No migrations were missing → none applied, no schema dump taken** (backup only
required before applying). pm2 restart counter still shows the historical ↺28
from the incident; all increments this session (29/30/31) were our reload/kill-test/reload.

## E3 — Bug fixes

1. **bulk-import** (`server/routes/crm.js`): `findOrCreateContact` now gets
   `company_id: companyId`, `addContactActivity(contact.id, companyId, …)`
   (was `null` → contacts landed with `company_id=null`). 401 without a company.
   Regression pinned by CP5 cases 35–37.
2. **chat.js**: hardcoded `DEAL_STAGES` (missing accepted/booked/nurture) replaced by
   `getDealStages(companyId)` reading the sales JSONB config per request
   (shared 60s-TTL loader); fallback list corrected + includes legacy stages.
3. **PATCH `/contacts/:id {deal_stage}`**: now calls `resolveDealStageTransitions()`
   → `getPipelineConfig(companyId,'sales')` + `getPipelineTransitions` — the exact
   checker `/advance` uses. `DEFAULT_STAGE_TRANSITIONS` survives only as fallback +
   for legacy-only stages (`lead`, `proposal_accepted`). Response shape unchanged:
   **400** `{error, allowed_transitions, current_stage}`.

## E4 — Contract harness (CP5)

- `test/contract.mjs` `PHASE=CP5`: advance legal/illegal(409+allowed)/idempotent for
  both pipelines; migration-007 `no_show→booked` probe; sales claim auto-deal at
  `accepted`; conversations find-or-create idempotent; inbound message →
  `responded` + `active_campaigns` + provider_message_id dedup; campaign-events
  single+array → by-campaign rollup; funnel marketing+sales; bulk-import tenant
  regression (3 cases). Stale legacy case fixed: `lost→lead` → `lost→accepted`
  (authority since f82738c); unknown pipeline_key expectation corrected to 404.
- `test/run-local.sh` + `npm test`: spins **Docker postgres:16** scratch DB
  (refuses non-local `DATABASE_URL_TEST`), applies `migrate.sql` + migrations
  002–007 in order, boots server on `:3101` with a JSON key binding
  (limited key → `co_bound_only` so the CP1 403 test runs), executes CP5.
- **Result: 39 passed, 0 failed** (never touched staging DB).

## Verification (Layer 2)

- **CI drift criterion:** staging `GET /api/crm/pipeline/transitions` md5
  `9ae4d0f94d73b7b4f6a4aaef8804fffb` — byte-identical to the pre-refactor DEFAULT
  map (verified pre- and post-deploy). `getPipelineStages` untouched.
- **Codex critic** ran over E3.3 (agent ac38ba98cbcca14d3): verdict *pass-with-fixes*,
  all 4 hard constraints hold. Fixes applied in `03f6961`: stale-cache-on-DB-error
  (no more fail-open to defaults), `Array.isArray` guard on config transitions,
  frozen cache entries, CP5 007-probe, chat fallback nits.
- **Known residuals (accepted, documented, NOT fixed here):**
  - `getPipelineStages` (feeding `/pipeline/transitions`) queries company-scoped
    rows only, never the global seeds — intentional today (CI pins the output),
    but "one authority" is not fully closed until automation_core's mirror +
    drift test move to the JSONB configs.
  - **automation_core's `STAGE_TRANSITIONS` mirror (`pro-workflows/automation_core/crm.py:37`)
    is stale** — still the pre-f82738c flat map (`lost→lead`, `lead→contacted/unqualified/lost`, …).
    If the drift test actually runs api-vs-mirror it was failing BEFORE this session;
    my change didn't alter the endpoint. Fix belongs in automation_core.
  - PATCH `/deals/:id` returns 409 while PATCH `/contacts/:id` returns 400 for the
    same violation class (pre-existing, contract-documented).
  - PATCH writes `activity_message` before rejecting an illegal `deal_stage` in the
    same body (pre-existing).
- **Staging reload evidence:** `/health` 200 `{ok:true,db:{ok:true,latency_ms:1}}`;
  error-log mark set at line 1185 @ 2026-07-02T11:20:30Z — no new error-log lines
  across reload + SIGKILL revive + second reload; final 30-min-window check
  recorded below.

## 30-min log window

- Mark: line 1185 @ 11:20:30Z. Interim checks 11:21Z, 11:33Z: clean.
- Final check ~11:56Z: see terminal report (background check `bulm6g0l4`) —
  expected clean; if anything appeared it is quoted there.

## Follow-ups for next session

1. automation_core: refresh `STAGE_TRANSITIONS` mirror + actually wire the CP2
   drift test into CI (it would have caught the f82738c divergence).
2. Consider pointing `/pipeline/transitions` at the JSONB configs once the mirror
   moves (coordinated change, breaks the byte-equality pin).
3. Migration-level guard at boot (warn if sales config lacks `no_show→booked`).
4. Unify 400 vs 409 across the two PATCH stage paths in a major contract rev.
