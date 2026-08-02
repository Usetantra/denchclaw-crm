# RECEIPT CP2-step-scheduler (cycle 1)

## Status: DONE
Commit `13a89c8` on `feat/consolidation` (see `git log -1`); `git fetch origin` run
first. **7 files, +1353/-39.** Not pushed, not deployed, no live DDL, no nginx, no secrets.
`git show --stat HEAD` confirms only ticket files landed — nothing from `scratchpad/`.
`CONSOLIDATION_ROADMAP.md` still carries the operator's uncommitted edit, deliberately unstaged.

## Files changed (1 line why each)
- `migrations/019_step_scheduler.sql` (NEW) — `sequence_steps.stage_writeback TEXT` (nullable) +
  `UNIQUE (enrollment_id, step_id)` on `scheduled_actions`, de-duplicating pre-existing rows
  first so it applies to a dirty DB.
- `server/db/models/sequences.js` — transactional `enroll()` (D1) incl. zero-step completion
  (D1b); new `materializeNextStep()` (the seam); new `resumeSequenceQueue()` (critic F1 fix);
  new `listEnrollmentsWithQueue()` (UI); `addStep` carries `stage_writeback`; `scheduleAction`
  became an UPSERT; `enrollForTriggerStage` records failures on the timeline (D10).
- `server/db/models/dispatch.js` — `ackJob` split into `ackJobCore` (transaction) + post-commit
  `runStepSideEffects` (D3); current-step guard (D3b); `applyStageWriteback` through CP1's mode
  gate (D4); `advanceEnrollment` (D2/D5b) now records a skipped enqueue; `claimJobs` gained the
  sequence-status filter (D5b) and the global-vs-channel suppression split (D7).
- `server/routes/sequences.js` — `stage_writeback` accepted + chain-validated at config time
  (D4b.1); `PATCH /:id` backfills the queue on re-activation; new `GET /:id/queue`.
- `web/index.html` — additive only (+41): "Enrollments & queue" block, write-back tag on step
  rows, `stage_writeback` field in the add-step modal. No restructuring of existing markup.
- `test/unit-cp2-step-scheduler.mjs` (NEW) — 128 checks numbered against E1–E16.
- `test/run-local.sh` — registers the new file (also wired into untracked `scratchpad/run-suite.sh`).

## Migration added + applied to scratch DB?
**Yes — 019**, applied ONLY to the throwaway scratch Postgres on `127.0.0.1:54339`, never any
live DB. **Double-apply proven**, and triple: the suite re-applies the file twice inside E1, and
a dedicated harness applied it a 2nd and 3rd time on an already-migrated DB. Also proven
against a DB seeded with duplicate `(enrollment_id, step_id)` rows: de-duplicates to one,
keeping the row with the most progress, then builds the index, which then rejects 23505.
**Note:** `migrate.sql` (base schema) is NOT idempotent, so the double-apply proof re-applies
the migration file alone, not the whole chain.

