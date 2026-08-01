# TICKET CP4a-email-executor — **rev 1 WITHDRAWN. DO NOT BUILD.**

> **CRITIC: FABLE 5 → FAIL. 6 HIGH + 3 MEDIUM + 3 LOW.** Lens = double sends / lost sends /
> anything that would email a real human wrongly. **I reproduced the three worst myself.** This
> ticket is not dispatchable and its premise does not survive contact with the schema.
>
> **THE FINDING THAT INVALIDATES THE TICKET (HIGH-4): there is nothing to send.**
> `scheduleAction` materialises `payload` as literally `'{}'::jsonb`
> (`server/db/models/sequences.js:307`); `sequence_steps` carries only `template_ref TEXT`
> (`migrations/014_sequences.sql:52`) — **no subject and no body exist anywhere in the schema**;
> and `sendEmail` defaults subject to `'(no subject)'` and text to `''`
> (`server/lib/email-resend.js:23-24`). An executor built to this ticket would deliver real
> prospects a blank email with no subject. E2/E3 would go green while doing it, because they
> assert status flips and never assert content.
>
> **CP4a is therefore BLOCKED on a prerequisite the roadmap never scoped: a message-content
> store.** An email executor without message bodies is not a partial feature, it is a hazard.
> The next checkpoint is **CP4a-0 — template/content store** (migration **021**: a body +
> subject per step, or a template table `template_ref` resolves against), after which this
> ticket is rewritten as rev 2.

## The other five HIGHs, to be folded into rev 2 (all cite verified file:line)

- **HIGH-1 — D4 mandates up to 3 duplicate physical sends.** `email-resend.js:38-42` is a bare
  `fetch` with **no timeout/AbortController**. If the connection drops *after* Resend accepted,
  the mail is out but the executor sees an error; D4 says ack `failed`, the ack path requeues with
  `attempt+1` (`dispatch.js:342-345`, `MAX_ATTEMPTS=3` at `:19`) and the next poll **re-sends a
  delivered email**. Rev 2 must split failure modes: ack `failed` ONLY on a definitive pre-flight
  or 4xx rejection; on timeout/reset after the request left, **do not ack** — let the claim expire.
- **HIGH-2 — D5 is unimplementable as written.** There is **no column** to "record the attempt
  before the send" (`scheduled_actions` has no `provider_message_id` and no attempt marker; the
  ack stashes the provider id in `contact_activity.data`), no contract endpoint to record one, and
  the expiry-reclaim `UPDATE` (`dispatch.js:133-137`) **does not bump `attempt`** — so no marker
  can distinguish "crashed before send" (must send) from "sent, ack lost" (must not). Rev 2 needs
  a migration, which rev 1's FILES-TO-TOUCH and E10 both forbid.
- **HIGH-3 — the D3 staleness guard loses legitimate sends.** Staleness is measured from
  `scheduled_for`, which A5 never refreshes while deferring: quiet hours return `[]`
  (`dispatch.js:49`) and rate limits shrink the budget without touching the row. A step scheduled
  22:00 under quiet-hours-until-08:00 is 10h "stale" the moment it becomes claimable and would be
  **skipped every night by design**. Rev 2 must measure from first-claimable, or apply the guard
  only to the pre-boot backlog it was actually written for.
- **HIGH-5 — a shared `claimed_by` neutralises ack ownership.** Ownership is a string compare
  (`dispatch.js:203`). With the constant identity rev 1 proposes, instance A can hang past
  `CLAIM_TIMEOUT_MS`, B reclaims **with the same identity** and sends a second email, and both
  acks return 200. Rev 2 must mandate a per-instance identity and test expiry-reclaim, not just
  simultaneous claim (which `SKIP LOCKED` already prevents).
- **HIGH-6 — "key configured, no connected sender" shreds every active enrollment.** D2 gates on
  `isConfigured()` alone (key present), but `sendEmail` throws `'no connected sender (from)'`
  (`:17`) → ack `failed` → 3 attempts → dead-letter → `enrollments.status='exited',
  exit_reason='failed'`, which is **terminal** (`dispatch.js:599-612`, verified myself). Enabling
  the executor on a deployment with a key but no sender **permanently kills every active ladder
  within minutes**. Rev 2's boot gate must also require a resolvable sender, and a
  config-shaped error must never consume a retry.

