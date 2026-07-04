# Handoff + loop prompt — DenchClaw consolidation (multi-tenancy + sequence engine)

Open a new Claude Code session in `/Users/adithyamurali/denchclaw-crm`. To START THE
LOOP, paste the one-line `/loop` command in section ③. To brief a session WITHOUT the
loop, paste section ② instead.

---

## ① The two goals (definition of done)

Run until BOTH are achieved end-to-end, tracked in `CONSOLIDATION_ROADMAP.md`:
- **GOAL A — multi-tenancy end-to-end** (each customer org = a tenant; tenant isolation
  is first-class: per-tenant keys, channel credentials, rate limits, data isolation, billing).
- **GOAL B — configurable multi-channel automated sequences per pipeline stage**, with the
  CRM as the orchestration brain and full integration with the **outreach**, **content**,
  **nurturing**, and **personalization** engines as thin channel executors.

The CRM must stay live the entire time.

## ② Context brief (read first)

Read `MEMORY.md` (auto-loaded), `CONSOLIDATION_ROADMAP.md`,
`SESSION_HANDOFF_2026_07_05_COMPANY_ARCHITECTURE.md`,
`ENGINE_RESEARCH_PROMPTS_2026_07_05.md`, and memory files `crm-staging-routing`,
`crm-company-architecture`, `crm-handoff-engine-local`, `crm-trial-run-lessons`.
Follow the Karpathy 3-layer protocol (spec → verify → environment).

**State (live on staging, verified 2026-07-05):** CRM = pm2 `denchclaw-crm`, loopback
:3100, `/home/yogi/denchclaw-crm`, own `denchclaw` Postgres. Access
`ssh -i ~/Downloads/yogi-agent-key.pem yogi@staging.usetantra.com`. Live:
https://staging.usetantra.com/crm/ (basic-auth `adi`, pw `/home/yogi/ui-password.txt`).
Public: UI from `/var/www/crm/`; API `/crm/api/...`→`:3100/api/crm/...`, nginx injects
`x-internal-key` + `x-company-id: tantra`. origin/main @ `2e21fa9`+. Migration 011
consolidated everything to a single tenant `tantra` + normalized company FK; auto-identify
on ingest; 257 accounts backfilled. Contract 46/46.

**Direction:** move sequence *definitions* + *orchestration* out of the engines into the
always-on CRM; engines become per-channel executors; content becomes a called service.
Kills the per-engine `prospect_inbox`/`campaigns`/`campaign_events` split-brain.

**Locked decisions:** productize (multi-tenant first-class); recon-first (4 engine recon
reports from `ENGINE_RESEARCH_PROMPTS_2026_07_05.md` feed Goal B/B6).

**Multi-tenancy debt (audited):** scaffolding exists but run single-tenant; latent leaks
`findContactByPhone` (crm.js:1521) + `getById→getByIdUnscoped` (contacts.js); productizing
needs real tenant resolution (not a hardcoded nginx header), per-tenant key issuance, and
per-tenant secret storage (secrets are global `.env` — NEVER edit).

**Gotchas:** `git fetch origin` before commits (parallel sessions; next migration 012);
box Postgres `max_connections=200` shared — pool budget <150; `pm2 restart` during a
`pg_dump` causes a transient fatal-startup that self-recovers in ~30s (don't restart
again); blocklist synced between `companies.js` and migration 011; migrations are
operator-applied (test via `npm test` on Docker postgres:16); never edit `.env`/secrets/
`.git`/live schema without explicit auth + `pg_dump -Fc` backup. Standing preference: end
every message with the live URL.

## ③ The loop (paste to run)

```
/loop Advance DenchClaw toward the two goals in CONSOLIDATION_ROADMAP.md until every item under GOAL A and GOAL B is checked ✅. Each iteration: (1) read CONSOLIDATION_ROADMAP.md and pick the highest-priority UNBLOCKED, SAFE task; (2) Karpathy it — small spec → verification plan → build → `npm test` on a Docker scratch DB → run the Codex `critic` subagent for anything touching migrations/auth/tenancy; (3) `git fetch origin` first, work on branch `feat/consolidation`, commit with receipts; (4) update the roadmap checkbox + append a dated progress-log note; (5) STOP the loop and surface to me at any 🚧 GATE — needs an engine recon report (B6), needs live-DB/deploy/nginx authorization, or needs a product decision (A4 encryption/KMS, A6 billing/onboarding). Do NOT deploy to live, apply live DDL, push to main, or edit secrets. If all items are ✅, announce DONE and stop. First unblocked units: A1 (close tenancy leaks + scoping audit), B1 (sequence data model), B4 (channel-executor contract). End every message with https://staging.usetantra.com/crm/
```

The loop advances safe local foundations autonomously and checkpoints with the user at
each gate — it will not silently build the whole platform unattended. Expect it to land
A1/B1/B4-class work on `feat/consolidation`, then pause for recon reports and deploy
authorization.
