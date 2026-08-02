# VERDICT — CP4a-email-executor → **PASS**

**Commits:** `f47bce4` (rev 2) + `30898e6` (both injected risks) + `a5f9e58` (harness guard)
**Receipt:** `.loop/receipts/CP4a-email-executor.md` · **Evidence:** `.loop/EVIDENCE/CP4a/`
**Verified by:** orchestrator/tester, 2026-08-01, independently.

## Context
Rev 1 was WITHDRAWN after a Fable critic returned 6 HIGHs, the worst being that **there was
nothing to send**. CP4a-0 fixed that. This is rev 2, built against the five surviving HIGHs.

## What I verified myself

| Check | Result | Evidence |
|---|---|---|
| Full suite, my own rebuilt DB | **774 passed / 0 failed** | Nothing pre-existing regressed. |
| Migration 022 applies 2nd **and** 3rd time | **PASS** | Adds `send_started_at`, `provider_message_id`. |
| **NO DOUBLE SEND across an expiry-reclaim** | **PASS** | The criterion this checkpoint exists for. Stub provider on :8899 made to **hang 9s** with `CHANNEL_JOB_CLAIM_TIMEOUT_MS=2000`, so the claim expired **mid-send**; a second instance then ticked. **Exactly ONE physical send reached the provider.** |
| `send_started_at` stamped **before** the provider call | **PASS** | `send_started=true` while A was still inside the hanging send — so the reclaim guard has something to see. |
| Second instance refused the in-flight job | **PASS** | 1 send during the hang, not 2. |
| Job settles correctly | **PASS** | `status=sent`, `provider_message_id=stub-1`. |
| **R8 — claim expiry must not consume delivery attempts** | **PASS** | Two forced expiry-reclaims left `attempt` at **1 → 1**, and the enrollment stayed **`active`**, not `exited`. This was the risk I injected: MAX_ATTEMPTS=3 dead-letters, and a dead-letter sets `enrollments.status='exited'` **terminally**, so claim churn burning attempts would have killed ladders permanently. |
| Boot gate requires a **resolvable sender**, not just a key (HIGH-6) | **PASS** | Proven accidentally and convincingly: my own probe misconfigured `CHANNEL_SENDERS` and the gate **refused to send**, returning "no explicitly configured sending address for email". It also refuses to fall back to `crm.js`'s built-in default addresses, so an operator who configured nothing can never send real outreach from an address they never chose. |
| Never touches a real provider | **PASS** | Entire verification ran against a local stub via `RESEND_API_BASE`. |

## Design calls I checked and agree with
- **`definitive` vs `outcomeUnknown`.** A 5xx is treated as *unknown*, not definitive — correct, because an upstream error after acceptance is indistinguishable from one before it. Unknown outcomes are **quarantined**, keeping `send_started_at`, so the row is never re-served.
- **The batch/timeout hazard was anticipated in code** (`email-executor.js:132-140`): 25 jobs × 15s can exceed CLAIM_TIMEOUT_MS, letting a second tick legitimately reclaim a job the first hasn't reached, after which the first would stamp and send it *again*. Guarded with a conditional UPDATE requiring ownership + still-claimed + no send started; zero rows updated means skip. That is the subtle case and it is handled.
- **Token guard relaxed correctly**: only *known* tokens block, so `{growth}` prose sends; `{{escape}}` supported; a `warnings` array surfaces typos like `{frist_name}` without blocking.

## Anomalies — **every one was mine again** (four this pass)
1. `query() called before initDatabase()` — imported models without initialising the DB layer.
2. `CHANNEL_SENDERS` shape wrong (`address` vs **`identity`**) — the boot gate correctly refused.
3. **"Two physical sends" was NOT a double send.** `tick()` claims a *batch*; the two sends went to
   **different recipients** (`milo-…`, `dana-…`), each once. I conflated a batch with a repeat.
4. Residue from earlier runs left my probe's subject on multiple rows, amplifying (3).
With `EMAIL_EXECUTOR_BATCH=1` and residue cleared: **6/6 clean.**

## Follow-up
**F-CP4a-1** — the claim door's token list is a hardcoded SQL literal `\{(first_name|company|stage)\}`
duplicating `KNOWN_TOKENS = ['first_name','company','stage']` in `ai-draft.js:49`. They agree today;
they will drift the first time a token is added. Derive the pattern from the single source.

## Verdict
**PASS.** The CRM can now send what it queues, and — the part that matters — **a claim expiring
mid-send does not email a prospect twice**, proven against a deliberately hanging provider. The
boot gate cannot be tricked into sending from an unconfigured identity, and claim churn cannot
silently kill a ladder.

---

# ADDENDUM — second, independent orchestrator pass (06:0x, parallel session)

