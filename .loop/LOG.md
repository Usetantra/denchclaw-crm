# Loop log (append-only; both sessions)

- 2026-07-31 [orch] cycle 0 — Grounded (roadmap, decided-lens doc, product brief, migs
  003/004/006/009/014/015/017, /advance + pipelines.js + sequences.js code). Wrote
  `.loop/PIPELINES_SPEC.md` verbatim. Mailbox created.
- 2026-07-31 [orch] cycle 1 — CP1 ticket authored (`tickets/CP1-funnel-pipelines.md`).
  Critic pass: Codex CLI auth DEAD (hard 401 refresh_token_invalidated — human must
  `codex login`; flagged). Single-model critic pass still ran, file:line-verified: FAIL
  with 4 CRITICALs (entity_type default mis-tags mig-009 custom pipelines; pipelines.js
  override paths strip mode/entity_type; PATCH /deals free-move bypasses the whole webinar
  state machine; entry rule = suppression escape) + 12 more findings. All 16 folded into
  ticket rev 2 (14 eval criteria, 6-step browser script). Spec open items locked:
  invitees=auto-on-send-ack, ladder stage=write-back side-effect (CP2), legacy=additive
  new keys. Migration number verified vs origin: 018 (origin tops at 011; local branch
  claims 012–017). → handoff: build.
