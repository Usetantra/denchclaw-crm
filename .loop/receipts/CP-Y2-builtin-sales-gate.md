# RECEIPT CP-Y2-builtin-sales-gate (cycle 11)

**Status: DONE.** Commit ``f899c2d`` on `feat/consolidation`. 2 files, +105/−23. **No migration** — 027
still free. **Suite 1065 / 0** — `unit-cpy` now **35** (13 new).

## You were right, and the diagnosis was exact

CP-Y hoisted the PATCH gate out of `if (funnel_type)` and put it in the **`else`** arm. `POST /deals`
normalises the built-in pipeline to NULL, so built-in deals take the **`if`** arm — and `won`/`lost`
live there. I moved the gate one branch short of the stages that matter and wrote a comment claiming
"THE MODE GATE RUNS FOR EVERY PIPELINE" directly above code that did not. **An aspirational comment
on a gate is worse than no comment**, because it is what the next reader checks instead of the code.

The lesson is now in the source rather than only in a receipt: **a gate placed inside any arm of a
branch is a gate that only guards some writes.** The config is resolved once — `deal.pipeline_key`
or the built-in `sales` — and the gate runs **above** the split. One place asks "may a robot set this
stage?", for every deal write.

`POST /deals` had the identical `funnel_type`-conditional pattern, so an automated create straight at
`won` was a 201. Hoisted out too.

## Acceptance

| | Result |
|---|---|
| **B1** `PATCH {stage:'won', automated:true}` on a NULL-pipeline_key deal → 403, unmoved | **PASS** (Y-7), `error_code: manual_stage` — migration 026 declares built-in `won` manual, so it refuses by the right reason |
| **B2** `POST /deals {stage:'won', automated:true}` → 403 | **PASS** (Y-8), and **no deal was minted at all** — which matters, because a minted deal wins the active-deal lookup |
| **B3** automated PATCH `contacted → booked` still 200 and moves | **PASS** (Y-9), plus an automated CREATE at a declared-`auto` stage still 201s |
| **B4** a HUMAN PATCH to `won` still 200 | **PASS** (Y-10), and a human CREATE at `won` still 201s |
| **B5** full suite green | **PASS**, 1065/0 |

**Y-7 first asserts the premise** — that a built-in deal really is stored with `pipeline_key = NULL`
— so the rest of the block cannot pass by testing the wrong arm, which is exactly how CP-Y's own
tests missed this.

**On your B3 note:** you are right that your earlier positive control proved nothing because the path
was ungated. That is the sharper version of a problem I hit myself in CP-D, where a test asserted a
column and passed while the behaviour was wrong. Y-9 is a real assertion now, and there is a
matching one for creation.

**Y-10 also pins the transition check**, which you told me not to touch: `contacted → won` on the
built-in arm is still a **409**, so the hoist did not swallow it.

## The `funnel_type` audit you asked for

Six remaining uses in `crm.js`, none a mode check:

| Line | What it is |
|---|---|
| 203 | SELECT filter — which pipelines to list |
| 761 | `/advance` pipeline_key validation — which keys are traversable |
| 919 | create-time stage **membership** validation (400 for a non-member stage); legitimately funnel-only, since untyped pipelines coerce to `stages[0]` by design |
| 1079 | rekey refusal into/out of a funnel |
| 1137 | **transition** check — funnel-only, left alone per your instruction |
| 1158 | terminal/`closed_at` semantics |

## One thing I found and did NOT fix, because it is out of scope and worth deciding deliberately

`DEFAULT_DEAL_STAGES` (the create-time whitelist) and the seeded `sales` JSONB **disagree**:
`lead` and `proposal_accepted` are in the array and in no pipeline config. Consequences today:
- `getPipelineTransitions(salesCfg, 'lead')` returns `[]`, so a built-in deal created at the default
  stage `lead` **cannot legally move anywhere** — a pre-existing 409 trap, not introduced here.
- Nothing declares them, so automation cannot set them either. That is the correct fail-closed
  behaviour, but it means an external engine creating a deal at `lead` with `automated: true` now
  gets a 403 where it previously got a 201.

**No CRM-owned automation creates deals** — the only `automated: true` producer is the marketing
ingest, and that is a *contact* advance — so nothing internal regressed, and the suite is green. But
an outside caller could notice. Filed as **F44**; the fix is to make the seeded `sales` config
complete (add `lead`/`proposal_accepted` with modes and transitions) rather than to special-case
undeclared stages, because special-casing them would reintroduce "unknown ⇒ allowed", which is the
exact shape of the original defect.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

`scratchpad/orch-cpy2-probe.mjs` should now report 403/403 where it reported 200/201. Worth adding:

| Probe | Expect |
|---|---|
| `PATCH {stage:'won', automated:true}` on NULL-pipeline_key | **403** `manual_stage`; deal unmoved |
| `POST /deals {stage:'won', automated:true}` | **403**, and **zero** deals for that contact |
| `PATCH {stage:'booked', automated:true}` from `contacted` | **200**, deal moves — the control that now means something |
| `POST /deals {stage:'contacted', automated:true}` | **201** |
| the same two without `automated` | **200 / 201** |
| `PATCH {stage:'won'}` from `contacted`, no automated flag | **409** — the transition check survived the hoist |
| `POST /deals {stage:'lead', automated:true}` | **403** — see F44; this is a behaviour change, deliberate and fail-closed |
| a custom untyped pipeline with mode-less stages | automated writes **refused** (your extra check, now also true on PATCH and create) |

## Gate hit
**None.** No push, no deploy, no live DDL, no secrets. `CONSOLIDATION_ROADMAP.md` unstaged,
`scratchpad/` not committed.

## Follow-ups
**F44** — `DEFAULT_DEAL_STAGES` vs the seeded `sales` config disagree on `lead`/`proposal_accepted`;
make the config complete rather than special-casing undeclared stages · **F42** a no-mode stage is now
neither manual nor automatable, and the UI shows no glyph for it — the honest UI is a third state ·
**F43** `sequences.pipeline_key` is free text; a typo yields a sequence that silently never enrols.

## Next
Unchanged: **F38, the anchored scheduler** — a port of `nurturing-engine/.../dispatcher.py:160-204`,
and still the last thing between the marketing funnel and being real.
