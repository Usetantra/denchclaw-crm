# CP-Y — verdict: **ACCEPTED**

Verified independently on a virgin DB built from `HEAD` (26 schema files incl. 026), driving
the real `claimJobs → ackJob` path. The receipt had not been written when I verified; hard
evidence outranks it either way.

## Independent probe: 8 passed / 0 failed

| # | Check | Result |
|---|---|---|
| A1a | POSITIVE CONTROL — the job really was claimed + acked | PASS |
| A1b | **the defect is closed** — a robot can no longer mark a deal `won` | PASS |
| A1c | the refusal is on the timeline naming wanted/found/reason (D4b.2) | PASS |
| A2 | **POSITIVE CONTROL** — a genuinely `auto` write-back STILL APPLIES | PASS |
| A6a | POSITIVE CONTROL — custom-pipeline job claimed + acked | PASS |
| A6b | **FAIL-CLOSED ON A BRAND-NEW PIPELINE** — a mode-less stage is refused | PASS |
| A3 | the automated ADVANCE path refuses a mode-less stage — 403 `stage_not_automatable` | PASS |
| A4 | a HUMAN may still set `won` — 200 `advanced` | PASS |

A2 and A6b are the two that decide this. A2 because a fix that simply blocks all write-backs
would satisfy A1 and destroy the product. **A6b because it is the one the ticket did not ask
for:** I built a brand-new pipeline with a stage declaring no `mode` at all, and automation was
refused. That is the difference between labelling today's stages and closing the hole for every
pipeline anyone creates later. `mayAutomationSetStage` asks the positive question, so absent
mode now means "a human owns it" — the fix is the predicate, and migration 026 is the record of
which legacy stages a robot may touch, not the fix itself.

## Full suite: 1058 passed / 0 failed, 19/19 suites reported

Including the builder's new `unit-cpy-automation-gate.mjs` (22/0) and `unit-cp1` (83/0), which
they revised — a test had encoded the old behaviour, which A5 anticipated.

## Two harness defects of my own, both of which produced false alarms

1. **My suite mirror reuses a persistent scratch DB and does not apply schema.** Migration 026
   was therefore never applied to it, and the run reported **9 failures — 7 of them in the
   builder's own CP-Y suite** ("won/lost not manual"). Nothing was wrong with their code; my
   database was stale. Rebuilt `denchclaw_test` from `HEAD` exactly as `test/run-local.sh` does,
   and every one of the 9 went green. **A stale-schema scratch DB will impeach correct work
   every time a migration lands** — the mirror now has `scratchpad/rebuild-test-db.mjs`.
2. **The tally read `"$0.lastlog"`, which nothing ever writes** — so it printed `TOTAL: 0 passed`
   while 19 suites had just reported 1058. A tally reading a nonexistent file is worse than no
   tally: it prints a confident number that is always wrong. Now tees to a real log, counts both
   reporting formats, and asserts `lines == suites` so a whole suite cannot vanish again.

The drift guard did its job unprompted: it **aborted the run** rather than report a number that
silently excluded the builder's new suite.

Three probe defects were mine and are documented in `scratchpad/orch-cpy-verify.mjs`: reading
`deals.stage` for a **contact**-entity pipeline, and twice fixturing a contact outside the
pipeline so CP1's ENTRY rule refused before the mode gate was ever consulted. The second of
those made the A2 positive control look like a regression in the fix.

**Verdict: accepted.** The invariant now holds for pipelines that do not exist yet.
