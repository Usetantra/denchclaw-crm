# TICKET CP2-step-scheduler (cycle 1) — **rev 2** (post-critic)

**Phase:** BUILD · **Branch:** `feat/consolidation` only · **Next migration: 019**
**Author:** orchestrator/tester. **Depends on:** CP1 (banked, `d8a314e`). **Blocks:** CP3.
**NOT blocked by CP-M** — touches no file `origin/main` changed except `web/index.html`.

> **rev 2 changelog** — Fable-5 critic returned **FAIL** on rev 1 with 1 HIGH + 4 MEDIUM +
> 3 LOW. All folded in below and marked `[C:…]`. The HIGH (a rollback-driven **repeated-send
> loop**) rewrote D3 entirely. Two of the critic's claims I re-verified in the code myself
> before accepting: `enrollForTriggerStage` swallows failures and returns `[]`
> (`sequences.js:74-84`), and the claim query has **no sequence-status filter**
> (`dispatch.js:87-91`) — so pausing a sequence does not currently stop anything.

---

## GOAL

Today an enrollment is a dead record. `sequences.scheduleAction()` is defined and exported but
**called from no server code at all** (`grep -rn scheduleAction server/` matches only its own
definition and the `module.exports` line; the only callers are three test files). A contact can
be enrolled into No-Show recovery — CP1 proved that fires — and then nothing happens. There is
no queue row, so the dispatcher's `scheduled_for <= now()` scan finds nothing.

CP2 closes that seam in both directions:

1. **On enrollment** → materialize step 1 as a `scheduled_actions` row.
2. **On `ack(sent)`** → advance the enrollment and materialize the next step.
3. **As a step side-effect** → write the reporting stage back, through CP1's mode gate
   (LOCKED — the board must reflect reality, not be derived at read time).

Acceptance shape is the No-Show ladder from `.loop/PIPELINES_SPEC.md`: a human marks a no-show
→ `no_show_followup_1` (manual) → enrollment → messages at **+0 / +3d / +6d / +9d / +16d**,
reporting stage mirrored to `no_show_followup_1..5` as each sends.

**Out of scope — do not build:** trigger taxonomy, `tags_include` gating, and `replied:true`
exit-halting are **CP3**. Do not implement `entry_conditions` / `exit_conditions` evaluation.
No new daemon, cron, or timer (D6). No channel provider work (CP4a/b). No content-engine /
task-manager / Slack coupling.

**Known interim gap, accepted:** until CP3, nothing halts a ladder when a human diverts the
deal (rebooks to `scheduled_call`, moves to `proposal_sent`/`deals`). PIPELINES_SPEC's "exit on
reply or rebooking" is CP3's. Do not solve it here — but see D4b, which makes the resulting
board staleness visible instead of silent.

---

## GROUND TRUTH (verified against the code — do not re-derive)

- `sequences.enroll()` (`server/db/models/sequences.js:142`) sets `current_step_id` to the first
  step and returns; queues nothing. Idempotent — an existing active enrollment is returned
  as-is; a 23505 loser re-selects the winner.
- `sequences.enrollForTriggerStage()` (`:55`) is the auto path, called from `crm.js` `/advance`
  (both entity branches) and `conversations.js`. **It catches everything and returns `[]`**
  (`:74-84`) — a failure is a `console.error` and nothing else.
- `sequences.scheduleAction()` (`:247`) derives `contact_id`, `channel`, `template_ref` from the
  enrollment/step, not the caller. **Keep that property.**
- `dispatch.claimJobs()` (`dispatch.js:43`) claims `pending` (or stale-`claimed`) rows with
  `scheduled_for <= now()`, gated by quiet hours, rate limit, suppression.
- `dispatch.ackJob()`'s `sent` branch (`:194`) marks the row sent, writes contact activity, then
  commits. **It never touches the enrollment.** Second seam.
