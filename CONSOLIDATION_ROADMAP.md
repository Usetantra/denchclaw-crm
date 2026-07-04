# DenchClaw consolidation roadmap — the loop's backbone + definition of done

The loop reads this each iteration, does the next **unblocked, safe** task, checks the
box, appends a progress note, and **stops at any GATE** (🚧). Loop is DONE when every
item under both goals is ✅.

Status keys: ⬜ todo · 🔄 in progress · ✅ done · 🚧 GATED (needs human/recon/auth).

---

## GOAL A — Multi-tenancy end-to-end

- ⬜ **A1. Close latent leaks + full scoping audit.** Fix `findContactByPhone`
  (crm.js) unscoped `list(null,…)` and the `getById→getByIdUnscoped` null-fallback
  (contacts.js). Sweep every route/model query for a `company_id` filter. Add negative
  contract-test cases. *(local, scratch-testable)*
- ⬜ **A2. Real tenant entity + resolution.** `tenants` table (id/company_id, name,
  slug/subdomain, status, plan). Replace the hardcoded nginx `x-company-id: tantra` +
  `auth.js` legacy fold with real resolution: API-key→tenant (and/or subdomain→tenant).
  Backfill `tantra` as the first tenant row. Migration 012. *(build local; 🚧 live apply
  + nginx change need auth)*
- ⬜ **A3. Per-tenant API keys.** Move key→company binding out of the `INTERNAL_API_KEYS`
  env blob into a DB table (`tenant_api_keys`, hashed). Issue/rotate endpoints. Keep env
  back-compat during cutover. *(build local; 🚧 secret handling review)*
- ⬜ **A4. Per-tenant channel credentials + settings.** Encrypted per-tenant store for
  provider creds (email/WhatsApp/SMS/AI-call/LinkedIn) — NOT global `.env`. Schema +
  management endpoints. 🚧 **GATE: choose encryption/KMS approach (product decision).**
- ⬜ **A5. Per-tenant limits/quotas/suppression.** Rate limits, sending quotas, quiet
  hours, global suppression list — all `company_id`-scoped. *(local)*
- ⬜ **A6. Tenant lifecycle + isolation proof.** Provisioning/onboarding flow; extend the
  contract suite to run N-tenant isolation across the NEW tables; billing hooks (stub).
  🚧 **GATE: billing model + onboarding UX (product decision).**
- ⬜ **A7. Tenant-aware UI.** Tenant switcher / scoping in the dashboard; per-tenant
  settings screens. *(local)*

## GOAL B — Multi-channel sequences per pipeline stage + engine integration

- ⬜ **B1. Sequence data model.** `sequences`, `sequence_steps` (channel, delay_offset,
  template_ref, entry/exit conditions), `enrollments`, `scheduled_actions` — all
  `company_id`-scoped. Migration (after A2 so tenant FK exists). *(local, scratch-tested)*
- ⬜ **B2. Stage-triggered enrollment.** Hook the existing stage authority (`/advance`,
  PATCH stage) so a transition enrolls/advances a prospect into the right sequence per
  pipeline stage. *(local)*
- ⬜ **B3. Always-on dispatcher.** Ticks `scheduled_actions`, applies timing/quiet-hours/
  throttle/suppression (from A5) once centrally, emits channel jobs. Must be resilient —
  the CRM is always-on; a channel failure must not stall the pipeline. *(local)*
- ⬜ **B4. Channel-executor contract.** The API each engine executor implements: pull/ack
  a job, post result back as `contact_activity`/`campaign_event`. Publish as OpenAPI +
  a reference stub executor. *(local — defines the target the engines conform to)*
- ⬜ **B5. CRM-owned prospect_inbox / campaigns / campaign_events.** Migrate these off the
  per-engine DBs into the multi-tenant CRM (the phased plan in `crm-handoff-engine-local`).
  Migration + a compatibility shim. *(build local; 🚧 per-engine rewire is gated on B6)*
- 🚧 **B6. Per-engine integration.** Rewire each engine to the contract, one checkpoint
  each: **outreach** (email/LinkedIn), **nurturing** (multi-channel drips), **content**
  (called service for asset generation), **personalization** (enrichment/personalization
  service). **GATE: needs `CONSOLIDATION_RECON_<engine>.md` for each + access to that
  engine's repo.**
- ⬜ **B7. Sequence builder UI.** Configure multi-channel sequences per pipeline stage in
  the dashboard. *(local)*
- ⬜ **B8. End-to-end proof.** One channel (email) proven CRM-orchestrated → executor →
  result-back, live, per-tenant. Then roll out remaining channels. 🚧 **GATE: live
  deploy authorization.**

---

## GATES (loop must stop and surface to the user)
1. **Recon reports** — B6 blocked until `CONSOLIDATION_RECON_{outreach,nurturing,content,personalization}.md` exist and the engine repos are reachable.
2. **Live DB / deploy authorization** — any migration applied to the live `denchclaw` DB, any nginx change, any `pm2` deploy needs explicit user OK + a `pg_dump -Fc` backup first.
3. **Product decisions** — A4 (encryption/KMS), A6 (billing + onboarding UX).

## Working rules (every iteration)
- Karpathy: spec small → verification plan → build → `npm test` on Docker scratch DB → Codex `critic` for anything touching migrations/auth/tenancy.
- `git fetch origin` before committing; migrations numbered in order from origin (next: **012**). Work on a `feat/consolidation` branch; do NOT push to `main` or deploy without authorization.
- Never edit `.env`/secrets/`*.pem`/`.git`; keep the company-name blocklist in `companies.js` and migration 011 in sync; keep box Postgres pool budget <150.
- End every user-facing message with the live URL: https://staging.usetantra.com/crm/

## Progress log (loop appends here)
- 2026-07-05 — roadmap created; recon (B6) pending; foundations A1/B1/B4 are the first unblocked units.
