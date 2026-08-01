# DenchClaw CRM

Standalone Node/Express + PostgreSQL CRM microservice for the Tantra automation
engines. Runs on `:3100` (loopback) behind pm2 as `denchclaw-crm` on
`staging.usetantra.com`, host path `/home/yogi/denchclaw-crm`, own isolated
`denchclaw` database.

- API contract (authoritative): [docs/API_CONTRACT.md](docs/API_CONTRACT.md)
- Product brief: [docs/PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md)

## Run

```bash
npm install
DATABASE_URL=postgres://... INTERNAL_API_KEY=... node server/server.js
```

Schema: apply `migrate.sql` (base) then `migrations/00N_*.sql` **in order**.
Migrations are operator-applied by design — the app never auto-migrates.

## Database connection budget (box-wide rule)

The staging box runs a **shared** Postgres with `max_connections = 200`
(a handful of slots reserved for superuser). Every service on the box draws
from that same budget, and an exhausted budget shows up as
`remaining connection slots are reserved` / `too many clients`.

**Rule: the sum of all engines' pool maxes + workers on the box must stay
well under 150**, leaving headroom below the 200 ceiling for psql sessions,
backups, cron jobs, and superuser slots.

- This service caps its pool via `DB_POOL_MAX` (default **10**). Keep it modest;
  raise it only after re-checking the box-wide sum.
- When adding a new engine/worker to the box, count its pool max against the
  150 budget *before* deploying.
- The server never exits on transient connection failures: startup probes retry
  forever with exponential backoff + jitter (1s → 2s → 4s … cap 30s,
  tunable via `DB_RETRY_BASE_MS` / `DB_RETRY_CAP_MS`), and runtime pool errors
  are logged, not fatal. A crash↔restart loop under pm2 holds connection slots
  and makes the pressure worse — waiting is always safer.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | CRM's own `denchclaw` DB. Missing ⇒ fatal config error. |
| `PORT` | `3100` | HTTP port (loopback behind pm2). |
| `DB_POOL_MAX` | `10` | pg pool cap — see connection budget above. |
| `DB_RETRY_BASE_MS` / `DB_RETRY_CAP_MS` | `1000` / `30000` | Startup probe backoff tuning. |
| `INTERNAL_API_KEY` | ephemeral dev key | Single shared key (bound to `*`). |
| `INTERNAL_API_KEYS` | unset | JSON key→company binding, e.g. `{"k1":["co_a"],"k2":"*"}`. **Set this for any multi-tenant deploy** — unset binds the single key to `*` (any `X-Company-Id` accepted); the server logs a startup warning under `NODE_ENV=production`. DB-backed per-tenant keys are roadmap A3. |
| `INTERNAL_API_ALLOWED_CIDRS` | `127.0.0.1/32,::1/128` | Caller IP gate — real IPv4/IPv6 CIDR matching; loopback always allowed. |
| `DEFAULT_COMPANY_ID` | `tantra` | Company when `X-Company-Id` absent (legacy `growthclub`/`dev_company` fold to it). |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` / `CLOUDFLARE_CHAT_MODEL` | — | `/api/crm/chat` assistant. |

## Tests

The tests write rows — they run against a **local scratch DB**, never staging.
19 suites, ~1100 assertions.

**You do not need Docker.** Point `DATABASE_URL_TEST` at any local Postgres and
the harness applies the schema itself using the `pg` driver already in
`dependencies`:

```bash
DATABASE_URL_TEST=postgres://you@127.0.0.1:5432/denchclaw_test npm test
```

If you do have Docker, plain `npm test` still spins up its own `postgres:16`
container and needs nothing from you:

```bash
npm test
```

Either way it applies `migrate.sql` + `migrations/` in order, starts a local
server, runs all 19 suites, and prints a total with an `N/19 suites reported`
count so a suite that vanishes cannot hide inside a healthy number.

Useful to know:

- **Re-runnable.** The scratch schema is reset before each run, so the same
  `DATABASE_URL_TEST` works run after run.
- **It cannot point at production.** A `DATABASE_URL_TEST` whose *host* is not
  local is refused before any DDL runs. The host is parsed, not string-matched,
  so `postgres://localhost:pw@prod.example.com/live` is correctly rejected.
- **`TEST_PORT`** (default `3101`) if that port is busy. The harness refuses to
  run against a server on that port that isn't the one it started.
- A failing suite is named in the output and the run exits non-zero.

Manual invocation against an already-running server:

```bash
CRM_API_BASE=http://127.0.0.1:3101 INTERNAL_API_KEY=... PHASE=CP5 node test/contract.mjs
```
