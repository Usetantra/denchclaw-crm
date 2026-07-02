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
| `INTERNAL_API_KEYS` | unset | JSON key→company binding, e.g. `{"k1":["co_a"],"k2":"*"}`. |
| `INTERNAL_API_ALLOWED_CIDRS` | `127.0.0.1/32,::1/128` | Caller IP gate. |
| `DEFAULT_COMPANY_ID` | `growthclub` | Company when `X-Company-Id` absent. |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_AI_TOKEN` / `CLOUDFLARE_CHAT_MODEL` | — | `/api/crm/chat` assistant. |

## Tests

Contract tests write rows — run them against a **local dev server + scratch
DB**, never staging:

```bash
npm test            # boots a Docker postgres:16 scratch DB + local server,
                    # applies migrate.sql + migrations/, runs PHASE=CP5 harness
```

Manual invocation against an already-running server:

```bash
CRM_API_BASE=http://127.0.0.1:3101 INTERNAL_API_KEY=... PHASE=CP5 node test/contract.mjs
```
