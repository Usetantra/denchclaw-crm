# CP-Y2 — CP-Y closed one of three write points. A robot can still mark a deal Won.

**Severity: high. Same defect, still live on the most common deal shape in the product.**

Your CP-Y receipt was right that the HTTP PATCH path was a second hole, and right to say that
fixing the scheduler alone would have "fixed the reproduction and not the defect". That
reasoning was correct — it just needs to go one branch further.

## What I measured at HEAD (f4e7c37), over HTTP, on a virgin DB

    PATCH automated → won on built-in sales: status=200 stage='won'     ← STILL OPEN
    CREATE automated directly at won:        status=201 stage='won'     ← STILL OPEN
    ADVANCE automated → won:                 404 (no active deal)       — different guard, fine

A $90,000 deal, moved to **Won** by `automated: true`, through the shipped HTTP API, after CP-Y.

## Why the fix missed it

`POST /deals` normalises the built-in pipeline to NULL (crm.js:1067):

    const newKey = updates.pipeline_key && updates.pipeline_key !== 'sales' ? updates.pipeline_key : null;

So **built-in sales deals are stored with `pipeline_key = NULL`** (I confirmed this in the table —
both probe deals read `NULL`). The PATCH stage block then branches:

    if (!deal.pipeline_key) {          // ← built-in sales. Transition check ONLY. NO MODE GATE.
      const salesPipeline = await getPipelineConfig(companyId, 'sales');
      ... getPipelineTransitions ... 409 if illegal
    } else {                           // ← CP-Y hoisted the mode gate into THIS branch only
      dealPipelineCfg = await getPipelineConfig(companyId, deal.pipeline_key);
      const patchRefusal = manualStageRefusal({ ... });
    }

The gate went into the `else`. The `if` is the default sales pipeline — where `won` and `lost`
actually live. Migration 026 correctly declares them manual; nothing on this path asks.

**Second write point:** `POST /deals` guards its `createRefusal` with `if (cfg && cfg.funnel_type)`
(crm.js:919/936) — the identical `funnel_type`-conditional pattern you just removed from PATCH. So
a deal can be **created** directly at `won` with `automated: true` → 201.

## Fix

Run the mode gate for **every** deal write, before the branch, not inside either arm.

1. **PATCH** — resolve the config once (`deal.pipeline_key ? that : 'sales'`) and call
   `manualStageRefusal` **above** the `if (!deal.pipeline_key)` split. Leave both transition
   checks exactly where they are — your reasoning about `DEAL_TRANSITIONS` vs the JSONB config
   still holds and I'm not asking you to touch it.
2. **POST /deals** — hoist `createRefusal` out of the `funnel_type` condition, same as PATCH.
3. Re-check for any other `funnel_type`-conditional gate. This pattern has now produced three
   instances; grep the file for `funnel_type` and confirm each remaining one is a *transition*
   check (legitimately funnel-only) rather than a *mode* check.

## Acceptance criteria

- B1 `PATCH /deals/:id {stage:'won', automated:true}` on a **NULL-pipeline_key** deal → 403,
  deal unmoved.
- B2 `POST /deals {stage:'won', automated:true}` → 403.
- B3 **POSITIVE CONTROL, and I will test it specifically:** an automated PATCH to a stage
  declared `auto` (e.g. `contacted → booked`) still returns 200 and moves the deal. Note my own
  P5 "positive control" last round passed only because that path was *ungated* — once you gate
  it, this becomes a real assertion for the first time.
- B4 a HUMAN PATCH to `won` still returns 200.
- B5 full suite green.

Repro: `scratchpad/orch-cpy2-probe.mjs`. Receipt to `.loop/receipts/CP-Y2-builtin-sales-gate.md`.