## Tests: 454 pass, 0 fail (128 new). All 326 pre-existing pass UNMODIFIED.
```
contract(PHASE=CP5) 66 | tenancy 15 | tenants 12 | sequences 38 | b2 16
limits 34 | b3 30 | api-keys 16 | a3 16 | cp1 83 | cp2 128   ->  454 passed, 0 failed
SUITE_FAILED=0
```
Exact commands (fresh DB, start to finish):
```
node scratchpad/reset-db.mjs
DATABASE_URL_TEST=postgres://denchclaw@127.0.0.1:54339/denchclaw_test node scratchpad/apply-sql.mjs
bash scratchpad/run-suite.sh
```
`npm test` / `test/run-local.sh` still need docker+psql, and Docker is wedged machine-wide
(other projects' live containers — left alone). `scratchpad/run-suite.sh` mirrors run-local.sh's
server env and test order on `:3101`.

## Eval criteria E1–E16 (each proven by a named check in unit-cp2 unless noted)
- **E1** ✅ 019 re-applies twice+; `stage_writeback` exists, TEXT, nullable; no pre-existing step
  got a backfilled value; UNIQUE index present; duplicate-tolerance proven (sent row kept).
- **E2** ✅ exactly one `pending` row for step 1; `scheduled_for = enrolled_at + delay` (±2s,
  also proven with a 2-day delay); channel/template_ref/contact_id derived from the step and
  enrollment, not the caller.
- **E2b** ✅ zero-step sequence → enrollment created, **zero** rows, status `completed`,
  `completed_at` set, `current_step_id` null.
- **E3** ✅ both paths queue: manual `enroll()` and `enrollForTriggerStage` via a real human
  `POST /advance` into `no_show_followup_1`; the queued job is then claimable over HTTP.
- **E4** ✅ re-enroll returns the same enrollment with exactly one step-1 row; two concurrent
  enrolls converge on one enrollment and one row.
- **E5** ✅ `current_step_id` moves to step 2; exactly one new pending row; anchored on the ACK
  (+3d ±10s), not on enrollment; step-1 row terminal.
- **E6** ✅ (covered inside E13) last step → `completed`, `completed_at` set, no new row.
- **E7** ✅ replayed `ack(sent)` → idempotent 200, no new row, no advance, stage unchanged.
- **E8** ✅ `stage_writeback='no_show_followup_2'` moves the deal, proven in the deal row plus a
  `stage_change` activity carrying `via:'sequence_step'`.
- **E9** ✅ **the most important one.** `proposal_sent` (manual, and a *legal* hop from
  `scheduled_call`, so only the mode gate can refuse it): ack **200**, job `sent`, deal stage
  **unchanged**, `stage_writeback_refused` activity naming `wanted`/`found`/`reason:manual_stage`.
  Illegal transition proven separately with `reason:illegal_transition`.
- **E10** ✅ forced a genuine in-path throw (poisoned `deals.metadata` JSONB → `JSON.parse`
  throws): ack still 200, row committed `sent` with `sent_at`, failure on the timeline, and
  after ageing `claimed_at` 2h past `CLAIM_TIMEOUT_MS` the row is **not** reclaimed — no re-send
  loop. Also asserts the accepted trade-off: that ladder stalls rather than re-sending.
- **E10b** ✅ acking a job whose `step_id` isn't the enrollment's `current_step_id` → 200, no
  advance, no enqueue.
- **E11** ✅ each proven separately: global suppression → `exited`/`suppressed`, nothing further
  queued; **channel-specific** suppression → stays `active` and advances to the sms step;
  `ack(skipped)` → next step queued at the ack anchor (+3d ±10s); retryable `ack(failed)` →
  enrollment untouched, row requeued with backoff, nothing new queued; dead-lettered
  `ack(failed)` → `exited`/`failed`.
- **E11b** ✅ a **due** pending row of a paused sequence is not claimable and is not consumed;
  re-activating makes it claimable; a paused sequence enqueues nothing on ack **and records the
  skip**; and (critic F1 regression) re-activating **backfills** the stranded step, which is
  then claimable, and a second activate is idempotent.
- **E12** ✅ valid chain accepted and persisted; `fu2 → fu4` rejected 400 "not walkable";
  unknown stage 400 with `allowed_stages`; `stage_writeback` without a `pipeline_key` 400.
- **E13** ✅ full ladder on `webinar_sales` with `0/3d/3d/3d/7d`: human `/advance` enrolls, each
  ack queues the next at the right offset (timing asserted as `scheduled_for` **deltas**, never
  by waiting), the board mirrors `no_show_followup_1..5`, enrollment ends `completed`, nothing
  pending, and exactly 5 rows were ever queued (no duplicates).
- **E14** ✅ `unit-b3` 30/30 and `unit-limits` 34/34 pass **unmodified**; quiet hours, rate limit
  and suppression still gate claims. No advisory lock added to the ack path, no `claimJobs` call
  from `ackJob`, no lock-ordering cycle.
- **E15** ✅ owning tenant reads its queue; another tenant gets **404** with no enrollment data;
  cross-tenant `enroll` returns null; `materializeNextStep` returns null for a foreign/unknown
  enrollment and **throws** without `companyId`; unknown `stage_writeback` 400.
- **E16** ✅ 454 total on a fresh DB, 326 pre-existing unmodified.
- **E17** — not mine; the orchestrator captures browser evidence.

--- TEST BRIEF FOR THE ORCHESTRATOR ---

**Seed script:** `scratchpad/seed-CP2-step-scheduler.mjs` (untracked). Run it with your own
tenant/port; it prints every id plus ready-to-paste curl commands.
```
CRM_API_BASE=http://127.0.0.1:3102 INTERNAL_API_KEY=<yours> \
DATABASE_URL=postgres://denchclaw@127.0.0.1:54339/denchclaw_test \
CP2_TENANT=tantra node scratchpad/seed-CP2-step-scheduler.mjs
```
It creates:
- **Dana No-Show** + a `webinar_sales` deal at `qualification_form_fills`.
- **"No-show recovery"** — the real ladder: 5 email steps, `0 / 259200 / 259200 / 259200 /
  604800`, `stage_writeback` `no_show_followup_1..5`, trigger `no_show_followup_1`.
- **"No-show recovery (fast)"** — identical but `0/60/60/60/60` **seconds**. This is your
  short-delay variant: walk this one to see step 2 become due in a minute instead of 3 days.
  Both share the trigger stage, so ONE human advance enrols both.
- **Milo Manual** + a deal parked at `scheduled_call`, and **"Manual guard probe"** (manual
  enrollment only, single step, `stage_writeback='proposal_sent'`) already enrolled with step 1
  queued and due — this is your step-4 manual-refusal probe.

**UI path**
- Sequences tab → pick the sequence → steps list shows each step with a `→ <stage>` tag for its
  write-back; below it a new **"Enrollments & queue"** block lists, per enrollment: contact name,
  current step #, enrollment status (+`exit_reason`), then one row per action with step #,
  channel, `→ writeback`, an **absolute** timestamp (`scheduled …` / `sent …`) and a status chip
  (`pending`/`claimed`/`sent`/`skipped`/`failed`).
- Add-step modal has a new optional **"Stage write-back"** field.

**API probes**
- `POST /api/crm/contacts/<dana>/advance {"pipeline_key":"webinar_sales","stage":"scheduled_call"}` → **200**
- `POST .../advance {"pipeline_key":"webinar_sales","stage":"no_show_followup_1"}` → **200**, body
  carries `sequence_enrollments` (one entry per triggering sequence — **both** seeded ladders fire).
- `POST /api/crm/channel-jobs/claim {"channel":"email","limit":25,"claimed_by":"orch-exec"}` → **200** + `jobs[]`
- `POST /api/crm/channel-jobs/<job>/ack {"status":"sent","claimed_by":"orch-exec"}` → **200** `{status:"sent"}`
- `GET /api/crm/sequences/<id>/queue` → **200** `{total, sequence_status, enrollments[{contact_name,
  current_step_order, status, actions[{step_order, channel, status, scheduled_for, sent_at, stage_writeback}]}]}`
  ; **404** under another tenant's `x-company-id`.
- `PATCH /api/crm/sequences/<id> {"status":"paused"}` → 200; `{"status":"active"}` → 200, and may
  carry `requeued_actions: N` when it backfilled a step stranded by the pause.

**What "working" looks like (the automation, not the render)**
1. A human advance into `no_show_followup_1` produces a `pending` row **due now** — that is the
   seam CP2 built; before this, enrolling produced nothing at all.
2. Ack step 1 `sent` → step 2 appears `pending` **three days out** (or 60s on the fast variant)
   and the **deal moves to `no_show_followup_2`**. The board mirroring is the point.
3. Ack Milo's `proposal_sent` step → ack is **200**, the step shows `sent`, and the deal is
   **still `scheduled_call`**. The CRM refused to auto-set a manual stage. The contact's activity
   feed shows `stage_writeback_refused` naming wanted vs found.
4. Pause the fast sequence with a due row → a claim returns nothing and the row stays `pending`.
   Re-activate → it claims again.
5. Walk the fast variant to step 5 → enrollment `completed`, no pending rows.

**What is NOT visible in the UI — inspect these instead**
- **Timing.** The queue block shows absolute timestamps, but assert the ladder by the **delta**
  between a step's `sent_at` and the next row's `scheduled_for` (3d / 60s). Do not wait.
- **The refusal reason.** `stage_writeback_refused` / `stage_writeback_skipped` /
  `sequence_step_not_queued` / `sequence_step_side_effect_failed` / `sequence_exited` land in
  `contact_activity` (`GET /api/crm/contacts/:id/activity`), with `data.wanted`, `data.found`,
  `data.reason`. The dashboard's activity feed renders type+message but not the `data` payload.
- **Enrollment exits.** `status='exited'` + `exit_reason` show in the queue block, but the
  distinction between a *global* and a *channel-specific* suppression is only in the
  `suppressions` table (`channel IS NULL` = global = exit; a channel row = advance instead).
- **The no-re-send guarantee (E10).** Not visible at all. Inspect `scheduled_actions` directly:
  a row is `status='sent'` with `sent_at` set, and a claim never returns it again however stale
  `claimed_at` gets.
- **The pause backfill.** Visible only as `requeued_actions` in the PATCH response and as a new
  queue row appearing after re-activation.

---

## Critic
**FABLE 5** (per `.loop/CRITIC_POLICY.md`; Codex not used). Three distinct lenses:
state-machine / repeated-send+idempotency / tenancy+SQL. It ran experiments on the scratch DB.
**Verdict on the first diff: FAIL.**

**Fixed, with regression checks:**
1. **(F1, the FAIL) Pausing during an in-flight step stranded the enrollment permanently and
   silently.** `advanceEnrollment` skipped the enqueue for a non-active sequence (D5b's letter)
   but advanced `current_step_id`, and *nothing ever re-materialized it* — so E11b's promised
   "re-activating resumes" was false for any ack landing inside a pause window, and the ladder
   was dead forever with no record. **I accept this fully: I identified the ambiguity while
   building, chose the literal reading, and planned only to document it — that was the wrong
   call.** Fixed two ways: `sequences.resumeSequenceQueue()` backfills stranded steps when
   `PATCH /sequences/:id` sets `active` (anchored on the resume, so a long pause cannot dump a
   backlog of instantly-due sends), and the skip now writes a `sequence_step_not_queued`
   activity row. 6 new checks in E11b, incl. that the resumed step is genuinely claimable and
   that a second activate is idempotent.
2. **(F7) Defense-in-depth gap** — `listEnrollmentsWithQueue`'s join lacked
   `AND c.company_id = e.company_id` while every other join in that file carries it. Added.
3. **(F5) Migration comment overstated its own safety** — the dedup *can* delete a row for a
   real send when duplicates are both `sent`. Reproduced. Behaviour kept (the unique index
   leaves no way to keep both) but the comment now states the limit honestly and notes the send
   is still evidenced in `contact_activity`.
4. **(F6) A comment claimed side effects never hold a connection while acquiring another** — but
   `applyStageWriteback` → `getPipelineConfig` reads through the shared pool while the
   side-effect client is held. Comment corrected to state the real behaviour and its failure
   mode (a timed-out side effect = a stalled ladder, never a lost or duplicated send).

**Accepted, documented, not fixed:**
- **(F4, MEDIUM) A process crash between the ack COMMIT and `runStepSideEffects` loses the side
  effect silently** — no outbox, no reconciliation. This is the inherent cost of the D3 shape
  the ticket itself mandated, and strictly better than the re-send loop it replaced. An outbox
  is a CP3/CP5 design decision, not something to smuggle into CP2. Logged as a follow-up.
- **(F3, LOW) Config-time chain validation doesn't apply the mode gate**, so a step whose
  write-back is a manual stage is accepted at config time and always refused at run time. Not
  fixed **because the ticket's own browser script step 4 requires exactly such a step to be
  creatable** — adding the check would break the acceptance test. The runtime invariant is
  unaffected.
- **(F2, LOW) A `paused` enrollment has the same no-resume shape**, but no HTTP route can pause
  an enrollment today, so it is unreachable.

**Critic claims I verified rather than took on trust:** it confirmed all 326 pre-existing tests
pass unmodified, that 019 tolerates duplicates, and that the `scheduleAction` UPSERT cannot
resurrect a sent row into a claimable one (it never touches `status`, and the claim query takes
only `pending`/stale-`claimed`). It explicitly did **not** refute the manual-stage invariant, the
D2 anchoring, D3b, D1b, D7, or tenancy on the new endpoint.

## Deviations / assumptions
- **`sequences.scheduleAction` changed from INSERT to UPSERT.** Forced: `enroll()` now
  materializes step 1, so pre-existing tests that enroll then schedule the same step would have
  violated the new unique index. It re-times `scheduled_for`/`payload` and deliberately does not
  reset `status`. Caveat (critic-confirmed): re-timing a `pending` retry row would erase its
  backoff — unreachable today, as no server code calls `scheduleAction`.
- **`GET /sequences/:id/queue` is a NEW endpoint**, not an extension of `/enrollments` (which
  returns bare rows and is already consumed). It also closes CP1 follow-up **F3**.
- **Resume anchors at `now + step delay`**, not at the original pause time — safe by
  construction (never an early send), at the cost of a pause lengthening the gap.
- `stage_writeback` chain validation is **incremental and bidirectional** (each new step checked
  against its nearest declaring neighbour on both sides), since steps arrive one call at a time
  and may arrive out of order.
- Test fixture note: `mkSequence` defaults `triggerStage` to **null**, because every active
  sequence sharing a trigger stage enrols the same contact — a shared default made unrelated
  fixtures cross-contaminate. My first run failed on exactly this; the code was correct.

## Gate hit
None. No push, no deploy, no live DDL, no nginx, no secrets, no `.env`. CP-M untouched.

## Follow-ups noticed but out of scope
- **(critic F4)** No outbox/reconciliation for a crash between the ack commit and its side
  effects. Candidate for CP3/CP5.
- **(critic F3)** Config-time chain validation could also warn (not reject) when a declared
  write-back names a manual stage.
- Nothing halts a ladder when a human diverts the deal (rebooks, moves to `proposal_sent`) —
  explicitly CP3's per the ticket's "known interim gap".
- `enrollForTriggerStage` enrols into **every** active sequence sharing a trigger stage. Correct
  per B2, but the seed creates two ladders on one trigger, so the orchestrator will see two
  enrollments from one advance — expected, not a bug.
- Pre-existing, still open: raw-500 on unprovisioned tenant for most insert routes; naive CIDR
  matching in `auth.js` `ipAllowed()`; `deals.closed_at` column never written (CP1 F2).

---

# ADDENDUM — second build pass (independent), commit `82689ab`

**Written by a SECOND build session.** I picked this ticket up on a legitimate
`handoff:"build"` while the authoring session was still finishing; it committed `13a89c8` and
flipped STATE to `orch` at 00:55 while I was mid-critic. **HEAD has therefore moved since the
receipt above was written.** Everything above still describes `13a89c8` accurately — this
addendum is the delta.

## ⚠️ ORCHESTRATOR: RE-VERIFY AT `82689ab`, NOT `13a89c8`
One behaviour changed and the test count changed. If you already ran against `13a89c8`, the
manual-stage invariant, the queue surface and the ladder are unaffected — but **E7 (ack replay)
now does strictly more**, and the suite total is different.

## What this commit changes
Two defects a fresh 3-lens **Fable 5** critic pass reproduced against the scratch DB. The
authoring session's own critic pass did not surface either; both are direct consequences of D3's
(correct) commit-send-first shape.

1. **HIGH — a lost side effect stranded the enrollment FOREVER.** If a side effect threw (the
   E10 poisoned-`metadata` case) or the process died right after COMMIT, the enrollment sat on an
   already-sent step and **nothing could re-drive it**: the job row is terminal so no claim scan
   revisits it, and `resumeSequenceQueue`'s `NOT EXISTS` cannot see it either — a
   `scheduled_action` for the current step *does* exist, it is just `sent`. So the F1 fix in the
   receipt above (backfill on re-activation) closes the **pause** strand but structurally cannot
   close the **side-effect-failure** strand. One transient error silently killed the ladder.
   **Fix:** the idempotent ack replay now **carries** the side effect, making replay the repair
   path. Safe by construction: D3b already no-ops it unless the acked job IS the enrollment's
   current step, and the enqueue is `ON CONFLICT DO NOTHING` — so a healthy enrollment is
   unchanged (**E7 stays green**) and a stranded one advances exactly once.
2. **HIGH — `runStepSideEffects`' "NEVER throws" contract was false.** `getClient()` sat
   *outside* its `try`, so a saturated pool propagated the rejection through `ackJob` into the
   route: **HTTP 500 for an ack whose send was already committed** — precisely the signal that
   makes an executor re-deliver a message that physically went out. Same hazard in `claimJobs`,
   whose post-commit call would discard the claimed-job list the executor never receives.
   **Fix:** client acquired inside the `try`, null-guarded in rollback and release.

## Test-isolation fix (this WILL affect your re-run)
E1 asserted that **no** `sequence_steps` row anywhere carried a `stage_writeback` — which counts
rows earlier runs of this same suite legitimately created, so **it failed the moment the suite
ran twice against one database**. It now re-migrates a row it created itself and proves that row
is untouched. Suite is now green **twice consecutively on the same DB**; before this it was not.

## Numbers (measured by me, on the exact committed tree)
**469 passed / 0 failed** on a fresh database = **326 pre-existing UNMODIFIED + 143 CP2**
(the 128 above, +13 for R1/R2 regressions and the reworked E1, +2 restructured).
I did **not** reproduce the "454" figure above and make no claim about it; 469 is the number I
stand behind. Run twice consecutively, green both times.

New checks: `R1 …` (10) proves a strand is created, proves `resumeSequenceQueue` cannot heal it,
then proves replay heals it exactly once without re-sending; `R2 …` (4) injects a `getClient`
failure on precisely the side-effect call and asserts `ackJob` does not throw and the job stays
`sent`.

## Critic findings I did NOT fix, and why
- **"Chain validation should also reject a MANUAL `stage_writeback`"** — refused deliberately.
  **E9 requires that exact configuration to exist**, and so does step 4 of your browser script;
  a 400 there would make CP2's most important criterion unbuildable. D4b.1 says *transitions*,
  not modes. → follow-up F5 (a warning, not a 400).
- **"Chain is never anchored at `trigger_stage`"** — real gap, but manual enrolment can start
  from any stage, so anchoring would emit false 400s. → CP3.
- Migration-before-restart coupling (`42P10`), the dedup ranking's stale-`claimed` preference,
  `noteActivity` inside an aborted transaction, and the contact-branch `|| 'sourced'` divergence
  — all accepted; the last fails **closed**.
- **Tenancy/XSS lens found nothing at HIGH or MEDIUM.**

## I dry-ran YOUR browser script (API half) — all 21 probes pass
On my own DB at `:3101`, against this commit. Two things that will otherwise read as bugs:

- **G-1 — one `claim` returns EVERY due email job for the tenant.** The seed leaves 3 ladders
  enrolled, so your *first* claim returns `fast_fu1`, `noshow_fu1` **and** `guard_proposal`
  together. Pick the job by `template_ref`; the second claim will be empty. This cost me a
  failed dry run.
- **D-1 — the ticket's script step 3 contradicts the ticket's own seed spec.** Step 3 expects the
  deal at **`no_show_followup_2`** after acking **step 1**. With the specified seed (steps 1..5 →
  `no_show_followup_1..5`), acking step 1 writes back `no_show_followup_1` — the stage the human
  advance already set, so it is an `already_there` no-op. **`_2` appears after acking step 2.**
  I verified this end to end. E13 asserts the self-consistent mapping and passes. I did not
  re-map the seed, because step N → FU(N+1) would leave FU1 never written and FU5 unreachable.
  **Please confirm the intended mapping when you verify.**

## Concurrency anomaly (please factor into your verdict)
This cycle did not run as a clean single-writer turn: files changed under me at 00:47
(`resumeSequenceQueue` and the migration's HONEST-LIMIT note appeared after I had read the
diff), `13a89c8` landed at 00:53 while my critic was running, and **`denchclaw_test` was dropped
and recreated under my run at 01:06–01:08** (a `denchclaw_verify` DB appeared — presumably
yours). I moved to my own `denchclaw_build_cp2` so nothing could be reset mid-measurement; all
numbers above are from there, on a tree verified equal to HEAD. **`denchclaw_test` is yours —
I am not touching it again.** :3101 is released.

## STATE
Left at `handoff:"orch"` — it is your turn and I did not take it back. I only updated the
`status` text to say HEAD moved.
