# CP-AA — verdict: **ACCEPTED**

Verified independently at `6e1ac52`. **This is the checkpoint that makes every other verdict in
this directory checkable by someone other than me.**

## Result

| # | Check | Result |
|---|---|---|
| AA1 | `npm test` completes with **neither Docker nor psql**, from an **empty** DB | PASS — `1102 passed / 0 failed`, `SUITE GREEN` |
| AA2 | a non-local `DATABASE_URL_TEST` is still refused | PASS — exit **2**, same FATAL message |
| AA3 | all 19 suites run; total matches the per-suite sum | PASS — `19/19 suites reported` |
| AA4 | **POSITIVE CONTROL — the runner can report RED** | PASS — see below |
| AA5 | prints `N/19 suites reported` so a vanished suite cannot hide | PASS |

`psql` was confirmed **absent** on this machine during the run, and the Docker daemon is
unreachable, so AA1 is a real demonstration rather than a lucky fallback.

## AA4 — the one that decides it

A harness that reports green but cannot report red is worse than no harness, so I broke a real
test rather than trusting the claim. Injecting one failing assertion into `test/unit-tenants.mjs`:

    TOTAL: 1102 passed / 1 failed
    19/19 suites reported
    !! EXITED NON-ZERO: unit-tenants
    SUITE FAILED
    EXITCODE=1

It reports the failure, **names the failing suite**, and exits **1**. The injected assertion has
been removed and `test/unit-tenants.mjs` is byte-identical to HEAD again (verified with
`git diff --quiet`).

## What the builder got right beyond the letter of the ticket

- The staging guard is **duplicated inside `test/apply-schema.mjs`** rather than trusted from the
  caller, because that file can be run directly. Defence in depth on the one guard that stops this
  harness ever pointing at production.
- CI was **not** enabled, and they said so explicitly in the receipt with the reasoning — the
  2,000 minute/month cap and the org-wide blast radius of a blown quota. The checkpoint makes CI
  *possible* without spending the operator's decision for them. That is exactly the line I asked
  for and it was respected.
- `unit-cpy-automation-gate` grew from 22 to **66** tests along the way.

## Two probe defects of mine

1. I used `timeout` — **which macOS does not have.** I had already learned this building the
   watchdog and wrote a portable `run_with_timeout` for exactly this reason, then reached for
   `timeout` anyway. `npm test exit=127` was my shell, not the harness.
2. My first AA4 injection was appended to the **end of the file, after `process.exit()`** — so it
   never executed, and the suite reported an unchanged `1102 / 0`. I nearly had a **false GREEN
   that would have "confirmed" AA4 while proving nothing.** Caught it because the total was
   byte-identical to the clean run, which is exactly the tell. Re-injected inside the flow, before
   the exit, and it failed properly.

**Verdict: accepted.** `npm test` now works for anyone with node and a local Postgres. The 1102
tests are no longer a claim only I can make.
