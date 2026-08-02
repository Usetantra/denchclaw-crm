# VERDICT — CP2-step-scheduler → **PASS**

**Ticket:** `.loop/tickets/CP2-step-scheduler.md` rev 2
**Receipt:** `.loop/receipts/CP2-step-scheduler.md`
**Commit under test:** `13a89c8` on `feat/consolidation` (7 files, +1353/−39)
**Verified by:** orchestrator/tester, 2026-08-01, independently of the builder
**Evidence:** `.loop/EVIDENCE/CP2-step-scheduler/`

---

## How this was verified

Every number in the receipt was treated as an **unverified claim**. I did not run the builder's
e2e or trust its suite output. Specifically:

- **Rebuilt the scratch DB from scratch myself** (`reset-db.mjs` + `apply-sql.mjs`, migrations
  002→019) and **re-ran the full suite myself** on that fresh DB.
- **Re-applied migration 019 a 2nd and 3rd time myself**, and additionally tested a case the
  builder's suite does not: a DB that *already contains duplicate* `(enrollment_id, step_id)`
  rows. Driver: `scratchpad/orch-cp2-e1-migration.mjs` (mine).
- **Wrote my own behavioural driver** from the ticket's criteria — not from the receipt —
  `scratchpad/orch-cp2-verify.mjs`: **28 checks, 28 passed**.
- **Drove the real dashboard myself** through my own shim (`:3102` server + `:8899` shim, my own
  `scratchpad/orch-cp2-browser.mjs`, real Chromium): **13 checks, 13 passed, 0 console errors**.
- Extra targeted probes for E12, E2b and D7 that the driver did not cover.

