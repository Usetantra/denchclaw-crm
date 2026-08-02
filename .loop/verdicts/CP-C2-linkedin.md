# VERDICT — CP-C2 LinkedIn executor + safety spine → **PASS**

**Commits:** `1a04bad` + `03e6111` · **Receipt:** `.loop/receipts/CP-C2-*` · **Evidence:** `.loop/EVIDENCE/CP-C2/`
**Verified by:** orchestrator/tester, 2026-08-01, independently.

## Why this one got the hardest look
On email a rate mistake is an apology. On LinkedIn it gets the **account restricted**, and that is
not recoverable. So the only question that mattered was whether the safety spine is real or
decorative — and I refused to issue a verdict last tick precisely because I could not yet prove it.

## The safety spine, verified at the CLAIM DOOR — 7 passed / 0 failed
`scratchpad/orch-cpc2-verify.mjs`, with a **positive control established first** so no refusal
below is vacuous:

| | |
|---|---|
| **C0 baseline** | with the window open the job **IS** claimable — the gate is not simply blocking everything |
| **A1** | **out of window ⇒ the CLAIM DOOR refuses to hand the job out at all** — not the executor declining afterwards |
| **A2** | …and the job is left **PENDING**, not consumed or skipped |
| **B1** | **kill-switch flipped mid-run stops the very next claim** — per tick, not per boot |
| **B2** | …and the job survives as pending |
| **B3** | …and clearing it **resumes immediately**, again with no restart |
| **C1** | the kill-switch is **global** — it stops email too, not just LinkedIn |

The gate is consulted **inside `claimJobs`**, in-transaction and under the advisory lock, via a
`CHANNEL_GATES` registry so email/SMS/WhatsApp are untouched. The builder's own comment says why
better than my instruction did: *"LinkedIn restricts ACCOUNTS rather than messages, so its limits
have to be enforced where jobs are handed out rather than where they are sent."*

## Design decisions I checked and want on the record
- **`engine_dispatch_not_confirmed_disabled`** — the CRM **refuses to send LinkedIn at all** until an
  operator has explicitly confirmed the *outreach engine's own* LinkedIn dispatch is off. Two systems
  driving one account is exactly how it gets restricted. **I did not ask for this and should have.**
- **Fails closed, consistently**: an empty `active_days` means "no days", not "every day"; a window
  where `end <= start` is treated as CLOSED rather than "always open" — the note calls out that
  upstream's pacer does the opposite and would turn a misconfiguration into unlimited sending.
- **`linkedin_action` defaults to `message`, not `invite`**, because defaulting to invite "would fire
  connection requests nobody asked for". A safe default in the direction that matters.
- **An unknown timezone logs loudly** rather than silently evaluating the window in UTC.
- **`LIVE_SENDS_DISABLED` reuses upstream's own variable name**, so one setting stops the CRM and the
  engines together — during an incident nobody has to remember two.
- Per-account caps: daily per-type + daily total + weekly invite + pending-invite ceiling + pacing.

## Regression checks
- **Full suite 900 passed / 0 failed** across 16 suites (CP-C2 contributes 88).
- **Migration 024 applies a 2nd and 3rd time** clean.
- **CP4a's no-double-send re-verified after `channel-executor.js` changed again: 4/0**, exactly one
  physical send with the claim expiring mid-send.
- `UNIPILE_API_BASE` seam present and strips trailing slashes.

## Anomalies — every one was mine, across two ticks
1. Fixture omitted `engine_dispatch_disabled` ⇒ gate refused ⇒ **the baseline failed and every
   "refusal" was vacuous.** I declined to issue a verdict rather than bank them.
2. `linkedin_action` NULL defaults to `message`, which needs connection evidence; `invite` is the
   clean positive control.
3. **`active_days` holds weekday NAMES** (`'Mon'`…), matching `Intl`'s `weekday:'short'`. I inserted
   numbers `{1..7}`, which can never match `'sat'`. I checked the schema default before blaming the
   code — it is `ARRAY['Mon'..'Fri']`, consistent, so this was mine.
4. Stale accounts from earlier probe runs meant the gate could resolve an account other than my
   fixture's; the probe now clears them first.

## Verdict
**PASS.** LinkedIn sends only inside its window, only under its caps, only when the operator has
confirmed the engine is not also sending, and stops within one tick of the kill-switch — all
enforced where jobs are handed out rather than where they are sent.
