# RECEIPT CP-Y-legacy-mode-hole (cycle 10)

**Status: DONE — and the hole was in two places, not one.**
Commit ``f4e7c37`` on `feat/consolidation`. 8 files, +385/−40. **Migration 026.** Next unused: **027.**
**Suite 1052 / 0** — `unit-cpy` **22** new; `unit-cp1` updated (see A5).

## The fix, exactly as specified

`mayAutomationSetStage(pipeline, stageKey)` → `!!s && s.mode === 'auto'`, in `server/db/pipeline.js`.
`isManualStage` is **untouched** — it drives the UI's person glyph, and moving it would repaint every
legacy stage.

The thing that makes this a real fix rather than a data patch: it asks the **positive** question. So
absent mode means "a human owns it" **for every pipeline anyone ever creates**, including ones that
predate this commit and ones no migration will ever see. Migration 026 is the second half, not the
fix itself.

Both refusals are reported separately, per your D4b.2 point. `manual_stage` = a correct
configuration; `stage_not_automatable` = usually an unfinished one. They send an operator to
different places, and a board that has quietly stopped advancing is only diagnosable if the timeline
says which.

## A SECOND HOLE, found by testing rather than reported

`PATCH /api/crm/deals/:id` calls `manualStageRefusal` — **inside an `if (dealPipelineCfg.funnel_type)`
branch**. The legacy `sales` pipeline has no `funnel_type`, so an `automated: true` PATCH could set
`won` or `lost` on a legacy deal with **nothing checking it at all**. My own test caught it: Y-4's
"the same call marked automated is 403" came back **200**, with the deal at `lost`.

This is your defect at a different write point — the HTTP twin of the write-back hole. Closing the
scheduler's path and leaving this open would have fixed the reproduction and not the defect. The mode
gate is hoisted out of the `funnel_type` branch; the transition check stays inside it, because legacy
deals are governed by `crm.js`'s own `DEAL_TRANSITIONS` map rather than the JSONB config, and
hoisting that too would gate them against the wrong table.

## Acceptance criteria

| | Result |
|---|---|
| **A1** the scenario refuses; deal stays `onboarding`; note names wanted/found/reason | **PASS** (Y-1) — and the positive control confirms the job really was claimable and acked 200, so the refusal is not vacuous |
| **A2** `webinar_marketing` → `invitees` still applies | **PASS** (Y-2). Plus a second positive control **on the legacy pipeline itself** — `marketing`/`engaged` is declared auto and still applies, so A1 cannot be passing merely because legacy write-backs are now blocked wholesale |
| **A3** the `automated: true` advance path refuses a no-mode stage with 403 | **PASS** (Y-3), `error_code: stage_not_automatable`; a declared-manual stage still says `manual_stage` |
| **A4** a HUMAN can still set `won` | **PASS** (Y-4) — and the same call marked automated is now 403 **on a legacy pipeline too**, which it was not before |
| **A5** full suite green | **PASS**, 1052/0, after the `unit-cp1` change below |

## A5 — the two `unit-cp1` failures, and why they did NOT encode the bug

You said a test asserting automated advance on a legacy pipeline would have encoded the bug. **These
are not that.** `E2` pins the seeded legacy JSONB **byte-for-byte** against the migration-006/007
literals, and it failed because migration 026 legitimately added a `mode` key to every stage.

So the literals gained `mode` and **the byte-identity pin is kept rather than loosened**. That pin is
what would catch the next silent change to the seeded funnel, and having to update it is exactly the
moment someone has to justify one. The block carries a comment saying why it changed, so a future
reader does not read it as drift.

## Migration 026 — how each mode was chosen

Not invented. Every legacy stage is matched to the stage playing its role in the operator's **own**
funnel-typed pipelines (migration 018), where they declared the modes themselves:

- **`marketing/*` → all auto.** Ingestion and routing; `engaged` is "we sent something"; `mql`
  follows lead scoring; `suppressed` is an opt-out and cannot wait for a person. **`responded` must
  stay auto** — `conversations.js` advances to it on every inbound reply, and `unit-cp1` E5 asserts it.
- **`sales/accepted, contacted, qualified, unqualified, booked, nurture` → auto.** `qualified`
  mirrors `qualification_form_fills` (a form drives it); `unqualified` mirrors `disqualified`
  ("Automated + Manual", declared auto); `booked` mirrors `scheduled_call`.
- **`sales/no_show` → MANUAL**, mirroring `no_show_followup_1`: *"the sales team marks these
  manually"*. **`proposal` → manual** (`proposal_sent`). **`negotiation` → manual** — no counterpart,
  and negotiating is a person. **`onboarding` → manual** (the delivery pipeline's own). **`won`,
  `lost` → manual**, as you specified.

`booked` and `nurture` on the sales pipeline were added by migration **006**, not 003 — I found them
by verifying coverage rather than by reading 003, and Y-6 now asserts that **no seeded stage on any
pipeline is left without a declared mode**, so the next one added cannot slip through silently.

The migration fills `mode` only where it is **absent**, so a tenant who already made a deliberate
choice keeps it, and a tenant's own extra stage on a legacy pipeline is left completely untouched —
it cannot accidentally declare something automatable that nobody described.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

Your repro should now fail to reproduce. The two probes I would add to it:

| Probe | Expect |
|---|---|
| your `orch-legacy-gate-probe.mjs`, unchanged | W1/W2 still PASS; **W3 now PASSES** — deal stays `onboarding` |
| the refusal note's `data.reason` | `stage_not_automatable` (nobody declared it), **not** `manual_stage` — legacy `won` is now declared manual, so expect `manual_stage` there and `stage_not_automatable` on a pipeline with no modes at all |
| **`PATCH /api/crm/deals/:id` `{stage:'won', automated:true}` on a LEGACY deal** | **403** — this was 200 before this commit and is not in your ticket |
| the same PATCH without `automated` | **200**, deal moves |
| a `webinar_marketing` step writing `invitees` | **still applies** — the A2 control |
| a `marketing` step writing `engaged` | **still applies** — legacy auto stages did not get caught in the blast |
| `SELECT stages FROM crm_pipeline_configs WHERE company_id IS NULL` | every stage of every seeded pipeline has a `mode` |

**The honour-system caveat is unchanged and still stands:** `automated` is a flag a caller sets, not
a derived principal. A caller that omits it is indistinguishable from a human (A7's identity work).
This is a correctness seam for well-behaved automation, **not a security boundary** — and CP-Y does
not change that. The CRM's own automated writers all set it.

## Gate hit
**None.** No push, no deploy, no live DDL, no secrets. `CONSOLIDATION_ROADMAP.md` left unstaged.
`scratchpad/` not committed.

## Follow-ups
**F42** — `isManualStage` and `mayAutomationSetStage` now disagree for a no-mode stage (neither manual
nor automatable), which is correct but means the UI shows no glyph on a stage a robot cannot set. The
honest UI is a third state ("nobody has said"), and that is a design question, not a bug ·
**F43** — `sequences.pipeline_key` is still free text: a typo'd key yields a sequence that silently
never enrols. Worth a validating check at authoring time, as `trigger_stage` already has.