A **second orchestrator ran this checkpoint concurrently** and did not see the verdict above until
after finishing. Its pass agrees with **PASS** and adds three findings the pass above does not
contain. Recorded here rather than as a competing verdict.

**Independently re-driven and confirmed:** suite `SUITE_FAILED=0` on a dropped-and-recreated
`denchclaw_test` (cp4a-exec 83, cp4a0 83, cp2 143, cpi 137, cp1 83, all prior 0-failed); migrations
002–022 applied a **2nd and 3rd** time clean; the claim door empirically refuses contentless jobs.
All on **:3102**, each run proving its own key is accepted before trusting a result (A5).

**Not re-driven by this pass:** the duplicate-send proof and the quarantine/release semantics —
the verdict above drives them, so they are covered, but by one pass rather than two.

**Caveat:** partway through, the builder began CP-B (untracked `migrations/023_marketing_ingestion.sql`,
`server/lib/stage-authority.js`, `server/lib/reply-classify.js`, modified `server/routes/crm.js`).
`git status` confirms `dispatch.js`/`templates.js`/`email-executor.js` stayed identical to HEAD, so
CP4a findings hold; the golden-journey numbers below came from a moving tree.

## F1 (MEDIUM-HIGH) — a job queued before its copy exists is stuck FOREVER
`materializeNextStep()` (`sequences.js:291-342`) **freezes** `content_resolved` into
`scheduled_actions.payload`; the claim door reads that frozen flag; **nothing re-resolves it.**
The claim door's own comment — *"become claimable the moment their copy is authored"* — is false:

```
PENDING BEFORE: noshow_fu1  pending  content_resolved=false  body=''
POST /api/crm/templates {ref:'noshow_fu1'} -> 201 ; GET -> 200, body present
POST /api/crm/channel-jobs/claim           -> 200, jobs claimed: 0
ROW AFTER:      noshow_fu1  pending  content_resolved=false  body=''
```
The operator takes the exactly-correct remedial action and the ladder stays dead. Recovery today
needs DB surgery. This lands hardest on the migration path the GOALS ask for: porting existing
outreach/nurturing sequences materialises jobs before their copy exists in the new store.

## F2 (HIGH) — readiness then tells the operator the OPPOSITE of the truth
`sequenceContentReadiness()` resolves **steps**, not queued rows. Once the template exists the
sequence reports clean while the row queued from that same step is permanently unclaimable:

```
readiness BEFORE authoring: sendable=false unresolved_steps=1
readiness AFTER  authoring: sendable=true  unresolved_steps=0
claim after authoring: 0 job(s)   stuck row: pending / content_resolved=false
```
`templates.js:244` calls `sendable` *"the one line an operator needs: is this sequence safe to
switch on?"* — here it answers **yes** about a ladder that will never send.

**Cheapest fix:** re-resolve at the claim door for `content_resolved=false` rows instead of trusting
the frozen flag (the resolver is already reachable there); failing that, make readiness count queued
unresolved rows so `sendable` cannot lie. A one-shot re-resolve endpoint unblocks operators but
leaves the trap armed.

## F3 (MEDIUM) — the standing golden journey is STALE and has been red unnoticed
`scratchpad/orch-golden-journey.mjs` reads **8 PASS / 4 FAIL** (L4, L5a, L6, L7), not 12/0/0.
**Root cause is the fixture, not the build:** the CP2 seed authors copy for `guard_proposal` only,
so the ladder steps (`noshow_fu1`, `fast_fu1`) are correctly refused at the content gate and every
downstream link fails. **The 12/0/0 baseline predates CP4a-0 and the journey was never re-run after
it landed.** It must grow a content-authoring step plus a link asserting the gate itself
(contentless ⇒ not claimable → author ⇒ claimable) — **that link is blocked on F1**, because today
authoring copy does not make it claimable.

`scratchpad/orch-full-chain.sh` now does reset → apply → seed → boot → journey as one reproducible
command (previously the `IDS` env was hand-assembled each cycle, which is how a stale run gets
mistaken for a regression).

## Two anomalies that were the tester's own, again
- Re-running `apply-sql.mjs` for idempotency failed with `relation "contacts" already exists`.
  **My probe, not a defect:** `migrate.sql` is a non-idempotent base schema and
  `scratchpad/apply-migrations-only.mjs` already existed saying so.
- My runner used `node apply-sql.mjs | tail -2 || exit 1` — a pipeline's status is `tail`'s, so a
  failed migration would have sailed through and I would have verified a stale DB. Fixed with `$?`.

**Evidence:** `.loop/EVIDENCE/CP4a-email-executor/` — `orch-full-chain.sh`,
`orch-stuck-content-probe.mjs`, `orch-readiness-divergence.mjs`.
