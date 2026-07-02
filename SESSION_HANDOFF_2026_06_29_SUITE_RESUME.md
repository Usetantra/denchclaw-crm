# Resume context — DENCHCLAW CRM (2026-06-29)

> Drop-in context for a fresh Claude Code session in this terminal. Read this, then `git status`.

## This terminal = DenchClaw CRM
Shared CRM (contacts, `prospect_inbox`, handoffs, activity feed) backing all Pro-Workflows engines.
`CRM_BACKEND=api` is the live cutover path.

## What changed for YOU this session (from the content-engine work)
- The Content Engine's **Engagement Prospector** writes prospects here via `automation_core.crm`:
  `find_or_create_contact(source='content', metadata={company_headcount, engager_views, engager_clicks,
  qualify_reason, suggested_campaign='content_prospect'})` + `add_contact_activity('content_engagement_prospect')`
  + `enqueue_handoff(target_engine=None)` (broadcast to Outreach/Nurturing).
- When content-engine's social sessions are added (X/IG/TikTok/Quora), prospect volume from social engagers will
  rise — watch for dedupe/identity-resolution quality on the `contacts` table.
- No code in this repo was changed this session. Your in-flight edits are whatever is uncommitted here.

---
## Pro-Workflows suite — shared state (verified live 2026-06-29)

Suite = three always-on engines (**Content**, **Outreach**, **Nurturing**) + **DenchClaw CRM** on the shared
**automation_core** lib (Followup Engine is a sibling). Separate git repos, each run in its own terminal;
NONE committed to YOGI.

- **Staging box (all engines):** Azure VM `20.219.185.55` = `staging.usetantra.com`.
  `ssh -i ~/Downloads/yogi-agent-key.pem yogi@staging.usetantra.com`. Engines in `/home/yogi/engines/<engine>/`;
  shared lib rsynced to `/home/yogi/engines/automation_core_pkg` (NOT pip/git on the box). Managed by **pm2**.
- **Deploy = rsync, not git on the box:** `rsync` then `pm2 reload <proc>`. Each `run.sh` does
  `set -a; . ../.env; . ./.env` → **root `.env` carries `DATABASE_URL`**, `backend/.env` the engine keys.
- **Shared Postgres** (one DB for all engines + CRM). `CRM_BACKEND=api`.
- **Cross-engine handoff:** `crm.find_or_create_contact` + `crm.enqueue_handoff(target_engine=None)` (broadcast,
  first-claim-consumes) → claimable by Outreach/Nurturing.
- **Secrets (box only, gitignored):** content-engine `backend/.env` has `ZERNIO_API_KEY`,
  `ZERNIO_WEBHOOK_SECRET`, `CLOUDFLARE_AI_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. `pro-workflows/retrieved-credentials.env`
  holds retrieved creds. Never commit/echo these.
- **Content-engine status:** Zernio cutover live; branch `feat/content-engine-zernio-completion` (pushed, not
  merged); GitHub repo moved → `Usetantra/content-engine`; details in
  `content-engine/CONTENT_ENGINE_COMPLETION_PLAN_2026_06_29.md`.