- `sequence_steps.delay_seconds` is documented in migration 014 as *"offset from enrollment
  (step 1) or previous step's fire time"* — **relative to the predecessor**, not cumulative.
- **`CLAIM_TIMEOUT_MS` is 300s**: a row left `claimed` is reclaimed and **re-sent**. This is the
  mechanism behind the HIGH finding — read D3 before writing any code.

### ⚠️ Correction to the standing brief — the A5 landmine is ALREADY CLOSED
The handoff warns that check-then-mark-sent needs a per-`(company, channel)` advisory lock.
**B3 already did it**: `dispatch.js:51-52` opens a transaction and takes
`pg_advisory_xact_lock(hashtext('<company>:<channel>'))` *before* `checkRateLimit` (`:54`), and
`:63-72` discounts non-stale in-flight claims. The critic independently confirmed this.
**Do not rebuild it, do not "fix" it.** Your only obligation is D5: don't break it.

---

## LOCKED DECISIONS (build to these; do not re-litigate)

- **D1 — enqueue on enrollment, atomically.** Materializing step 1 happens in the **same
  transaction** as the enrollment insert, so an enrollment can never exist without its first
  queued action. Both paths get it (`enroll` and `enrollForTriggerStage`).
- **D1b `[C:MEDIUM-4]` — a zero-step sequence completes immediately.** Enrolling into a sequence
  with no steps must set the enrollment `status='completed'`, `completed_at=now()` — **not**
  leave it `active`. Rev 1 mandated a permanently-stuck row: sequences are `active` on creation
  and steps are added by a separate call, so a trigger firing in that window would dead-end the
  contact forever (the partial unique index blocks re-enrolment while active, and there is no
  route that can update an enrollment).
- **D2 — `scheduled_for` arithmetic.** Step 1 fires at `enrolled_at + step1.delay_seconds`.
  Step N (N>1) fires at **the moment its predecessor was acked** `+ stepN.delay_seconds` — not
  at enrollment time plus a cumulative offset. The ladder's +0/+3d/+6d/+9d/+16d is therefore
  `delay_seconds` of `0 / 3d / 3d / 3d / 7d`, matching "+3 days after FU1 … +1 week after FU4".
  `[C:LOW-7]` The same anchor rule applies to the `ack(skipped)` advance: **anchor = ack time**.
- **D3 `[C:HIGH-1]` — THE SEND MUST NEVER BE UNDONE. Mark sent first; do side-effects after.**
  Rev 1 put the next-step INSERT, the enrollment advance and the write-back *inside* `ackJob`'s
  transaction before `COMMIT`. That is a **repeated-send bug**: the executor has already
  physically sent the message, so if any CP2 side-effect throws (a 23505, malformed
  `deal.metadata`, any DB error), the rollback also undoes `status='sent'`. The row stays
  `claimed`, crosses the 300s timeout, is reclaimed at `dispatch.js:88` — **and is sent again,
  every ~5 minutes, forever, for a persistent error.**
  The codebase already knows this lesson: `campaignEvent` is deliberately forwarded **after**
  `COMMIT` for exactly this reason (`dispatch.js:203-227`). Follow that discipline.
  **Required shape:** commit the `status='sent'` marking + its activity row first; then run the
  CP2 side-effects (advance, enqueue-next, write-back) so that a failure **cannot** roll the
  send back. If you keep them in one transaction instead, they must be inside a **SAVEPOINT**
  whose rollback leaves `status='sent'` committed. Either way:
  - the next-step insert uses `ON CONFLICT (enrollment_id, step_id) DO NOTHING`;
  - a side-effect failure is **logged and recorded in `contact_activity`**, never surfaced as a
    failed ack. `ack(sent)` returns 200 whenever the send itself was recorded.
- **D3b `[C:MEDIUM-2]` — advance only on the current step.** Apply the CP2 side-effects **only
  when the acked job's `step_id` equals the enrollment's `current_step_id`**; otherwise no-op
  them (still 200). Without this, two rows for the same (enrollment, step) — precisely the
  pre-existing state migration 019 is told to tolerate — each advance, so the enrollment jumps
  two steps and the write-back fires twice.
