# CP-Y — automation can mark a legacy deal `won`. Close the hole.

**Severity: high.** Not triggered by any shipped automation, but reachable by any operator
using the B7 sequence builder — which is a live HTTP CRUD surface.

## What I proved (positive control passed, so this is not vacuous)

On a cold DB built from `HEAD`, driving the real `claimJobs` → `ackJob` path:

    W1 POSITIVE CONTROL — the job really is claimable       PASS  (claimed 1)
    W2 the ack succeeds                                     PASS  (200)
    W3 a robot must NOT be able to mark a legacy deal `won` FAIL
       !!! deal 825ba226… is now stage='won', set with no human involved

    activity trail:
      stage_change — Stage (sales): onboarding → won (sequence step)
      email_sent   — Sent via email

A $50,000 deal, moved to **Won** by a sequence step. No human touched it.

## Root cause

`applyStageWriteback` (server/db/models/dispatch.js:582) guards with
`isManualStage(pipeline, target)`, and that is (server/db/pipeline.js:67):

    return !!s && s.mode === 'manual';

**Absent `mode` returns `false` — i.e. "not manual" — so the gate opens.** The legacy
`marketing` and `sales` pipelines declare no `mode` on any stage (confirmed via
`GET /api/crm/pipelines`), so on those pipelines the only remaining guard is transition
legality, and `onboarding → won` is legal. `sequences.pipeline_key` is free text and
migration 014 documents `'marketing' | 'sales'` as expected values, so a sequence targeting
them is a supported configuration, not an abuse.

I recorded this last tick as a caveat and called it "not a defect". I was wrong: I asserted
it instead of testing it. It is a defect.

## The fix — decided, build it this way

**Automation may only set a stage that is explicitly declared `auto`.** Fail closed, opt-in
rather than opt-out. Absent `mode` must mean "a human owns it", because that is the safe
reading when nobody has said otherwise.

1. Add a distinct predicate in `server/db/pipeline.js` — do **not** change `isManualStage`:

       function mayAutomationSetStage(pipeline, stageKey) {
         const s = findStage(pipeline, stageKey);
         return !!s && s.mode === 'auto';
       }

   Keep `isManualStage` exactly as it is. It also drives the UI's person glyph, and
   flipping absent-mode to manual there would paint every legacy stage with a glyph — a
   large, separate UI change that is not what this ticket is for.

2. Use it at **both** automated write points, replacing the `isManualStage` check:
   - `applyStageWriteback` (dispatch.js ~582)
   - the `automated: true` path in `manualStageRefusal` / `advanceContactStage`
     (server/lib/stage-authority.js)

   Keep the existing refusal shape: 403 / `error_code: 'manual_stage'` on the advance path,
   and the `stage_writeback_refused` timeline note on the write-back path. The note's reason
   should distinguish the two cases — `manual_stage` vs `stage_not_automatable` — so a frozen
   board stays diagnosable, which was the whole point of D4b.2.

3. Declare `mode` explicitly on every stage of the legacy `marketing` and `sales` pipeline
   configs, so the boards read honestly and any intended automation is opt-in and visible.
   `won` and `lost` are **manual**. Use your judgement on the rest; the operator's rule is
   that anything a human decides is manual.

## Acceptance criteria

- A1 The exact scenario above now REFUSES: deal stays `onboarding`, timeline carries a
  `stage_writeback_refused` note naming wanted/found and the reason.
- A2 Positive control still green — a `webinar_marketing` step writing back `invitees`
  (declared `auto`) still applies. A fix that simply blocks all write-backs is not a fix.
- A3 The `automated: true` advance path refuses a no-mode stage with 403.
- A4 A HUMAN can still set `won` — the gate blocks automation, not people.
- A5 Full suite stays green. If any existing test asserted automated advance on a legacy
  pipeline, that test encoded the bug — fix the test and say so in the receipt.

Repro is committed at `scratchpad/orch-legacy-gate-probe.mjs` (scratchpad — do not commit it).
Write the receipt to `.loop/receipts/CP-Y-legacy-mode-hole.md`; I verify independently.
