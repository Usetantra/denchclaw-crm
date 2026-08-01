# CP-AA — nobody but me can run the test suite. Fix the committed entrypoint.

**Severity: high, and it is about durability rather than correctness.** Nothing here is broken in
the product. What is broken is the operator's ability to verify it without me.

## The situation, measured

    npm test  →  bash test/run-local.sh
    run-local.sh needs:  Docker (postgres:16 container)   ← daemon unreachable on this machine
                    OR:  psql, to apply schema            ← NOT INSTALLED
    .github/workflows:   does not exist                   ← nothing runs these tests automatically

So the **19 suites / 1102 tests** that every verdict in `.loop/verdicts/` rests on are, today,
runnable only through `scratchpad/run-suite.sh` — a mirror that is deliberately never committed,
on one machine, driven by hand. **When this session ends, the operator has no way to run their own
suite.** Every green number becomes a claim they cannot check.

Do not "fix" this by committing my mirror. The mirror exists to work around the committed harness;
the committed harness is what should work.

## Fix

`pg` is **already** a production dependency (`dotenv, express, pg, uuid`), so the schema can be
applied from node with **no new dependency and no psql**.

1. Replace `apply_sql()`'s `psql` path with a small node applier (read file → `client.query`),
   used whenever `DATABASE_URL_TEST` is set. Keep the Docker path as-is for anyone who has it.
2. Drop the `command -v psql` hard requirement — it is now only needed for the Docker path, which
   already has psql *inside the container*.
3. **Do not weaken the staging guard.** The refusal of a non-local `DATABASE_URL_TEST` must stay
   exactly as strict; that guard is the reason this harness can never point at production.
4. Carry over two lessons my mirror learned the hard way, so the committed runner has them too:
   - **completeness**: report `N/19 suites reported` alongside the total, and warn loudly if a
     suite ran but printed no count. My tally silently dropped an entire 88-test suite once, and
     separately printed `TOTAL: 0` while 19 suites had just reported 1058.
   - **both formats**: suites print either `N passed, M failed` or `N passed / M failed`. Count both.

## Acceptance criteria

- AA1 `npm test` runs to completion with **neither Docker nor psql available**, given only
  `DATABASE_URL_TEST` pointing at a local scratch DB.
- AA2 a non-local `DATABASE_URL_TEST` is still refused, with the same message and exit code.
- AA3 all 19 suites run, and the reported total matches the sum of the per-suite counts.
- AA4 **POSITIVE CONTROL — this is the one that matters.** Deliberately make one test fail and
  confirm the runner **exits non-zero**. A harness that reports green but cannot report red is
  worse than no harness, and I will test exactly this by breaking a test myself.
- AA5 the run prints `N/19 suites reported` so a vanished suite cannot hide inside a healthy total.

Optional, only if it is quick and you flag it clearly: a minimal `.github/workflows` running
`npm test` against a `postgres:16` service. **Do not enable it without saying so in the receipt** —
the org's Actions plan has a 2,000 min/month cap and a blown quota fails every job org-wide.

Receipt to `.loop/receipts/CP-AA-suite-unrunnable.md`.