- **D4 — stage write-back is a step side-effect, through CP1's mode gate.** Add
  `sequence_steps.stage_writeback TEXT` (migration 019, nullable). When a step with a non-null
  `stage_writeback` is acked `sent`, mirror that stage onto the entity the sequence's
  `pipeline_key` governs — reusing CP1's authority helpers, **not** an HTTP call to `/advance`,
  **not** a raw UPDATE that skips the gate.
  The write-back is **programmatic by definition**, so the `conversations.js` rule applies:
  **if the target stage is `mode:'manual'`, skip it** — never set it. Same if the transition is
  illegal from the current stage. In both cases **the send still succeeds and the ack still
  returns 200**; record the skip in `contact_activity` with a distinguishable type. A
  write-back must never turn a successful send into a failed ack.
- **D4b `[C:MEDIUM-5]` — a skipped write-back freezes the rest of the ladder; make that
  visible, and lint the chain up front.** `webinar_sales` FU transitions are strictly linear
  (`FU_n → FU_{n+1} | scheduled_call | disqualified`), so once one write-back is skipped the
  deal is stale and **every later write-back is illegal too** — messages keep sending while the
  board lies, for up to 13 days. Two required mitigations, both cheap:
  1. **Validate at step-create/update time** that a sequence's declared `stage_writeback` chain
    is actually walkable through the pipeline's transitions in `step_order`. A chain that
    cannot advance is a **400** at configuration time, not a silent freeze at run time.
  2. Every skipped write-back writes its `contact_activity` row (per D4) **naming the stage it
    wanted and the stage it found**, so a frozen board is diagnosable.
  Reconciling a board that a human diverted mid-ladder is **CP3's** job. Do not build it.
