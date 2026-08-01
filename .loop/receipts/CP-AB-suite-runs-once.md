# RECEIPT CP-AB-suite-runs-once (cycle 15)

**Status: DONE.** Commit ``82ccfbb`` on `feat/consolidation`. 1 file. **No migration** — 027 still free.
**`npm test` three consecutive times on one database: `1102 / 0`, `19/19`, exit 0, byte-identical.**

## Your repro was the right one

Running it **twice** is what a real user does, and it is the thing I did not do. Every CP-AA number I
reported came from a run against a database I had just dropped and recreated by hand — so I proved
the harness works and never proved it works *the way a contributor would use it*. That gap is the
whole checkpoint.

## The fix, and the one I did not take

`apply-schema.mjs` resets the public schema before applying. **Not** by adding `IF NOT EXISTS` to
`migrate.sql` — you were right about why, and it is worth restating: that would let a **partially**
applied schema pass silently as complete, which is a worse failure than a loud one, and `migrate.sql`
is the production base schema rather than a test fixture. `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
is at `migrate.sql:4`, so dropping the schema is safe — the extension comes straight back.

## The reset is guarded twice, and the second guard earned its place immediately

**Guard 1 — the URL host**, already in the file from CP-AA. It exits the process, and nothing runs
between it and the reset, so the DROP is **unreachable** for a non-local URL rather than merely
unlikely to run against one. **Proven by ordering, not by inspection:** pointing at
`nonexistent.invalid` returns the guard's message, not a DNS error — if the guard ran after
`connect()`, that would have been `EAI_AGAIN`.

**Guard 2 — the server actually reached**, via `inet_server_addr()`. A hosts-file entry or an SSH
tunnel can make `localhost` resolve somewhere else entirely, and this is the one statement in the
repo where being wrong is unrecoverable. A `NULL` result (unix socket) is local by construction.

**And guard 2 rejected the local server on its very first run.** `inet_server_addr()` is an `inet`,
so `::text` yields `127.0.0.1/32` and my compare against `'127.0.0.1'` failed — three runs of
`FATAL: connected to a NON-LOCAL server (127.0.0.1/32)`. That is the correct direction for a guard to
fail in, and I would rather report it than quietly fix it, because it is the only evidence anyone has
that the second guard is live rather than decorative. `host()` fixes the format.

## Acceptance

| | Result |
|---|---|
| **AB1** two runs on the same `DATABASE_URL_TEST`, green both | **PASS** |
| **AB2** three runs, still green | **PASS** — exit 0 each time |
| **AB3** non-local refused **before** anything destructive | **PASS** — `nonexistent.invalid` → guard message not DNS error (which is what proves ORDER); `localhost` hidden in a password → refused; unparseable → refused. All exit 2 |
| **AB4** totals identical run to run | **PASS** — `1102 / 0` and `19/19` three times, `uniq -c` shows one distinct value each. Also checked the DB directly: `contacts` and `tenants` row counts are **identical** after run 3 and run 4, so no state accumulates |
| **AB5** AA4 still holds through the reset path | **PASS** — injected failure → `1102 passed / 1 failed`, `19/19`, `!! EXITED NON-ZERO: unit-tenants`, exit **1**; and green again on the very next run, same database |

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

| Probe | Expect |
|---|---|
| `npm test` twice, same local `DATABASE_URL_TEST` | green both, `1102 / 0`, `19/19` |
| a third and fourth time | identical; row counts unchanged between runs |
| non-local URL, including one that cannot resolve | exit **2**, guard message — **not** a connection error. That difference is the proof the DROP is unreachable |
| `postgres://u:localhost@evil.example.com/db` | refused on the **host**, not the string |
| break a test, re-run | exit **1**, suite named; then unbroken → green, no manual dropdb |
| `npm test` with no `DATABASE_URL_TEST` | Docker path, unchanged |

**Worth knowing if you probe guard 2:** it only fires when the URL passes guard 1 but the connection
lands somewhere non-local — a tunnel or a hosts-file entry. There is no way to trigger it with a URL
alone, which is why the accidental `127.0.0.1/32` rejection above is the useful evidence that it runs
at all.

## Gate hit
**None.** No push, no deploy, no live DDL, no secrets, no CI. `CONSOLIDATION_ROADMAP.md` unstaged,
`scratchpad/` not committed. The only destructive statement added is `DROP SCHEMA` behind two guards
on a scratch database.

## Follow-ups
**F47** — the reset makes the scratch DB single-tenant to one run; two `npm test` invocations against
the **same** `DATABASE_URL_TEST` concurrently would now have one drop the other's schema mid-run.
Previously they would merely have collided on the port guard. Worth a note in the README or an
advisory lock if anyone ever runs them in parallel.
**F46** scratchpad mirrors now redundant · **F45** channel vocabulary duplicated · **F44**
`DEFAULT_DEAL_STAGES` vs seeded `sales` · **F42** no-mode stage UI glyph · **F43**
`sequences.pipeline_key` free text.

## Next
Unchanged: **F38, the anchored scheduler**. `registrants`, `auto_registrants` and `attendees` still
trigger nothing.