Ports: I used **:3102 + :8899** only. `:3101` (builder's) untouched. Scratch PG `:54339` left up.

---

## Criterion-by-criterion

| # | Criterion | Result | Evidence I captured |
|---|---|---|---|
| **E1** | 019 applies twice; `stage_writeback` nullable; unique index; tolerates pre-existing dupes | **PASS** | Applied a **2nd and 3rd** time clean. Column = `text`, `is_nullable=YES`. Exactly **1** unique index `uq_scheduled_actions_enrollment_step`. **My own dupe probe**: planted 2 rows for one `(enrollment_id, step_id)`, re-applied 019 → collapsed to **1**, index rebuilt. Rolled back, DB unchanged. |
| **E2** | Enroll → exactly one `pending` step-1 row, `scheduled_for ≈ enrolled_at + delay` | **PASS** | 2 enrollments → exactly 2 rows, both step 1, both `pending`; `scheduled_for` skew < 10s for `delay_seconds=0`. |
| **E2b** | Zero-step sequence → `completed`, never stuck `active` | **PASS** | Exercised via the **trigger path** (there is no `/enroll` route — enrollment is trigger-driven). Result: `status=completed`, `completed_at` set, `current_step_id=null`, **0** queued rows. |
| **E3** | Both paths queue; a human `/advance` into the trigger stage enrolls | **PASS** | Pre-state 0 rows → human `/advance` 200 → `sequence_enrollments` carried **2** entries (both seeded ladders — correct B2 fan-out). |
| **E4** | Re-enrolling an active contact leaves exactly one step-1 row | **PASS** | Re-advancing into the same trigger stage queued **nothing** extra (2 rows before, 2 after). |
| **E5** | `ack(sent)` → `current_step_id` moves, one new row for step 2, anchored on ack | **PASS** | One new `pending` row for step 2; **delta measured from ack time = ~60s** on the fast ladder — anchored on the **ack**, not on enrollment. |
| **E6** | Ack on the last step → `completed`, no new row | **PASS** | Milo's single-step enrollment shows **`completed`** on screen after its ack (`CP2-01`); zero-step case also completes. |
| **E7** | Ack replay is idempotent | **PASS** | Second `ack(sent)` → 200, row count unchanged (2), written-back stage unchanged. |
| **E8** | Write-back moves the deal, proven in the row **and** on screen | **PASS** | **E8.a** acking step 1 (write-back `_1`, the stage it is already in) causes **no spurious move**. **E8.b** walking the real ladder to step 2 moved the deal to **`no_show_followup_2`**, confirmed in the DB *and* browser-observed. |
| **E9** | **Write-back never auto-advances a manual stage** — the most important criterion | **PASS** | All five sub-checks: job claimable; `ack(sent)` → **200** (the send is not punished); row `status='sent'` with `sent_at`; **deal still `scheduled_call`** (unchanged); a `contact_activity` row records the refusal. Visually confirmed in `CP2-01-manual-guard-sent-but-deal-unmoved.png`: step `→ proposal sent` chip **`sent`**, enrollment `completed`, deal never moved. |
| **E10** | A failing side-effect never re-sends | **PASS** | I poisoned the write-back to a non-existent stage and acked: row committed **`status='sent'`** with `sent_at`, ack 200. I then aged `claimed_at` to **2 hours** (far past `CLAIM_TIMEOUT_MS`) and re-claimed: **never returned, still `sent`**. The re-send loop the ticket's HIGH-1 warned about does not exist. |
| **E10b** | Ack on a non-current step changes nothing | **PASS** | 200, `current_step_id` unchanged, no enqueue, row count unchanged. |
| **E11** | D7 suppression/skip/fail variants, each proven separately | **PASS** | **Channel-specific** suppression → row `skipped`, enrollment stays **`active`** (not killed). **Global** (`channel IS NULL`) → not claimable, enrollment **`exited`** with `exit_reason='suppressed'`, **0** rows left queued. Remaining variants (skipped/retry/dead-letter) covered by the 128 CP2 tests, which I ran myself on my own rebuilt DB. |
| **E11b** | Pause actually pauses; re-activation resumes | **PASS** | A **due** (`scheduled_for` in the past) row of a `paused` sequence was **not claimable** and stayed `pending`; after `PATCH status=active` it claimed. This is the critic's F1 fix, verified live. |
| **E12** | Chain validation rejects at **config time** | **PASS** | Broken chain → **400** with an actionable body naming from/to/allowed. Unknown stage → **400** listing the pipeline's real stages. A valid next rung → **201**. |
| **E13** | Full No-Show ladder, timing by **delta** not by waiting | **PASS** | Real ladder: ack step 1 → step 2 queued at **259200s = exactly +3 days** (measured delta, ±30s). Fast variant walked rung-by-rung; enrollment reaches `completed`. |
| **E14** | B3 send-gating unchanged; b3/limits pass **unmodified** | **PASS** | `unit-b3` **30/30**, `unit-limits` **34/34** on my rebuilt DB. `git show 13a89c8 --stat` confirms **no pre-existing test file was touched** — the only test changes are the new `unit-cp2-step-scheduler.mjs` and a 6-line registration in `run-local.sh`. |
| **E15** | Tenancy on the new endpoint | **PASS** | `GET /sequences/:id/queue` → **200** for the owner, **404** cross-tenant (not a leak, not a 200). Queue names the contact — closes CP1 follow-up **F3**. |
| **E16** | Full suite green on a fresh DB; all 326 existing tests unmodified | **PASS** | My run: **454 passed / 0 failed** = contract 66 + tenancy 15 + tenants 12 + sequences 38 + b2 16 + limits 34 + b3 30 + api-keys 16 + a3 16 + cp1 83 (**= 326 exactly**) + **cp2 128**. Matches the receipt. |
| **E17** | Browser evidence, console error-free | **PASS** | **3 distinct** dashboard views + console log in `.loop/EVIDENCE/CP2-step-scheduler/` (see `EVIDENCE-INDEX.md`). **0 console lines, 0 errors.** The browser pass took 5 shots, but the sequences list auto-selects its first item so two pairs were byte-identical; I removed the duplicates rather than file them as extra coverage. Each remaining PNG opened and read, not just filed. |

**Independent checks run by me: ~55. Failures attributable to the code: 0.**

---

## Anomalies — every one traced to MY error, not the code

Exactly as in CP1, my first pass threw failures that were all mine. Recorded so the next session
does not re-raise them:

1. **9 failures on the first driver run.** Root causes: (a) the claim response's id field is
   **`job_id`**, not `id` — my `guard.id` was `undefined`, so the API's
   `400 "job_id must be a UUID"` was it **correctly rejecting my malformed request**; the same
   bug silently broke E11b's claimed-set membership test; (b) I assumed acking step 1 mirrors the
   deal to `_2`, but step 1's write-back is `no_show_followup_1` — the stage the deal is already
   in. After fixing both: **28/28**.
2. **"Global suppression does not exit the enrollment."** False. My probe recycled a row that the
   preceding channel-suppression probe had already consumed and advanced past, so it was no
   longer the enrollment's current step. Re-run on a fresh current-step row: exits correctly with
   `exit_reason='suppressed'`.
3. A `sed` I used to fix a table name also renamed my own assertion's response field
   (`sequence_enrollments` → `enrollments`), producing a spurious E3.b failure.

**Schema note for future sessions:** the enrollments table is **`enrollments`**, not
`sequence_enrollments`; the claim response field is **`job_id`**; there is **no `/enroll` route** —
enrollment is trigger-driven only.

---

## Defect found in the TICKET (mine, not the build)

The ticket's **browser script step 3** says that after acking step 1 the deal should show
`no_show_followup_2`. That contradicts the ladder the same ticket specifies in **E13**
(`stage_writeback` = `no_show_followup_1..5`, so step N mirrors `_N`). Acking step 1 correctly
leaves the deal at `_1`; it reaches `_2` when **step 2** is acked. The build is right and the
ticket was wrong. I verified the intended behaviour instead (E8.a + E8.b).

---

## Critic

**FABLE 5** (per `.loop/CRITIC_POLICY.md`; Codex is not used on this project). The builder ran
three lenses on the diff and returned **FAIL** on its first pass; its F1 — pausing during an
in-flight step stranding the enrollment permanently and silently — was a **real defect**, and the
builder's receipt says plainly that it had identified the ambiguity, chosen the literal reading,
and planned only to document it. That was the right call to reverse. **I verified the fix live
rather than accepting it**: E11b passes on a genuinely due row.

I did not spend a second critic pass on the CP2 diff: three adversarial lenses had already run on
it, its one FAIL was fixed and I re-verified that fix, and my own ~55 independent checks
constitute the second look the policy exists to guarantee. My remaining critic budget went to the
**CP-M ticket**, where nothing had been reviewed at all — and it caught a HIGH there.

---

## Accepted, documented, not fixed (I reproduced each and agree)

- **F4 (MEDIUM)** — a process crash between the ack COMMIT and `runStepSideEffects` loses the
  side-effect silently; no outbox. This is the inherent cost of the D3 shape **the ticket itself
  mandated**, and strictly better than the re-send loop it replaced. Correctly deferred to CP3/CP5.
- **F3 (LOW)** — config-time chain validation does not apply the mode gate, so a manual-stage
  write-back is creatable and always refused at run time. Deliberately not fixed **because the
  ticket's own browser script step 4 requires such a step to be creatable**. The runtime
  invariant (E9) is unaffected. The ticket, not the code, is what should change.
- **F2 (LOW)** — a `paused` enrollment has the same no-resume shape, but no HTTP route can pause
  an enrollment, so it is unreachable.

---

## New follow-ups I found (none blocking)

- **F-CP2-1** — the steps list renders a 60-second delay as **`+0h`**
  (`CP2-02-fast-ladder-steps-and-queue.png`). Cosmetic
  rounding; the real ladder renders `+72h` correctly. Only affects sub-hour test fixtures.
- **F-CP2-2** — the dashboard footer hardcodes `127.0.0.1:3100` regardless of the port actually
  serving it (visible in every screenshot).
- **F-CP2-3** — the ticket's browser-script step 3 is internally inconsistent (see above); fix the
  ticket text so a future session does not chase it as a defect.
- Carried forward from the receipt and still open: raw-500 on an unprovisioned tenant for most
  insert routes; **naive CIDR matching in `auth.js` `ipAllowed()`** — independently found by me
  while specing CP-M and now tracked there as **GT-1/M9**, since the merge is where it becomes
  dangerous; `deals.closed_at` never written (CP1 F2).

---

## Verdict

**PASS.** The step-scheduler seam is real: an enrollment now materializes work, `ack(sent)`
walks the ladder anchored on the ack, and the reporting stage mirrors onto the pipeline — while
**CP1's central invariant survives contact with the scheduler**: the CRM sent the message and
still refused to auto-advance a manual stage (E9), proven in the row and on screen. The
repeated-send failure mode the ticket's HIGH-1 was written to prevent is demonstrably absent
(E10). 454/0 on a database I rebuilt myself, with all 326 pre-existing tests unmodified.

**CP2 is BANKED at `13a89c8`.**

Next: **CP-M** (`.loop/tickets/CP-M-merge-main.md` rev 2) is specced and critic-reviewed but
**not dispatched** — it was blocked on CP2 banking (now clear) and carries one open question for
the operator: who executes the merge resolution. See the ticket's final constraint.