- **D5 — do not weaken B3's send-gating.** Rate-limit, quiet-hours and suppression behaviour
  must be identical after your change; their tests pass untouched. Do not take the claim path's
  advisory lock in the ack path, do not call `claimJobs` from `ackJob`, introduce no
  lock-ordering cycle. (The critic found no deadlock in rev 1's shape — keep it that way.)
- **D5b `[C:MEDIUM-3]` — pausing a sequence must actually stop it.** The claim query
  (`dispatch.js:87-91`) has **no sequence-status filter**, so today a `paused` sequence's queued
  rows still send and CP2 would happily queue the next one. Make the claim query require the
  owning sequence to be `status='active'` — the scalar subquery at `:85` already reaches
  `sequence_steps`, so it is one more hop — **and** skip enqueueing the next step when the
  sequence is no longer active. This is a send-control the user already believes they have.
- **D6 — no new daemon.** The dispatcher is pull-based: engines poll `POST /channel-jobs/claim`,
  which already selects `scheduled_for <= now()`. Materializing rows with a future
  `scheduled_for` is the whole mechanism. No cron, worker, interval, or `setTimeout`.
- **D7 — terminal outcomes end the ladder, except an executor-chosen skip.**
  - Claim-time **global** suppression skip (`dispatch.js:98-100`) → **exit** the enrollment:
    `status='exited'`, `exit_reason='suppressed'`. Applied inline in `claimJobs`, where the
    distinction is available — no ack-time discrimination is needed.
  - `[C:LOW-6]` A **channel-specific** suppression must **not** kill a multi-channel
    enrollment: treat it like an executor skip and **advance** to the next step. Only a global
    (all-channel) suppression exits.
  - `ack(status:'skipped')` from an executor → **advance** to the next step (anchor per D2).
  - `ack(status:'failed')` that **will retry** → change nothing; the row requeues itself.
  - `ack(status:'failed')` that has **dead-lettered** → exit, `exit_reason='failed'`.
  - `[C:LOW-7]` Accepted-and-documented edge: a stale `claimed` row can be suppression-skipped
    during a reclaim scan after its original executor already sent, so its later `ack(sent)`
    409s while the enrollment exits `suppressed`. Note it in the receipt; do not solve it.
- **D8 — idempotency.** Re-enrolling an already-active contact must not queue a second step 1.
  Replaying `ack(sent)` for an already-`sent` job (the existing idempotent-terminal-replay path)
  must not queue the next step twice, advance twice, or write the stage back twice. Add
  `UNIQUE (enrollment_id, step_id)` on `scheduled_actions`; migration 019 must tolerate
  pre-existing duplicates (de-duplicate or create the index concurrently-safe — say which).
  Retries are safe: `ack(failed)` UPDATEs the same row (`dispatch.js:255-257`), never inserts.
- **D9 — tenancy.** Every new query is `company_id`-scoped. The write-back resolves its config
  tenant-scoped via `getPipelineConfig(companyId, …)` so a tenant override wins, exactly as CP1.
- **D10 `[C:LOW-8]` — enrollment failures stop being invisible.** `enrollForTriggerStage`
  swallows all errors and returns `[]`; D1 widens that failure surface to include queueing. When
  enrollment-or-materialization fails, write a `contact_activity` row alongside the existing
  `console.error` so a dropped ladder is visible in the contact's timeline. Keep the
  never-throw-into-the-request-path property.

---

## FILES TO TOUCH (keep it to these)

- `migrations/019_step_scheduler.sql` **(NEW)** — `sequence_steps.stage_writeback TEXT`;
  `UNIQUE (enrollment_id, step_id)` on `scheduled_actions` (D8). Idempotent; **applies twice
  cleanly**.
- `server/db/models/sequences.js` — `materializeNextStep(companyId, enrollmentId, {client, after})`;
  wire into `enroll()` + `enrollForTriggerStage()` transactionally (D1, D1b, D10).
- `server/db/models/dispatch.js` — `ackJob`: post-commit/savepoint side-effects (D3), current-step
  guard (D3b), write-back (D4), terminal handling (D7); `claimJobs`: sequence-status filter
  (D5b) and global-vs-channel suppression split (D7).
- `server/db/pipeline.js` — only if the write-back needs a helper not already exported
  (`isManualStage` / `isTerminalStage` / `getPipelineTransitions` exist).
- `server/routes/sequences.js` — the queue surface below; accept + validate `stage_writeback`
  on step create/update (D4b.1).
- `web/index.html` — the read-only queue block. **Surgical, additive only**: this is the worst
  CP-M conflict surface (main added ~497 lines). One new block, one new render function, no
  restructuring.
- `test/unit-cp2-step-scheduler.mjs` **(NEW)** + `test/run-local.sh` (register it).

---

## UI I REQUIRE (so the automation is provable in a browser, not just in SQL)

Sequences tab → sequence detail → a read-only **"Enrollments & queue"** block. One row per
enrollment: **contact name**, **current step #**, **next send channel**, **`scheduled_for`**
(absolute timestamp, not "in 3 days"), **status** (`pending`/`claimed`/`sent`/`skipped`/
`failed`), and `sent_at` for sent steps. Show the enrollment's own status
(`active`/`completed`/`exited` + `exit_reason`).

Small, and it also closes CP1 follow-up **F3** (the pane shows only a count today, never *who*).
`esc()` every interpolated value, no exceptions. Back it with a tenant-scoped
`GET /sequences/:id/queue` (or extend the enrollments endpoint — say which in the receipt).

---

## EVAL CRITERIA — I check every one; number your receipt against these

- **E1** Migration 019 applies cleanly **twice** on a fresh scratch DB; `stage_writeback` exists
  and is nullable; existing `sequence_steps` rows unaffected; 002–018 still apply ahead of it;
  the new UNIQUE index survives a DB that already contains duplicate `(enrollment_id, step_id)`.
- **E2** Enrolling into a sequence with steps creates **exactly one** `pending` row for **step
  1**, `scheduled_for = enrolled_at + delay_seconds` (±2s), `channel`/`template_ref` from the
  step.
- **E2b** `[C:MEDIUM-4]` Enrolling into a **zero-step** sequence creates the enrollment,
  queues nothing, and leaves it **`completed`** — never `active`.
- **E3** Both paths queue: the manual route **and** `enrollForTriggerStage` (a human `/advance`
  into `no_show_followup_1`, the CP1-proven path).
- **E4** Idempotency: re-enrolling an already-active contact leaves **exactly one** step-1 row;
  two concurrent enrolls leave exactly one.
- **E5** `ack(sent)` on step 1 → `current_step_id` moves to step 2 **and** exactly one new
  `pending` row for step 2, `scheduled_for ≈ ack_time + step2.delay_seconds` (D2).
- **E6** `ack(sent)` on the **last** step → enrollment `completed`, `completed_at` set, no new
  row.
- **E7** Ack replay: `ack(sent)` twice returns the idempotent 200 and leaves step count,
  `current_step_id` and the written-back stage **unchanged**.
- **E8** Write-back: a step with `stage_writeback='no_show_followup_2'` acked `sent` moves the
  deal to `no_show_followup_2` — proven in the deal row **and** on screen.
- **E9** **Write-back never auto-advances a manual stage.** A step with
  `stage_writeback='proposal_sent'` (manual) acked `sent`: ack is **200**, message counts as
  sent, deal stage **unchanged**, and a `contact_activity` row names the wanted-vs-found stage.
  Same for an illegal transition. **This is the most important criterion in CP2** — it is CP1's
  invariant surviving contact with the scheduler.
- **E10** `[C:HIGH-1]` **A failing side-effect never re-sends.** Force a CP2 side-effect to
  throw on an `ack(sent)` (e.g. a duplicate `(enrollment_id, step_id)` insert, or a poisoned
  `metadata`). EXPECT: the job is still `status='sent'`, the ack returns 200, the failure is in
  `contact_activity`/logs, and after `CLAIM_TIMEOUT_MS` the row is **not** reclaimed and **not**
  re-sent. Prove the row's terminal state directly.
- **E10b** `[C:MEDIUM-2]` Acking a job whose `step_id` is **not** the enrollment's
  `current_step_id` returns 200 and changes nothing — no advance, no enqueue, no write-back.
- **E11** D7, each proven separately: claim-time **global** suppression → `exited`/`suppressed`,
  nothing further queued; **channel-specific** suppression → advances instead of exiting;
  executor `ack(skipped)` → next step queued at ack-time anchor; retryable `ack(failed)` →
  enrollment untouched, row requeued with backoff; dead-lettered `ack(failed)` →
  `exited`/`failed`.
- **E11b** `[C:MEDIUM-3]` **Pause actually pauses.** A `paused` sequence's due rows are **not
  claimable**, and no next step is enqueued for it. Re-activating resumes. Prove pause with a
  row whose `scheduled_for` is already in the past.
- **E12** `[C:MEDIUM-5]` `stage_writeback` chain validation: a chain that cannot walk the
  pipeline's transitions in `step_order` is rejected **400 at configuration time**; a valid
  ladder chain is accepted.
- **E13** **The full No-Show ladder end to end** on `webinar_sales`, `delay_seconds`
  `0/3d/3d/3d/7d`, `stage_writeback` `no_show_followup_1..5`: human `/advance` into
  `no_show_followup_1` enrolls; step 1 due immediately and claimable; acking each step queues
  the next at the right offset and mirrors the stage; after step 5 the enrollment is
  `completed`. Prove **timing by asserting `scheduled_for` deltas**, not by waiting.
- **E14** B3 send-gating unchanged (D5): `unit-b3-dispatcher.mjs` and `unit-limits.mjs` pass
  **unmodified**; quiet hours / rate limit / suppression still gate claims; no deadlock under
  concurrent claim+ack.
- **E15** Tenancy (D9): tenant A cannot see or advance tenant B's enrollments or queue rows;
  `GET /sequences/:id/queue` cross-tenant is 404, not a leak; `stage_writeback` naming an
  unknown stage for the sequence's pipeline → 400.
- **E16** Full suite green on a **fresh** database, all **326** existing tests **unmodified**.
  Report the new total.
- **E17** Evidence for the browser script below; console error-free.

---

## BROWSER TEST SCRIPT — I run this myself; build so it can pass

Seed I need (script or documented API calls in the receipt): tenant, one contact, one
`webinar_sales` deal at `qualification_form_fills`, one **active** sequence `No-show recovery`
on `pipeline_key=webinar_sales`, `trigger_stage=no_show_followup_1`, **5 email steps**,
`delay_seconds` `0 / 259200 / 259200 / 259200 / 604800`, `stage_writeback`
`no_show_followup_1 … _5`. Also a **short-delay variant** so I can watch a second step become
due without waiting three days — tell me how to seed it.

1. **Sequences tab** → open `No-show recovery`. EXPECT: 5 steps in order with their delays.
   → `CP2-01-sequence-steps.png`
2. Advance the deal (human, no `automated`) `qualification_form_fills` → `scheduled_call` →
   `no_show_followup_1`. Return to the sequence. EXPECT: **the contact listed by name**, step 1,
   channel `email`, `scheduled_for` ≈ now, status `pending`.
   → `CP2-02-enrolled-step1-queued.png`
3. Claim + ack step 1 as `sent` (I drive `POST /channel-jobs/claim` then `/ack` through the
   shim). Reload. EXPECT on screen: step 1 `sent` with `sent_at`, **step 2 pending** three days
   out, deal showing **`no_show_followup_2`**. → `CP2-03-step2-queued-stage-mirrored.png`
4. **The manual-stage guard.** Ack a step whose `stage_writeback` is `proposal_sent`. EXPECT:
   ack **200**, step shows `sent`, deal stage **still** `no_show_followup_2`, and the activity
   entry naming the refusal visible on screen. → `CP2-04-manual-writeback-refused.png`
5. **Pause actually pauses.** With a due `pending` row, pause the sequence, run a claim. EXPECT:
   nothing claimed, row still `pending`. Re-activate → it claims.
   → `CP2-05-paused-not-claimable.png`
6. Walk the short-delay variant to the **last** step. EXPECT: enrollment `completed`, no pending
   rows. → `CP2-06-ladder-completed.png`
7. Browser console: **zero** errors beyond the HTTP status of a deliberate refusal probe.

---

## CONFLICT DISCIPLINE (CP-M is still an open gate)

`origin/main` is diverged (11 ahead / 10 behind) and is what runs on staging. Of the files
above only `web/index.html` is in main's changed set — keep that edit **additive and
self-contained**. `dispatch.js`, `sequences.js` (model + route) and the migration are ours
alone. Do not touch `crm.js`, `conversations.js`, `auth.js`, `contacts.js`, `server.js` or
`test/contract.mjs` unless a criterion forces it — if one does, say so loudly in the receipt.

---

## CONSTRAINTS

- Scratch Postgres only (embedded PG `:54339`; Docker is wedged machine-wide — leave it).
  **Builder owns `:3101`.** Never the live `denchclaw` DB or any engine's DB.
- `git fetch origin` before committing. `feat/consolidation` only. No push to main, no deploy,
  no live DDL, no nginx, no secrets, no `.env`.
- `CONSOLIDATION_ROADMAP.md` has an uncommitted operator edit — leave it unstaged.
- Nothing from `scratchpad/` gets committed.
- **You do not test in the browser.** End the receipt with a **"TEST BRIEF FOR THE
  ORCHESTRATOR"**: the seed script, exact claim/ack calls, what "working" looks like on screen,
  and anything CP2 does that is *not* visible in the UI.
