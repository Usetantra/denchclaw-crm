# SESSION HANDOFF — 2026-07-05 — Company data architecture + single-tenant consolidation

Commit `40a7e2c` on `origin/main`. Applied + verified live on staging.

## Mission
The Companies tab was empty. Build proper data architecture between contacts,
companies, pipelines, and deals so any incoming contact/deal auto-identifies its
company, backfill existing data, and display it.

## Audit findings (root cause)
1. **No ingestion path** created companies — only deal-create did, and only 8 deals existed.
2. **Tenant scoping**: the UI was bound to `growthclub` (23 contacts) while 21,838
   contacts sat under `dev_company` (a bulk import mis-tagged; "dev_company" appears
   nowhere in code). 4 tenant ids existed; none named "Tantra".
3. Contact↔company link was a free-text `company_name` string, no FK.

## Decisions (user)
- **One tenant, minted clean id `tantra`** (folded growthclub+dev_company).
- **Normalized FK** model (company_ref_id on contacts + deals).
- **Backfill only accounts with 2+ contacts** sharing a name (+ scrape-noise blocklist).
- Build & apply to live now.

## What shipped
- **Migration 011** (`migrations/011_company_normalization.sql`): tenant fold across
  all 10 company_id tables (collision-safe aggregate-merge for campaign_event_rollups,
  NOT-EXISTS guard for companies/pipeline_configs); `company_ref_id` FK + unique index
  `uq_companies_tenant_lname`; backfill (2+ rule, blocklist); link contacts + deals.
- **Auto-identify** (`server/db/models/companies.js` `identifyAndLink`): wired into
  POST /contacts, bulk-import, findOrCreateContact, PATCH /contacts, POST /deals
  (deals force-create). 2+-contact threshold applied continuously.
- **auth.js**: default tenant `tantra` + legacy-id fold (`LEGACY_COMPANY_IDS`).
- **companies route**: FK rollups (contact/deal counts + values) + `GET /companies/:id/contacts`
  and `/:id/deals`.
- **UI** (`web/index.html`): clickable account rows → detail drawer (contacts + deal
  pipeline), Deals column.

## Verification
- Local: contract suite **46/46** + focused company-ident **11/11** (Docker scratch DB).
- **Codex critic** reviewed migration → fixed HIGH rollup-collision (aggregate-merge),
  added same-tenant guard on deal link, blocklist guard on contact link.
- Live staging receipts: backup `denchclaw-backup-20260704-210953-pre011.dump` (131M);
  migration applied (21,861 re-tagged, **257 companies**, 541 contacts linked, rollups
  merged 8→8 no collision); public API 257; **live ingest test** (2 contacts → company
  auto-created + rolled up, then cleaned up); chat now reports 21,861 (was 23).

## Gotcha hit + resolved
`pm2 restart` while `pg_dump` still ran spiked DB connections past the box-wide 200
ceiling → fatal-startup "connection slots reserved for SUPERUSER". The backoff-retry
loop self-recovered in ~30s (README design). Lesson: finish the backup before restart.

## Follow-ups
- 8 legacy deals link to 0 accounts (contacts' companies are blocklisted/singleton test
  names) — expected. New deals link fine.
- Blocklist lives in BOTH `companies.js` and migration 011 — keep in sync if extended.
- Companies still not enriched with domain/industry/size (manual/PATCH only) — future.
- Rollback if ever needed: `pg_restore -c` the pre011 dump + `git checkout 243f4a1`
  + revert nginx `crm.conf.bak-*` + `pm2 restart`.