## Folded MEDIUMs / LOWs

- **MEDIUM-2 — the staleness guard does not stop the burst, it moves it one rung down.** A
  `skipped` ack **advances** the ladder and materialises the successor at ack time
  (`dispatch.js:324-328`). Mass-skipping the backlog would fire "step 2" at people who never
  received step 1 — a *"hope you enjoyed the webinar"* with no invite. Rev 2 must choose
  explicitly: skip-and-advance, pause, or an operator flush.
- **MEDIUM-1** executor credentials and multi-tenant claim enumeration are unspecified — a
  single-tenant implementation would pass every criterion while other tenants never send.
- **MEDIUM-3** the browser script is unrunnable as written: "never point at a real provider key"
  plus a hardcoded `api.resend.com` in an untouchable file means the `pending → sent` flip needs a
  stub the ticket never specifies.
- **LOW-2 — my own claim was imprecise.** I reported "42 due-and-pending". Verified: 42 total, but
  only **32 are email**; 10 are SMS the email executor can never claim. Corrected below.
- **LOW-1** line drift: the advisory lock is `dispatch.js:57`/`:59`, not 51-52. Substance correct.
- **Refuted, and worth recording:** the same-process HTTP claim does **not** deadlock against the
  advisory lock — the executor holds no DB resources while awaiting its own HTTP call and the lock
  is xact-scoped. That concern is closed.

---

# (rev 1 text retained below for the rewrite — DO NOT BUILD FROM IT)

# TICKET CP4a-email-executor (cycle 3) — **rev 1**

Authored under standing authorisation: `.loop/CP-M_DECISION.md:46-48` — *"CP4a is rescoped by this
merge. `main` already ships the Resend sender and the inbound webhook. CP4a must **wrap** them in
the B4 claim/ack executor contract — not rebuild them. The orchestrator rewrites the CP4a ticket
accordingly after CP-M lands."* CP-M has landed (`a2045a7`) and is verified (PASS, all M1–M14).

---

## GOAL — close the loop: make the CRM actually send what it queues

CP2 made the CRM **queue** work. CP-I made it **visible**. **Nothing sends it.**

I verified this on the live tree, and it is the single largest remaining gap in the product:

- `git grep -nE "setInterval|cron|pollJobs"` over `server/` → **nothing**. There is no internal
  executor and no polling loop anywhere.
- `sendEmail` is called from exactly two places, both **human-facing**:
  `server/routes/conversations.js:224` and `server/routes/inbox.js:334`. **No call site exists on
  the `scheduled_actions` path.**
- On the scratch DB right now: **42 rows are `pending` with `scheduled_for <= now()`** — of which
  **32 are email** and 10 are SMS (corrected per critic LOW-2) — due, and nobody is ever going to
  send them.

Every green result this loop has produced for the automation chain had **me** acting as the
executor, claiming and acking by hand in the golden journey. In production, an outreach sequence
enrolls a contact, materialises step 1, and then silently does nothing forever.

CP4a makes the CRM its own email executor by **wrapping main's Resend sender in the B4 claim/ack
contract** — not by rebuilding it, and not by adding a privileged shortcut around the contract.

---

## GROUND TRUTH (verified myself — do not re-derive)

- **The sender exists and is small.** `server/lib/email-resend.js` exports exactly
  `{ isConfigured, sendEmail }`; `sendEmail({from,to,cc,bcc,subject,text,replyTo})` at `:14`.
  `isConfigured()` at `:8` is false without `RESEND_API_KEY`, and CP-I already renders that
  honestly as *"Logged — not delivered"* (`inbox.js:48,52`).
- **The contract exists and is documented.** `docs/contracts/CHANNEL_EXECUTOR_CONTRACT.md`:
  an executor polls `POST /channel-jobs/claim` for its channels, does the send, and reports via
  `POST /channel-jobs/:id/ack`. It already specifies the things CP4a must obey:
  **ack ownership is enforced** (`claimed_by` must match the claim winner), **claims expire**
  past `CLAIM_TIMEOUT_MS` so a crashed executor self-heals, `retry` on a `failed` ack tells the
  executor what happens next, and `campaign_event` is optional.
