# RECEIPT CP1-funnel-pipelines (cycle 1)

## Status: DONE
Commit `d8a314e` on `feat/consolidation` (fetched origin first; origin migrations still top out at 011, branch 012–017, so 018 confirmed next). Not pushed, not deployed, no live DDL.

## Files changed (1-line why each)
- `migrations/018_funnel_pipelines.sql` (NEW) — funnel_type + entity_type columns, entity_type backfill (`key <> 'marketing' AND funnel_type IS NULL` → 'deal'), seeds the three global webinar rows with the ticket's exact JSONB; idempotent twice.
- `server/db/pipeline.js` — loader carries entity_type/funnel_type (frozen, cached); `isManualStage`/`isTerminalStage`/`terminalStageKeys`/`findStage`; `findFunnelContactPipelineForStage` (decision 10, name-collision-safe); cache-invalidation hub (`invalidateCompanyPipelines` + listener registry).
- `server/routes/crm.js` — /advance generalized (entity_type branch, entry rule + suppression refusals, automated/manual 403, terminal-aware funnel deal lookup + closed_at, sales-only nurture recycle); POST /deals funnel validation + contact-pipeline refusal + creation mode-gate; PATCH /deals funnel gate + REKEY refusal; PATCH /contacts deal_stage side door; stats/GET /deals count terminal funnel deals as closed.
- `server/routes/pipelines.js` — normalizeStages/withColors preserve mode/terminal (terminal:false clears); resolve/list carry entity_type/funnel_type; global funnel rows listed override-aware (once); POST collision check includes globals + explicit entity_type='deal'; PATCH inherits entity_type/funnel_type; DELETE of a global-backed key's override no longer reassigns deals; every write invalidates the config caches.
- `server/routes/sequences.js` — config-driven pipeline_key validation via getPipelineConfig (tenant-scoped) + trigger_stage membership 400.
- `server/routes/conversations.js` — inline `isManualStage` check before the inbound auto-advance write (no-op for mode-less legacy configs; comment documents why).
- `web/index.html` — manual/terminal badges in the pipeline editor stage rows; new-sequence modal's pipeline dropdown fed from GET /pipelines (webinar keys appear); esc() defenses untouched.
- `test/unit-cp1-funnel-pipelines.mjs` (NEW) — 83 checks numbered against E1–E12 + critic-fix regressions F1–F7.
- `test/run-local.sh` — runs the new CP1 test file after unit-a3.

## Migration added + applied to scratch DB? 
Yes — **018**, applied to the throwaway scratch Postgres (never any live DB), and applied a **second** time inside the test run (E1 double-apply proof: no dup rows, seeded webinar_marketing stays entity_type='contact').

## Tests: 326 pass, 0 fail (83 new). 
Command context: Docker's daemon wedged mid-session (API dead on both sockets; left untouched to avoid bouncing 5 live containers of other projects), so the scratch DB ran as PostgreSQL 16 via `@embedded-postgres/darwin-arm64` binaries on `127.0.0.1:54339` — still local + throwaway, `migrate.sql` + migrations 002–018 applied in order via `scratchpad/apply-sql.mjs`, and `scratchpad/run-suite.sh` mirrors `test/run-local.sh`'s exact server-env + test order (`npm test` itself requires docker/psql). Totals: contract 66 (PHASE=CP5) + tenancy 15 + tenants 12 + sequences 38 + b2 16 + limits 34 + b3 30 + api-keys 16 + a3 16 + **cp1 83** = **326**, run start-to-finish on a fresh DB after the final code change. Verifier rerun: `scratchpad/pgruntime/.../bin/pg_ctl -D scratchpad/pgdata -o "-p 54339 -c listen_addresses=127.0.0.1 -k /tmp" start` → `DATABASE_URL_TEST=postgres://denchclaw@127.0.0.1:54339/denchclaw_test node scratchpad/apply-sql.mjs` (after `DROP/CREATE DATABASE denchclaw_test` via the port-54339 `postgres` db) → `bash scratchpad/run-suite.sh`.

