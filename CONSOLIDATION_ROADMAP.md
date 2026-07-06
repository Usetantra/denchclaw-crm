# DenchClaw consolidation roadmap — the loop's backbone + definition of done

The loop reads this each iteration, does the next **unblocked, safe** task, checks the
box, appends a progress note, and **stops at any GATE** (🚧). Loop is DONE when every
item under both goals is ✅.

Status keys: ⬜ todo · 🔄 in progress · ✅ done · 🚧 GATED (needs human/recon/auth).

---

## GOAL A — Multi-tenancy end-to-end

- ✅ **A1. Close latent leaks + full scoping audit.** Fix `findContactByPhone`
  (crm.js) unscoped `list(null,…)` and the `getById→getByIdUnscoped` null-fallback
  (contacts.js). Sweep every route/model query for a `company_id` filter. Add negative
  contract-test cases. *(local, scratch-testable)*
- 🔄 **A2. Real tenant entity + resolution.** `tenants` table (id/company_id, name,
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

- ✅ **B1. Sequence data model.** `sequences`, `sequence_steps` (channel, delay_offset,
  template_ref, entry/exit conditions), `enrollments`, `scheduled_actions` — all
  `company_id`-scoped. Migration (after A2 so tenant FK exists). *(local, scratch-tested)*
- ✅ **B2. Stage-triggered enrollment.** Hook the existing stage authority (`/advance`,
  PATCH stage) so a transition enrolls/advances a prospect into the right sequence per
  pipeline stage. *(local)*
- ⬜ **B3. Always-on dispatcher.** Ticks `scheduled_actions`, applies timing/quiet-hours/
  throttle/suppression (from A5) once centrally, emits channel jobs. Must be resilient —
  the CRM is always-on; a channel failure must not stall the pipeline. *(local)*
- ✅ **B4. Channel-executor contract.** The API each engine executor implements: pull/ack
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
- 2026-07-05 — **A1 done.** Fixed the two named bugs: `findContactByPhone` (crm.js)
  now requires+scopes by `companyId` instead of `list(null,…)`; `contacts.getById`
  no longer falls back to an unscoped read (dead `getByIdUnscoped` deleted). Full
  sweep (per Codex critic pass) also found and closed the same latent-leak shape in
  `contacts.list`, `listPaginated`, `update`, `addActivity`, `getActivity` (all now
  require `companyId`, no silent unscoped path) and two missed call sites in
  `POST /contacts` (existing-contact update + note-activity write). Added
  `test/unit-tenancy.mjs` (15 cases) since these functions have no HTTP route for
  `contract.mjs` to reach; wired into `npm test`/`run-local.sh`. 46 contract +
  15 unit tests pass on scratch Docker Postgres. Codex critic: pass-with-fixes,
  all flagged gaps closed in the same iteration. Branch `feat/consolidation`,
  not pushed/merged/deployed.
- 2026-07-05 — **B4 done.** Published `docs/contracts/channel-executor.openapi.yaml`
  (claim/ack contract engines implement) + prose companion
  `CHANNEL_EXECUTOR_CONTRACT.md`, mirroring the existing `prospect_inbox`
  claim pattern. Reference stub (`examples/mock-channel-jobs-server.mjs` +
  `stub-executor.mjs`) self-tests the state machine via
  `npm run verify:channel-contract` (13 assertions). Codex critic first pass
  found real gaps — spoofable ack ownership, no way for an executor to learn
  if a `failed` job would be retried, an overclaimed "proves Postgres
  concurrency" comment, an unimplemented claim-timeout promise, and a
  vacuous concurrency assertion — all fixed in the same iteration: ack now
  requires+checks `claimed_by` (404 on mismatch), ack response carries a
  `retry{will_retry, next_attempt_at, attempt, max_attempts}` block, the mock
  comment now explicitly disclaims Postgres-safety equivalence, claim-timeout
  reclaim is implemented (`CLAIM_TIMEOUT_MS`) and tested, and the concurrency
  test now asserts exact job-id identity + both executors got a non-empty
  share. One known gap intentionally left open (documented, not silently
  shipped): a retryable `failed` ack is not idempotent against a duplicate ack
  call — needs a per-attempt idempotency key, deferred to B3. B1 (sequence
  data model) is next per the roadmap but its own text says "after A2 so
  tenant FK exists" — A2 isn't done, so B1 is not actually unblocked;
  proceeding to A2's local-buildable portion instead.
- 2026-07-05 — **A2 local-buildable portion done** (marked 🔄, not ✅ — nginx +
  subdomain resolution + live apply remain gated). Migration 012: `tenants`
  table (id, name, slug, status, plan, aliases[]), backfills `tantra` with
  today's env-default legacy aliases (`growthclub`, `dev_company`) so
  behavior is unchanged the moment resolution flips from env to DB.
  `server/db/models/tenants.js`: getById/getBySlug/resolve/list/create.
  `auth.js`'s `canonicalCompanyId` is now DB-backed (was a static env-parsed
  Set) with a bounded (max 1000 entries) TTL cache and a fail-open fallback
  to the old static fold on any DB error (never blocks auth on DB pressure,
  matching this service's existing "always-on" posture) — ad-hoc test
  tenants (`co_a_<run>` etc.) still pass through unresolved, unchanged.
  Two critic passes: first found real gaps (no deterministic exact-id-wins
  priority + no DB guard against alias collisions, unbounded cache = DoS
  vector, async middleware with no Express-4-safe error wrapper, migration
  re-run semantics needing clarification) — fixed with an `ORDER BY`
  priority + a collision-checking trigger, a bounded LRU-ish cache, a sync
  wrapper around the async auth handler, and doc clarification. Second
  critic pass on the fixes themselves found a genuine race (two concurrent
  transactions each adding the same alias to different tenants could both
  pass the collision check under READ COMMITTED) — reproduced empirically
  against real Postgres 16, fixed with `pg_advisory_xact_lock` serializing
  alias-mutating transactions, then re-reproduced to confirm the fix holds
  (second transaction now correctly blocks then rejects). Also added a
  `res.headersSent` guard in the auth error handler for defense in depth.
  Migration integrity checked directly: idempotent re-run (no duplicate
  tantra row), trigger rejects both collision directions, legitimate insert
  still succeeds. 71 tests pass (46 contract + 15 + 10 unit).
  **Remaining for A2 to be ✅** (gated): subdomain→tenant resolution, nginx
  config change, live migration apply — needs explicit authorization per
  the roadmap gates, not attempted here.
- 2026-07-06 — **A2 FK enforcement done** (still 🔄, same gates as above
  remain). Asked the user whether B1 should enforce a real tenant FK given
  it'd conflict with the contract suite's ad-hoc tenant pattern — chose
  "enforce FK, rewrite test suite." Migration 013 adds a real FK
  (company_id -> tenants.id, ON DELETE RESTRICT, NOT VALID + VALIDATE
  pattern for safe live application later) to all 10 company_id-bearing
  tables; crm_pipeline_configs' nullable company_id (global defaults)
  correctly satisfies the FK via NULL without needing a tenant row. Added
  `POST/GET /api/crm/tenants` (admin-gated: only a `*`-bound key may
  provision tenants) so the test suite has an HTTP way to provision ad-hoc
  tenants before writing under them; rewired test/contract.mjs +
  unit-tenancy.mjs + unit-tenants.mjs accordingly, with a direct test
  proving the FK actually rejects an unprovisioned insert. Critic pass found
  the real operational risk: `bulk-import`'s per-row catch would have
  silently swallowed the new FK violation (worse than before — same
  invisible failure, now for an undiagnosable reason), and `POST /contacts`
  would have surfaced a raw Postgres 500 instead of a clear error. Fixed
  both: bulk-import now checks tenant existence once up front (422, not N
  silent per-row failures), POST /contacts catches the FK violation
  specifically (422). `prospect-inbox` needed no fix — a contact can't exist
  under an unprovisioned tenant anymore, so it 404s earlier via the existing
  contact lookup. **Not fixed, flagged as follow-up**: other insert routes
  (POST /deals, /conversations, /campaign-events, etc.) have the same latent
  "raw 500 on unprovisioned tenant" shape — same fix pattern, not applied
  everywhere in this pass to keep the change reviewable; worth a dedicated
  sweep. Pre-existing, unrelated: `auth.js`'s `ipAllowed()` CIDR matching is
  naive string-prefix, not real subnet math (confirmed by two independent
  critic passes) — flagging separately, out of scope for A2.
  78 tests pass (51 contract + 15 + 12 unit).
- 2026-07-06 — **B1 done.** Migration 014: `sequences` (name, pipeline_key,
  trigger_stage — the B2 enrollment trigger), `sequence_steps` (channel,
  delay_seconds, template_ref, entry/exit conditions JSONB), `enrollments`
  (one ACTIVE enrollment per (sequence, contact) via partial unique index),
  `scheduled_actions` (the backing store for B4's ChannelJob — a row here
  becomes a real claim/ack job once B3 wires the dispatcher). All FK'd to
  `tenants(id)`. Data model only — no HTTP routes, no B2/B3 wiring, by design.
  Codex critic found a CRITICAL cross-tenant injection: `enroll()` and
  `scheduleAction()` took companyId alongside foreign ids (sequenceId,
  contactId, enrollmentId, stepId) without verifying those ids actually
  belonged to that tenant — a valid companyId + another tenant's sequence/
  contact id silently succeeded. Fixed: every foreign id is now ownership-
  checked before any write (or derived server-side instead of trusted from
  the caller — contact_id/channel/template_ref on scheduled_actions are now
  always read from the enrollment/step, never caller-supplied). Also fixed a
  real TOCTOU race in enroll()'s idempotency check (reproduced live: two
  concurrent enroll() calls both pass the "existing active?" SELECT; the
  partial unique index correctly rejects the loser with 23505, which
  enroll() now catches and recovers from instead of crashing). A follow-up
  critic pass on the fixes found one more real gap — the post-fix "existing
  active enrollment" SELECT still wasn't filtered by company_id, exploitable
  only if a poisoned row already existed outside this DAL — closed with an
  explicit `AND company_id = $N`. sequence_steps also gained its own
  company_id column (denormalized from sequence_id, matching every other
  tenant-scoped table's convention) after the critic flagged its absence as
  inconsistent. Two critic rounds, 38 sequence-specific tests (11 of them
  direct cross-tenant-injection/race proofs). 116 tests pass total (51
  contract + 15 + 12 + 38 unit). B2 (stage-triggered enrollment), B3
  (dispatcher), B7 (sequence builder UI) build on this next.
- 2026-07-06 — **B2 done.** Added `sequences.enrollForTriggerStage(companyId,
  contactId, pipelineKey, stage)` — enrolls a contact into every active
  sequence matching that exact (pipeline_key, stage) pair, never throws into
  the caller's request path. Hooked into every real stage-authority path:
  `/advance` (marketing + sales branches), the sales `nurture` off-ramp
  (`recycleContactToMarketingNurture`, both its call sites — `/advance` and
  `PATCH /deals/:id`), `PATCH /deals/:id {stage}` directly, and inbound-reply
  auto-advance in `conversations.js` (a fourth path outside crm.js entirely).
  **Four critic rounds, each finding a real bug**, in order: (1) missing
  hooks on the nurture off-ramp and the conversations.js path entirely; (2) a
  stage-domain collision — `nurture` is a legitimate stage name in BOTH the
  sales and marketing JSONB pipeline configs (migration 006), so a
  membership-check ("is this a sales stage name") on the legacy
  `contacts.deal_stage` field cannot reliably tell a real sales transition
  from a marketing mirror; reproduced live: PATCHing `deal_stage:'nurture'`
  with no real deal involved wrongly enrolled into a sales sequence. Fixed by
  removing the enrollment hook from that legacy path ENTIRELY (deal_stage is
  too ambiguous a signal to trust) rather than trying to out-clever the
  ambiguity — the two reliable trigger points (`/advance`, `PATCH /deals/:id`)
  both operate on an unambiguous real `deals` row already; (3) an ordering
  bug in `PATCH /deals/:id` — enrollment fired before the stage actually
  persisted; (4) the SAME ordering bug at a second call site inside the same
  route (`recycleContactToMarketingNurture`'s own internal enrollment call),
  found only after fixing the first one — plus a missing `rowCount` check
  that could fire a deferred side effect for a row that silently failed to
  update. Also parallelized the per-sequence enrollment loop
  (`Promise.all`, safe since the partial unique index is keyed per-sequence)
  and improved the non-blocking error log to include company/pipeline/stage
  context. 132 tests pass (51 contract + 15 + 12 + 38 + 16 unit-b2). One
  pre-existing note flagged, not fixed (out of scope): `PATCH /deals/:id`
  writes a `contact_activity` row before its own `rowCount` guard, so a
  deal deleted mid-request could still leave an orphaned activity entry.