- **The claim path already enforces the safety spine.** B3 takes
  `pg_advisory_xact_lock(hashtext(company:channel))` before `checkRateLimit`
  (`server/db/models/dispatch.js:51-52`), discounts in-flight claims (`:63-72`), and applies A5
  quiet hours / rate limits / suppression at claim time. **CP4a must not bypass or duplicate any
  of it** — claiming through the real route inherits all of it for free.
- **CP2's ack path is banked and must not change.** `ackJob(status='sent')`
  (`dispatch.js:272-278`) updates `scheduled_actions` and writes a `contact_activity` row; the
  ladder advance and stage write-back run **after** the send commits, deliberately (CP2's HIGH-1).

---

## LOCKED DECISIONS

- **D1 — The executor is a real client of the public contract, not an insider.** It calls
  `POST /channel-jobs/claim` and `POST /channel-jobs/:id/ack` over the **same HTTP routes an
  external engine uses**, with its own `claimed_by` identity (e.g. `crm-internal-email`).
  **No direct `dispatch.claimJobs()` call, no in-process shortcut.** The point is that the CRM
  dogfoods its own contract: if the internal executor works, an external one provably can too.

- **D2 — Opt-in, and off by default.** Runs only when **`INTERNAL_EMAIL_EXECUTOR=1`** *and*
  `resendEmail.isConfigured()`. An operator who has not asked for autonomous sending must never
  get it by upgrading. Log one clear line at boot stating which state it is in and why.

- **D3 — `[BACKLOG SAFETY, the one that would burn a real tenant]` A staleness guard.** There are
  **42 due-and-pending rows on the scratch DB today**, some hours old. Switching an executor on
  against a real tenant would fire that entire backlog at once — to real people, for a webinar
  that may be over. **The executor must refuse any job whose `scheduled_for` is older than
  `EXECUTOR_MAX_STALENESS_MINUTES` (default 120)** and instead ack it `skipped` with a reason, so
  the ladder advances rather than stalling. Turning the executor on must be safe by default and
  loud about what it declined.

- **D4 — Delivery failure maps honestly onto the contract.** A Resend failure acks **`failed`**
  with the provider's real reason, and lets the **dispatcher** decide retry vs dead-letter — the
  contract says retry/backoff policy lives in B3, not in the executor. The executor never
  silently swallows a failure and never marks a job `sent` it did not send. This is the same
  honesty rule CP-I's D5 established, one layer down.

- **D5 — Idempotency and single delivery.** Pass the provider's id back as
  `provider_message_id` on ack. If a send succeeded but the ack fails, the job stays `claimed`
  and expires — on reclaim the executor must not send twice. Use the job id as the idempotency
  key with the provider where possible; where not, record the attempt **before** the send so a
  reclaim can detect it. **A duplicate send to a real prospect is the worst outcome in this
  ticket** — worse than a missed send, which is merely late.

- **D6 — Recipient resolution and the no-address case.** A queued job carries a contact, not an
  address. Resolve the contact's email; if there is none, ack **`skipped`** with a reason (never
  `failed`, which would retry forever against a contact that will never have an address).

- **D7 — Concurrency and politeness.** One in-flight claim batch at a time; a bounded batch size
  (`EXECUTOR_BATCH=10`); a poll interval (`EXECUTOR_POLL_MS`, default 30000). It must be safe to
  run **two** CRM processes — the advisory lock and atomic claim already guarantee that, and the
  test must prove it rather than assume it.

- **D8 — Scope.** IN: email only, via the existing Resend sender, through the existing contract,
  plus the staleness guard and its config. **OUT:** LinkedIn/WhatsApp/SMS/AI-call executors
  (those stay external engines), retry-policy changes, any change to CP2's ack path, any new
  provider. If a criterion seems to require touching `dispatch.js`'s ack logic — stop and say so.

---

## FILES TO TOUCH

