# CP-AB — `npm test` works exactly once per database

**Severity: high (usability).** CP-AA is what surfaced this, and CP-AA is still correct — but the
path it opened up for everyone without Docker works **once**, and then fails forever.

## Measured

    run 1 on an empty denchclaw_rr:  TOTAL 1102 passed / 0 failed · SUITE GREEN · EXITCODE=0
    run 2 on the SAME database:      FATAL: migrate.sql failed to apply:
                                            relation "contacts" already exists
                                     FATAL: schema failed to apply · EXITCODE=2
    run 3:                           identical failure — deterministic, not a race

## Why

`migrate.sql` is **not idempotent**: 4 bare `CREATE TABLE` statements, **0** with
`IF NOT EXISTS`. That never mattered before because the Docker path spins up a **fresh container**
per run, so the database was always empty. CP-AA correctly made `DATABASE_URL_TEST` the path
anyone without Docker uses — and **that database persists between runs.**

So the first `npm test` a new contributor runs is green, and the second is `FATAL`. They will
reasonably conclude the suite is broken rather than that it needs a manual `dropdb`.

## Fix

Reset the scratch schema before applying, inside `test/apply-schema.mjs`:

    DROP SCHEMA public CASCADE; CREATE SCHEMA public;

**Guard it with the same non-local check that is already duplicated in that file** — you put that
guard there precisely so the file is safe when run directly, and this is the operation that makes
it matter most. A `DROP SCHEMA` must be unreachable for any non-local `DATABASE_URL_TEST`.

Do **not** instead sprinkle `IF NOT EXISTS` through `migrate.sql`. That would make a *partially*
applied schema silently pass as complete, which is a worse failure than a loud one — and
`migrate.sql` is the production base schema, not a test fixture.

## Acceptance criteria

- AB1 `npm test` twice in a row against the **same** `DATABASE_URL_TEST` is green both times.
- AB2 three runs, still green — no slow accumulation (leftover rows shifting a count).
- AB3 **POSITIVE CONTROL** — a non-local `DATABASE_URL_TEST` is still refused **before** any
  destructive statement runs. Prove the DROP is unreachable there, not merely unlikely.
- AB4 the totals are identical run to run (`1102 / 0`, `19/19`), so no test is leaking state into
  the next run.
- AB5 **AA4 still holds** — break a test, confirm the runner still exits non-zero. Do not let a
  reset path swallow failures.

Repro is trivial: `npm test` twice with `DATABASE_URL_TEST` set to any local scratch DB.
Receipt to `.loop/receipts/CP-AB-suite-runs-once.md`.
