# VERDICT CP1-funnel-pipelines (cycle 1) — **PASS**

Author: ORCHESTRATOR + TESTER (session A). Date: 2026-07-31.
Subject: commit `d8a314e` on `feat/consolidation` (9 files, +1115/-93).
Method: **redone from scratch** — the builder's suite numbers, browser script and
screenshots were treated as unverified claims. Every number below is one I produced
myself on a database I rebuilt myself.

## Runtime I used (all mine, torn down after)
- Scratch Postgres 16 (embedded-postgres) `127.0.0.1:54339`, database **dropped and
  recreated**, then `migrate.sql` + migrations 002–018 re-applied in order.
- Test server `:3102`, nginx shim `:8899` (untracked `scratchpad/`), real Chromium via
  playwright-core. Server + shim killed at the end; scratch PG deliberately left up.
- My own drivers, written from the ticket (NOT the builder's `cp1-e2e.mjs`):
  `scratchpad/orch-cp1-verify.mjs`, `orch-cp1-probe2.mjs`, `orch-cp1-probe3.mjs`,
  `orch-cp1-probe4.mjs`. No tracked file was modified to inject auth headers.

## E13 — suite, re-run by me on a FRESH database
```
contract(PHASE=CP5) 66 | tenancy 15 | tenants 12 | sequences 38 | b2 16
limits 34 | b3 30 | api-keys 16 | a3 16 | cp1 83          →  326 passed, 0 failed
SUITE_FAILED=0
```
Matches the receipt's claim exactly. **E13 ✅**

## E1/E2 — migration, checked in SQL by me
Applied migration 018 a **second and third** time on top of an already-migrated DB:
- exactly **3** new global rows; `DUP GLOBAL KEYS: 0`
- `webinar_marketing` stayed `entity_type='contact'` (did **not** flip to `deal`)
- global `marketing` (9 stages) and `sales` (12 stages, i.e. mig-006 **as amended by 007**)
  `stages::text` **byte-identical** before vs after — literal string compare, both `true`
- stage keys/modes/terminal read back from the DB match `.loop/PIPELINES_SPEC.md` verbatim:
  marketing `prospects(manual) invitees visits registrants auto_registrants attendees`;
  sales 13 stages with `no_show_followup_1 / proposal_sent / deals / deal_followup_1..3`
  manual and `disqualified` terminal; delivery 5 stages all manual.
- a pipeline created fresh through `POST /pipelines` lands `entity_type='deal', funnel_type=NULL`.
**E1 ✅  E2 ✅**

## E3–E12 — each checked by me against the running app
| # | Criterion | Result | Proof |
|---|---|---|---|
| E3 | `isManualStage` manual/auto/absent/unknown | ✅ | suite (unit-cp1) + behaviour below |
| E4a | `sourced→prospects` entry 200 | ✅ | `status=200 changed=true` |
| E4b | `prospects→invitees` 200 changed:true | ✅ | 200 |
| E4c | `prospects→attendees` 409 + allowed | ✅ | `allowed=["invitees"]` |
| E4d/e | `qualification_form_fills→scheduled_call→…` 200 | ✅ | 200 |
| E4f | `qualification_form_fills→deals` 409 | ✅ | `allowed=["scheduled_call","disqualified"]` |
| E4g | legacy marketing/sales unmodified | ✅ | 243 pre-existing tests green; legacy `sourced→enriched` 200, `enriched→mql` 409 |
| E4h | untyped mig-009 key on /advance still 400 | ✅ | `Unknown pipeline_key '…' — use 'marketing' or 'sales'` |
| E4i | contact with BOTH a legacy and a webinar_sales deal | ✅ | each `deal_id` matched its own key; DB rows `null@contacted` + `webinar_sales@scheduled_call` |
| E5 | automated→manual 403 `manual_stage`; automated→auto 200; human→manual 200; 403≠409 | ✅ | all four observed |
| E5 | conversations.js inbound gate | ✅ | **negative**: tenant override marks `responded` manual → inbound reply leaves contact at `engaged`. **positive control**: mode-less tenant advances `engaged→responded`. **isolation**: override did not leak to the other tenant |
| E6 | `suppressed` refused 409; active all-channel A5 suppression refused 409 | ✅ | both, error text mentions suppression |
| E7 | PATCH funnel illegal 409; automated→manual 403; rekey refused; POST non-member 400 + `allowed_stages`; omitted stage → stages[0] | ✅ | all; rekey → `deals cannot be re-keyed into or out of a funnel-typed pipeline` |
| E8 | terminal sets closed_at; deal leaves the active lookup; a new deal is creatable + advanceable | ✅ | `metadata.closed_at=2026-07-31T18:11:07Z`, surfaced by `GET /deals/:id`; new deal created and `/advance` moved the **new** one |
| E9 | override preserves mode/terminal/entity_type/funnel_type; gates still enforced | ✅ | 6 manual preserved, `disqualified.terminal=true`, DB row `deal/webinar`; post-override auto→auto 200 / auto→manual 403 (cache invalidation works) |
| E10 | sequence validation + B2 carry-through | ✅ | valid 201; `bogus_pipeline` 400; `bogus_stage` 400; **cross-tenant company-scoped key 400 while its owner gets 201**; human advance into `no_show_followup_1` produced an **active** enrollment row |
| E11 | 3 global funnel configs listed; override appears once; DELETE semantics | ✅ | all three with `funnel_type` + per-stage `mode`; override count=1 with precedence; DELETE of an un-overridden global 404; deleting an override did **not** dump funnel deals into sales |
| E12 | `PATCH /contacts deal_stage` side door | ✅ | contact at `webinar_marketing.invitees` → 400 `use POST /contacts/:id/advance`; non-stage fields still 200 |

## E14 — evidence I captured (`.loop/EVIDENCE/CP1-funnel-pipelines/`)
`CP1-01-dashboard.png` · `CP1-02-pipelines-tab-webinar-sales.png` ·
`CP1-03-pipelines-webinar-marketing.png` · `CP1-04-sequence-modal.png` ·
`CP1-05-sequence-created.png` · `CP1-06-enrollment-on-screen.png` ·
`CP1-07-illegal-transition-409.png` · `CP1-browser-console.txt` ·
`CP1-orch-results.json` + `probe2/3/4-results.json`.

I opened every PNG. `02` shows all five pipelines in the left rail with **manual** badges on
No-Show Follow-up 1, Proposal Sent, Deals, Deal Follow-up 1–3 and **terminal** on Disqualified,
13 stages in seeded order. `06` shows `Triggers on webinar sales → no show followup 1` and
**"1 enrolled (1 active)"** — the automation actually fired. `07` shows the live 409 body with
`allowed:[no_show_followup_2, scheduled_call, disqualified]`.

Console: exactly **5** error lines, all of them the HTTP status of a deliberate refusal probe
(409/403/409/400/400). **Zero unexpected errors.** **E14 ✅**

## Three anomalies my first pass raised — all traced, none a defect
1. `POST /deals {stage:'deals'}` returned **201**, not 400. `deals` is a *member* stage of
   webinar_sales and the call was human, so E7's letter ("non-member stage 400") is met —
   unknown stage `nope` does 400 with `allowed_stages`, and `automated:true` into a manual
   member stage does 403. **My assertion was wrong, not the code.** (See follow-up F1.)
2. `deals.closed_at` **column** stayed null on a terminal advance. `closed_at` is stored in
   `deals.metadata` and surfaced by the API — the same single line serves legacy `won/lost`,
   so this is pre-existing shape, not a CP1 regression. **E8 stands.** (Follow-up F2.)
3. Legacy `/advance {stage:'engaged'}` returned 400 "pipeline_key and stage required".
   `git show d8a314e^` shows that guard **verbatim pre-CP1** — my call omitted `pipeline_key`.
   No regression.

## The 3 accepted-not-fixed LOWs — I reproduced each; all genuinely acceptable
- **Entry rule reachable on the legacy `marketing` key.** Reproduced: a contact parked at a
  non-member `marketing_stage` can now enter legacy marketing **only at `sourced`** (200; was
  409 pre-CP1), mid-pipeline entry still 409, and a `suppressed` contact is still 409 on the
  legacy key. A narrow, safe widening with no suppression escape. Accept.
- **403-before-409 when a caller is both automated and suppressed.** Both refuse; the ticket
  locks no ordering. Accept.
- **Dedup-suffixed duplicate stage keys skip prev-inheritance.** Degenerate input. Accept.

## Critic
Per the operator's 2026-07-31 22:55 policy note and the session brief, **CP1's Fable-5 review
counts as complete — no re-review is owed**, so no diff-critic pass was spent here. Its 5
fixed findings were re-checked live by me: the rekey refusal (E7g), the automated-create mode
gate (E7c), cache invalidation after an override (E9c), the name-collision-safe side door
(E12), and `terminal:false` clearing (E9a) all behave as claimed.

## VERDICT: **PASS** — CP1 is banked.

## Follow-ups logged (do NOT silently fix; they are not CP1 defects)
- **F1** `POST /deals` on a funnel-typed pipeline accepts **any member stage** for a human
  caller — including manual and terminal ones. A deal created directly at `disqualified` is
  born with `metadata.closed_at` **null** yet is immediately invisible to `/advance` (404 "no
  active deal"). Contact pipelines have a stages[0] entry rule; deal pipelines have none.
  Candidate for CP2/CP5.
- **F2** `deals.closed_at` column is never written by any stage authority; `closed_at` lives
  only in `metadata` JSONB. Any reporting SQL reading the column sees null. Pre-existing.
- **F3** The sequence detail shows an enrollment **count**, not the enrolled contacts. The
  ticket's browser step 4 wanted the contact listed; I proved the row via the API instead
  (E10 explicitly allows this). Enrollment list view → CP5.
- **F4** `nice()` lowercases labels, so the trigger line renders "webinar sales → no show
  followup 1". Cosmetic, pre-existing helper.