- 2026-07-31 [operator] Critic fallback policy added. Codex CLI auth is dead
  (refresh_token_invalidated). PROJECT POLICY: if Codex is unavailable at any
  point, the critic falls back to **Fable 5** (Agent tool, model:'fable', same
  adversarial refute brief) — never skip the critic, never let a single-model
  self-review pass silently. Prefer Codex; revert once `codex login` is restored.
  See `.loop/CRITIC_POLICY.md` and CONSOLIDATION_ROADMAP.md "Working rules". Log
  which critic ran each pass. STATE untouched (still CP1/BUILD, builder's turn).
- 2026-07-31 [build] cycle 1 — CP1 built + committed (d8a314e, feat/consolidation only).
  Migration 018 (double-apply proven), stage authorities mode/transition-gated, entry
  rule + suppression refusals, sequences config-validated, override safety + immediate
  cache invalidation, web badges/dropdown. Suite 326/326 on scratch PG (Docker wedged
  mid-run → embedded-postgres binaries on :54339, recipe in receipt; daemon left alone
  to protect other projects' live containers). Browser e2e green via playwright-chromium
  through an untracked nginx-shim (no tracked-file shim to revert); 4 PNGs + console log
  in EVIDENCE/. Critic: FABLE-5 fallback (codex auth dead) — initial FAIL, 5 findings
  fixed (+12 regression checks: rekey gate, creation mode-gate, cache invalidation,
  side-door name-collision, terminal:false) , 3 accepted+documented in receipt.
  → handoff: orch (VERIFY).
- 2026-07-31 22:45 [operator-session] Status sweep. CP1 VERIFY WAS NEVER COMPLETED — the
  orchestrator session ended mid-pass (receipt read, diff critic launched, scratch PG
  booted, suite re-run started) without writing a verdict; no CP1 entry exists in
  CONSOLIDATION_ROADMAP.md's progress log and no verdict line here. Both loop sessions are
  dead (no claude process, no .loop poller for this repo). STATE left untouched at
  {CP1, VERIFY, handoff:orch} — the NEXT orchestrator must redo the CP1 verify pass from
  scratch and must not assume it passed. Re-verified: codex auth still DEAD (`codex login
  status` reports logged-in but `codex exec` 401s refresh_token_invalidated) → Fable-5
  fallback still in force; Docker daemon still wedged (other projects' containers on it) →
  embedded-postgres on :54339 remains the sanctioned scratch runtime; scratch DB still
  carries migrations through 018 with the 3 global webinar rows seeded and legacy
  marketing/sales intact. Fresh handoff prompts written:
  SESSION_HANDOFF_2026_07_31_ORCHESTRATOR_V2.md + SESSION_HANDOFF_2026_07_31_BUILD_TEST_V2.md.
- 2026-07-31 22:55 [operator] CRITIC POLICY CHANGED: **Fable 5 is the standing critic**.
  Codex CLI is NOT used on this project (no external-app dependency). Its dead auth is no
  longer a gate and no Codex re-review is owed on CP1. `.loop/CRITIC_POLICY.md` and
  CONSOLIDATION_ROADMAP.md "Working rules" updated. Compensate for same-family blind spots
  with distinct lenses per pass + empirical reproduction of claimed bugs.
- 2026-07-31 22:55 [operator-session] NEW LOAD-BEARING FINDING (from sibling sessions,
  confirmed against git): `feat/consolidation` is **11 ahead / 10 behind origin/main**, and
  **origin/main (9ff21cb) is what runs on staging** (pm2 `denchclaw-crm` :3100). main
  shipped a parallel CRM line this loop never saw: Resend outbound email + inbound webhook
  (12bc79f, fail-closed secret 855bd84, recipient→tenant resolution b8488d7),
  server/lib/scoring.js, integrations/cloudflare-email/, a GHL-style multi-channel inbox
  composer + unified Opportunities board (+497 lines of web/index.html), contact-activity
  audit log. Consequences: (1) **CP4a is half-built already** — wrap main's Resend sender
  in the claim/ack contract, do not rebuild it; (2) conflict surface is already 7 shared
  files incl. crm.js, conversations.js, auth.js, contacts.js, server.js, contract.mjs,
  web/index.html — it grows with every checkpoint; (3) migration numbering is still safe
  (origin/main tops at 011, so 019 is next); (4) a new checkpoint **CP-M** (reconcile the
  two lines) is inserted after CP1 and before CP4a — 🚧 GATE, the human picks merge vs
  rebase vs cherry-pick. Providers already wired in the outreach engine: Unipile
  (LinkedIn), Resend (adi@growthclub.org), Twilio (+12183095959); LinkedIn safety spine =
  kill-switch + allowlist (0 LinkedIn URLs) + 07:00-18:00 IST window.
- 2026-07-31 23:05 [operator] ROLE SPLIT CHANGED (v3). Testing moves OFF the builder and ONTO
  the orchestrator: session A = ORCHESTRATOR + TESTER (spec, critic, browser E2E, verify),
  session B = BUILD only (code, migrations, unit/contract suite). Rationale: the author no
  longer certifies its own work. Protocol changes: (1) new phase TEST between BUILD and
  VERIFY; (2) new `.loop/verdicts/<ticket>.md` authored by the orchestrator (PASS/FAIL,
  criterion-by-criterion, critic verdict) — the builder reads it before any fix-ticket;
  (3) `.loop/EVIDENCE/` is now authored by the ORCHESTRATOR, not the builder; (4) the builder's
  receipt gains a "TEST BRIEF FOR THE ORCHESTRATOR" block (seed script, UI path, API probes,
  what "working" looks like, what isn't visible in the UI); (5) port ownership to prevent
  collisions — builder :3101, orchestrator :3102 + shim :8899, scratch PG :54339 shared
  single-writer by turn. Canonical prompts: SESSION_HANDOFF_2026_07_31_ORCH_TEST_V3.md and
  SESSION_HANDOFF_2026_07_31_BUILD_V3.md; all earlier handoff files are superseded.
  Also noted: Anthropic quota hit a hard 429 today (5h 1.01 / 7d 0.84), shared with the
  content-engine appwire mission — on 429, write STATE + receipt BEFORE stopping.
- 2026-07-31 23:45 [orch] **CP1 VERIFY COMPLETE → PASS.** Redone from scratch by the
  orchestrator/tester; the builder's numbers, browser script and screenshots were treated as
  unverified claims. Dropped + recreated `denchclaw_test` on scratch PG :54339, re-applied
  migrate.sql + 002–018, re-ran the suite myself: **326 passed / 0 failed** (contract 66,
  tenancy 15, tenants 12, sequences 38, b2 16, limits 34, b3 30, api-keys 16, a3 16, cp1 83)
  — matches the receipt. Migration 018 applied a 2nd AND 3rd time: exactly 3 global rows, 0
  dup keys, webinar_marketing stayed entity_type='contact', legacy marketing(9)/sales(12)
  `stages::text` byte-identical (literal compare true/true), stage modes match PIPELINES_SPEC
  verbatim. Drove the real dashboard through my own shim (:3102 server + :8899 shim, my own
  drivers `scratchpad/orch-cp1-{verify,probe2,probe3,probe4}.mjs`, NOT the builder's e2e):
  all of E1–E14 checked individually and green, incl. the conversations.js inbound gate proven
  behaviourally with a negative + positive control + tenant isolation, the cross-tenant
  company-scoped sequence key (400 for the other tenant / 201 for its owner), and cache
  invalidation after an override (auto→auto 200 / auto→manual 403). Enrollment fired for real:
  human advance into `no_show_followup_1` → "1 enrolled (1 active)" ON SCREEN + an active
  enrollment row via API. Console: 5 error lines, all deliberate refusal probes, 0 unexpected.
  Three first-pass anomalies were all traced to MY assertions, not the code (member-stage
  POST /deals is permitted by E7's letter; closed_at lives in metadata and is API-surfaced,
  same line that serves legacy won/lost; the legacy /advance 400 is a verbatim pre-CP1 guard).
  The 3 accepted LOWs were each reproduced and are genuinely acceptable — notably the legacy
  `marketing` entry rule widens ONLY to stages[0] and a suppressed contact is still 409.
  Critic: none spent — per the 22:55 operator policy CP1's Fable-5 review is complete and no
  re-review is owed; its 5 fixed findings were re-checked live and all hold.
  Verdict: `.loop/verdicts/CP1-funnel-pipelines.md`. Evidence (mine):
  `.loop/EVIDENCE/CP1-funnel-pipelines/` — 7 PNGs (each opened and read), console log, 4 JSON
  result sets. New follow-ups F1–F4 recorded in the verdict (deal-pipeline has no entry rule
  so a human can create a funnel deal at any member stage incl. terminal; `deals.closed_at`
  column never written; sequence UI shows a count not the enrolled contacts; nice() lowercases
  labels). Test stack torn down (:3102 + :8899 killed); scratch PG :54339 left up per protocol.
- 2026-07-31 23:45 [orch] NEXT: **CP-M is a 🚧 GATE** — feat/consolidation is 11 ahead / 10
  behind origin/main and origin/main is what runs on staging. Reconciliation strategy
  (merge / rebase / cherry-pick) is the human's call and blocks CP4a. Surfaced to the operator.
- 2026-08-01 [operator] **CP-M gate CLOSED by decision.** Reconcile by **merging
  `origin/main` INTO `feat/consolidation`** (no rebase, no cherry-pick), resolve the 5
  conflicting files by **UNION — never selection** (banned: `-X ours/theirs`,
  `checkout --ours/--theirs`), verify on the branch, then land on `main`. Push to `main`
  is authorised for the verified result; **deploying to staging is NOT** (still a gate).
  Migrations do not collide (origin tops at 011); next new migration is **019**. CP4a is
  rescoped: `main` already ships the Resend sender + inbound webhook, so CP4a must WRAP
  them in the B4 claim/ack contract, not rebuild them. Full strategy, per-file resolution
  map and mandatory eval criteria M1–M8: `.loop/CP-M_DECISION.md`.
  **Execution moves to a fresh Claude Code account** — see
  `SESSION_HANDOFF_2026_08_01_A_ORCHESTRATOR.md` / `_B_BUILDER.md`. STATE deliberately
  left `GATED` so the currently-running orchestrator does not pick CP-M up; the NEW
  orchestrator clears it as its first action.
- 2026-08-01 [operator] **CP-M GATE DECISION: MERGE `origin/main` INTO `feat/consolidation`.**
  Not rebase, not cherry-pick. Operator picked this when the build session surfaced the gate
  with measured numbers. Rationale recorded: a merge hand-resolves each conflict exactly ONCE
  and preserves main's history (main IS what runs on staging); a rebase replays 11 commits and
  resurfaces the same crm.js/auth.js hunks repeatedly while rewriting already-verified CP1
  hashes; a cherry-pick discards shared ancestry and makes the NEXT reconciliation worse.
  Measured by the build session (read-only, in a throwaway worktree since removed; branch
  still at d8a314e, nothing staged): merge-base b7bd2ab, 10 main-only commits / 11 branch-only,
  7 files touched on both sides, but a **dry-run merge conflicts in only 5** —
  `server/routes/crm.js` (+87/-51 main vs +359/-66 branch) and `server/middleware/auth.js`
  (+72/-6 vs +160/-12) are the real work; `server/routes/conversations.js`,
  `server/db/models/contacts.js`, `server/server.js` are smaller; **`web/index.html`
  (+441/-56 on main) and `test/contract.mjs` auto-merge cleanly** despite being the
  highest-churn files. NOTE: the BUILD session did NOT perform the merge — it does not merge
  and does not pick its own work. CP-M is still the orchestrator's to spec and execute.
  STATE left untouched at {CP-M, GATED, handoff:orch}; build is parked and polling.
- 2026-08-01 00:20 [orch] CP2 SPEC dispatched → `.loop/tickets/CP2-step-scheduler.md` **rev 2**.
  Goal: the step-scheduler seam. Confirmed the premise myself — `grep -rn scheduleAction server/`
  matches only its own definition + module.exports; the only callers are 3 test files, so an
  enrollment is a dead record and the dispatcher's `scheduled_for <= now()` scan finds nothing.
  Scope: enroll → queue step 1 atomically; ack(sent) → advance enrollment + queue next step;
  stage write-back as a step side-effect through CP1's mode gate. Migration 019 adds
  `sequence_steps.stage_writeback` + `UNIQUE(enrollment_id, step_id)`. Trigger taxonomy,
  tags_include, and replied:true exit stay OUT (CP3). No daemon — the dispatcher is pull-based.
- 2026-08-01 00:20 [orch] CRITIC pass 1 of 2 (ticket, **FABLE 5**, lens = correctness /
  state-machine / send-gating): **FAIL** on rev 1 — 1 HIGH + 4 MEDIUM + 3 LOW, all folded into
  rev 2 marked `[C:…]`. **HIGH-1 (rewrote D3)**: rev 1 put the next-step insert, enrollment
  advance and write-back INSIDE ackJob's transaction before COMMIT — any thrown side-effect
  rolls back `status='sent'` for a message the executor already physically sent, so the row
  stays `claimed`, crosses CLAIM_TIMEOUT_MS (300s), is reclaimed at dispatch.js:88 and is
  **re-sent every ~5 min forever** for a persistent error. The codebase already knows this
  lesson (campaignEvent is deliberately post-COMMIT, dispatch.js:203-227). D3 now requires the
  send to be committed first, side-effects after (or in a SAVEPOINT that can't undo it), plus
  `ON CONFLICT DO NOTHING`. MEDIUM-2 duplicate step rows double-advance → guard on
  `job.step_id === enrollment.current_step_id`. MEDIUM-3 **pausing a sequence stops nothing** —
  the claim query has no sequence-status filter (I re-verified: dispatch.js:87-91) → D5b.
  MEDIUM-4 zero-step enrollment permanently stuck `active` (no route can update an enrollment,
  partial unique index blocks re-enrol) → complete it immediately. MEDIUM-5 one skipped
  write-back freezes every later one because FU transitions are strictly linear → lint the
  chain at config time + name wanted-vs-found in the activity row. LOW-6 channel-specific
  suppression must not kill a multi-channel enrollment. LOW-7 ack-time anchor + stale-skip edge
  documented. LOW-8 enrollment failures are silently swallowed (I re-verified:
  sequences.js:74-84 catches everything and returns []) → write a contact_activity row.
  **Critic also CONFIRMED the ticket's correction to the standing brief: the A5 advisory-lock
  landmine is ALREADY CLOSED by B3** (dispatch.js:51-52 takes
  `pg_advisory_xact_lock(hashtext(company:channel))` inside BEGIN before checkRateLimit, and
  :63-72 discounts non-stale in-flight claims). Builder must NOT rebuild it — only not break it.
  Ticket carries 17 criteria (E1–E17) + a 7-step browser script the orchestrator runs itself.
- 2026-08-01 00:20 [orch] STATE → {cp:CP2, phase:BUILD, handoff:build}. Operator chose "keep
  building" over resolving CP-M first; **CP-M stays an open GATE** (merge strategy unauthorized)
  and still blocks CP4a, but not CP2 — CP2 touches no file origin/main changed except
  web/index.html, which the ticket constrains to an additive block. Polling for the builder.
- 2026-08-01 [build] cycle 1 — **CP2 built + committed (13a89c8, feat/consolidation only)**.
  Migration 019 (`sequence_steps.stage_writeback` + `UNIQUE(enrollment_id, step_id)`) applied
  only to scratch PG; idempotent on a 2nd AND 3rd apply, and proven against a DB pre-seeded with
  duplicate rows (de-dups keeping the most-progressed row, then builds the index). The seam is
  closed: `enroll()` materializes step 1 in the SAME transaction as the enrollment (zero-step
  sequences complete instead of stranding), `ack(sent)` advances the enrollment and queues the
  next step anchored on the ACK, and `stage_writeback` mirrors the reporting stage THROUGH CP1's
  mode gate — a manual target and an illegal transition are both refused, recorded wanted-vs-found
  on the timeline, and neither can turn a successful send into a failed ack. Side effects run
  AFTER the send commits and after the pooled client is released (the rev-1 critic's HIGH: inside
  the transaction a throwing side effect rolls back `status='sent'` for an already-sent message
  and the row is reclaimed and re-sent every ~5 min forever). Suite **454/0** on a rebuilt DB =
  326 pre-existing UNMODIFIED + 128 new. `crm.js`/`conversations.js`/`auth.js`/`contacts.js`/
  `server.js`/`contract.mjs` all untouched (verified file-by-file); `web/index.html` +41 additive
  only. Critic: **FABLE-5, 3 lenses, verdict FAIL** — F1 was a REAL defect I under-called
  (pausing during an in-flight step stranded the enrollment permanently and silently; my own E11b
  walked into that state without asserting). Fixed with `resumeSequenceQueue()` backfilling on
  re-activation + a visible `sequence_step_not_queued` row, 6 regression checks. F5/F6/F7 also
  fixed; F2/F3/F4 accepted + documented (F3 deliberately NOT fixed — the fix would break the
  ticket's own browser script step 4). Receipt + TEST BRIEF + seed script named in
  `.loop/receipts/CP2-step-scheduler.md`. Next unused migration: **020**. :3101 released;
  :3102/:8899 never touched. → handoff: orch (TEST).
- 2026-08-01 01:0x [orch] **CP-M SPECED** → `.loop/tickets/CP-M-merge-main.md` **rev 2**.
  Authored on the operator's standing authorisation (`CP-M_DECISION.md`: "This file closes the
  CP-M gate. The orchestrator may author the CP-M ticket from it without asking again"). Wrote it
  during the builder's CP2 turn — spec only, no shared runtime, no file collision. Re-measured all
  ground truth MYSELF after `git fetch origin`: merge-base `b7bd2ab`, 10/11 (now 10/12 post-CP2),
  and `git merge-tree --write-tree` (real dry run, tree untouched) → **exactly 5 conflicts**
  (contacts.js, auth.js, conversations.js, crm.js, server.js), with `test/contract.mjs` +
  `web/index.html` **auto-merging**. Three findings git will not flag: **GT-1** both sides define
  `ipAllowed` but the branch's is a string-prefix hack that widens a /32 to a /24 (main's is real
  CIDR math at auth.js:91/127/140) — "keep ours" is a security downgrade; **GT-2** main's
  `webhooks.js:16,100` self-calls with `x-internal-key`+recipient-derived `x-company-id`, and the
  branch's `requireAuthAsync` **ignores `X-Company-Id` for a DB-backed key** → inbound email
  silently re-tenanted (or 403/401 depending on binding) with no conflict marker anywhere;
  **GT-3** `server.js` conflicts on the mount block, so selection unmounts either `/webhooks` or
  all four `/api/crm/*`. Also corrected the decision file: the inbound fail-closed + recipient
  routing are in `webhooks.js`, **not** `auth.js`; and re-applying main's 6 contacts.js lines
  verbatim would **resurrect `getByIdUnscoped`** (A1's fix). Ruled out by measurement: no
  main-side caller of the now-async `canonicalCompanyId`. 16 criteria M1–M16, 7-step browser
  script, D1–D11.
- 2026-08-01 01:0x [orch] CRITIC pass 1 of 2 on the CP-M ticket (**FABLE 5**, lens = feature loss
  / security regression the criteria would not catch): **FAIL** on rev 1 — 1 HIGH + 4 MEDIUM +
  4 LOW, all folded into rev 2 marked `[C:…]`. **HIGH-1 was a feature-loss instruction in my own
  D4**, which I reproduced and confirmed: the branch's `conversations.js` delta is **three**
  changes (sequenceDb import, the `isManualStage` gate, **and `enrollForTriggerStage(…'marketing',
  'responded')`** — B2's inbound-reply hook), but rev 1 and the decision file both called it "one
  surgical gate", so a resolver following it verbatim deletes B2's enrollment. D4 rewritten to
  enumerate all three + demand post-merge line numbers for the gate AND the enroll call.
  Also folded: MEDIUM-2 ground truth went stale mid-flight (CP2 landed as `13a89c8`; 10/12 now)
  → added a mandatory STEP ZERO re-measure; MEDIUM-3 `origin/main` **already ships** duplicate
  ids (`cv-from`/`cv-to`/`cv-body` ~:916-937) so M12's absolute no-dup-id check false-fails a
  perfect merge → made it baseline-relative; MEDIUM-4 the merged tree lets main's composer deliver
  to an **A5-suppressed** contact (composer checks no suppressions; branch enforces only in the
  dispatcher/entry paths) → new D11; MEDIUM-5 main **fixed** `addContactActivity` (the old body
  reset `lead_score_numeric` to 0 every call) so "rebuild crm.js from the branch" reverts a
  bugfix → D3 amended + M13 now pins the expected score delta; LOW-6 the ipAllowed widening bites
  under DEFAULT config too (`127.0.0.2`) → M9 gained a second probe; LOW-7 M10 probed mount roots
  that 404 legitimately → concrete subroute probes; LOW-8 Resend's deliver branch is skipped
  entirely when `RESEND_API_KEY` is unset → new M15; LOW-9 `INBOUND_ROUTING` vs `tenants` are
  unsynchronised registries → new M16. Critic independently re-confirmed GT-1/GT-2/GT-3, the two
  decision-file corrections, and the merged `contract.mjs` union count (base 54 + main 2 + branch
  20 = 76). **CP-M is NOT dispatched** — it is blocked on CP2 banking (D10) and carries an open
  dispatch question (v3 role split says the builder resolves and I verify; a 08-01 log line says
  the orchestrator executes). Operator to settle.
- 2026-08-01 01:15 [build-2] **CP2 SECOND BUILD PASS — HEAD moved to `82689ab`, re-verify there,
  not at `13a89c8`.** A second build session picked the ticket up on a legitimate
  `handoff:"build"` (STATE still said BUILD) while the authoring session was still finishing; it
  committed `13a89c8` at 00:53 and flipped STATE to `orch` mid-critic. Ran a fresh **Fable 5**
  pass with 3 distinct lenses (state-machine / idempotency+re-send / tenancy+XSS). Two HIGHs,
  both **reproduced against the scratch DB**, both consequences of D3's commit-send-first shape,
  both fixed with regression checks: (1) a side effect that threw — or a crash right after
  COMMIT — stranded the enrollment FOREVER; the job row is terminal so no claim scan revisits
  it, and `resumeSequenceQueue`'s `NOT EXISTS` structurally cannot see it because a
  `scheduled_action` for the current step DOES exist, just `sent`. So the earlier F1 fix closes
  the PAUSE strand but not this one. Fixed by making the idempotent ack replay CARRY the side
  effect — safe by construction, since D3b already no-ops it unless the acked job IS the current
  step and the enqueue is `ON CONFLICT DO NOTHING`, so E7 stays green and a strand advances
  exactly once (`R1`, 10 checks). (2) `runStepSideEffects`' "NEVER throws" was false —
  `getClient()` sat OUTSIDE its try, so a saturated pool returned **HTTP 500 for an ack whose
  send was already committed**, the exact signal that makes an executor re-deliver; same hazard
  in `claimJobs`' post-commit call, which would discard the claimed-job list. Fixed by acquiring
  the client inside the try (`R2`, 4 checks, fault-injected). Also fixed a **test-isolation
  defect**: E1 asserted a table-global property and failed whenever the suite ran twice against
  one DB. **Suite 469/0 on a fresh DB (326 pre-existing UNMODIFIED + 143 CP2), green twice
  consecutively** — the earlier "454" was not reproduced and is not claimed. Refused the
  critic's "reject a MANUAL stage_writeback at config time" on purpose: E9 and browser-script
  step 4 REQUIRE that configuration to exist. Dry-ran the orchestrator's browser script (API
  half): 21/21 pass, and surfaced that **the ticket's step 3 contradicts its own seed spec** —
  after acking step 1 the deal is `no_show_followup_1`, `_2` appears after step 2. ANOMALY, for
  the record: not a clean single-writer turn — files changed under me at 00:47, `13a89c8` landed
  mid-critic, and `denchclaw_test` was dropped/recreated under my run at 01:06-01:08
  (`denchclaw_verify` appeared). Measurements were moved to a private `denchclaw_build_cp2`.
  STATE left at `handoff:"orch"` — turn NOT taken back; only `status` updated to flag the moved
  HEAD. Detail: ADDENDUM at the end of `.loop/receipts/CP2-step-scheduler.md`.
- 2026-08-01 01:15 [orch] **CP2 TEST + VERDICT COMPLETE → PASS. CP2 is BANKED at `13a89c8`.**
  Redone from scratch; every number in the receipt treated as an unverified claim. Dropped +
  recreated `denchclaw_test` on scratch PG :54339, re-applied migrate.sql + 002–019, and re-ran
  the suite MYSELF: **454 passed / 0 failed** = contract 66 + tenancy 15 + tenants 12 +
  sequences 38 + b2 16 + limits 34 + b3 30 + api-keys 16 + a3 16 + cp1 83 (**= 326 exactly**) +
  **cp2 128** — matches the receipt, and `git show 13a89c8 --stat` confirms **no pre-existing
  test file was touched** (E14/E16). Migration 019 applied a **2nd and 3rd** time by me, plus a
  probe the builder's suite lacks: planted duplicate `(enrollment_id, step_id)` rows, re-applied
  019, watched them collapse to 1 with the unique index rebuilt (E1). Wrote my OWN behavioural
  driver from the ticket's criteria (`scratchpad/orch-cp2-verify.mjs`): **28/28**. Drove the real
  dashboard through my own :3102+:8899 stack with my own playwright driver: **13/13, 0 console
  errors**. Extra targeted probes for E12 (chain validation 400s with actionable bodies + a valid
  201), E2b (zero-step → `completed`, 0 queued — exercised via the TRIGGER path, since there is
  no `/enroll` route) and D7. **~55 independent checks, 0 attributable to the code.**
  E9 — the most important criterion — proven in the row AND on screen: ack 200, chip `sent`,
  enrollment `completed`, deal still `scheduled_call`. E10 proven by poisoning a write-back, then
  ageing `claimed_at` to 2h past CLAIM_TIMEOUT and confirming the row is never reclaimed — the
  re-send loop HIGH-1 warned about does not exist. E11b (the critic's F1 fix) verified live on a
  genuinely due row. **All first-pass anomalies were MINE again, exactly as in CP1**: the claim
  response field is `job_id` not `id` (so a `400 "job_id must be a UUID"` was the API correctly
  rejecting my malformed request); I wrongly assumed acking step 1 mirrors the deal to `_2` when
  step 1's write-back is `_1`; and my "global suppression doesn't exit" failure was a probe that
  recycled a row already consumed and advanced past by the preceding channel-suppression probe —
  on a fresh current-step row it exits correctly with `exit_reason='suppressed'`.
  **Schema facts for future sessions:** the table is `enrollments` (NOT `sequence_enrollments`);
  the claim response id field is `job_id`; there is no `/enroll` route — enrollment is
  trigger-driven. **Defect found in the TICKET, not the build:** browser-script step 3 expects the
  deal at `no_show_followup_2` after acking step 1, contradicting the same ticket's E13 ladder
  (step N mirrors `_N`) — the build is right. No second critic pass spent on the CP2 diff: three
  adversarial lenses had already run on it, its one FAIL was fixed and I re-verified that fix
  live; the remaining critic budget went to the CP-M ticket, which had had no review at all and
  where it caught a HIGH. Verdict: `.loop/verdicts/CP2-step-scheduler.md`. Evidence (mine):
  `.loop/EVIDENCE/CP2-step-scheduler/` — 3 distinct PNGs (each opened and read; 2 byte-identical
  duplicates deleted rather than filed as coverage), 5 logs, an index. New follow-ups F-CP2-1
  (60s delay renders as `+0h`), F-CP2-2 (footer hardcodes :3100), F-CP2-3 (fix the ticket's
  step 3). Test stack torn down (:3102 + :8899 killed); scratch PG :54339 left up per protocol.
  NOTE: `CONSOLIDATION_ROADMAP.md` progress log still owed a CP1 AND CP2 entry — deliberately not
  written by me because the file carries an uncommitted operator edit I was told to leave alone.
- 2026-08-01 [orch] **CP-M EXECUTOR DECIDED + DISPATCHED.** Operator delegated the executor call
  to me; I chose **BUILDER resolves / ORCHESTRATOR verifies**, superseding the earlier log line
  that said CP-M was mine to execute. Reason: the v3 role split exists precisely so the author
  never certifies its own work, and union-resolving 5 files — `auth.js` and `crm.js` among them —
  is substantial security-critical code, not a clerical merge; I have to stay uncontaminated to
  check M1–M16. Ticket constraint updated from an open question to a locked decision.
  STATE → {cp:CP-M, phase:BUILD, handoff:build}.
- 2026-08-01 [orch] **NEW SCOPE FROM THE OPERATOR: CP-I, a consolidated LinkedIn-style Inbox
  tab.** Every to-and-fro across email / LinkedIn / WhatsApp / SMS / calls / AI-agent output
  lands in one inbox AND in the contact-or-deal activity feed; users reply through an AI
  interface; replies are logged back onto the CRM entity. **I verified CP-I is BLOCKED on CP-M
  and said so before spending build effort**: `feat/consolidation` carries only a minimal inbox
  (7 composer markers, a basic `renderInbox` at web/index.html:707) while `origin/main` carries
  the full GHL-style composer (27 markers) plus `server/lib/email-resend.js`,
  `server/routes/webhooks.js` and `server/lib/scoring.js` — **none of which exist on the branch**
  (`git cat-file -e` → NO for all three). Building CP-I on the branch now would rebuild main's
  Resend sender, inbound webhook, composer and reply attribution from scratch — exactly the waste
  CP-M exists to prevent and exactly what CP-M_DECISION.md decision 6 forbids. So: CP-M builds
  now, CP-I is specced in parallel and dispatched after CP-M banks.
- 2026-08-01 [orch] Operator asked for a recurring driver: `/loop 30m` → cron job `9866bd0c`
  (every 30 minutes, session-only, auto-expires after 7 days) re-entering the loop to poll STATE
  and advance the current phase.
- 2026-08-01 [operator] **BUILDER CONSOLIDATION — there is now exactly ONE build session.**
  Two builders were polling the same `handoff:"build"` flag (this session, author of CP2
  `13a89c8`, and `build-2`, author of `82689ab`). With CP-M — a 5-file hand-resolved merge —
  next in the queue, two sessions resolving the same conflicts in one working tree was a real
  hazard. The operator kept the OTHER session; this one stood down and was archived. Anything
  that flips STATE to `handoff:"build"` from here is unambiguously for the surviving builder.
  Context handed over in-session AND recorded below so it survives regardless.
- 2026-08-01 [build] **CP-M measured, read-only — carry these numbers into the merge.** Taken in
  a throwaway git worktree that was removed afterwards; the branch was not modified.
  merge-base `b7bd2ab90103ffd24433b98f6573a3ef31000314`; 10 commits only on origin/main, 11 only
  on feat/consolidation; 7 files touched on BOTH sides, but **a dry-run merge conflicts in only
  FIVE**: `server/routes/crm.js` (+87/-51 main vs +359/-66 branch) and
  `server/middleware/auth.js` (+72/-6 vs +160/-12) are the real work, with
  `server/routes/conversations.js` (+74/-6 vs +14/-2), `server/db/models/contacts.js`
  (+6/-1 vs +24/-38) and `server/server.js` (+2/-0 vs +8/-0) small. **`web/index.html`
  (+441/-56 on main) and `test/contract.mjs` auto-merge CLEANLY** despite being the
  highest-churn files. Re-measure before trusting these (they may move with later commits):
  `git worktree add -q --detach /tmp/cpm-probe feat/consolidation && cd /tmp/cpm-probe &&
   git merge --no-commit --no-ff origin/main >/dev/null 2>&1; git diff --name-only --diff-filter=U;
   git merge --abort; cd -; git worktree remove --force /tmp/cpm-probe`
  Operator's chosen strategy remains MERGE origin/main INTO feat/consolidation. CP-M is a GATE.
- 2026-08-01 [build] **Stale claims that must stop propagating.** (1) The A5 advisory-lock
  warning in `SESSION_HANDOFF_2026_08_01_B_BUILDER.md` (~l.221) and `_A_ORCHESTRATOR.md` (~l.100)
  is FALSE — B3 already closed it at `server/db/models/dispatch.js:51-52`; rebuilding it risks a
  lock-ordering cycle. (2) Next unused migration is **020**, not 019. (3) Suite: 326 pre-CP2 →
  454 at `13a89c8` → 469 at `82689ab`; the 326 pre-existing must always pass UNMODIFIED.
  (4) CP1 follow-up F3 is CLOSED by CP2's `GET /sequences/:id/queue`.
  Untracked helpers left for whoever builds next: `scratchpad/reset-db.mjs` (drop+recreate the
  scratch DB; refuses any non-:54339 URL), `scratchpad/seed-CP2-step-scheduler.mjs` (the
  orchestrator's CP2 fixture — real ladder + a 60-SECOND fast variant so a 5-step ladder walks in
  ~4 min instead of 16 days + a pre-enrolled manual-refusal probe), `scratchpad/mig019-check.mjs`
  (migration idempotency + duplicate-tolerance harness; adapt for 020).
- 2026-08-01 [orch] **CP-I RESEARCH DONE — 36 inbox UI images analysed one by one**, banked at
  `.loop/EVIDENCE/CP-I-research/` (images `1.jpg`–`36.jpg`, `source-urls.json`, and
  `INBOX-UI-ANALYSIS.md` with a per-image table). Method: image search → 36 distinct results
  downloaded locally → each opened and read at full resolution. The in-app browser pane kept
  wedging on script-heavy marketing pages and localhost navigation is one-shot per origin, so
  after several dead ends I downloaded the images and read them directly off disk — far more
  reliable and higher fidelity than screenshotting galleries. Mix: LinkedIn native across four
  eras (2012 mail-style inbox → current Focused/Other) + Sales Navigator + eight third-party
  LinkedIn-CRM inboxes (Waalaxy/Piwaa, LeadDelta, Breakcold, CloseChimp, Octopus, Network
  Cleaner, Prosp, Sprout Social). Two of the 36 were low value (a feed page, an angled photo of a
  monitor) and are recorded as such rather than padded. Patterns that drove the design: the
  universal three-pane shell where every CRM-flavoured clone replaces LinkedIn's ad rail with the
  CONTACT RECORD; the list as a workflow queue rather than a mailbox (**Your turn / Their turn**
  is the standout idea); channel identity as a BADGE ON THE AVATAR, not a column; the composer as
  **Reply | Note | Templates** peer tabs; automated messages visually marked with a compliance
  footer; smart replies as chips above the composer.
- 2026-08-01 [orch] **CP-I SPECED** → `.loop/tickets/CP-I-unified-inbox.md` rev 1, grounded in the
  live schema rather than designed in the abstract. Three findings reshaped it: (1)
  `conversations` is one row **per channel per contact**, so a unified thread is a CONTACT and
  must be grouped at query time — no new "unified conversation" table; (2) **`messages.ai_generated`
  already exists**, so the automated-vs-human marker is free; (3) there is **no read/unread state
  anywhere**, so unread needs migration 020 (`last_read_at`, `starred`) — but **"Your turn /
  Their turn" costs nothing**, being derivable from the latest message's `direction`. Also
  verified: `messages`/`conversations` carry **no `deal_id`** (so deal scope must be explicit and
  never guessed — D6), and `origin/main` gates delivery on `channel === 'email' &&
  resendEmail.isConfigured()` at `conversations.js:165`, so every other channel records but does
  not send — CP-I must say **"Logged — not delivered"** on screen rather than imply a send (D5,
  the worst failure this feature could have). CP-M's **D11 is absorbed as CP-I's D9**: suppression
  is enforced in the composer, not just the dispatcher. D7 forbids any autosend — AI drafts into
  the composer and a human must click Send. 18 criteria I1–I18, 9-step manual browser script.
  **NOT dispatched: blocked on CP-M** (D10/constraints), and deliberately so — the builder is
  mid-merge in the very two files CP-I touches (`web/index.html`, `conversations.js`).
- 2026-08-01 [orch] CRITIC pass 1 on the CP-I ticket launched (**FABLE 5**, lens = correctness /
  data-integrity in a multi-tenant CRM that already sends autonomously). Briefed to attack the
  unread race (can an inbound message arriving mid-read be silently marked read and lost?), the
  turn-derivation edge cases, whether the "Automated" badge is even implementable (is there any
  link from `messages` to `scheduled_actions`?), whether the OLD `POST /conversations/:id/messages`
  route left by CP-M is an unsuppressed side door, and prompt-injection into the AI draft from
  untrusted inbound bodies — which the ticket does not mention at all. Running in background;
  findings fold into rev 2 next cycle.
- 2026-08-01 [operator, mid-turn] **NEW REQUIREMENT: pipeline stages must be surfaced as TAGS in
  the UI**, with a separate plan, then integrated into the chosen UX.
- 2026-08-01 [orch] **PLAN WRITTEN → `.loop/CP-T_STAGE_TAGS.md`**, and folded into CP-I as **D11 +
  I19–I23 + browser steps 9–11** so it ships with the Inbox rather than floating as a design doc.
  Grounded first: stages live in `crm_pipeline_configs.stages` as `{key,label,mode,transitions[]}`
  (verified on `webinar_sales`: `scheduled_call` is `mode:auto`, `no_show_followup_1` is
  `mode:manual`), and `getPipelineTransitions`/`isManualStage`/`isTerminalStage` are already
  exported from `server/db/pipeline.js:51,67,75`. Also found: **free tags are not chips today** —
  `web/index.html:632` renders `(c.tags||[]).join(", ")` as flat text — so both chip types get
  built here. **The design risk I flagged and resolved:** a stage is authoritative state governed
  by CP1's mode gate, a tag is an arbitrary label with no rules; render them identically and a user
  will hunt for an `×` on a stage, and any edit affordance we bolt onto a stage chip silently
  becomes a NEW stage-transition surface — the exact surface CP1 spent a checkpoint gating. So:
  same visual family, deliberately distinguishable (pipeline glyph, no remove control), and the
  chip's menu is built from `getPipelineTransitions()` with illegal targets ABSENT rather than
  greyed, posting to the EXISTING `/advance` authority — no new transition path. Bonus: encoding
  `mode` in the chip style (auto = filled, manual = outlined + person glyph) makes CP1's invariant
  visible for the first time; today `mode` is enforced server-side and invisible, which is exactly
  why an operator cannot tell why a deal "won't move". I22/I23 exist to prove the chip did not
  become a bypass.
- 2026-08-01 02:10 [build] **CP-M MERGE RESOLVED + COMMITTED — `a2045a7`** (merge commit, parents
  `82689ab` + `9ff21cb`; 15 files +1282/−121). **NOT pushed to `main`** — pre-authorised only "for a
  verified result", and that verdict is the orchestrator's. Deploy untouched (shut gate).
  STEP ZERO re-measured at resolution time, not inherited: merge-base `b7bd2ab`, **10 main-only / 13
  branch-only** (13 not 12 — CP2 landed as TWO commits, `13a89c8` plus the follow-up `82689ab` the
  CP2 verdict predates), **exactly 5 conflicts**, `contract.mjs` + `index.html` auto-merged.
  All five resolved by **UNION**: `server.js` keeps `/webhooks` AND all four `/api/crm/*`;
  `auth.js` keeps the branch's whole A3 structure with **main's CIDR math replacing the prefix
  hack** (GT-1) and union exports, IP check still on every request (`:277`); `conversations.js`
  keeps main's composer/threads/attribution/scoring **plus all THREE** branch changes — CP1 mode
  gate `:320`, B2 `enrollForTriggerStage` `:336`, ordered gate→UPDATE→activity→enroll;
  `crm.js` keeps the branch's stage authority but takes **main's** scoring plumbing so the
  `lead_score_numeric`-reset bug is not reintroduced (`addContactActivity:1896`);
  `contacts.js` = main's loud warning **on top of** the branch's throw. **Deviation on D5**: kept
  the THROW rather than "return null" because `unit-tenancy.mjs:49-52` asserts a throw and M2
  forbids editing existing tests; the unscoped path is still gone (grep = 0).
  **Both merge-created holes CLOSED inside the merge, not documented away.** D7/GT-2: `auth.js` was
  deliberately NOT weakened (`unit-a3:74` asserts a DB key ignores `X-Company-Id` **on purpose**);
  instead `webhooks.js` now VERIFIES the tenant it actually got and refuses loudly rather than
  cross-filing. D11: composer suppression gate at `conversations.js:195`.
  **Suite 471/0 on a fresh DB** (326 pre-CP2 + 143 CP2, all UNMODIFIED; contract 66→68); migrations
  002–019 applied twice more clean; `contract.mjs` `check()` = 65 = the exact union (43 + 20 + 2).
  **M1–M16 all PASS except M7** (browser evidence = orchestrator's). M9 proven behaviourally **with
  a negative control** (old hack admits `192.168.1.99`); M12 duplicate-id check done
  **baseline-relative** — novel duplicates: none; M13 pins the score delta to the exact weight
  (+15) AND proves the manual-stage 403 in one test; M15 run with a bogus `RESEND_API_KEY` so the
  deliver branch really executed (502), not a vacuous pass.
  **CRITIC (Fable 5, 2 lenses, `auth.js` first): the union was NOT refuted — but both HIGHs were in
  code I ADDED during resolution**, and both were reproduced, then fixed with regressions: (1) my
  D11 gate was contact-keyed while delivery is **address-keyed**, so a suppressed address in
  `metadata.to` on an unsuppressed thread still sent → `to`/`cc`/`bcc` now mapped back to contacts
  and checked (`R-CPM-1`, 6 checks + 2 controls); (2) my `tenantMismatch` guard **502'd a config
  that worked on main**, because `INBOUND_ROUTING` may name an ALIAS (012 seeds `tantra` with
  `growthclub`) and auth canonicalises → now folded through `tenantDb.resolve` first, M16 preserved
  (`R-CPM-2`). Push-back welcome on one line: D11 currently refuses a **same-channel** suppression
  too, not only a global one (matches the dispatcher).
  For the verdict, three things that are NOT merge regressions but are real: (a) `trust proxy: 1` +
  `X-Forwarded-For: 127.0.0.1` defeats the IP allowlist — reproduced, identical in base/main/branch,
  needs an operator call; (b) `AUTOMATION_ENV_FILE=/nonexistent` does **not** isolate the test
  runner (it still finds `~/automation-engines-shared/.env.shared`), so a real `RESEND_API_KEY` can
  be live during a test run — must be fixed before anything uses `deliver:true` (CP4a); (c) merged
  `README.md` still calls A3 "roadmap" when A3 ships.
  Scratch DB: measured on my own `denchclaw_build_cp2` (`denchclaw_test` kept being dropped under my
  runs last cycle) — **`denchclaw_test` is the orchestrator's and I did not touch it**. `:3101`
  released. Next unused migration still **020**. CP-I is unblocked. Receipt:
  `.loop/receipts/CP-M-merge-main.md`.
- 2026-08-01 02:05 [orch] CRITIC pass 1 on the CP-I ticket (**FABLE 5**, lens = correctness /
  data-integrity in a CRM that already sends autonomously): **FAIL** — 2 HIGH + 4 MEDIUM + 3 LOW,
  all folded into **rev 2** marked `[C:…]`. **I reproduced both HIGHs myself before accepting.**
  **HIGH-1 killed the ticket's headline goal:** CP2 sequence sends never write a `messages` row —
  the only `INSERT INTO messages` in the repo is `conversations.js:248,263`, while
  `ackJob(sent)` at `dispatch.js:272-278` writes only an `UPDATE scheduled_actions` + an
  `INSERT INTO contact_activity` carrying `scheduled_action_id` in `data`. So D8's "metadata links
  it to a scheduled_actions row" was **false** and the very messages that motivated the feature
  were invisible. D8 rewritten: the thread is a **UNION of `messages` and `contact_activity` send
  events**, and CP2's ack path is explicitly NOT to be changed (it is banked). **HIGH-2:** rev 1's
  unread predicate was direction-blind — `conversations.js:274` stamps `last_message_at = now()`
  on every insert including outbound, so the operator's **own reply** would re-flag the contact
  unread; and stamping `last_read_at = now()` on open races an inbound arriving mid-fetch, marking
  it read though never rendered — **a lost customer message**. D2 rewritten: unread is
  **inbound-only**, and the read stamp is **max(created_at of messages actually returned)**, never
  `now()`. Also folded: MEDIUM-3 "open deal" now defined as `stage NOT IN` terminal stages reusing
  `dispatch.js:436-441` (not `closed_at`, which the dispatcher ignores) + server-side `deal_id`
  re-validation; MEDIUM-4 `uq_conversations_contact_channel` is a **partial** index
  (`WHERE status <> 'closed'`) so closed conversations must be included or messages vanish;
  MEDIUM-5 split the badge into **Sequence** (autonomous) vs **AI-assisted** (human clicked send)
  — rev 1 conflated them; MEDIUM-6 **prompt injection** was entirely unaddressed → draft output is
  inert text, never parsed for actions; LOW-7 turn tiebreak `(created_at, id)` + zero-message
  contacts; LOW-8 the gate also needs `deliver === true`; LOW-9 `company_id` on both sides of every
  join. Critic also caught that **D1's right rail and D4's Templates tab had NO criteria at all** —
  a builder could have shipped an empty third pane and passed. Added I12–I12i. Criteria now 32.
  It also correctly flagged that citing `CP-M_DECISION.md` decision 6 against CP-I is an
  extrapolation (that decision is about CP4a) — corrected in rev 2.
- 2026-08-01 02:06 [orch] **WATCHDOG INSTALLED** (operator asked for one that survives session
  death and quota exhaustion). `.loop/watchdog/watchdog.sh` + launchd agent
  `~/Library/LaunchAgents/com.denchclaw.loop-watchdog.plist`, StartInterval 300, RunAtLoad,
  registered and validated (`launchctl list` → `com.denchclaw.loop-watchdog`, `plutil -lint` OK).
  It reads STATE.json, detects a stall (>12 min with no .loop or git activity), and relaunches a
  headless Claude on the current phase with the hard rules embedded. Safety paths **tested, not
  assumed**: kill switch (`.loop/watchdog/DISABLED`) ✔, quota backoff honoured ✔, branch gate
  refuses to act off `feat/consolidation` ✔, stall detection ✔, exponential backoff 5→160 min on
  rate-limit ✔, single-instance lock with stale-lock recovery.
  **Testing found two real bugs in my own script**, both fixed and re-verified: (1) `command -v
  claude` resolves to the user's zsh *function*, not an executable, so the fallback never fired —
  now resolves a real binary (`/Users/adithyamurali/.local/bin/claude`); (2) **macOS has no
  `timeout`**, so the original `timeout 3600` line would have failed outright and the watchdog
  would never have launched anything — replaced with a portable background+kill implementation
  (verified rc=0 on success, rc=124 on overrun).
  **HONEST BLOCKER, surfaced not hidden:** the headless CLI is **not authenticated**. Both the
  standalone binary and the app-bundled one return "Not logged in · Please run /login" under
  `-p`, even though the keychain entry `Claude Code-credentials` exists — the desktop app injects
  credentials into its own sessions and `claude -p` does not inherit them. A watchdog cannot
  create quota **or** credentials. It now preflights auth, writes a `NEEDS_LOGIN` marker and logs
  the one-time fix (`claude login` in a terminal) rather than spinning silently. Until that is
  done it monitors and reports but cannot drive the build. Session-only cron `9866bd0c` deleted
  and replaced with **durable** job `ac182011` (every 17 min, persisted to
  `.claude/scheduled_tasks.json`) which also instructs the loop to report progress in chat each
  tick — the operator was rightly frustrated by long silent stretches.
- 2026-08-01 02:06 [orch] **CP-M HANDED BACK → {cp:CP-M, phase:TEST, handoff:orch}**, receipt at
  `.loop/receipts/CP-M-merge-main.md`, merge commit `a2045a7` ("union, never selection").
  First-pass spot checks (full M1–M16 verification still owed): **M1 clean** — `git grep` finds no
  conflict markers anywhere; all three main-only files now present on the branch
  (`email-resend.js`, `webhooks.js`, `scoring.js`); **GT-1 held** — main's `ipToBig`/`ipInCidr`
  CIDR math survived in `auth.js`; **GT-3 held** — 5 mount markers, both `/webhooks` and all four
  `/api/crm/*`; and critically **the critic's HIGH-1 feature loss did NOT happen** — B2's
  `enrollForTriggerStage` inbound hook survived at `server/routes/conversations.js:336`, which is
  the single thing rev 1 of my own ticket would have told the builder to delete.
- 2026-08-01 02:25 [build] CP-M foundation check for CP-I (orchestrator's request, no scope change,
  no code changed). Verified against committed `a2045a7`: `server/db/pipeline.js` is **byte-identical**
  to the pre-merge branch with all of `getPipelineTransitions`/`isManualStage`/`isTerminalStage` still
  exported; `web/index.html` has **zero duplicated function definitions** (63 defs) and one renderer
  per pane; main's composer/threads/Message-ID/reply-attribution all intact. The merged tree is a
  **superset of main** in both CP-I foundation files except exactly 3 deliberately-superseded lines
  (the pipeline import → union with `isManualStage`; the ungated `allowed.includes('responded')` →
  CP1 mode-gated form; main's 7-tab list → union 8-tab list adding `"sequences"`). Two apparent
  losses in my first pass (main's channel filter, `in_reply_to`) were grep-spelling false alarms —
  the filter is destructured at `conversations.js:68` and `in_reply_to` lives in `webhooks.js`.
  Also noted for the record: the other build session has been shut down by the operator, so this is
  now the SOLE builder lane; STATE remains `{CP-M, TEST, handoff:orch}` — still the orchestrator's turn.
- 2026-08-01 02:10 [orch] **ORCHESTRATION FIX — SWITCHED TO PARALLEL.** The operator challenged
  whether the loop was actually working, and the evidence splits two ways. It IS transmitting:
  all five injection checks pass — the builder used my "union, never selection" framing, preserved
  B2's `enrollForTriggerStage` (the exact feature loss the Fable critic caught in MY OWN rev-1
  D4), kept main's `ipToBig`/`ipInCidr` CIDR math (GT-1), kept both mount blocks (GT-3), and built
  the D11 suppression check I added to scope. But the operator is right about the outcome: three
  checkpoints banked and **the inbox they actually asked for still does not exist** (no migration
  020, no unified thread) — I have been producing process while the deliverable stayed at zero.
  Root cause of the "stuck" feeling, found on inspection: **`handoff=orch` parked the BUILDER
  while I verified.** One handoff token serialised two independent workstreams. Fixed: STATE now
  carries `build_ticket` + `orch_ticket` and runs PARALLEL — builder starts CP-I on `a2045a7`
  immediately, orchestrator verifies CP-M M1–M16 concurrently. If CP-M verification finds a
  defect it becomes a fix-ticket, which is a cheaper risk than idling the build session for the
  length of a full verification pass.
- 2026-08-01 02:12 [orch] **GOLDEN JOURNEY created — `scratchpad/orch-golden-journey.mjs`.** The
  operator asked how we can actually test this properly, and the honest answer is that my testing
  had a structural hole: every checkpoint was verified against its OWN criteria in isolation
  (CP1 green, CP2 green, CP-M green) and **nothing tested the chain**, which is the product. So
  green verdicts kept accumulating while the operator correctly perceived that nothing worked
  end to end. The golden journey walks one real operator path across every checkpoint at once —
  advance → enroll → materialise → claim → ack → advance ladder → mirror stage → refuse a manual
  stage → SEE it in the inbox → reply → log to contact+deal → suppression refusal — and fails at
  whichever link is broken. It is designed to GROW: `[CP-I]` links are skipped-with-a-reason until
  the inbox lands, then become hard assertions.
  **First run on the merged tree (a2045a7): 7 passed, 0 failed, 4 SKIPPED.** That single line is
  the truest statement of where this build is: **the machine half works end to end; the
  human-facing half does not exist yet.** L7–L10 skip with "CP-I not built yet — /inbox returns
  404". When CP-I lands the run should read 11/0.
- 2026-08-01 02:12 [orch] **CP-M verification in progress — M2/M3 GREEN.** Full suite on the
  merged tree, my own rebuilt DB: **471 passed / 0 failed** (contract 68, tenancy 15, tenants 12,
  sequences 38, b2 16, limits 34, b3 30, api-keys 16, a3 16, cp1 83, cp2 143). **M3 satisfied:
  contract went 66 → 68, so main's two extra contract cases survived the merge** — the union, not
  just our side. cp2 128 → 143 reflects the builder's 82689ab hardening. Still owed: M4 (migrations
  twice on a fresh DB), M5a/b/c (webhook fail-closed, recipient tenant, end-to-end inbound under
  A3 auth), M9 (CIDR probe incl. the DEFAULT-config 127.0.0.2 case), M10 (subroute probes), M11
  (getByIdUnscoped still gone), M12 (index.html baseline-relative dup ids), M13 (audit+score fire
  on an auto transition), M14 (no main file lost), and browser evidence for both worlds.
- 2026-08-01 03:05 [build] **CP-I BUILT + COMMITTED — `b97b7c5`** on `feat/consolidation`, on top of
  the CP-M merge `a2045a7` (9 files, +2130/−6; nothing from `scratchpad/`, roadmap left unstaged).
  **Suite 608/0 on a fresh DB = 471 pre-CP-I UNMODIFIED + 137 new.** Migration **020**
  (`conversations.last_read_at` + `starred` + 2 indexes) applies **3× clean**. I1–I23 all PASS
  except I18 (browser evidence = orchestrator's). Next unused migration is **021**.
  **DEVIATION, stated up front:** the endpoints live in a NEW `server/routes/inbox.js`, not in
  `conversations.js` as the ticket listed — CP-M had just hand-resolved that file (main's composer +
  the CP1 mode gate + the B2 hook all in one success path) and adding a second feature there would
  park the next reconciliation on the worst merge surface in the repo. `conversations.js` is
  unchanged and the new router reuses the same libraries, so they cannot drift.
  Both of the orchestrator's HIGHs honoured: the thread is a **UNION** of `messages` +
  `contact_activity` `<channel>_sent` rows — proven with a **REAL** `ackJob(sent)` driven through the
  ack route and asserted to write **no** `messages` row — and unread is **inbound-only** with the read
  stamp set to the newest message **actually returned**.
  **CRITIC (Fable 5, 2 lenses) found FOUR HIGHs, all fixed with 19 regression checks:** (1) the thread
  returned the **OLDEST n**, so any thread longer than the limit hid its newest inbound *and* froze
  `read_through` below it — deterministic, no race; (2) `POST /read` fell **OPEN** on a message-less
  contact, letting any caller stamp `last_read_at` into the future so every later inbound was born
  read; (3) the keyset cursor was the timestamp alone, skipping contacts tied at a page boundary and
  stranding message-less ones from page 2; (4) a per-deal **stage chip could advance a DIFFERENT
  deal**, because `/advance` picks the newest itself — chips are now inert unless `/advance` would
  act on that exact deal. Also fixed: the **AI-assisted badge was unreachable** (the UI hardcoded
  `ai_generated:false` even for Draft-with-AI sends); the read watermark **lost microseconds**
  (JSON/JS `Date` are ms, Postgres is µs, so the stamp landed just BEHIND the message it covered —
  the thread now hands out `read_through_exact`); `message_sent` is excluded from the union **by
  name** rather than by an accident of how `addActivity` nests its payload.
  **Also closed CP-M follow-up F11:** `AUTOMATION_ENV_FILE=/nonexistent` does **not** isolate the
  runner (it still finds `~/automation-engines-shared/.env.shared`), so `RESEND_API_KEY` was live
  during tests — the runners now blank `RESEND_API_KEY` and `CLOUDFLARE_AI_TOKEN`. Without this,
  CP-I's reply tests would have attempted **real outbound email**.
  Seed `scratchpad/seed-CP-I-inbox.mjs` (8 fixtures incl. a real CP2 ack + an XSS probe). Builder-side
  browser smoke on my own shim: lands on Your turn, unread clears on open, the Sequence badge renders,
  the XSS name renders as text, **zero console errors** — the 12-step script remains the orchestrator's.
  Documented, not fixed: a backdated/late-committing inbound can be born read (needs a monotonic
  sequence, not a timestamp — F15); an executor overriding `activity.type` could fall out of the union
  (F16); foreign `deal_id` returns 400 not 404 (no existence oracle).
  Five gotchas that will otherwise read as bugs are in the receipt's TEST BRIEF — the load-bearing one
  is **post `read_through_exact`, not `read_through`**, or unread will not clear.
  `:3101` released; `:3102`/`:8899` never touched; `denchclaw_test` untouched (used
  `denchclaw_build_cpi`). Receipt: `.loop/receipts/CP-I-unified-inbox.md`.
- 2026-08-01 02:20 [orch] **CP-M VERIFIED → PASS (pending M8).** Verdict:
  `.loop/verdicts/CP-M-merge-main.md`. Done independently on my own rebuilt DB, treating the
  receipt as unverified claims. **M1** no conflict markers; **M2** 471/0; **M3** contract 66→68 so
  main's cases survived (the union, not just our side); **M4** 19/19 migrations re-apply clean;
  **M5a/b/c** inbound fails closed 503, wrong secret 401, and — the merge's biggest hidden risk —
  **GT-2 closed behaviourally**: an inbound delivery lands on the recipient's tenant under the
  branch's A3 auth, not 401/403/re-tenanted; **M6** all consolidation suites green; **M7** browser,
  both worlds in one session, 8 tabs, 0 console errors; **M9 GT-1 closed behaviourally** —
  `192.168.1.99` rejected under a /32, and `127.0.0.2` rejected under the DEFAULT config (the
  critic's LOW-6 case), so the prefix-hack downgrade did not happen; **M10** all five mounts;
  **M11** `getByIdUnscoped` still 0; **M12** zero duplicate ids in the LIVE DOM; **M13** CP1's
  authority AND main's audit both fire, and scoring proven alive (weighted event moved the score
  0→5, so main's `addContactActivity → recordEngagement` fix survived); **M14** all 7 main-only
  files present and all 10 main commits are ancestors. **Both first-pass anomalies were mine
  again**: the `channel-jobs` 404 was my probe hitting a mount root the router never defines (the
  exact trap M10 warns about), and the flat `lead_score_numeric` is correct because `scoring.js:11`
  excludes `stage_change` from the weight table. **M8 (mandated critic on the merge diff, auth.js
  first, call-paths-not-definitions) is IN FLIGHT — I am holding the push to main until it clears.**
  Deploy remains a shut gate regardless.
- 2026-08-01 03:05 [orch] **CP-I BUILT (b97b7c5) AND THE FULL CHAIN NOW PASSES END TO END:
  GOLDEN JOURNEY 12 passed / 0 failed / 0 skipped.** This is the first time the product has been
  proven working as a whole rather than checkpoint by checkpoint. Parallel mode paid off inside a
  single tick — the builder shipped CP-I while I verified CP-M. What the run proves, live on the
  merged+CP-I tree: human `/advance` → enrollment → step materialises → executor claims → ack(sent)
  advances the ladder and mirrors the stage → **a manual stage is still refused while the send
  counts** → **the CP2 sequence send IS VISIBLE in the unified thread** (`source:"sequence"`,
  `automated:true`) → a non-delivering channel is logged but marked NOT delivered (D5) → an email
  reply either delivers or maps the provider failure honestly to 502, never a silent success →
  the reply lands on the contact activity feed → **a globally suppressed contact is refused by the
  SERVER with 403 and the thread says why** (`suppressed_globally:true` + reason).
  **The critic's HIGH-1 is resolved in the shipped code**: the thread is a union that surfaces
  CP2 sends, which is exactly the hole that would have made this feature blind to the messages it
  exists to show.
  **Two false failures along the way, both mine, both traced before being reported:** (1) L7/L8
  first failed because my driver asserted invented field names (`badge`, `scheduled_action_id`)
  instead of the real contract (`source`, `automated`, `delivered`, `delivery_note`) — the code
  was right; (2) a second evidence run showed L3–L6 failing because **the golden journey is not
  idempotent** — the first run consumes the queued jobs, so a re-run on dirty state has nothing to
  claim. Fixed by reset+reseed before each run and a NOTE in the header. Evidence:
  `.loop/EVIDENCE/CP-I/golden-journey-full-chain.log`.
- 2026-08-01 03:10 [orch] **M8 CLEARED → CP-M VERDICT IS FINAL: PASS on all of M1–M14.**
  Critic: **FABLE 5 → PASS, no HIGH**, lens = dropped security check / lost feature, auth.js first,
  **call paths not definitions**. It walked every auth check to its call site and confirmed each
  still RUNS: missing-key 401 (:215), DB-backed key resolution (:226→:286, correctly ignoring
  X-Company-Id), ambiguous-binding 401 (:254), fail-closed-on-DB-error 401 (:258), unknown-key 401
  (:272), **main's real CIDR allowlist invoked at :277-280 ahead of BOTH next() sites with the
  branch's prefix hack confirmed absent**, DB canonicalization (:290), env key→company 403 (:292),
  `warnIfKeyUnboundInProduction` as a live load-time IIFE (:120), requireAdmin (:313), union
  exports (:327). It further proved `test/contract.mjs` and `web/index.html` are **empirically
  exact line-unions** — zero parent-added lines missing, check-name union 74 = 72 branch ∪ 54 main
  — and that nothing main shipped is dead code.
  **🚧 DEPLOY-BLOCKING HAZARD found by M8 and re-verified by me:** deploying this merge to staging
  before applying migrations 012–019 **401s the entire API**. `auth.js:258-271` deliberately fails
  CLOSED when the `tenant_api_keys` collision check cannot run; that table is created by
  **migration 017**; `initDatabase` runs no migrations; staging is at **≤011**. Mandatory runbook
  order: **DDL 012–019 FIRST, restart SECOND.** Recorded in the verdict. Deploy remains a shut gate.
  Two smaller notes recorded not fixed: `webhooks.js:17` self-calls with the literal
  INTERNAL_API_KEY (configure INTERNAL_API_KEYS without it and inbound email 401s); and
  `trust proxy` + `ipAllowed('')===true` lets a proxy-injected XFF satisfy the allowlist —
  **pre-existing identically in base, main AND branch**, so out of merge scope but deserves a ticket.
  **PUSH TO MAIN: STILL HELD, deliberately.** The pre-authorisation was for the verified CP-M
  result and CP-M is verified — but the branch has since advanced to `b97b7c5` (CP-I), which is
  NOT yet verified. Pushing now would ship unverified work to main under an authorisation granted
  for something else. Operator's call: wait for the CP-I verdict, or push `a2045a7` alone.
  **Worth recording about the two-pass policy:** the critic's own NOT-PROVEN list says its
  verification was **static only** (servers were barred), while mine was **behavioural** (471/0
  suite, live CIDR probes, live webhook probes, live scoring delta). Neither pass alone covered
  this merge; together they did.
- 2026-08-01 03:15 [orch] **CP-I VERIFIED → PASS.** `.loop/verdicts/CP-I-unified-inbox.md`.
  Golden journey **12/0/0** on a fresh seed (was 7/0/4-skipped pre-CP-I); suite **608/0** (was
  471; unit-cpi adds 137, nothing pre-existing regressed); my own browser pass **11/0** with **0
  console errors**. The critic's HIGH-1 is resolved in shipped code — the thread is a union and
  the CP2 sequence send appears with `source:"sequence"`/`automated:true`. D5 honesty holds: a
  WhatsApp reply is logged `delivered:false`, an email reply that Resend rejects returns **502 with
  the real reason** rather than a silent success. Suppression is refused by the **server** (403)
  and surfaced in the thread. On screen, visually confirmed: three panes with the **contact record**
  as the third, `Reply | Note | Templates` composer tabs, Draft-with-AI, channel picker, tags as
  chips, `◆ Scheduled Call` stage chip rendered **verbatim** and with **no remove control**, and a
  hostile `<img src=x onerror>` contact name rendering as literal text with no script execution.
  **I caught a FALSE PASS in my own driver**: S2 first passed while the thread pane still said
  "Nothing selected", because I asserted against whole-page text that matched the LIST. Rewritten
  to assert on `#ib-thread` and to click the app's real `.ib-row[data-ib=…]` selector; it then
  failed honestly and passed only once the thread actually opened. A green assertion pointed at the
  wrong element is worse than a red one, and it is exactly the failure mode this loop exists to
  catch. **Coverage stated honestly in the verdict:** I12c (unread race), I12f (draft injection),
  I21–I23 (stage-chip transition menu), I10/I12e (deal scoping) are suite-covered but not
  hand-driven by me — named as the thinnest part of the verdict and the first target next cycle.
- 2026-08-01 [orch] **CP-I GAP CLOSURE — 14 passed / 0 failed** (`scratchpad/orch-cpi-gaps.mjs`,
  evidence `.loop/EVIDENCE/CP-I/gap-closure-14.log`). The previous verdict named four areas as
  suite-covered but not hand-driven; rather than leave that as prose I drove all four this cycle.
  **I12c the unread race**: constructed by hand — fetch thread, let an inbound land AFTER the
  fetch, stamp read with the token the fetch handed out → **the contact stays unread**. Better
  than the ticket specified: the route REQUIRES `through` and 400s rather than defaulting to
  `now()` (the exact stamp HIGH-2 forbade), and a future-dated stamp is clamped, not accepted.
  **I12f prompt injection**: a hostile inbound body ordering the model to mark the deal won,
  advance the stage and delete all suppressions produced `sent:false`, `messages_created:0`,
  **stage unmoved**, suppressions intact — the draft is inert text. **I21–I23 the stage chip is
  not a bypass**: illegal target 409; a human choosing the MANUAL stage 200; the SAME transition
  attempted programmatically **403 "Stage 'no_show_followup_1' is manual — only a human may set
  it"**. CP1's invariant survives the new clickable-chip surface, which was the entire risk of
  rendering stages as tags. **I10/I12e deal scoping**: two open deals both exposed (selector, not
  a guess); a foreign `deal_id` rejected 400 "deal_id is not an open deal belonging to this
  contact"; a nonexistent one rejected; a valid note lands with `data.deal_id` and sends nothing.
  Verdict updated. Still un-driven by me and stated honestly: I6 filter composition, I12d closed
  conversations in-thread, I12i Templates token resolution.
- 2026-08-01 [orch] **CP-I VERIFICATION IS NOW COMPLETE — final gaps 12 passed / 0 failed**
  (`scratchpad/orch-cpi-gaps2.mjs`, evidence `.loop/EVIDENCE/CP-I/gap-closure-final-12.log`).
  The three criteria still resting on the suite are now hand-driven, so **no part of this verdict
  rests on the builder's receipt**. **I6** filters genuinely compose — `unread ∧ linkedin` drops
  the email-only contact, adding `q="zephyr"` keeps the match, and the same query with a
  non-matching `q` returns ZERO (search is applied, not ignored); unknown filter/channel both 400.
  **I12d** the partial-unique-index case proven: closed one email conversation, opened a SECOND on
  the same channel (only possible because `uq_conversations_contact_channel` is
  `WHERE status <> 'closed'`), and the thread carries BOTH messages while the contact still
  appears ONCE in the list. **I12i** 11 templates returned with no raw
  `{first_name}`/`{company}`/`{stage}` tokens surviving, cross-tenant 404. Verdict updated to drop
  the caveat section entirely. Running totals across the whole build: golden journey 12/0/0, suite
  608/0, CP-I browser 11/0, CP-M browser 9/0, gap closures 14/0 and 12/0 — all with 0 console
  errors. **Loop remains blocked on the operator: push-to-main (held; this tick forbids it),
  deploy (shut gate + the DDL-first hazard), and `claude login` for the watchdog.**
- 2026-08-01 [orch] **CP4a SPECED under standing authorisation** (`CP-M_DECISION.md:46-48` — "the
  orchestrator rewrites the CP4a ticket accordingly after CP-M lands"; CP-M landed and passed).
  Ticket: `.loop/tickets/CP4a-email-executor.md` rev 1, 12 criteria, 6-step browser script.
  **The spec is built on a gap I found and verified this tick, and it is the largest remaining
  hole in the product: THE CRM QUEUES WORK AND NOTHING SENDS IT.** Evidence, all mine:
  `git grep -nE "setInterval|cron|pollJobs"` over `server/` returns **nothing** — there is no
  internal executor and no polling loop; `sendEmail` is called from exactly two **human-facing**
  sites (`conversations.js:224`, `inbox.js:334`) and from **no** `scheduled_actions` path; and the
  scratch DB currently holds **42 rows `pending` with `scheduled_for <= now()`** that nobody will
  ever send. Every green automation result this loop has produced had **me** hand-claiming and
  hand-acking in the golden journey — in production a sequence enrols a contact, materialises step
  1, and then silently does nothing forever. CP4a wraps main's Resend sender in the **existing**
  B4 claim/ack contract: D1 the executor is a real HTTP client of the public routes with its own
  `claimed_by`, never an in-process shortcut, so the CRM dogfoods its own contract; D2 opt-in and
  **off by default** (`INTERNAL_EMAIL_EXECUTOR=1` **and** `isConfigured()`) so nobody gets
  autonomous sending by upgrading; **D3 a staleness guard**, which is the decision that would
  otherwise burn a real tenant — switching an executor on against that 42-row backlog would fire
  hours-old messages at real people for a webinar that may be over, so anything older than
  `EXECUTOR_MAX_STALENESS_MINUTES` (default 120) is acked `skipped` with a reason rather than
  sent; D4 provider failures ack `failed` with the real reason and leave retry policy in B3 where
  the contract puts it; D5 idempotency, since **a duplicate send to a real prospect is the worst
  outcome in this ticket** — worse than a late one; D6 no-address acks `skipped` not `failed`;
  D7 two CRM processes must be provably safe; D8 email only, and `dispatch.js` /
  `channel-jobs.js` / `email-resend.js` / the inbox routes are explicitly not to be touched.
  Critic pass 1 launched (**FABLE 5**, lens = double sends / lost sends / anything that would email
  a real human wrongly), briefed to attack whether D5's "record the attempt before the send" is
  even implementable against the current schema, what happens when a claim expires **mid-send**
  under Resend latency, whether the first instance's ack then fails ownership while the mail has
  already gone, and whether acking a stale job `skipped` silently skips a ladder rung the operator
  wanted. **NOT dispatched** — loop is at handoff=operator and the builder should not start a new
  checkpoint while three operator decisions are outstanding.
- 2026-08-01 [orch] **CP4a CRITIC → FAIL. 6 HIGH + 3 MEDIUM + 3 LOW. REV 1 WITHDRAWN, NOT
  DISPATCHED.** This is the most consequential critic pass of the session and it prevented the
  loop shipping something that would have emailed real prospects wrongly. **I reproduced the three
  worst myself before accepting them.**
  **HIGH-4 invalidates the ticket's premise: THERE IS NOTHING TO SEND.** `scheduleAction`
  materialises `payload` as literally `'{}'::jsonb` (`sequences.js:307`); `sequence_steps` carries
  only `template_ref TEXT` (`014_sequences.sql:52`) — **no subject and no body exist anywhere in
  the schema**; `sendEmail` defaults subject to `'(no subject)'` and text to `''`
  (`email-resend.js:23-24`). An executor built to rev 1 would deliver blank emails to real people,
  and **E2/E3 would have gone GREEN doing it** because they assert status flips and never assert
  content. **CP4a is therefore blocked on a prerequisite the roadmap never scoped: a
  message-content store (CP4a-0, migration 021).** An email executor without message bodies is not
  a partial feature, it is a hazard.
  **HIGH-6, also reproduced: enabling the executor with a Resend key but NO connected sender would
  permanently kill every active enrollment within minutes** — `sendEmail` throws `'no connected
  sender (from)'`, D4 acks `failed`, 3 attempts dead-letter, and `failed_dead` sets
  `enrollments.status='exited', exit_reason='failed'`, which is TERMINAL (`dispatch.js:599-612`).
  Also folded: HIGH-1 no fetch timeout in `email-resend.js:38-42` turns "outcome unknown" into up
  to **3 duplicate physical sends** via `attempt+1` requeue; HIGH-2 D5's "record the attempt before
  the send" is **unimplementable** — no column exists and expiry-reclaim never bumps `attempt`, so
  no marker can tell "crashed before send" from "sent, ack lost"; HIGH-3 the staleness guard
  measures from `scheduled_for`, which A5 never refreshes while deferring, so a step scheduled
  22:00 under quiet-hours-until-08:00 would be **skipped every night by design**; HIGH-5 the
  constant `claimed_by` I proposed neutralises ack ownership across an expiry-reclaim, giving two
  physical emails and two clean 200s; MEDIUM-2 a `skipped` ack **advances** the ladder, so the
  staleness guard does not stop the burst — it fires "step 2" at people who never got step 1.
  **LOW-2 corrected my own reporting:** I said "42 due-and-pending"; verified, only **32 are
  email**, 10 are SMS the email executor can never claim. One concern of mine was **refuted** and
  recorded as such: the same-process HTTP claim does not deadlock against the advisory lock.
- 2026-08-01 [orch] **GOAL-CONFORMANCE AUDIT** → `.loop/GOAL_CONFORMANCE_AUDIT.md`, run against the
  operator's full pipeline spec. **The SPINE conforms exactly**: 3 webinar pipelines, 24 stages,
  every manual/automated mode matching the spec line for line, No-Show ladder 0/+3d/+6d/+9d/+16d
  proven by measured `scheduled_for` deltas, deal follow-ups manual with no timers, and the
  manual/automated distinction enforced rather than decorative (403 "only a human may set it" to a
  programmatic advance, holding through both CP2's scheduler and CP-I's stage chips).
  **The LIMBS are not built, and I named the biggest gap honestly: the automated MARKETING stages
  are inert** — `visits`, `registrants`, `auto_registrants`, `attendees`, `invitees` appear in
  **ZERO server files**, so the entire marketing funnel above `prospects` is a diagram, not a
  mechanism. Also unbuilt: nothing sends on any channel; no message content exists in the schema;
  no non-email providers (Unipile/Twilio/ai_call) wired though all five channels are declared
  valid; 0 pipeline configs carry automations; every sequence in the DB is a test fixture.
  Ordered path recorded: content store → email executor → per-channel executors → marketing-stage
  ingestion.
- 2026-08-01 [orch] **12-HOUR RUN ARMED.** Builder dispatched with the full audit + all 6 CP4a
  HIGHs on CP4a-0 (content store, migration 021), then CP4a rev 2, then ingestion. Watchdog
  cadence raised 5 min → **3 min** and reloaded. **Root cause of it having sat idle: it was
  correctly declining to act because `handoff=operator`** ("a human decision is owed, not a
  relaunch") — 57 ticks of standing down. STATE flipped to `handoff=build` so it will now relaunch
  the builder on a stall. Durable cron `ac182011` (every 17 min) still registered. **Remaining
  blocker on TRUE autonomy is unchanged and is not something I can fix: the headless CLI is not
  authenticated.** The watchdog re-probes auth every tick and clears its own NEEDS_LOGIN marker,
  so the whole loop self-arms the instant `claude login` succeeds — no further action needed then.
- 2026-08-01 04:46 [orch] Tick: **handoff=build, builder is progressing on CP4a-0.**
  `migrations/021_message_content.sql` + `test/unit-cp4a0-content.mjs` exist; sequences model,
  sequences/inbox routes and server.js modified. Watchdog now on the 3-min cadence and correctly
  logging "active — no action" (it stood down 57 ticks earlier only because handoff was
  `operator`; flipping to `build` was what re-armed it). Reviewed 021 rather than rubber-stamping:
  the two-sources/one-precedence rule with resolution in a single place is the right shape,
  `body NOT NULL CHECK (length(btrim(body)) > 0)` closes the empty-body hazard at the schema level,
  and the tenancy reasoning is genuinely sharp — pipeline shape is structural and shareable, message
  copy is tenant-authored, so a global fallback would let one tenant's words go out under another's
  name.
  **Injected the one interaction 021 does not cover: LEGACY QUEUED JOBS.** 32 email jobs are already
  `pending` and due carrying `payload='{}'::jsonb`, materialised BEFORE this migration — so the
  first thing a CP4a executor meets in production is a queue with no resolvable content, and
  "send blank mail" would arrive through the back door of the very migration written to prevent it.
  Asked for: a defined "resolves to nothing" outcome from `resolveStepContent` (a checkable result,
  not an exception), the "content or explicitly none, no third state" rule made true for pre-021
  jobs as well, and a criterion proving a job with an unresolvable `template_ref` is identifiable as
  content-less WITHOUT calling the sender. Also told the builder **CP4a rev 2 takes migration 022,
  not 021** — the send-idempotency column belongs to the executor concern, and HIGH-2's real
  difficulty is that `dispatch.js:133-137` never bumps `attempt` on expiry-reclaim, so nothing can
  distinguish "crashed before send" from "sent, ack lost". Plus two design questions worth settling
  now: whether `message_templates.channel IS NULL` means "any channel", and whether a step/template
  channel mismatch should be a config-time 400 following CP2's stage_writeback-chain precedent.
- 2026-08-01 04:55 [orch] Tick: builder progressing on CP4a-0 (021 + `server/db/models/templates.js`
  + `test/unit-cp4a0-content.mjs`). **Audited the two PRE-EXISTING test files the builder modified**,
  because every ticket I have written requires existing tests stay unmodified and this is exactly
  where test-weakening would hide. **Verdict: both legitimate, nothing weakened** — assertion counts
  identical (`unit-b3-dispatcher.mjs` 31→31, `unit-cpi-inbox.mjs` 126→126), and the only deleted
  lines are the two replaced with stronger versions.
  **The b3 change is a real latent bug fix and I confirmed it live.** The old form pinned
  `quietHoursStart: 0` and computed `quietHoursEnd: (nowHour+1)%24`, so between 23:00 and 00:00 UTC
  end became 0 too, `start === end`, and migration 016's
  `chk_tenant_channel_limits_quiet_hours_distinct` (`016_limits_hardening.sql:38`) rejected the row —
  **crashing that suite for one hour every single day**. I checked the clock: it is 23:xx UTC right
  now and the collision reproduces, so the builder hit it rather than theorised it. The replacement
  `[nowHour, nowHour+1)` window can never collide and correctly relies on `isQuietHours` handling the
  midnight wrap. The cpi-inbox change is likewise correct and STRONGER than what it replaced: I12i's
  intent was "tokens resolve against the real contact", and post-CP4a-0 the copy legitimately lives in
  `message_templates`, so authoring a real template and asserting resolution through the actual
  content path is a better test than matching a ref string. Both accepted, recorded here so the
  builder need not defend them in its receipt, and the b3 one will be called out in the verdict as a
  flaky-test fix worth having. Re-raised the still-open item: the 32 legacy `pending` jobs carrying
  `payload='{}'::jsonb` from before 021 — that is the back door through which "send blank mail" could
  re-enter, and it is the first thing I will attack on verification.
- 2026-08-01 05:20 [build] **CP4a-0 BUILT + COMMITTED — `a29e18d`** on `feat/consolidation`, on top of
  CP-I `b97b7c5` (13 files, +944/−25). **The audit's blocking finding is closed: there is now something
  to send.** Migration **021** adds `message_templates` (tenant-scoped, `UNIQUE(company_id, ref)`,
  NOT NULL body) plus inline `sequence_steps.subject/body`; inline wins, and that precedence lives in
  exactly one place. Content is resolved against the contact and **frozen into
  `scheduled_actions.payload` at schedule time**, so the executor reads one row and never reaches
  around the claim/ack contract. **Suite 677/0** on a fresh DB (608 prior + 69 new); 021 applies **3×**
  clean; next unused migration is **022**.
  STATE note: the dispatch arrived by message while `STATE.json` still read `handoff:"operator"` — I
  proceeded on the explicit dispatch (its `next_ticket` named CP4a-0) and corrected the field.
  **The Fable-5 critic was right about the thing that mattered — the first cut established the contract
  everywhere EXCEPT where it was enforced.** Three HIGHs fixed: (1) every pre-021 row had **no
  `content_resolved` key at all** — a third state where an executor checking `=== false` sees
  `undefined` and **sends**, while the readiness index sees nothing wrong; `ON CONFLICT DO NOTHING`
  meant those rows would never be upgraded, so 021 now **backfills** them. (2) `claimJobs` **served
  blank jobs** — refusal lived only in comments and in an executor nobody had written; **the claim door
  now refuses**, with `COALESCE(..., false)` so "absent" reads as unsafe, and unresolved jobs are left
  **PENDING not skipped** (a skipped ack ADVANCES the ladder — mass-skipping missing copy would fire
  "step 2" at people who never received step 1). (3) `content_resolved:true` could still carry a literal
  `Hi {first_name},` or a missing/whitespace email subject — warnings nothing was required to read, i.e.
  a send with extra steps; both now **block** and say why.
  **Pre-existing tests modified, declared:** `unit-b3`'s quiet-hours fixture was a **latent time bomb
  unrelated to this work** — `start:0` with `end:(nowHour+1)%24` are equal between **23:00 and 00:00
  UTC**, tripping migration 016's `chk_..._quiet_hours_distinct` and crashing the suite **for one hour
  every day since B3 landed**. It went off during this session; the window is now `[nowHour, nowHour+1)`.
  And `unit-b3`/`unit-cp2`/`unit-cpi` fixtures now supply content (one helper each) because a step with
  nothing to send is deliberately no longer claimable — no assertion was weakened.
  Also closes CP-I **F17** (inbox Templates reads real content) and CP-M **F11** (runners blank
  `RESEND_API_KEY`/`CLOUDFLARE_AI_TOKEN`, so no test can make a real provider call).
  **Verify by asserting CONTENT, not status** — that was CP4a rev 1's exact failure mode.
  Receipt: `.loop/receipts/CP4a-0-content-store.md`. Next: **CP4a rev 2**, built to the five surviving
  HIGHs; CP4a-0 already softens HIGH-6, since a job with no resolvable content is never handed out and
  so cannot burn retries into terminal `exited`.
- 2026-08-01 05:55 [build] **CP4a-0 ADDENDUM — `4e47245`.** Answers both orchestrator follow-ups; suite
  **690** (608 prior + **82** CP4a-0). **Legacy queue:** all three asks were already shipped in
  `a29e18d`; what was missing was the criterion, now **C15**. Proven two ways — out-of-band in the
  real-world order (schema 002–020, create a `pending`+DUE job with `payload='{}'`, hold 021 back,
  then apply it) and in-suite. Before 021 the row has **no `content_resolved` key** (the third state);
  after 021 it is `content_resolved=false`/`body=null` with a reason; a DUE legacy job is handed to an
  executor **zero** times; it stays **`pending`** not `skipped`; and readiness names it **without
  touching a sender**. Two independent guards: the backfill AND the claim door's `COALESCE(..., false)`,
  which treats "absent" as unsafe even if the backfill were skipped.
  **Decisions settled:** `message_templates.channel` NULL = **any channel** (stated in migration + model,
  proven by C16 using one NULL-channel template on both email and WhatsApp); a step whose channel
  disagrees with its template's pin is a **config-time 400** per CP2's `stage_writeback` precedent —
  with two deliberate boundaries: a ref that does not resolve **yet** is not an error (readiness reports
  it), and resolution does not re-check the pin, because by then the job is queued and refusing would
  strand a contact mid-ladder. **Migration 022 left clear** for CP4a rev 2's send-attempt marker.
- 2026-08-01 05:1x [orch] **CP4a-0 VERIFIED → PASS.** `.loop/verdicts/CP4a-0-content-store.md`.
  My own rebuilt DB: **690 passed / 0 failed — HIGHER than the receipt's 677**, because the builder
  kept hardening after writing it (unit-cp4a0 is 82, not 69). Migration 021 applies a 2nd and 3rd
  time clean. **The claim door genuinely enforces**: a job with the pre-021 shape (no
  `content_resolved` key at all) is NOT served and is left **PENDING, not skipped** — correct, and
  for CP2's reason, since a skipped ack advances the ladder and mass-skipping missing copy would
  fire "step 2" at people who never got step 1. Explicit `false` also refused. **Positive control
  passes** — a content-carrying job IS claimable and the served payload carries the real
  subject+body, so an executor reads one row and never reaches around the contract. Whole-queue
  sweep: across 63 content-less due rows, **zero** served. Token blocking confirmed through the
  REAL `resolveStepContent` path (unsatisfiable token → resolved:false with a precise reason;
  satisfiable → "Hi Ada at Acme."; whitespace-only email subject → blocked; chat channel with no
  subject → correctly allowed).
  **All three first-pass anomalies were MINE again**, each traced before being reported: (1) I
  picked a row whose enrollment was `completed`, sequence `paused`, and which wasn't the current
  step — unclaimable for three CP2 reasons unrelated to content; (2) my ELIGIBLE query **never
  filtered company_id**, so I picked another tenant's job and claimed as tantra — that returning
  nothing is tenancy working correctly; (3) I hand-forged `content_resolved:true` WITH tokens via
  raw SQL, a state no code path can produce. One genuine follow-up recorded, **F-CP4a0-1**: the
  claim door trusts `content_resolved` without re-validating tokens — unreachable today, but a
  cheap belt-and-braces when CP4a rev 2 touches that query. **CP4a rev 2 is unblocked; next
  migration is 022.**
- 2026-08-01 05:2x [orch] Tick: builder progressing fast on **CP4a rev 2** — migration 022
  (`send_attempt`), `server/lib/email-executor.js`, `test/unit-cp4a-executor.mjs`, plus a committed
  CP4a-0 addendum (`4e47245`) answering my legacy-queue and channel-decision injections.
  **Suite 742/0 on my own rebuilt DB**, `unit-cp4a-exec` already 52/52, and — the check that
  mattered — **no regression from touching the SHARED sender**: `unit-cpi` still 137/137, contract
  still 68/68.
  **Reviewed the two off-limits files the builder touched and ACCEPTED both as justified.**
  `email-resend.js`: the timeout + typed `definitive`/`outcomeUnknown` split IS HIGH-1's fix and
  cannot live anywhere else; treating a **5xx as `outcomeUnknown` rather than definitive** is the
  subtle call and it is right, since an upstream error after acceptance is indistinguishable from
  one before it; `RESEND_API_BASE` closes the critic's MEDIUM-3 (the browser script was literally
  unrunnable without emailing real people) while defaulting to the real API. `dispatch.js`: the
  builder folded in **F-CP4a0-1 one tick after I filed it**, plus `send_started_at IS NULL` and the
  reclaim `attempt` bump.
  **Injected two forward risks I found by inspection, both specific:** (1) **the reclaim-driven
  `attempt` bump can reach MAX_ATTEMPTS through pure claim churn and dead-letter a job, terminally
  exiting the enrollment** — HIGH-6's catastrophe by a new route: `computeRetryInfo` (`:26`) does
  `willRetry = attempt < 3`, `will_retry:false` → `failed_dead` (`:397`) → `enrollments.status
  ='exited'` (`:635-638`), so two executor restarts could make the FIRST genuine failure fatal;
  "times we tried to SEND" and "times a claim EXPIRED" must not share a counter, and a job reclaimed
  twice then acked failed once must still retry. (2) **the claim-door token regex false-blocks
  legitimate copy** — it correctly allows `{"a":1}` and `{}`, but BLOCKS `We call this the {growth}
  framework.`; failing safe is right, but it must be a tested, conscious decision with an
  operator-facing reason that says "looks like an unresolved token — escape it if literal", because
  an operator who cannot work out why a good email will not send will switch the executor off.
- 2026-08-01 07:05 [build] **CP4a REV 2 BUILT + COMMITTED — `f47bce4`** (8 files, +1022/−11).
  **Suite 762/0** on a fresh DB (690 prior UNMODIFIED + 72 new). Migration **022** applies twice
  clean; next unused is **023**. Shape: **not a daemon** — one HTTP tick runs one batch, plus
  `/status`, `/quarantine`, `/quarantine/:id/release`.
  **The five HIGHs:** timeout + failure split by TYPE (`definitive` may consume a retry,
  `outcomeUnknown` never does); `send_started_at` + per-attempt token committed BEFORE the provider
  call, and the claim scan never re-serves a row that has one; **the staleness guard is GONE, not
  fixed** — "how long has this been sendable?" is not derivable from any column, so opt-in dead code
  would have been a lie (**F23**: needs a `became_claimable_at` column); per-process `INSTANCE_ID`;
  and the gate requires an **explicitly configured** sender with 401/403 as config errors and 429
  transient, so neither burns a retry into a terminal `exited`.
  **The critic then reproduced FIVE MORE against my first cut**, all fixed with regressions R1–R7:
  the dominant duplicate path was **not** the one I guarded (a slow tick stalls past
  `CLAIM_TIMEOUT_MS`, a second tick reclaims and sends, the first then sends again → `markSendStarted`
  is now a **compare-and-set**); **quarantine lasted five minutes** (pre-send quarantines have no
  `send_started_at`, so the scan reclaimed and sent them with no human release); a **sent** row kept
  appearing in the quarantine list so an operator would "resend" an already-delivered message;
  401/403/429 were "definitive" so a bad key dead-lettered into terminal `exited` in three ticks; and
  the gate accepted a **hardcoded default sender**. Crash-limbo rows are now surfaced; one bad job no
  longer aborts the batch.
  **Tried and deliberately reverted: bumping `attempt` on reclaim.** It makes "picked up twice"
  indistinguishable from "failed twice", so a merely-reclaimed row dead-letters early — and a
  dead-letter exits the enrollment terminally. It broke `unit-b3`/`unit-cp2` retry semantics, which
  was the tests telling me the truth. Churn is bounded by the in-flight and quarantine exclusions.
  **`RESEND_API_BASE`** makes the endpoint overridable (fixes the old MEDIUM-3: the browser script
  was unrunnable against a hardcoded `api.resend.com`). The suite starts a local stub and **records
  every request** — that is how "exactly once" is proven rather than asserted. No test can reach a
  real provider. **Deploy order:** `dispatch.js` now references `send_started_at` for all channels, so
  012–022 must be applied before any restart (fails closed, but a dispatcher outage until 022 lands).
  Receipt: `.loop/receipts/CP4a-email-executor.md`. **Next: the automated MARKETING stages are inert**
  (audit item 1) — the biggest remaining gap to the operator's spec.
- 2026-08-01 05:4x [orch] Tick: **CP4a rev 2 committed (`f47bce4`) with a receipt at 05:36 — but the
  builder kept working at 05:39 on the two risks I injected, so the receipt is STALE and I RETURNED
  THE TURN (handoff=build) rather than verify a moving target.** In flight and better than I asked
  for: Risk 2 now splits KNOWN tokens (blocking) from brace-shaped prose (non-blocking), so
  `{growth}` sends while `{first_name}` still blocks, with an actionable reason offering
  `{{escape}}` and a `warnings` array that catches typos like `{frist_name}` at authoring time —
  a mistyped merge field is exactly what ships silently otherwise. Risk 1 has criterion **R8**:
  "reclaimed twice then failed once ⇒ still retries, does NOT dead-letter" + "the enrollment is NOT
  terminally exited", closing the HIGH-6 catastrophe at the second door.
  **A FALSE ALARM THAT WAS ENTIRELY MY OWN TOOLING, recorded so it is never re-diagnosed as code:**
  my suite returned **225 passed / 88 failed** and briefly looked like CP4a had broken half the
  build. `scratchpad/run-suite.sh` **hardcoded `TEST_PORT=3101` — the BUILDER's port.** The
  builder's server held it, mine could not bind, my tests silently fell through to THEIR server with
  MY `ct-key-$$`, and every keyed request 401'd (`failed to provision test tenant … Missing or
  invalid X-Internal-Key`), cascading into 88 phantom failures. The tell: DB-only suites needing no
  server passed clean (sequences 38/0, limits 34/0). **Fixed my harness** — it now defaults to
  **:3102** and, more importantly, **refuses to run against a server that is not ours**: after the
  health check it proves our own key is accepted and aborts with a clear message otherwise. A silent
  fall-through to the wrong server is precisely what makes a green suite meaningless, and it was in
  MY tooling, not the build's. **Clean re-run on my own port: 774 passed / 0 failed** (up from 742).
  One red is expected and in-flight: `unit-cp4a-exec` R9 `{{first_name}}` escape syntax.
- 2026-08-01 07:40 [build] **CP4a risk addendum — `30898e6`.** Suite **774/0**. **Risk 1** (reclaim churn
  dead-lettering a ladder) was already resolved before the message — the reclaim `attempt` bump broke
  `unit-b3`/`unit-cp2` retry semantics, which was the tests saying exactly what the orchestrator then
  described. Went further than asked: the two quantities **never share a counter** — `attempt` counts
  explicit `ack(failed)` only, and churn is bounded by the in-flight/quarantine exclusions. Criterion
  added as **R8** (reclaimed twice + one real failure ⇒ still retries; note `attempt` DEFAULTs to 1).
  **Risk 2** (guard false-blocking prose) fixed better than a reworded error: the guard matches only
  the **closed** token set, so `the {growth} framework` sends verbatim while `Hi {first_name},` for a
  nameless contact still blocks; brace-shaped non-tokens became an authoring-time advisory, which also
  catches the `{frist_name}` typo a pure block would have buried. Added a real escape —
  `{{first_name}}` → literal `{first_name}` — which needed care because a restored literal is
  byte-identical to a failed merge, so resolution **validates with sentinels and restores last** and
  records `content_literal_braces`. Three C10 assertions updated: they asserted the very false block
  we were removing. Receipt now carries the **exact 3-command stub invocation**.
- 2026-08-01 08:15 [build] **CP4a rev 2 FINISHED — handing back a tree that is no longer moving.**
  Three commits: `f47bce4` (executor), `30898e6` (the two forward risks), `a5f9e58` (test-harness
  guard). **Suite 774/0** on a fresh DB. **Receipt refreshed to match the tree** as requested.
  The `R9` red the orchestrator saw is green — it was the `{{escape}}` work in flight, and it needed
  more care than expected: once `{{first_name}}` is restored to a literal `{first_name}` it is
  byte-identical to a FAILED merge, so resolution validates with escapes still as sentinels and
  **restores last**, recording `content_literal_braces` so the send-time guards stay strict.
  **The port clash was the orchestrator's harness — but the COMMITTED `test/run-local.sh` had the
  identical hazard**, so it is fixed in the repo rather than only in their copy: after the health
  check the runner proves its own key is accepted and aborts naming the real cause. Verified both
  ways (fires against a foreign server answering `/health` 200 + 401 everything; passes against ours).
  Worth recording their diagnostic: **DB-only suites passing while every server-backed suite fails is
  the signature of a port clash**, not a broken feature — nothing in the harness said so, which is
  what made it cost a false alarm. `TEST_PORT` still defaults to 3101; stayed off :3102.
- 2026-08-01 06:0x [orch] **CP4a rev 2 VERIFIED → PASS.** `.loop/verdicts/CP4a-email-executor.md`.
  Suite **774/0** on my own rebuilt DB; migration 022 applies 2nd+3rd time clean. **THE criterion is
  proven: NO DOUBLE SEND across an expiry-reclaim** — stub provider on :8899 made to hang 9s with
  `CHANNEL_JOB_CLAIM_TIMEOUT_MS=2000` so the claim expired MID-SEND, then a second instance ticked:
  **exactly ONE physical send reached the provider**, `send_started_at` was stamped BEFORE the
  provider call, and the job settled `sent` with a provider id. **R8 also passes**: two forced
  expiry-reclaims left `attempt` at 1→1 and the enrollment `active`, so claim churn cannot burn
  delivery attempts into a dead-letter that terminally exits the ladder — the risk I injected two
  ticks ago. HIGH-6's boot gate proved itself by accident: my own probe misconfigured
  CHANNEL_SENDERS and the gate REFUSED to send, and it also refuses to fall back to crm.js's
  built-in default addresses. Entire verification ran against a local stub via RESEND_API_BASE —
  never a real provider. **All four first-pass anomalies were MINE again**: missing
  `initDatabase()`; wrong sender field (`address` vs `identity`); and most importantly **"two
  physical sends" was NOT a double send** — `tick()` claims a BATCH and the two went to DIFFERENT
  recipients, each once, which I only caught by making the stub record recipients. Follow-up
  **F-CP4a-1**: the claim door's token list is a hardcoded SQL literal duplicating `KNOWN_TOKENS`
  in `ai-draft.js:49` — they agree today and will drift the first time a token is added.
- 2026-08-01 06:05 [orch] **CP4a re-verified independently (second, parallel orchestrator pass) —
  agrees PASS, adds three findings.** Suite `SUITE_FAILED=0` on a dropped-and-recreated DB;
  migrations 002–022 clean on the 2nd AND 3rd apply; claim door empirically refuses contentless
  jobs. All on :3102, each run proving its own key first (A5). **NEW: F1** — `content_resolved` is
  frozen into the payload at materialisation and nothing re-resolves it, so a job queued before its
  copy exists is permanently unclaimable; authoring the copy does NOT un-stick it, contradicting the
  claim door's own comment. **F2** — readiness then reports `sendable:true` for that same sequence,
  telling the operator a silently-dead ladder is safe to switch on. **F3** — the standing golden
  journey is **8/4, not 12/0/0**, stale since CP4a-0 because its fixture never authors ladder copy;
  blocked on F1. Two anomalies were my own probes again (non-idempotent `migrate.sql`; a
  `| tail || exit` pipeline that would have hidden a failed migration). Verdict addendum + evidence
  written. **Builder is mid-CP-B** (untracked 023_marketing_ingestion.sql, stage-authority.js,
  reply-classify.js) — CP4a files verified identical to HEAD, so the findings hold, but the golden
  journey numbers came from a moving tree. Left handoff=build; did not clobber the parallel dispatch.
- 2026-08-01 06:0x [orch] Tick: builder early on **CP-B (marketing-stage ingestion)** — no migration
  023 or CP-B test yet, but it is doing something structurally important: **extracting the stage
  authority out of `crm.js` into `server/lib/stage-authority.js`** (`advanceContactStage`, created
  06:00) so ingestion can REUSE the authority rather than duplicate its rules in an ingest route.
  That is the right architecture and precisely what I asked for. `scoring.js` also gains
  `webinar_attended: 25` and `content_comment: 8`, which map cleanly onto the operator's Attendees
  and content-comment auto-registrant path.
  **Injected three things while the refactor is still open**, because this is the most
  safety-critical code in the build: (1) it must be a **behaviour-preserving** extraction —
  **112 test references** depend on that authority behaving identically (`unit-cp1` 57, `unit-cp2`
  20, `unit-b2` 20, `unit-cpi` 15) and every one must pass UNMODIFIED; if a test needs editing to
  accommodate the refactor that is the signal behaviour CHANGED, and the builder must stop and
  surface it rather than fix the test. (2) **Do not leave two copies of the invariant** — "only a
  human may set it" now exists at `stage-authority.js:85` AND `crm.js:819` AND `crm.js:940`, which
  is the identical drift hazard I filed as F-CP4a-1 one tick ago, except this time on the invariant
  that outranks everything: two copies will disagree eventually and the failure mode is the CRM
  silently auto-advancing a manual stage. Either route the deal and initial-stage paths through
  `advanceContactStage` too, or justify in the receipt how they stay in sync. (3) Re-run the golden
  journey and hold it at **12/0/0** — it is the only test that would catch the authority drifting
  underneath CP2's scheduler.
- 2026-08-01 06:15 [build] **CP-B: STOPPED WITHOUT WRITING — possible concurrent writer.** Dispatched
  on CP-B, but found it already ~1500 lines in flight and uncommitted: `migrations/023_marketing_
  ingestion.sql`, `server/lib/marketing-events.js` (607 lines), `server/routes/marketing.js`,
  `marketing-public.js`, `reply-classify.js`, `stage-authority.js`, plus uncommitted edits to
  `crm.js`/`webhooks.js`/`scoring.js`/`server.js`, and a CP-B ticket whose header says "self-authored
  by the build session". **Those files were last written at 06:07 and I looked at 06:08.** I could not
  distinguish a live second writer from my own prior tick cut off before committing, and two sessions
  writing 600-line files at once costs more than a paused turn — so I wrote nothing. Byte-stable since.
  **Verified read-only:** tree is GREEN (**774/0**, no regression), migration 023 applies in the
  002–023 chain, every new file parses, routes mounted and sane (`/marketing/invites` → 400 validation,
  `/webhooks/marketing/registration` → 503 fail-closed). **Gap:** no tests exist and nothing is
  committed. **Question for the orchestrator: was a second builder dispatched on CP-B?**
  **Engine survey done and it changes the design:** the reusable code is not in either engine but in a
  third shared package, `pro-workflows/automation_core` (`automation-engines-shared` is env-only).
  Registrants has a working reference to port; attendees has an idempotent bulk-import shape but **no
  webinar-platform connector exists anywhere**; auto-registrants is one-third present (calendar RSVP
  reading, LinkedIn comment ingestion and positive-intent classification all absent); and **visits has
  nothing to borrow at all** — no tracked link, redirect, pixel or visit table in any of the three
  repos, and UTM decoration is campaign+step level so it cannot identify which invitee clicked.
- 2026-08-01 06:35 [build] **Collision resolved — it is my own tick, not a second builder** (the
  orchestrator confirmed it is watching my `stage-authority.js` extraction). Resumed CP-B.
  **Banked `20b14e7`, deliberately separate from the in-flight ingestion:**
  (1) **One copy of the manual-stage invariant.** It existed in FOUR places — the extracted contact
  authority plus three deal paths in `crm.js`. The deal paths cannot call `advanceContactStage`
  (they move `deals.stage`), but they can share the RULE: `manualStageRefusal()` now owns the
  decision and the 403 body and all four call it. **Behaviour-preserving, proven: 774 green with NO
  test edited**, including all 112 references that depend on this authority.
  (2) **F1+F2 from the parallel orchestrator pass.** A job queued BEFORE its copy existed stayed
  unclaimable forever — authoring the template returned 201 and changed nothing. My own C13 only
  passed because it re-scheduled (which re-resolves); authoring alone never did. The claim door now
  retries resolution for due-but-unresolved rows and rewrites in place; a job with still no copy is
  left untouched, so it is a repair path and **not a bypass**. Readiness now counts queued unresolved
  jobs, so `sendable` can no longer say "safe to switch on" about a ladder that can never send.
  Load-bearing for CP-B: borrowed automations **will** queue jobs before their copy exists.
  **Suite 783/0.** Still uncommitted and untested: the CP-B ingestion itself (~1500 lines, coherent
  and mounted). Next: `test/unit-cpb-marketing.mjs`, critic, commit, receipt.
- 2026-08-01 06:2x [orch] **SESSION CONSOLIDATION on operator instruction — DenchClaw is now
  exactly TWO sessions: this orchestrator/tester and the build session (local_773502b8).**
  Enumerated everything first rather than killing blind. **Found a real hazard: a THIRD session,
  "DenchClaw CRM automation workflows" (local_0ffc35be), was RUNNING concurrently in the same repo
  on the same branch** while the builder was mid-refactor of `server/lib/stage-authority.js` — the
  file carrying the manual-stage invariant that 112 tests depend on. Two live writers on one
  working tree.
  Handled it safely rather than fast: sent it an explicit STAND-DOWN first (stop editing; do NOT
  commit/revert/stash/checkout — destroying work is worse than duplicating it; kill only your own
  servers; leave scratch PG :54339 up because it is shared; and if you believe YOU own CP-B say so
  INSTEAD of stopping, because retiring the wrong session costs more than the duplication).
  Confirmed ownership from evidence before retiring it: commit `20b14e7` responds directly to MY
  injection to local_773502b8, so the build session demonstrably owns the work. Waited until the
  tree was clean and CP-B was committed, then archived it. **Archived 5 sessions total**
  (the duplicate + its dead twin, the superseded orchestrator, the superseded handoff session, and
  two unrelated one-offs). **Deliberately did NOT touch** the content-engine and outreach-engine
  sessions, two of which are RUNNING — different missions, not mine to kill.
  **CP-B LANDED WHILE THIS WAS HAPPENING: `a897ad4` — 2,084 lines** (migration 023,
  `marketing-events.js` 607, `reply-classify.js` 122, `marketing-public.js` 309, `marketing.js` 288,
  webhooks +46, `unit-cpb-marketing.mjs` 518). **All five previously-inert stages — visits,
  registrants, auto_registrants, attendees, invitees — are now referenced in server code**, having
  appeared in ZERO server files for six weeks. That is the biggest goal gap closed in code; it
  still needs my independent verification. Also `20b14e7` consolidated the duplicated manual-stage
  gate to ONE copy, closing the drift hazard I injected mid-refactor.
  Injected a full consolidation prompt into the build session: it is now the only builder, with the
  operator's goals quoted verbatim, the autonomy rules (never park on operator; decide by default
  and record in DECISIONS_PENDING.md), port ownership, and the order I will attack CP-B in.
- 2026-08-01 06:55 [build] **CP-B DONE — receipt written, handing off.** `a897ad4` (ingestion) +
  `20b14e7` (one manual-stage gate + the F1/F2 fixes it depends on). **Suite 848/0**, `unit-cpb`
  **65/0**, everything prior unmodified. Migration 023; next 024.
  **Harness trap worth recording:** the public marketing webhooks fail closed AND derive the tenant
  **from the secret**, so a runner without `MARKETING_WEBHOOK_SECRET`/`_SECRETS` turns every CP-B
  webhook test into a 503 cascade. I saw **46/19** and nearly reported a green checkpoint as red;
  `test/run-local.sh` is correct (it also pins `RUN=$$` so the server knows the tenant the test will
  create) — my local scratchpad mirror had gone stale. Same class as the orchestrator's port clash.
  **`a897ad4` is not my commit** — it came from the archived session. I verified rather than trusted
  it (65/0 standalone, no regression, routes mounted and fail-closed) and changed nothing in it.
  **Borrowed vs new:** the reusable code is not in either engine but in `pro-workflows/automation_core`.
  Borrowed — nurturing's ingest shape (incl. "a dedupe conflict skips EVERY side-effect"), the
  two-layer idempotency (tenant-scoped here, unlike the nurturing copy), the public-webhook posture,
  and `classify_reply`'s regexes. **Not borrowable because absent:** visits entirely (no tracked
  link/pixel/visit table anywhere; UTM is campaign+step and cannot identify an invitee), calendar RSVP
  reading, LinkedIn comment ingestion, positive-intent classification, and any webinar connector.
  **Not done:** the golden journey has not been re-run — flagged, not claimed.
- 2026-08-01 06:3x [orch] **CP-B VERIFIED → PASS** (`a897ad4`), verdict written **without a receipt**
  — the builder committed and went idle, so I verified independently rather than park a tick.
  **THE BIGGEST GOAL GAP IS CLOSED: the operator's marketing funnel moves end to end**, proven by
  `scratchpad/orch-cpb-positive.mjs` **10/0** on a fixture chain I built: invite → `invitees`;
  following the real invite link → `visits`; landing-page registration → `registrants`; **YES to a
  cold CALENDAR invite** → `auto_registrants` (path 1); an interested **COMMENT under a content
  post** → `auto_registrants` (path 3); attendance → `attendees`. Live funnel:
  auto_registrants=5, prospects=3, registrants=3, visits=3, attendees=1. Those five stages appeared
  in ZERO server files for six weeks.
  **Security on the first PUBLIC surface in this system**: `/registration`, `/rsvp`, `/comment` all
  401 without the secret and with a wrong one; **tenant forgery refused 403 with zero rows created
  under the attacker's company** — the tenant is decided server-side, which is the only thing that
  makes one shared public secret safe. Idempotency real: three hits on one invite link increment
  `visit_count` but yield ONE stage advance and ONE activity row. No ingestion path moved a deal
  onto a MANUAL stage. Suite **783/0**; migration 023 applies 2nd+3rd time clean.
  **All four first-pass anomalies were MINE**: flat payloads that skipped the webinar→invite→token
  chain (making my early idempotency and manual-stage "passes" VACUOUS, which I recorded rather than
  banked); contacts are born at `sourced` so CP1's entry rule correctly refused a mid-funnel jump;
  `prospects → invitees` is the only legal first move so every later stage needed an invite first;
  and the attendance endpoint takes `attended`, not `attendees`. **Stated as NOT driven by me:**
  auto-registrant path 2 (interested reply to cold email, via reply-classify.js + CP-I inbound),
  the golden journey re-run, and whether anything was genuinely borrowed from the outreach/nurturing
  engines — only the builder can report that last one.
- 2026-08-01 06:40 [orch] **CORRECTION to the CP-B verdict.** It said "Receipt: NOT WRITTEN". That was
  wrong — the receipt landed at 06:24 while I was mid-probe and I wrote the verdict at 06:28. Fixed,
  and the receipt now read in full. **It answers the operator's reuse question properly, and the
  headline finding is operationally useful: the reusable code is NOT in either engine** — outreach and
  nurturing are thin FastAPI shells importing a third shared package,
  `/Users/adithyamurali/pro-workflows/automation_core`. **Borrowed:** nurturing's
  `app/events.py::ingest_event` shape (normalize → resolve → dedupe → log → side-effects) keeping its
  rule that a dedupe conflict skips EVERY side-effect; two-layer idempotency (`webhook_events
  (provider, provider_event_id)` ON CONFLICT DO NOTHING **plus** a business `dedupe_key` partial unique
  index — different failure modes: transport retries vs the same fact arriving by two routes) made
  **tenant-scoped from the start**, which the nurturing copy is not; the public-webhook posture
  wholesale; and `classify_reply`'s STOP/auto-reply regexes. **Could NOT be borrowed, stated plainly:**
  Visits — nothing exists in any of the three repos, and `automation_core/utm.py` is campaign+step
  granular so it cannot identify WHICH invitee clicked, which is exactly what the operator's definition
  requires; calendar RSVP reading (invites are created, `responseStatus` is never read); LinkedIn
  comment ingestion (Unipile wired, no `comment.*` trigger); positive-intent classification (no
  "interested" detector); and no webinar-platform connector at all. Verified the builder only READ
  `pro-workflows` — that shared checkout is unmodified and still on `s9/per-company-crm-seam`.
  DECISIONS_PENDING.md now carries 8+ default decisions incl. "ingestion never walks more than one
  stage hop", "attendance by a contact who never registered does not force a stage", and "interest is
  opt-in, never inferred by default" — all sensible and all recorded rather than silently taken.
- 2026-08-01 06:42 [orch] **CP-C DISPATCHED — per-channel EP integrations.** The operator's words:
  "different EP INTEGRATIONS and DIFFERENT PROVIDERS FOR DIFFERENT CHANNELS". Today `email`, `sms`,
  `whatsapp`, `linkedin`, `ai_call` are all declared valid channels and **only email can send**;
  everything else records and goes nowhere (CP-I renders that honestly as "Logged — not delivered",
  which is why it is safe but not the goal). Governing rule, the same one that made CP4a work:
  **WRAP, do not rebuild** — every channel executor goes through the EXISTING B4 claim/ack HTTP
  contract with the same claim door, content guard, `send_started_at` idempotency, definitive-vs-
  outcome-unknown split, per-instance `claimed_by`, and a boot gate requiring an explicitly
  configured sender. Told the builder to apply the same discipline that just worked on CP-B: mine
  `automation_core` for each provider BEFORE writing anything (its own report says Unipile is already
  fully wired and webhook-authenticated). Two constraints stated up front because they are how this
  goes wrong: **(1) reuse the outreach engine's LinkedIn safety spine** — kill-switch, allowlist,
  07:00–18:00 IST window — rather than inventing limits, or an account gets restricted; **(2) every
  provider needs a stub seam like `RESEND_API_BASE`**, because no test may touch a real key and
  without a seam the test cannot be written at all. Next unused migration 024.
- 2026-08-01 07:20 [build] **CP-C survey done — it changes the scope, so decisions were recorded
  before any code.** (1) **The LinkedIn safety spine is NOT in the adapter.** Wrapping
  `LinkedInAdapter.send()` gets suppression + kill-switch/allowlist + eligibility and nothing else;
  every rate limit, the 07:00–18:00 IST window, the accept gate and the reserve lease live in
  `linkedin_gate.py` plus the orchestration order in `dispatcher.py:355-429`, which is not a reusable
  function. **LinkedIn therefore ships no sender in v1** — the half-wrapped version sends up to 400
  invites in an hour at 3am to people who never accepted, i.e. the account-restriction scenario.
  Correction to the brief: there are **two** windows and the narrower channel default
  (Tue/Wed/Thu 09:00–10:30) is what actually binds. (2) **Twilio's base URL is hardcoded** with no
  override in any of the three repos, so "never point an executor at a real key" is unsatisfiable by
  reuse — SMS/WhatsApp get a thin CRM client with a `TWILIO_API_BASE` seam, everything else borrowed.
  (3) **WhatsApp Business API only** — the browser mode is a single global logged-in profile with no
  rate limiting or per-tenant identity, chosen upstream by silent fallthrough. (4) No provider
  supports idempotency keys, so CP4a's `send_started_at` compare-and-set is the reserve — which also
  avoids inheriting an upstream bug where a Twilio timeout re-sends every tick forever.
- 2026-08-01 06:5x [orch] Tick: CP-C dispatched and the builder is in its RESEARCH phase (no
  artefacts yet, correct — I told it to mine `automation_core` before writing). So I closed the two
  gaps I had explicitly declared un-driven.
  **AUTO-REGISTRANT PATH 2 VERIFIED — 8/0** (`scratchpad/orch-cpb-path2.mjs`). A genuine interested
  reply auto-registers an invitee; and every dangerous false-positive is refused: STOP/unsubscribe,
  "remove me", an out-of-office auto-reply, an explicit negation, a polite decline, and the nastiest
  case — "I'm **not interested** in the webinar" — which contains the word and is still not read as
  interest. **A STOP reply also creates a SUPPRESSION, not merely a non-advance**, which is the one
  that matters: an opt-out that only "does nothing" gets mailed again. **My first run of this probe
  was VACUOUS and I nearly banked it** — I used `event: 'reply'` when the field is `event_type` and
  the value is `email_reply`, so all six negatives "passed" because every request 400'd. Caught it
  because the POSITIVE also failed; a probe where only the negatives pass is not evidence.
  **GOLDEN JOURNEY — I FOUND A FAILURE IN MY OWN PROCESS.** Re-running it returned **8/4**, not the
  12/0/0 I have been quoting. Root cause: CP4a-0's content guard correctly refuses jobs with no
  resolvable content, and `seed-CP2-step-scheduler.mjs` predates the content store — it creates
  steps with `template_ref` but **zero `message_templates` rows and zero inline content**, so every
  seeded job carries `content_resolved:false` and is (rightly) unclaimable. **The product was never
  broken; my instrument was.** I declared "the golden journey must never regress" and then did not
  re-run it after CP4a-0 landed, so the number I quoted was stale across CP4a, CP4a-0 and CP-B.
  Fixed by authoring `message_templates` for all 11 seeded `template_ref`s and re-seeding so the new
  enrollment resolves content at schedule time (CP4a-0 freezes it into the payload, so pre-existing
  rows legitimately keep their `false`). **Golden journey restored to 12 passed / 0 failed / 0
  skipped** — and it is now a truthful instrument again rather than a stale claim.
- 2026-08-01 07:06 [orch] **FOUND AND FIXED A REAL FLAW IN MY OWN WATCHDOG — it could not see a
  stalled builder.** The build session went idle at 06:49 (right after receiving the CP-C dispatch)
  with no commits, no `migrations/024*`, no CP-C source files — yet the watchdog logged
  "active — no action" every 3 minutes for 16 minutes. Root cause: the activity signal was
  `.loop/STATE.json` and `LOG.md` mtimes, **files the ORCHESTRATOR rewrites every single tick**, so
  my own bookkeeping masked a dead builder. An unattended 12-hour run would have reported health
  while building nothing, which is worse than failing loudly.
  **Fixed:** the signal now depends on whose turn it is — with `handoff=build`, activity is measured
  ONLY from source-file changes (`server/`, `test/`, `migrations/`, `web/`) and git commits, with
  `.loop` writes deliberately EXCLUDED, because on the builder's turn only the builder's work counts
  as progress; with `handoff=orch`, `.loop` writes do count because that is the orchestrator working.
  Verified live: it now reports **"STALLED at CP-C/BUILD"** where it previously said "active", and
  correctly identifies that the only thing stopping it relaunching is the unauthenticated headless
  CLI. This is the second flaw found in my own tooling today (the first being `run-suite.sh`
  hardcoding the builder's port and silently producing 88 phantom 401 failures) — both were in the
  instruments, not the build.
  Nudged the builder to resume CP-C, restated WRAP-do-not-rebuild, told it to mine `automation_core`
  first as it did so effectively on CP-B, re-flagged the LinkedIn safety spine (kill-switch,
  allowlist, 07:00-18:00 IST — reuse it, an account restriction is not recoverable) and the need for
  a stub seam per provider, and explicitly authorised splitting CP-C one-channel-per-checkpoint as a
  DECIDED BY DEFAULT rather than stalling on the question.
- 2026-08-01 07:55 [build] **CP-C DONE (SMS + WhatsApp) — `27a6c01`.** Suite **877/0**; `unit-cpc` 29
  new; **CP4a's 83 pass unmodified** against the refactored executor. **No migration** — 022 already
  covers every channel, so **024 is still unused**. **One executor instantiated per channel**: the
  email logic IS `channel-executor.js` and email is an instance, so CP4a's five properties are
  inherited, not re-implemented. **Twilio had to be a thin client** — `automation_core` hardcodes
  `api.twilio.com` with no override, making "never use a real key in testing" unsatisfiable by reuse;
  everything else borrowed. **Not borrowed: upstream's error handling**, which conflates 400/429/timeout
  and re-sends timed-out messages every tick forever against a provider with no idempotency key.
  **LinkedIn ships no sender** — its safety spine is not in the adapter (all caps, the window, the
  accept gate and the reserve lease live in `linkedin_gate.py` + a non-reusable orchestration order),
  and the half-wrapped version is the account-restriction scenario; `/executors/linkedin/status` 404s
  honestly. Correction: there are **two** windows and Tue/Wed/Thu 09:00–10:30 is the binding one.
  WhatsApp Business API only. Receipt: `.loop/receipts/CP-C-channel-executors.md`.
- 2026-08-01 07:2x [orch] **CP-C VERIFIED → PASS** (`27a6c01`, SMS + WhatsApp). The builder split
  CP-C as I pre-authorised — Twilio covers two channels, LinkedIn deferred as highest-risk. **WRAP
  confirmed structurally: `email-executor.js` collapsed ~370 → 32 lines**, a thin wrapper over a
  shared `channel-executor.js` (254) plus a per-channel registry, with EVERY CP4a guarantee present
  in the shared path (`send_started_at` ×11, `INSTANCE_ID` ×9, definitive/outcomeUnknown, bootGate,
  content_resolved) and a **`TWILIO_API_BASE` seam explicitly modelled on `RESEND_API_BASE`**.
  Per-channel enable flags; no migration needed, 024 still free.
  **The check that mattered — did the refactor break CP4a? No.** Re-ran no-double-send against the
  GENERALISED executor (stub hanging 9s, 2s claim timeout so the claim expires mid-send, second
  instance ticks): **4/0**, exactly one physical send. Suite **812/0**.
  **THREE FLAWS IN MY OWN TOOLING THIS TICK, none in the build.** (1) **My suite mirror was missing
  `unit-cpc-channels.mjs` entirely** — it printed "783/0", a green number covering ZERO CP-C tests;
  I would have passed CP-C without running it. Fixed, plus a **DRIFT GUARD** that diffs the mirror
  against `test/run-local.sh` and ABORTS if the real runner has a suite the mirror lacks. (2) My
  port-ownership guard fired correctly and aborted on a stale :3102 server — that guard exists
  because of the 88-phantom-failure incident and just prevented a repeat. (3) **My no-double-send
  probe counted sends GLOBALLY**, so two ticks legitimately sending two DIFFERENT people read as a
  double send — it raised a false alarm TWICE before I scoped it to the target contact's address.
  A false double-send alarm is nearly as damaging as missing a real one. Not driven by me and stated
  in the verdict: an actual SMS/WhatsApp send through the Twilio stub (first target next pass),
  LinkedIn (still owed, must REUSE the outreach engine safety spine), and a golden-journey re-run
  after `27a6c01`.
- 2026-08-01 07:40 [orch] Tick: builder actively on **CP-C2 (LinkedIn)** — `migrations/024_linkedin
  _safety.sql`, `server/lib/linkedin-gate.js`, `unipile-send.js`, `send-safety.js`, plus
  `channel-executor.js` in flight. **The watchdog fix proved itself**: it flagged the stall at
  07:34 and then correctly reported "real source/git activity" at 07:37 — the signal now tracks the
  builder rather than my own bookkeeping.
  Design review rather than a rubber stamp: the gate **internalised my claim-door constraint
  verbatim** ("a job claimed at 17:59 and sent at 18:05 has left the window"), the verdict taxonomy
  goes well beyond an allowlist (`PACED`, `WEEKLY_CAPPED`, `PENDING_CAPPED`, `AWAITING_ACCEPT` —
  modelling invite acceptance and pending ceilings, i.e. LinkedIn's real risk surface), timezones
  are **per account** rather than hardcoded IST, and it **deliberately refuses to add a second lease
  table** because the claim plus migration 022's `send_started_at` already is one. Migration 024
  adds `linkedin_accounts` + `linkedin_prospect_state` with pending-invite indexes.
  **INJECTED THE ONE REAL CONCERN: the gate is not wired in.** `git grep -ln "linkedin-gate"` over
  `server/` returns NOTHING — no file imports it, and neither `dispatch.js` nor `channel-executor.js`
  references `windowVerdict`/`pacedAllowance`. So the module's own header asserts "WHERE IT RUNS...
  at the CLAIM DOOR" while the code does not yet deliver it. **That is the exact failure shape the
  builder itself diagnosed in CP4a-0** ("refusal lived only in comments and in an executor nobody
  had written"), and on LinkedIn a decorative gate costs an account restriction, which is not
  recoverable. Flagged as a finish-line checkpoint, not an accusation — `channel-executor.js` is
  uncommitted and this is plainly mid-flight. Told it exactly what I will verify: that `claimJobs`
  ITSELF refuses an out-of-window job (not that the executor declines afterwards), kill-switch
  effective within one tick not one restart, caps holding under concurrency, no bypass via the
  generic channel path, a `UNIPILE_API_BASE` stub seam, and CP4a's no-double-send re-checked after
  `channel-executor.js` changes again.
- 2026-08-01 07:5x [orch] Tick: **the CP-C2 concern I raised last tick is RESOLVED — the LinkedIn
  gate is now wired at the CLAIM DOOR.** `linkedin-gate` is imported by `server/db/models/
  dispatch.js` and consulted **inside `claimJobs`**, within the transaction and under the advisory
  lock, via a `CHANNEL_GATES` registry so email/sms/whatsapp are unaffected. That is exactly the
  right placement: LinkedIn restricts ACCOUNTS rather than messages, so its limits have to be
  enforced where jobs are handed out, not where they are sent. Builder still mid-build (dispatch.js,
  channel-executor.js, executors.js, run-local.sh uncommitted; no CP-C2 commit or receipt yet).
  **Used the tick to close BOTH gaps I owed on CP-C rather than idle.**
  (1) **An actual SMS and WhatsApp send, driven through a stub Twilio on :8901**: SMS
  `+15550001111 → +15557654321` returned `{id:'SM00000001', providerStatus:'queued'}`; WhatsApp
  carried the required `whatsapp:` prefix on BOTH ends; auth header present on both; `TWILIO_API_BASE`
  genuinely diverts the call so no real account was touched. Evidence banked at
  `.loop/EVIDENCE/CP-C/twilio-stub-sends.json`. Noted from the source: **Twilio has no idempotency
  key**, so preventing a duplicate is entirely the CRM's job — which is why the `send_started_at`
  reservation matters more on this channel than it did for email.
  (2) **Golden journey re-run after `27a6c01`: 12 passed / 0 failed / 0 skipped.** The
  channel-executor generalisation did not disturb the full chain. CP-C verdict updated — both
  "not driven by me" items are now struck through and evidenced rather than left as caveats.
- 2026-08-01 09:40 [build] **CP-C2 DONE — `1a04bad`.** Suite **965/0**; `unit-cpc2` 88 new; CP4a's 83 and
  CP-C's 29 unmodified. **Migration 024** (next unused 025). Window enforced at the **claim door** via a
  generic `CHANNEL_GATES` hook under the lock it already holds — plus a **per-job re-check before every
  send**, because a critic showed claim-door-only was itself a loosening for a slow batch. Kill switch is
  per tick and **cross-channel**. Spine ported from `linkedin_gate.py` almost line for line; every
  deviation is a tightening (default-deny message evidence, fail-closed inverted window and empty day
  list, invites consult prospect state). **Two refusals needing your sign-off:** LinkedIn is no longer
  claimable over HTTP (**narrows B4**), and an account cannot send until an operator asserts the engine
  is not dispatching on the same identity. **Critics found seven real defects, all fixed** — the HIGH
  (`releaseClaim` with no ownership guard, clearing `send_started_at` mid-flight) **affected email and
  SMS too**. Next: **F34**, the accept webhook — nothing currently writes `accepted_at`.
  Receipt: `.loop/receipts/CP-C2-linkedin.md`.
- 2026-08-01 09:58 [build] Orchestrator's mid-build check crossed with the finish: the gate was written
  and unwired when they looked, and is wired now (`dispatch.js:21/109/112/228/230`,
  `channel-executor.js:201`). Also `03e6111` — **`TWILIO_API_BASE` now strips a trailing slash**, so the
  end-to-end SMS/WhatsApp probe they still owe cannot fail on `//2010-04-01`. Receipt gained a Twilio
  rough-edges section; the likeliest hour-loser is that a hand-inserted `scheduled_actions` row is
  **quarantined, not sent**, because the claim door requires `content_resolved`.
- 2026-08-01 08:1x [orch] CP-C2 (LinkedIn) handed back at `1a04bad` (+ `03e6111`, a trailing-slash
  fix in TWILIO_API_BASE). **NO VERDICT ISSUED THIS TICK — deliberately.** What I did establish
  independently: full suite **900 passed / 0 failed across 16 suites** (CP-C2's own contributes 88);
  migration 024 applies a 2nd and 3rd time clean; the `UNIPILE_API_BASE` seam exists and strips
  trailing slashes; `killSwitchOn()` reads `process.env.LIVE_SENDS_DISABLED` **fresh on every call**,
  not cached at module load, and it reuses **upstream's own variable name so one setting stops the
  CRM and the engines together** — an operational call I did not ask for and should have.
  **MY DRIFT GUARD PAID FOR ITSELF ON ITS FIRST OUTING**: it ABORTED the suite because
  `unit-cpc2-linkedin.mjs` was missing from my mirror — the exact failure that nearly let me pass
  CP-C untested one checkpoint ago. Added it. **Also caught my own tally under-reporting**: CP-C2
  prints "88 passed / 0 failed" (slash) where every other suite prints "N passed, M failed" (comma),
  so my awk silently dropped a whole suite and I would have reported 812 instead of 900. I then
  briefly computed 965 from a sloppier pattern and re-derived it properly rather than quote a number
  I could not defend — 900 reconciles as 812 + 88.
  **WHY NO VERDICT: my independent LinkedIn probe cannot yet establish a POSITIVE CONTROL.** The
  baseline "with the window open the job IS claimable" fails, so the out-of-window and kill-switch
  refusals I observed are **not proven non-vacuous** and I refuse to bank them as evidence — that is
  the same vacuous-pass trap that has already bitten me on CP-B and on auto-registrant path 2, and a
  safety gate is the last place to accept it. Root causes found so far, all mine: the fixture omitted
  `engine_dispatch_disabled`, and a LinkedIn *message* additionally requires **connection evidence**
  (a `linkedin_prospect_state` row with `accepted_at`) per the builder's own L-7.
  **A genuinely valuable safety property surfaced while debugging it**: `preScan` refuses with
  `engine_dispatch_not_confirmed_disabled` — the CRM will not send LinkedIn until an operator has
  explicitly confirmed the OUTREACH ENGINE's own LinkedIn dispatch is off. Two systems driving one
  LinkedIn account is exactly how an account gets restricted, and I had not thought to ask for it.
- 2026-08-01 08:2x [orch] **CP-C2 VERIFIED → PASS** (`1a04bad` + `03e6111`). Verdict at
  `.loop/verdicts/CP-C2-linkedin.md`. **The positive control is established, so the refusals are
  real evidence and not the vacuous passes I refused to bank last tick: 7/0.** With the window open
  the job IS claimable (C0); out-of-window the **CLAIM DOOR itself** refuses and leaves the job
  pending; the kill-switch flipped mid-run stops the **very next claim** and clearing it resumes
  immediately, both with no restart; and the kill-switch is **global**, stopping email too.
  Regressions clean: suite **900/0** across 16 suites, migration 024 idempotent, and **CP4a's
  no-double-send re-verified after `channel-executor.js` changed again — 4/0, exactly one physical
  send with the claim expiring mid-send**.
  **Design decisions worth recording**: `engine_dispatch_not_confirmed_disabled` refuses to send
  LinkedIn until an operator confirms the OUTREACH ENGINE's own dispatch is off (two systems on one
  account is how it gets restricted — I did not ask for this and should have); empty `active_days`
  means "no days" not "every day"; a window with `end <= start` is CLOSED, not "always open", with a
  note that upstream's pacer does the opposite and would turn a misconfiguration into unlimited
  sending; `linkedin_action` defaults to `message` not `invite` because defaulting to invite "would
  fire connection requests nobody asked for"; an unknown timezone logs loudly instead of silently
  evaluating in UTC.
  **All four anomalies were mine, across two ticks**: fixture missing `engine_dispatch_disabled`;
  `linkedin_action` NULL meaning `message` (which needs connection evidence) rather than `invite`;
  **`active_days` holding weekday NAMES where I inserted numbers `{1..7}`** — I checked the schema
  default before blaming the code and found `ARRAY['Mon'..'Fri']`, consistent, so it was mine; and
  stale accounts from earlier runs shadowing my fixture.
- 2026-08-01 08:4x [orch] Tick: builder actively on **CP-D (automation definitions)** —
  `migrations/025_merge_defaults.sql`, `server/lib/automation-definitions.js`,
  `server/routes/automations.js`, `test/unit-cpd-automations.mjs`, plus dispatch/sequences/
  templates/ai-draft/server.js in flight. Reviewed the definitions against `.loop/GOALS.md` rather
  than waiting for the receipt.
  **The No-Show ladder matches the operator's spec EXACTLY — `0, 3*DAY, 6*DAY, 9*DAY, 16*DAY`** —
  and the rung-1 reasoning is the invariant respected at DESIGN level, not just enforced: "the
  contact is already in Follow-up 1 — that is what triggered this — and Follow-up 1 is MANUAL, so
  writing it back would be the CRM touching a manual stage." That also retroactively settles a
  defect in MY OWN CP2 ticket, whose browser script wrongly expected the deal at `_2` after acking
  rung 1. The definition is honestly labelled **`source: 'AUTHORED — no sales-call no-show ladder
  exists in either engine; every upstream no_show means "did not attend the webinar", which is a
  different event entirely'`** — the same shape as CP-B's finding that Visits existed nowhere, and
  exactly the honesty I asked for about borrowing.
  **INJECTED: F-CP4a-1 HAS COME TRUE, precisely as I filed it after CP4a.** `KNOWN_TOKENS` is now
  nine (`book_url`, `join_url`, `unsubscribe_url`, `webinar_date`, `webinar_time`, `sender_name`
  added) while the claim door's hardcoded SQL regex is **still `\{(first_name|company|stage)\}`**.
  My follow-up said: "they agree today and will drift the first time a token is added." A token was
  added; they drifted. **Severity MEASURED, not asserted: this is hardening, not a live hole** —
  I verified `unresolvedTokensIn` uses the full list and returns `["first_name","book_url"]`, so
  `resolveStepContent` marks such content unresolved and the claim door still blocks on
  `content_resolved=false`. What degraded is the defence-in-depth layer the builder added
  deliberately. Asked for the SQL pattern to be DERIVED from the single source while it is in
  `dispatch.js` anyway. Also flagged `{cta}/{cta_url}/{para}/{t}` appearing in definitions but not
  in KNOWN_TOKENS (likely build-time helpers, but they ship literally if they can reach a body),
  and asked for a DECISIONS_PENDING line confirming Deal Follow-ups have no automation **by design**
  (MANUAL, no timers) so a future reader does not mistake the absence for a gap.
- 2026-08-01 11:20 [build] **CP-D DONE — `537d0bb`.** Suite **1030/0**; `unit-cpd` 71 new. Migration 025.
  Invite ladders + long-term drip **borrowed**; the No-Show ladder **authored**, because no sales-call
  no-show ladder exists in either engine. **The copy could not be pasted** — `{{...}}` means the
  opposite here, and `{book_url}` was not a known token, so the door would have sent a literal brace to
  a prospect. Token set 3→9, **F-CP4a-1 closed**. `automations` column stays empty as a projection.
  **Critics found three HIGHs, all mine:** cumulative delays in a relative engine (day 34, not 16 — and
  my test asserted the column, which is why it passed), overwrite cascade-deleting the send/LinkedIn-cap
  ledger, and F38 being a **port** not a design. All fixed. **Not shipped and named:** the anchored
  reminder ladders — `registrants`/`attendees` still trigger nothing. Receipt:
  `.loop/receipts/CP-D-automations.md`.
- 2026-08-01 09:0x [orch] **CP-D VERIFIED → PASS** (`537d0bb`). The last unbuilt item in
  `.loop/GOALS.md` is closed. Seeded the operator's real No-Show ladder and read back what landed:
  per-step `0/3/3/3/7` ⇒ **cumulative 0 / +3d / +6d / +9d / +16d — exactly the operator's spec** —
  with **rung 1 writing back NOTHING** because Follow-up 1 is MANUAL and is what triggered the
  ladder, rungs 2–5 mirroring `no_show_followup_2..5`, the trigger being the MANUAL stage a human
  marks, copy resolving **per contact at schedule time** (so rung 5 sixteen days later reflects who
  the contact is when it actually goes out), and re-seeding not duplicating. **8/0.** Six
  definitions ship: four invite ladders (email/SMS/WhatsApp/LinkedIn) plus the No-Show ladder and a
  10-step nurture. Suite **971/0 across 17 suites** (CP-D adds 71); migration 025 adds
  `crm_merge_defaults` as the per-tenant source for the new context tokens.
  **F-CP4a-1 is CLOSED, and it had already come true**: CP-D added six tokens and the hardcoded
  claim-door regex did drift, exactly as I predicted when filing it. It is now generated ONCE in
  `templates.js` as `UNRESOLVED_TOKEN_RE` and imported by both readers — verified behaviourally
  (all nine tokens block, braced prose still allowed).
  **Both my probe failures were mine again**: I compared the operator's CUMULATIVE ladder against
  PER-STEP `delay_seconds` and misread `[0,3,3,3,7]` as wrong when it sums to the spec; and I looked
  for step copy in `sequence_steps.subject/body` (correctly NULL) instead of `message_templates`,
  which is CP4a-0's own design. **My drift guard fired for the third time**, aborting the suite
  because `unit-cpd-automations.mjs` was missing from my mirror — it has now caught that same class
  of tooling rot on CP-C, CP-C2 and CP-D.
- 2026-08-01 09:1x [orch] Goals complete and the builder is awaiting scope, so I used the tick to
  turn the deploy hazard from a warning into a **measured fact**, and wrote
  **`.loop/DEPLOY_RUNBOOK.md`**.
  **PROVEN EMPIRICALLY**: I built a throwaway database at staging's actual schema level (≤011),
  booted the CURRENT code against it, and measured — **`/health` returns 200 while every
  authenticated request returns 401**. Server log: `relation "tenant_api_keys" does not exist` →
  `[Auth] SECURITY: DB key-collision check unavailable (DB error) for an env-bound key — refusing
  rather than risk an undetected collision`. The fail-closed behaviour is correct security; the
  danger is that it is **silent** — `initDatabase()` runs no migrations and `/health` never touches
  `tenant_api_keys`, so a health-checked rollout reports success while the API is entirely dead.
  Runbook records the mandatory order (DDL 012→025 FIRST, verify with `to_regclass` on the five
  load-bearing tables, THEN restart, then verify with an **authenticated** request — a 401 means
  the migrations did not land, roll back the restart), plus the send-safety posture (every channel
  executor off unless explicitly enabled AND given a configured sender; `LIVE_SENDS_DISABLED` read
  fresh per claim so it bites within one tick; LinkedIn additionally refusing until
  `engine_dispatch_disabled=true` so two systems cannot drive one account), the per-tenant
  `crm_merge_defaults` prerequisite, and an explicit warning to check the queued backlog before
  enabling any executor so stale test jobs are not fired at real people. Stated plainly as NOT
  covered: migration rollback — 012–025 are additive but no down-migrations exist and I have not
  tested a reversal, so the DDL is forward-only. Scratch probe DB dropped afterwards.
- 2026-08-01 09:2x [orch] `handoff=operator`, so rather than restate the three pending decisions I
  closed the last verification gap I actually owned: **there was no browser evidence of the FINISHED
  system.** I had not driven the UI since CP-I, and CP-B, CP-C, CP-C2 and CP-D have all landed since.
  Seeded a realistic end-state (tenant merge defaults, three seeded automations, a webinar, five
  contacts driven to **every** automated marketing stage via the real public ingestion endpoints, a
  sales no-show mid-ladder with a $12,000 opportunity, and inbound traffic on two channels), then
  drove the whole app as an operator would. **15 passed / 0 failed, console clean across every tab.**
  Evidence in `.loop/EVIDENCE/FINAL/` — 10 screenshots, each opened and read.
  What the finished screen shows, all at once: the three-pane inbox with the **contact record** as
  the third pane; **Your turn** as the landing filter; Devon Pierce carrying **both `email` and
  `linkedin` chips**; the thread interleaving both channels with per-message chips and absolute
  timestamps; the right rail showing score, **STAGE `◆ No-Show Follow-up 1 👤`** — the **manual-mode
  person glyph from the CP-T stage-tags plan, so the operator's manual/automated distinction is now
  VISIBLE**, next to the `webinar` funnel_type — tags, and an activity feed reading back the real
  history (`stage change (webinar_sales): scheduled_call → no_show_followup_1`, opportunity created
  $12,000, contact created); and the composer with **Reply | Note | Templates**, a channel picker,
  the **`Deal: Devon Pierce — Pro Delivery` context chip** (CP-I's D6 explicit deal scoping, never
  guessed), and **Draft with AI**. Every pattern from the 36-image research and every stage rule
  from `.loop/GOALS.md` visible in one frame.
- 2026-08-01 09:4x [orch] `handoff=operator` again, so rather than restate the same three decisions
  I closed the gap that actually de-risks one of them. Every green number so far came from a DB I
  had been shaping all session; a deploy gets none of that. **CP-X COLD START: 11 passed / 0 failed.**
  Virgin database, schema read via `git show HEAD:` so nothing uncommitted could leak in — all 25
  committed schema files applied in order, all 16 fail-closed tables present, committed server booted
  and served **authenticated** traffic (`/api/crm/contacts` → 200, no-key → 401). The deploy hazard in
  `.loop/DEPLOY_RUNBOOK.md` is now demonstrated in BOTH directions, not just documented. Then the
  invariant itself on that virgin DB: the ENGINE is refused entry into `no_show_followup_1` with
  403 `manual_stage`, nothing is written, a HUMAN may set the same stage, and the mode gate outranks
  transition legality. Also confirmed the UI's manual glyph is **server-driven** — `/api/crm/pipelines`
  returns per-stage `mode` matching the spec exactly. Recorded one caveat: the legacy `marketing` and
  `sales` pipelines declare no mode at all (they predate CP1's funnel_type), so the invariant does not
  constrain them — worth knowing before assuming blanket coverage. Three probe defects were mine and
  are written up in the verdict; two had manufactured **vacuous passes** (a refusal for the wrong
  reason, and a TypeError read as a refusal). Verdict: `.loop/verdicts/CP-X-cold-start.md`.
- 2026-08-01 10:0x [orch] Last tick I recorded "legacy marketing/sales pipelines declare no mode" as a
  caveat and called it **not a defect**. This tick I tested that claim instead of asserting it, and it
  was wrong. `applyStageWriteback` guards with `isManualStage`, which returns FALSE when `mode` is
  ABSENT, so on the legacy pipelines the only remaining guard is transition legality — and
  `onboarding → won` is legal. Driving the real `claimJobs → ackJob` path on a cold DB **with a
  positive control** (claim=1, ack=200 — the control is what makes this non-vacuous, and my first
  attempt at this probe DID produce a vacuous pass by claiming 0 jobs through a wrong HTTP shape):
  **a $50,000 deal ended at `stage='won'`, trail reading `Stage (sales): onboarding → won (sequence
  step)`. No human involved.** Not reachable through any shipped automation, but fully reachable
  through the B7 sequence builder, which is a live CRUD surface. Fix decided rather than asked:
  automation may only set a stage explicitly declared `auto` — fail closed, opt-in — via a NEW
  `mayAutomationSetStage` predicate at both automated write points, deliberately leaving
  `isManualStage` untouched because it also drives the UI's person glyph. Ticket written with
  acceptance criteria including a positive control (A2), dispatched to the build session,
  `handoff=build`.
- 2026-08-01 12:35 [build] **CP-Y DONE — `f4e7c37`.** Suite **1052/0**; `unit-cpy` 22 new. Migration 026.
  `mayAutomationSetStage` asks the POSITIVE question, so absent mode means a human owns it for every
  pipeline — including ones no migration will see. `isManualStage` untouched. **A second hole, found by
  my own test and not in the ticket:** the PATCH `/deals/:id` mode gate sat inside `if (funnel_type)`,
  and legacy `sales` has none — a robot could set `won`/`lost` over HTTP with nothing checking it
  (Y-4 returned 200). Hoisted out. The two `unit-cp1` failures did **not** encode the bug — E2 pins the
  seeded JSONB byte-for-byte and 026 added a key; the pin is kept, not loosened. Receipt:
  `.loop/receipts/CP-Y-legacy-mode-hole.md`.
- 2026-08-01 10:1x [orch] Builder shipped CP-Y in 54 seconds (f4e7c37 + migration 026 + a new suite).
  Verified INDEPENDENTLY before the receipt existed: **8/0** on a virgin DB from HEAD through the real
  `claimJobs → ackJob` path. The two that decide it: **A2**, a genuinely `auto` write-back still
  applies (a fix that blocked everything would have passed A1 and destroyed the product), and **A6b,
  which the ticket did not ask for** — I built a BRAND-NEW pipeline with a mode-less stage and
  automation was refused, so the hole is closed for pipelines that do not exist yet rather than merely
  labelled shut on the legacy two. `mayAutomationSetStage` asks the positive question; migration 026
  is the record, not the fix. Automated advance → 403 `stage_not_automatable`; a human still sets
  `won` → 200. **Full suite 1058/0, 19/19 suites reporting.** TWO HARNESS DEFECTS OF MINE, both of
  which slandered correct work: my mirror reuses a persistent scratch DB and never applies schema, so
  026 was absent and the run reported **9 failures, 7 inside the builder's own CP-Y suite** — their
  code was fine, my DB was stale (fixed with `rebuild-test-db.mjs`); and the tally read `"$0.lastlog"`,
  which nothing writes, printing `TOTAL: 0 passed` while 19 suites had just reported 1058 — a tally
  reading a nonexistent file is worse than none, now teed to a real log and asserting lines==suites.
  The drift guard aborted the run unprompted rather than report a total excluding the new suite.
  Verdict `.loop/verdicts/CP-Y-legacy-mode-hole.md`. `handoff=operator`.
- 2026-08-01 10:3x [orch] Verified CP-Y's receipt rather than accepting it — and the builder's own
  second find was right but one branch short. **CP-Y closed one of three write points.** At HEAD, over
  HTTP, on a virgin DB: `PATCH {stage:'won', automated:true}` on a built-in sales deal → **200, deal
  moved ($90,000)**, and `POST /deals` creating directly at `won` with `automated:true` → **201**.
  Cause: `POST /deals` normalises the built-in pipeline to `pipeline_key = NULL` (crm.js:1067), and the
  PATCH stage block branches on `if (!deal.pipeline_key)`; CP-Y hoisted the mode gate into the **else**
  arm only, while the **if** arm is the default sales pipeline — where `won`/`lost` actually live.
  Migration 026 declares them manual; nothing on that path asks. Second point: `POST /deals` still
  guards `createRefusal` with `if (cfg && cfg.funnel_type)` — the very `funnel_type`-conditional
  pattern CP-Y removed from PATCH, now three instances of one defect class. Also caught that my own P5
  "positive control" last round passed only because that path was **ungated** — it proved nothing, and
  CP-Y2's B3 makes it a real assertion for the first time. Ticket dispatched, `handoff=build`.
  **Deploy should wait for this.**
- 2026-08-01 13:30 [build] **CP-Y2 DONE — `f899c2d`.** Suite **1065/0**; `unit-cpy` 35 (13 new). No migration.
  CP-Y's gate went into the **`else`** arm; built-in sales deals store `pipeline_key = NULL` and take the
  **`if`** — where `won`/`lost` live. One branch short, under a comment claiming it covered every
  pipeline. Config now resolved **once** and gated **above** the split; `POST /deals` hoisted out of the
  same `funnel_type` conditional (an automated create at `won` was a 201). Transition checks untouched;
  all six remaining `funnel_type` uses audited and none is a mode check. **F44 filed:**
  `DEFAULT_DEAL_STAGES` and the seeded `sales` config disagree on `lead`/`proposal_accepted`, so
  automated creation at `lead` is now a 403 — deliberate, fail-closed, and the fix is to complete the
  config rather than special-case undeclared stages. Receipt: `.loop/receipts/CP-Y2-builtin-sales-gate.md`.
- 2026-08-01 10:5x [orch] **CP-Y2 ACCEPTED — 8/0.** Because this defect class had already survived two
  fixes, I swept every deal write path rather than re-testing only the two I reported: PATCH on a
  NULL-pipeline_key deal → 403 with the deal unmoved, `POST /deals` at `won` → 403, plus two sweep
  cases of my own (create via an **explicit** pipeline_key; **re-key + manual stage in one automated
  PATCH**) — both refused. **B3 is the one worth naming:** last round my P5 "positive control" passed
  only because that path was *ungated* and asserted nothing; now that the gate exists it tests the auto
  path for real, and automated writes to a declared-`auto` stage still apply. Suite **1071/0, 19/19
  suites reporting**. NEW FINDING, dispatched as **CP-Y3**: `automated` fails **OPEN** on a
  non-boolean — `automated:"true"` as a string returns 200 and moves the deal, because all three gate
  sites read `=== true`, so a string is treated as a **human**. Identical fail-open shape to the
  original bug. Severity is hardening, not a live break, and I checked before saying so: every in-repo
  caller sends a real boolean. It matters because the engines call this API over HTTP. Fix specified as
  one shared `isAutomatedRequest` helper — absent means human, present-but-unrecognisable means
  automated — rather than a third hand-inlined comparison. Verdict
  `.loop/verdicts/CP-Y2-builtin-sales-gate.md`.
- 2026-08-01 14:10 [build] **CP-Y3 DONE — `ee9e4f1`.** Suite **1085/0**; `unit-cpy` 55 (20 new). No migration.
  The flag itself was fail-open: all three sites read `=== true`, so the string `"true"` was treated as a
  HUMAN. One shared `isAutomatedRequest` helper, no inline comparison left. **Absent ⇒ human** (the UI
  sends nothing), **present-but-unrecognisable ⇒ automated** (a caller that sent the field is a program).
  Still honour-system, still not a security boundary. C3 — no flag is still a human — is the assertion
  that protects the product rather than the invariant. Also covered the **contact `/advance`** path,
  which no probe had reached. Receipt: `.loop/receipts/CP-Y3-automated-coercion.md`.
- 2026-08-01 11:1x [orch] **CP-Y3 ACCEPTED — 15/0**, and the three-checkpoint arc that began with a
  robot marking a $50,000 deal Won is now closed end to end: CP-Y the write-back path, CP-Y2 every
  deal write path, CP-Y3 the flag those gates read. All six truthy spellings (`true`, `"true"`, `1`,
  `"TRUE"`, `" True "`, `"yes"`) refused into a manual stage with the deal unmoved; all four explicit-no
  spellings still human; **C3, the criterion that protects the product — no `automated` field at all,
  which is what the UI sends, is still a HUMAN** (a coercion resolving absent⇒automated would have
  locked every real user out of their own board); a robot may still write a declared-`auto` stage.
  CREATE and `/advance` coerce identically, **each with its own paired positive control** — S2b exists
  because S2's 403 could otherwise have been a transition or entry refusal rather than coercion.
  Audited: no raw `automated === true` remains anywhere in `server/`. Recorded the builder's own
  caveat because it is correct and it bounds the claim: **the flag is not a security boundary** — it
  is self-declared and honour-system, so this makes it mean what it says for a well-behaved caller,
  not one that lies; anything stronger is identity work. **Suite 1091/0, 19/19 suites.** One probe
  defect of mine: S2 rev 1 404'd because `webinar_sales` is a DEAL-entity pipeline and my fixture
  created no deal — a refusal for the wrong reason. Verdict `.loop/verdicts/CP-Y3-automated-coercion.md`.
  `handoff=operator`.
- 2026-08-01 11:2x [orch] `handoff=operator`. Three consecutive defects (CP-Y/Y2/Y3) were all one
  shape — **a guard that opens when its configuration is absent** — so instead of restating the
  decisions a fourth time I swept the remaining send guards for that same shape. **5/0, no new
  defect.** LinkedIn fails **CLOSED** at every level: no `linkedin_accounts` row → refused;
  account present but `disconnected` → refused; connected but `engine_dispatch_disabled=false` →
  refused; and a **positive control** proves it becomes claimable when fully configured (which also
  showed the refusals leave jobs `pending` rather than consuming them, since the control then claimed
  the accumulated backlog). **But the sweep surfaced an asymmetry an operator would never guess, and
  it is now in the deploy runbook:** email/SMS/WhatsApp fail **OPEN by design** —
  `getChannelLimits` returns `DEFAULT_LIMITS` (`max_per_hour: null, max_per_day: null`) when no row
  exists and `checkRateLimit` reads null as uncapped, documented in-code as "a valid, permissive
  state". So **on deploy a tenant with no `tenant_channel_limits` row sends UNCAPPED, with
  `LIVE_SENDS_DISABLED` as the only brake** — while LinkedIn is not exposed this way at all. Not a
  bug and not dispatched; a precondition. Runbook now carries the SQL to check it and says plainly
  that an empty result means uncapped, not safe defaults.
- 2026-08-01 11:4x [orch] `handoff=operator`. CP-Y/Y2/Y3 changed the gate the UI reads and **migration
  026 gave the legacy pipelines per-stage `mode` for the first time** — and the stage chips and advance
  menu are built from that same config, which nobody had looked at since. Drove the browser:
  **15 passed / 0 failed.** All 8 tabs render; the MANUAL person glyph survived 026; and **the real
  risk landed green** — the chip menu is built from `getPipelineTransitions()`, so a bad config shape
  after 026 would have produced an **empty** menu, which renders as "nothing is allowed" rather than as
  an error and would have shipped silently. It offers exactly the three legal targets
  (`no_show_followup_2`, `scheduled_call`, `disqualified`) with illegal ones **absent**, not disabled —
  CP-T's decision holding. Evidence in `.loop/EVIDENCE/POST-CPY/`. **Four probe defects were mine**: a
  stale shim from an earlier session already owned :8899 so mine died on EADDRINUSE and every request
  hit the old one with an old key (23 phantom 401s, six false failures) — I moved to :8903 rather than
  kill processes I had not positively identified as mine, one being `orch-resend-stub.mjs`; this shim
  serves `web/` at root not `/crm/`; I clicked the **inert** list-row chip and read its empty menu as a
  regression; and **U3's detail string was hardcoded, printing "Rowan Ellis present" while FAILING** — a
  status line contradicting its own verdict is worse than none. One console 404 remains: reproducible
  yet invisible to every page-level request event, the signature of the browser's internal favicon
  fetch — `web/` ships no favicon. Asserted on **page-level** 4xx/5xx rather than muting the console,
  so a genuine app 404 would still fail. Cosmetic, not dispatched. Verdict
  `.loop/verdicts/CP-UI-post-cpy.md`.
- 2026-08-01 11:5x [orch] `handoff=operator`, and this tick's finding was not code. **`feat/consolidation`
  did not exist on origin at all** — `git ls-remote` returned nothing, the branch tracked no upstream, and
  **39 commits / 89 files / 18,792 insertions of verified work existed only on this laptop.** One disk
  failure and every checkpoint in this log would have been gone. Pushing the *branch* is not among the
  hard rules' prohibitions (that is main) and is strictly less consequential than the push-to-main
  already pre-authorised, so I fetched origin first (parallel sessions push there), asserted the current
  branch really was `feat/consolidation` before pushing, and pushed with `-u`. **Verified the backup
  rather than trusting the success message:** remote tip `ee9e4f1` matches local HEAD exactly.
  `origin/main` is untouched at `9ff21cb`. GitHub returned a PR URL —
  https://github.com/Usetantra/denchclaw-crm/pull/new/feat/consolidation — which I did **not** open,
  because merging toward main is the operator's decision, not mine to take by momentum.
- 2026-08-01 12:0x [orch] Closed the sibling of last tick's finding. I had pushed 39 commits of **code**
  after discovering the branch never existed on origin — but the same risk was still open for the thing
  that makes those commits trustworthy: **`.loop/` was untracked**, so 15 verdicts, 13 receipts, the
  tickets and `DEPLOY_RUNBOOK.md` lived on one disk and nowhere else. Committed and pushed (`663eb1f`),
  then **verified on origin rather than trusting the push**: 15 verdicts and the runbook present, remote
  tip matches local HEAD, `origin/main` still `9ff21cb`. **Deliberate split, not an accident:** the
  markdown record is tracked because the verdicts are *reasoning* — why a robot could mark a $50,000
  deal Won, which branch the gate was hoisted above, why absent `mode` had to mean "a human owns it",
  and which of my own probes produced vacuous passes — none of which regenerates; the 3.5M of evidence
  PNGs are gitignored *with the reason written in `.gitignore`* because every one is reproducible by
  re-running a probe. `scratchpad/` stays out per the standing rule; `CONSOLIDATION_ROADMAP.md` stays
  unstaged. **Consequence worth knowing:** `.loop/STATE.json` is now tracked, so every tick will show as
  a tracked modification in `git status` for both sessions. The 10 `SESSION_HANDOFF_*.md` files are left
  untracked by choice — they were delivered inline in chat and are recoverable.
- 2026-08-01 12:1x [orch] Re-ran the **goal-conformance audit against the live system** — the copy on
  disk was from 04:39, before CP-B/C/C2/D and the whole CP-Y arc, and it listed four things as not
  built. **10/0, all four closed**, checked against behaviour on a virgin DB rather than checkpoint
  names. The marketing funnel above `prospects` is now a mechanism and not a diagram: visits,
  registrants, attendees, and **all three auto-registrant paths verbatim** — calendar YES/MAYBE,
  cold-email reply expressing interest, comment below a content post — each drove a real contact
  through the real public endpoints. That third detail is precisely what the old paraphrased spec had
  lost, which is why it was never built. Per-channel providers wired (Resend, Twilio SMS+WhatsApp,
  Unipile LinkedIn); all six borrowed automations seed 200 across four channels; no-show ladder
  cumulative `[0,3,6,9,16]`; delivery pipeline all five stages. **Retracted one gap rather than leave a
  scary zero in the record:** `crm_pipeline_configs.automations` being empty was MY OWN note about an
  unused column, never an operator ask — the automations live in `sequences`+`sequence_steps`, which is
  what the dispatcher reads. **One loose end found and dispatched as CP-Z:** `ai_call` is accepted by
  five whitelists but `executors.js` wires only Resend/Twilio/Unipile, so a step creates (201), **the
  claim door hands the job out**, and it strands in `claimed` with nothing able to send it. Not a goal
  violation — GOALS.md never asks for AI calls — but the CP-Y shape again. Specified the fix
  **generally** (derive the sendable set from the executor registry; refuse at both claim door and
  front door) rather than special-casing `ai_call`, with a positive control (Z3) so a too-narrow fix
  cannot pass.
- 2026-08-01 14:55 [build] **CP-Z DONE — `62ac44a`.** Suite **1096/0**; `unit-cpy` 66 (11 new). No migration.
  Sendable set = `Object.keys(byChannel)`; Z-1 pins the **derivation**, not a snapshot. Claim door refuses
  and leaves the job **pending** (a skipped ack advances the ladder); front door 422s naming what IS
  sendable. **`ai_call` stays** — sendable and recordable are different questions, and an AI call that
  happened out of band belongs on the timeline. Registry required **lazily** inside `claimJobs`: the
  require cycle would otherwise hand back `canSend === undefined`, failing open. **F45 filed** — the
  channel *vocabulary* is still restated in five places plus three CHECK constraints.
  Receipt: `.loop/receipts/CP-Z-channel-without-executor.md`.
- 2026-08-01 12:2x [orch] **CP-Z ACCEPTED — 10/0.** A channel with no executor can no longer be
  queued: an `ai_call` job is not claimed and stays `pending`, creation is refused at the front door
  with 422 naming the channel, and **the sendable set is derived** (`Object.keys(byChannel)`) so it
  cannot drift — which is exactly how `ai_call` got into five whitelists to begin with. **Z1b is mine,
  beyond the ticket:** a refused claim does NOT burn a retry, so a never-attempted job cannot climb to
  `MAX_ATTEMPTS` and dead-letter itself — a slow failure that would have looked like a delivery problem
  rather than a configuration one. **The builder improved on my ticket:** I offered two options for
  `ai_call` and they took neither, correctly separating **sendable** from **recordable** — an AI call
  that happened out of band is still loggable and listable, only *queuing* is refused. I verified both
  directions, because a fix that also blocked recording would have passed every criterion I wrote while
  quietly removing a capability. **Suite 1102/0, 19/19 suites.** Two probe defects were mine and both
  were **refusals for the wrong reason**: my LinkedIn positive control was refused first by the CP-C2
  safety spine (no account row) and then for a missing `linkedin_action` defaulting to `message` — both
  lessons already in my own notes. A control that fails for the wrong reason is worse than no control;
  it would have sent the builder chasing a regression that did not exist. Verdict
  `.loop/verdicts/CP-Z-channel-without-executor.md`.
- 2026-08-01 12:4x [orch] `handoff=operator`, and the gap I chased is one I had been stepping around
  for many ticks: **every number I report comes from `scratchpad/run-suite.sh` — my own mirror, which
  is deliberately never committed.** Measured the committed entrypoint instead of assuming it works:
  `npm test` → `test/run-local.sh`, which needs **Docker** (daemon unreachable here — the machine-wide
  wedge I must never restart) **or** `psql` (**not installed**), and there is **no `.github/workflows`
  at all**. So the **19 suites / 1102 tests** every verdict in `.loop/verdicts/` rests on are runnable
  only by me, by hand, on one machine, through an uncommitted script. **When this session ends the
  operator cannot run their own suite, and every green number becomes a claim they cannot check.**
  Dispatched as **CP-AA**, explicitly *not* to be fixed by committing my mirror — the mirror exists to
  work around the committed harness; the harness is what should work. `pg` is already a dependency, so
  the fix is a node applier instead of psql, with the non-local `DATABASE_URL_TEST` guard left exactly
  as strict. Carried two of my own hard-won lessons into the ticket (report `N/19 suites reported`;
  count both reporting formats) after my tally once silently dropped an 88-test suite and separately
  printed `TOTAL: 0` while 19 suites reported 1058. **AA4 is the criterion that decides it:**
  deliberately break a test and confirm the runner exits non-zero — a harness that reports green but
  cannot report red is worse than none, and I will break a test myself to check. Flagged CI as optional
  and **not** to be enabled without saying so: the org's Actions plan has a 2,000 min/month cap and a
  blown quota fails every job org-wide.
- 2026-08-01 15:45 [build] **CP-AA DONE — `6e1ac52`.** `npm test` → **1102 passed / 0 failed, 19/19 suites**,
  with **neither Docker nor psql**. `test/apply-schema.mjs` uses `pg` (already a dependency); the staging
  guard is untouched and duplicated there, **stricter** — it parses the host, so a password containing
  `localhost` is refused. Suite table is one list; the `N/19` denominator is derived. All three red paths
  proven by injection (failing assertion, crashed suite, vanished suite) — exit 1 each. **CORRECTION:** my
  hand-tallied totals were low — the real number is **1102**, not the 1096 I reported at CP-Z; no verdict
  changes, but the number was wrong, which is the error this removes. **No CI enabled** — the 2,000 min/mo
  org cap makes that the operator's spending decision. Receipt: `.loop/receipts/CP-AA-suite-unrunnable.md`.
