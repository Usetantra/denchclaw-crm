# Handoff prompt — DenchClaw CRM: company architecture done, engine-consolidation planning next

Paste everything below the line into a new Claude Code session opened in
`/Users/adithyamurali/denchclaw-crm`.

---

You are picking up the DenchClaw CRM. Read `MEMORY.md` (auto-loaded) and these files
first: `SESSION_HANDOFF_2026_07_05_COMPANY_ARCHITECTURE.md`,
`ENGINE_RESEARCH_PROMPTS_2026_07_05.md`, and the memory files
`crm-staging-routing`, `crm-company-architecture`, `crm-trial-run-lessons`,
`crm-handoff-engine-local`. Follow the Karpathy 3-layer protocol (spec → verify →
environment); do not build multi-step without a spec + verification plan.

## Where things stand (all live on staging, verified 2026-07-05)

**Access:** staging box `ssh -i ~/Downloads/yogi-agent-key.pem yogi@staging.usetantra.com`.
CRM runs pm2 `denchclaw-crm` on loopback :3100, path `/home/yogi/denchclaw-crm`, own
`denchclaw` Postgres. Live app: https://staging.usetantra.com/crm/ (basic-auth user
`adi`, pw in `/home/yogi/ui-password.txt` on the box). **Standing user preference: end
every result message with the live URL.**

**Public routing** (`/etc/nginx/snippets/crm.conf`): UI served from `/var/www/crm/`
(NOT the repo); API at `/crm/api/...` → `:3100/api/crm/...` with nginx injecting
`x-internal-key` + `x-company-id: tantra`. Deploy = commit→push→box `git pull`→
`sudo cp web/<file> /var/www/crm/`.

**Just shipped** (origin/main @ `7599ba0`): single-tenant consolidation + normalized
company entity. Migration 011 folded legacy tenants (`growthclub`,`dev_company`) into a
single tenant **`tantra`**; added `company_ref_id` FK on contacts+deals; auto-identifies
the employer account on every ingest (2+-contact rule; deals force-create); backfilled
257 accounts / 541 linked contacts. Company detail drawer + `/companies/:id/contacts`
and `/:id/deals` endpoints. Contract suite 46/46 + focused 11/11; Codex-critic-reviewed
migration; live-verified. See the company-architecture handoff for receipts + rollback.

## The strategic direction (this is the real work now)

We're consolidating the outreach / nurturing / content "engines" with the CRM. The
framing: every engine is a tangle of four concerns — (1) system of record/state,
(2) sequence definitions, (3) orchestration (the always-on brain), (4) channel
execution. **Target: move #2 + #3 into the always-on DenchClaw CRM; leave the engines
as thin, per-channel executors; content engine becomes a called service.** Kills the
current split-brain where `prospect_inbox`/`campaigns`/`campaign_events` are per-engine,
locality-coupled, in separate DBs (see `crm-handoff-engine-local`).

**Locked decisions (2026-07-05):**
- **Productize → multi-tenant is first-class.** Each customer org = a tenant. Invest in
  tenant isolation now (per-tenant channel credentials, rate limits, data isolation,
  billing). This shapes every new table (`company_id`-scoped) and the auth model.
- **Recon first, then spec.** The user is running 4 engine-recon prompts (from
  `ENGINE_RESEARCH_PROMPTS_2026_07_05.md`) in the outreach / nurturing / content /
  automation_core repos, producing `CONSOLIDATION_RECON_<engine>.md` reports.

## Your immediate next step

When the user brings back the 4 recon reports, synthesize a **tenant-first consolidation
spec**: target architecture (CRM = record + orchestration brain; engines = channel
executors; content = called service); CRM-owned multi-tenant data model (`sequences`,
`sequence_steps`, `enrollments`, `scheduled_actions`, plus CRM-owned `prospect_inbox`/
`campaigns`/`campaign_events`, all `company_id`-scoped); per-tenant channel layer
(credentials/rate-limits/quiet-hours/suppression); and a phased cutover that never takes
the pipeline offline (prove one channel end-to-end first, then migrate engine-by-engine).
If reports aren't ready, help run the recon prompts or start speccing the CRM sequence
engine in parallel (the user may pick either).

## Multi-tenancy debt to fix as part of productizing (audited this session)

- CRM has real tenant scaffolding (key→company binding, CIDR guard, `company_id` on all
  tables, cross-tenant isolation proven by contract tests) but is **run single-tenant**
  (one key=`*`, nginx hardcodes one company, legacy-id fold in `auth.js`).
- **Latent leaks to close:** `findContactByPhone` (crm.js:1521) does an unscoped
  `contactDb.list(null,…)` across all tenants (0 callers today); the `getById →
  getByIdUnscoped` null-fallback in `server/db/models/contacts.js`.
- Productizing means: real tenant resolution (subdomain/API-key → tenant, not a
  hardcoded nginx header), per-tenant key issuance, and per-tenant secret storage for
  channel providers (today secrets are global `.env` — which the agent must NEVER edit).

## Gotchas / rules

- `git fetch origin` before committing — parallel sessions push to this repo; check
  `migrations/` numbering against origin (next is 012).
- Box-wide Postgres `max_connections=200` shared across all engines; keep pool maxes well
  under 150. `pm2 restart` while a `pg_dump` runs spikes connections → transient
  fatal-startup; the server's backoff-retry self-recovers in ~30s — do NOT restart again.
- The company-name blocklist lives in BOTH `server/db/models/companies.js` and
  `migrations/011_company_normalization.sql` — keep in sync.
- Never edit `.env`/secrets/`*.pem`/`.git` internals or the live app DB schema without
  explicit user authorization + a `pg_dump -Fc` backup first (operator-gated DDL).
- Migrations are operator-applied (never auto-migrate); test on a Docker scratch DB via
  `npm test` (postgres:16, applies migrate.sql + migrations/, runs PHASE=CP5).

Live app: https://staging.usetantra.com/crm/ · Workflow reference:
https://staging.usetantra.com/crm/denchclaw-crm-workflow.html