- `server/lib/email-executor.js` **(NEW)** — the poll → claim → send → ack loop.
- `server/server.js` — start it when D2's conditions hold; stop it cleanly on shutdown.
- `test/unit-cp4a-email-executor.mjs` **(NEW)** + register in `test/run-local.sh`.
- **Do NOT touch** `server/db/models/dispatch.js`, `server/routes/channel-jobs.js`,
  `server/lib/email-resend.js`, or CP-I's inbox routes. If you believe you must, that is a
  finding to surface, not a change to make.

---

## EVAL CRITERIA

- **E1** With `INTERNAL_EMAIL_EXECUTOR` unset, the executor does **not** run and no job is ever
  claimed by it. Prove by leaving a due job pending across a full poll interval.
- **E2** With it enabled and Resend configured, a due queued job is **claimed via the HTTP route**
  (`claimed_by='crm-internal-email'` visible on the row), sent, and acked `sent` with a
  `provider_message_id`.
- **E3** **The whole chain runs with NO external executor and no human**: advance a contact into a
  trigger stage → CP2 queues step 1 → the internal executor sends it → the enrollment advances,
  the next step is queued, and the stage mirrors. This is the criterion the ticket exists for.
- **E4** `[D3]` A job whose `scheduled_for` is older than the staleness window is acked
  **`skipped`** with a reason and **never sent**; the enrollment still advances. Prove with a job
  backdated well past the window, and prove a fresh job in the same batch **is** sent.
- **E5** `[D4]` A provider failure acks **`failed`** carrying the real reason; the job is not
  marked `sent`; the dispatcher's retry/dead-letter policy decides what happens next and the
  executor does not re-implement it.
- **E6** `[D5]` **No double send.** Simulate a send that succeeds and an ack that fails; let the
  claim expire; reclaim. Prove the message is **not** delivered twice.
- **E7** `[D6]` A contact with no email address acks `skipped` (not `failed`), with a reason.
- **E8** `[D7]` **Two executor instances running concurrently never double-claim.** Prove against
  a batch of due jobs that each is claimed exactly once.
- **E9** A5 is still enforced **through** the executor: a suppressed contact's job is not
  claimable, quiet hours and rate limits still gate, and the executor added no bypass.
- **E10** Nothing in `dispatch.js`, `channel-jobs.js`, `email-resend.js` or the inbox routes
  changed — `git diff --stat` proves it.
- **E11** Full suite green on a fresh DB, all existing tests unmodified; report the new total.
- **E12** The **golden journey** (`scratchpad/orch-golden-journey.mjs`) still reads **12/0/0**, and
  gains a link proving the send happened **without** the harness acting as executor.

---

## BROWSER SCRIPT — I run this myself

1. Enable the executor, seed a contact, advance them into `no_show_followup_1`.
2. **Wait one poll interval and touch nothing.** EXPECT: in the Sequences → Enrollments & queue
   block, step 1 flips `pending` → `sent` **on its own**, with a `sent_at`. → `CP4A-01`
3. Open the Inbox. EXPECT: the sent message appears in that contact's thread with the
   **Sequence** badge — sent by the CRM, with no human and no external engine. → `CP4A-02`
4. The deal's stage chip has mirrored to the step's `stage_writeback`. → `CP4A-03`
5. Backdate a job past the staleness window, wait a poll. EXPECT: `skipped`, a visible reason,
   and **no** message in the thread. → `CP4A-04`
6. Console: zero errors.

---

## CONSTRAINTS

- Scratch Postgres only (`:54339`). Builder owns `:3101`; orchestrator owns `:3102` + `:8899`.
- `feat/consolidation` only. No push to main, **no deploy** — and note the standing
  deploy-blocking hazard: migrations 012–020 must be applied **before** any restart, or
  `auth.js:258-271` 401s the entire API.
- **Never point the executor at a real provider key during testing.** Use an unconfigured or
  stubbed sender; a test that actually emails a real person is a gate breach, not a pass.
- Nothing from `scratchpad/` committed. Leave the roadmap's uncommitted operator edit unstaged.
- End the receipt with a TEST BRIEF FOR THE ORCHESTRATOR, including exactly how to run the
  executor without sending real mail.
