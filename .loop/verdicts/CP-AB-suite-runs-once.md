# CP-AB — verdict: **ACCEPTED**

Verified independently at `82ccfbb`.

## Result

| # | Check | Result |
|---|---|---|
| AB1 | `npm test` twice on the **same** DB | PASS — both `1102 / 0`, exit 0 |
| AB2 | a **third** run, still green | PASS — `1102 / 0`, exit 0 |
| AB3 | **the DROP is unreachable for anything non-local** | PASS — 6/6 refused, exit 2 |
| AB4 | totals identical run to run — no state leaking forward | PASS — `1102 / 0` × 3 |
| AB5 | **AA4 still holds — the reset path does not swallow failures** | PASS — see below |

Before this change, run 2 was `FATAL: relation "contacts" already exists`, deterministically.

## AB3 — I tried to defeat the guard, not just confirm it

The guard parses the URL and checks the **host**, rather than pattern-matching the string. So I
gave it the cases that break substring checks:

| `DATABASE_URL_TEST` | Result |
|---|---|
| `postgres://u@prod.example.com/live` | refused, exit 2 |
| `postgres://localhost:pw@prod.example.com/live` — *"localhost" in the credentials* | **refused** |
| `postgres://u@prod.example.com/localhost` — *"localhost" as the database name* | **refused** |
| `postgres://u@10.0.0.5/db` — private-range remote IP | refused |
| `not-a-url` | refused, "not a parseable URL" |
| empty | refused, "is required" |

Any `rc=0` there would have meant a `DROP SCHEMA` reached a database it should never touch. None did.
Parsing the host instead of matching a substring is what makes rows 2 and 3 safe, and those are
exactly the shapes a careless implementation gets wrong.

## AB5 — the reset must not hide red

    TOTAL: 1102 passed / 1 failed
    19/19 suites reported
    !! EXITED NON-ZERO: unit-tenants
    SUITE FAILED
    EXITCODE=1

A reset path that quietly re-ran or swallowed a failing suite would have produced a green run here.
Injected assertion removed; `test/unit-tenants.mjs` is byte-identical to HEAD (`git diff --quiet`).

## An unrelated thing this run caught, worth recording

My third run first failed with:

    FATAL: :3117 answered /health but rejected our key (HTTP 404).

That was **not** CP-AB. `:3117` was a **`content-engine` vite dev server** — a different project
on this machine. Two things worth noting: the committed harness has an **ownership guard** that
refused to run against a foreign server rather than producing meaningless output, which is the
right behaviour and the same protection I had to add to my own mirror after 88 phantom 401s; and I
identified the process before killing anything, because it belonged to neither this project nor
the builder.

**Verdict: accepted.** `npm test` is now repeatable, guarded, and still able to report red.
