# RECEIPT CP-AA-suite-unrunnable (cycle 14)

**Status: DONE.** Commit ``6e1ac52`` on `feat/consolidation`. 2 files. **No migration** — 027 still free.
**`npm test`: 1102 passed / 0 failed, 19/19 suites reported** — on this machine, which has **neither
Docker nor psql**.

## First, a correction to my own numbers

The runner now sums per-suite counts programmatically, and it reports **1102**. My hand-tallied
totals in the last few receipts were **low** — CP-Z said 1096. Every suite was 0 failed in every one
of those runs, so no verdict changes, but a number I asserted was wrong, and it drifted by
accumulating incremental additions instead of re-summing. That is exactly the class of error this
checkpoint removes: **your 1102 was right and my 1096 was not.**

## What was actually broken

Nothing in the product. What was broken is that `npm test` required Docker (daemon unreachable here)
or psql (not installed), so the suites every verdict rests on ran only through an uncommitted mirror.
**A green number nobody else can reproduce is a claim, not a result** — and I have been quoting those
numbers in every receipt.

I did not commit the mirror. The mirror existed to work around the harness; the harness now works.

## The fix

**`test/apply-schema.mjs`** — applies `migrate.sql` + `migrations/0*.sql` with `pg`, already a
dependency. No psql, no new package.

**The staging guard is untouched** in `run-local.sh` — same check, same message, same exit code 2 —
and **duplicated** in `apply-schema.mjs`, because that file can be run directly and the one thing it
must never do is apply DDL to something that is not a scratch DB. The duplicate is deliberately
**stricter**: it parses the URL and compares the **host**, so
`postgres://user:localhost@evil.example.com/db` is refused, where the shell's `*localhost*` glob
would have waved it through. Verified both.

**The suite table is one list**, and the `N/19` denominator is `${#SUITES[@]}` — derived, so a suite
cannot be added and quietly left out of the tally. That is the structural version of the failure your
mirror hit.

**Both count formats are matched** (`N passed, M failed` and `N passed / M failed`), and a suite that
ran but printed **neither** is named under `RAN BUT PRINTED NO COUNT` rather than counted as an empty
success.

## Acceptance

| | Result |
|---|---|
| **AA1** `npm test` with neither Docker nor psql | **PASS** — 1102/0, 19/19, exit 0. `psql: NOT INSTALLED` confirmed on this machine |
| **AA2** non-local `DATABASE_URL_TEST` still refused | **PASS** — identical message, **exit 2**, measured directly rather than through a pipe (a piped `$?` reports `head`'s status, which reads as 0 and would have looked like a pass) |
| **AA3** all 19 run; total matches the sum | **PASS** — per-suite sum is exactly 1102 |
| **AA4** deliberately break a test ⇒ non-zero | **PASS**, three ways — see below |
| **AA5** prints `N/19 suites reported` | **PASS**, and a vanished suite makes the run red on its own |

### AA4, and a mistake worth recording

My first attempt injected a failing `check(...)` at the first match of `check(` — which is `check`'s
own **definition**, so the suite died with a ReferenceError. It exited non-zero, so it *looked* like
a pass. It was testing the crash path, not the failing-assertion path.

Redone properly, injecting before the summary print. All three red paths now proven:

| Injected | Result |
|---|---|
| a genuinely failing assertion | `TOTAL: 1102 passed / 1 failed`, `19/19`, **exit 1**, and the FAIL line surfaces |
| a suite that crashes before reporting | `18/19 suites reported`, named under **both** `RAN BUT PRINTED NO COUNT` and `EXITED NON-ZERO`, **exit 1** |
| a suite missing from the tally | same `18/19` mechanism, **exit 1** |

`git diff --stat test/` after each run confirms only `run-local.sh` changed — the injected failures
were restored, not left behind.

## GitHub Actions: NOT enabled, and this is the explicit statement you asked for

I wrote **no** `.github/workflows`. The org's Actions plan has a **2,000 minute/month cap** on private
repos, and a blown quota **fails every job org-wide** — including for the other repos in this
programme. A test suite that boots Postgres and a server on every push is not a small consumer, and
turning that on is a spending decision with blast radius beyond this repo. It is the operator's call,
not mine.

If they want it, the shape is small: a `postgres:16` service container, `DATABASE_URL_TEST` pointed
at it, and `npm test` — which now works unmodified, since the harness no longer needs Docker or psql.
That is the whole reason this checkpoint makes CI *possible* without enabling it.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

The point of this one is that **you should not need my machine**.

| Probe | Expect |
|---|---|
| `DATABASE_URL_TEST=postgres://…@127.0.0.1:5432/scratch npm test` | 1102/0, `19/19 suites reported`, exit **0** |
| the same with a non-local URL | refused, exit **2**, message unchanged |
| `postgres://u:localhost@evil.example.com/db` into `apply-schema.mjs` | refused — the host is parsed, not pattern-matched |
| break any assertion, re-run | exit **1**, `TOTAL: … / 1 failed` |
| `process.exit(7)` at the top of any suite | exit **1**, `18/19`, suite named twice |
| delete a line from the `SUITES` table | the denominator drops with it — **this one is worth confirming**, because it is the difference between a derived count and a hardcoded one |
| `npm test` with no `DATABASE_URL_TEST` at all | falls back to Docker, unchanged |

## Gate hit
**None.** No push, no deploy, no live DDL, no secrets, no CI enabled. `CONSOLIDATION_ROADMAP.md`
left unstaged; `scratchpad/` not committed; your mirror not committed.

## Follow-ups
**F46** — `scratchpad/run-suite.sh` and my own `run-suite-build.sh` are now redundant with the
committed harness and should be deleted rather than left to drift back into being the real runner.
Not mine to delete (yours is yours), but mine will go.
**F45** channel vocabulary duplicated in five places · **F44** `DEFAULT_DEAL_STAGES` vs seeded
`sales` · **F42** no-mode stages show no UI glyph · **F43** `sequences.pipeline_key` is free text.

## Next
Unchanged: **F38, the anchored scheduler** — a port of `nurturing-engine/.../dispatcher.py:160-204`.
`registrants`, `auto_registrants` and `attendees` still trigger nothing.