## Eval criteria E1–E14 (each proven by a named check in unit-cp1 unless noted)
- **E1** ✅ double-apply clean; exactly 3 global rows; per-stage key/mode/terminal/transitions canon-compared cell-for-cell against the ticket tables; re-run does not flip webinar_marketing to 'deal'.
- **E2** ✅ global marketing byte-identical to mig-006 literal; global sales byte-identical to the **mig-006+007** literal (ticket said 006; 007 later added `no_show → booked` — the pre-CP1 DB truth, verified, test literal documents it); planted pre-migration-shaped company `sales` override + mig-009-style custom row both backfilled 'deal' on re-apply.
- **E3** ✅ manual→true, auto→false, absent→false, unknown-stage→false, null-pipeline→false.
- **E4** ✅ (a) sourced→prospects entry 200; (b) prospects→invitees 200 changed:true; (c) prospects→attendees 409+allowed; (d) qual→scheduled_call 200; (e) scheduled_call→deals 200; (f) qual→deals 409; (g) all 243 existing tests pass UNMODIFIED; (h) untyped custom key 400; (i) both-deals contact — each key moves its own deal (deal_id + per-row DB stage asserted).
- **E5** ✅ automated→manual 403 `error_code:'manual_stage'` (deal AND contact paths); automated→auto 200; human→manual 200; 403/409 shapes asserted distinct; conversations gate proven behaviorally (tenant override marks `responded` manual → inbound reply does NOT advance; **plus positive control**: mode-less tenant's reply still advances to responded).
- **E6** ✅ contact at `suppressed` 409; contact with active all-channel A5 suppression 409 with 'suppress' in the error.
- **E7** ✅ PATCH funnel illegal jump 409; PATCH automated→manual 403; untyped custom free-move 200; legacy sales PATCH unchanged (legal 200/illegal 409); POST non-member stage 400+allowed_stages; omitted stage → stages[0].
- **E8** ✅ disqualified sets closed_at; deal drops out of the active lookup (404); new webinar_sales deal creatable and advanceable.
- **E9** ✅ rename-one-stage override: every mode preserved, terminal preserved, entity_type/funnel_type inherited (asserted on the DB row too), appears once, mode gates still enforced for that tenant.
- **E10** ✅ webinar_sales+no_show_followup_1 201; bogus pipeline 400; bogus stage 400; cross-tenant company-scoped key 400; esc() defenses present; B2 carry-through — human advance into no_show_followup_1 → active enrollment via GET /sequences/:id/enrollments.
- **E11** ✅ three global funnel configs with funnel_type + per-stage mode; override appears once with precedence; DELETE of a global key 404 (tested before any override exists).
- **E12** ✅ deal_stage PATCH at a webinar stage → 400 pointing to /advance; non-stage fields still 200.
- **E13** ✅ 326 total (above).
- **E14** ✅ below.

## Browser e2e walkthrough (real Chromium via playwright-core + the machine's cached browser, through scratchpad/cp1-dev-shim.mjs — an nginx simulator injecting X-Internal-Key/X-Company-Id and rewriting /crm/api/* → /api/crm/*; **no tracked file was modified for the shim, so there was nothing to revert** — `git show --stat d8a314e` confirms only the 9 ticket files)
1. Boot scratch stack → shim at 127.0.0.1:8899/crm/ → dashboard loads. 
2. Pipelines tab → Webinar Marketing/Sales/Delivery listed alongside legacy; webinar_sales stages in seeded order; "manual" badge on all 6 manual stages, "terminal" on Disqualified → **EVIDENCE/CP1-pipelines-tab.png** (visually verified).
3. Sequences tab → created "No-show recovery (test)" with pipeline `webinar_sales` (present in dropdown) + trigger `no_show_followup_1` → listed with trigger rendered escaped → **EVIDENCE/CP1-sequence-created.png**.
4. Contact + webinar_sales deal (starts qualification_form_fills) → human advance → scheduled_call → no_show_followup_1 → sequence detail shows **"1 enrolled (1 active)"** → **EVIDENCE/CP1-enrollment.png**.
5. Illegal `qualification_form_fills→deals` fired in-page through the shim → HTTP 409 `{error, current, requested, allowed:[scheduled_call,disqualified]}` rendered on-screen → **EVIDENCE/CP1-illegal-transition.png**.
6. Console: zero errors across steps 2–4; the single expected Chromium "Failed to load resource: 409" line from the deliberate step-5 probe is the only error after → **EVIDENCE/CP1-browser-console.txt**. E2E re-run green against the final (post-critic-fix) code.

## Critic (per .loop/CRITIC_POLICY.md)
**FABLE-5 fallback** (Codex auth dead). Verdict on the initial diff: **FAIL** — 1 HIGH + 2 MEDIUM + fixable LOWs; its "E13 unexecuted/E14 absent" blockers were timing artifacts (it reviewed while the suite/evidence were in flight). **Fixed in this cycle, each with regression checks (F1–F7 in unit-cp1):**
1. (HIGH) PATCH /deals `pipeline_key` rekey was an ungated bypass of the whole funnel state machine → rekeys into/out of funnel-typed pipelines now 400; untyped↔legacy rekeys unchanged.
2. (MED) `automated:true` could CREATE a deal directly in a manual stage → POST /deals mode-gates the resolved initial stage (403 manual_stage), incl. manual stages[0] defaults (webinar_delivery).
3. (MED) config writes left the three 60s caches stale → pipelines.js POST/PATCH/DELETE now invalidate pipeline.js `_cache` + `_funnelContactKeysCache` + crm.js `_pipelineCache` immediately; proven by priming the cache before the override (F3).
4. (MED) side-door gate keyed off a bare stage name could lock legacy contacts under a name-colliding tenant override → ambiguous names (also legacy-marketing stages) now resolve to legacy behavior (F4).
5. (LOW) `terminal:false` couldn't clear an inherited flag → incoming-wins, symmetric with mode (F7). Plus the critic's test-quality gap: positive control added for the conversations gate.
**Accepted, documented, not fixed:** entry rule + suppression refusal now also reachable on legacy `marketing` key (unreachable with legacy-written data — critic traced all writers); automated+suppressed entry gets the 403 before the suppression 409 (both refuse; ticket doesn't lock order); dedup-suffixed duplicate stage keys skip prev-inheritance (degenerate input).

## Deviations / assumptions
- Scratch DB ran on embedded-postgres binaries instead of Docker (daemon wedged machine-wide; not restarted to protect 5 live containers of other projects). Same PG 16, same schema path, same test order.
- E2 sales baseline is mig-006 **as amended by 007** (see E2 above).
- POST /deals also refuses funnel-typed **contact**-entity pipelines (400) — a small extension beyond decision 6's letter; without it a webinar_marketing "deal" would be unreachable by every stage authority.
- Stats decision 7: terminal funnel deals excluded from open/pipeline_value (still in total; not counted won/lost).
- `CONSOLIDATION_ROADMAP.md` has an uncommitted operator edit (critic-policy addition) — deliberately left unstaged, not mine to commit.

## Gate hit
None. No push/deploy/live-DDL/nginx/secrets touched.

## Follow-ups noticed but out of scope
- `GET /pipeline?pipeline_key=webinar_marketing` returns a deals-shaped (empty) board — contact-entity funnel board view for the dashboard is unbuilt (CP2+ candidate).
- Per .loop/CRITIC_POLICY.md: re-review CP1 with Codex once `codex login` is restored (Fable-5-only critic on this checkpoint).
- Docker daemon on this box needs a human-timed restart (API dead on both sockets; live containers of other projects made me leave it).
- Pre-existing (flagged in earlier cycles, still open): other insert routes' raw-500-on-unprovisioned-tenant shape; naive CIDR matching in auth.js `ipAllowed()`.
