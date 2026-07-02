# SESSION HANDOFF — 2026-07-02 (evening) — CRM spec verification + E2E trial run

Commits: `43981a0` (doc-alignment fixes) → `8ff9b13` (merge) → `e0a3f63` (merge
origin's Contacts/Companies/Pipelines work) → `d8408aa` (integration seam fixes).
All pushed to `origin/main` (github.com/adisuja/denchclaw-crm).

## Mission

Verify the DenchClaw CRM build against the Google Doc spec tab
(`Tantra Consolidated Funnel Documentation` → Pre-Built Funnel Automations →
DenchClaw CRM, tab `t.471q7dtwlx74`), fix gaps, then run a code-based and a
visual browser E2E trial with the 6 sample test contacts, and update the doc tab.

## Spec verdict

Every recommendation in the doc tab was already shipped by migrations 003–007
(booked stage, no_show→[contacted,booked,lost], unqualified→nurture|lost,
nurture→segmented only, sourced→segmented direct). **One real gap**: the doc's
sales `nurture` off-ramp return path is *Marketing's nurture queue* — the build
parked deals in a sales-side `nurture` stage without recycling the contact.

## Fixed this session

1. **Nurture recycle bridge** — deal→`nurture` (via `/advance` or `PATCH /deals/:id`,
   built-in sales pipeline only) now also advances the contact's `marketing_stage`
   to `nurture` when legal; `/advance` response carries `marketing_recycled`.
2. **Email-authoritative dedupe (BUG-1 class, CRM-side)** — `POST /contacts` and
   `bulk-import` merged distinct emails via shared phone/LinkedIn (the 6 test
   contacts imported as 3!). Fallback now fires only when the record has NO email.
3. **`GET /contacts/export` un-shadowed** — was defined after `/contacts/:id`, so
   `:id` captured `export` and returned JSON "contact not found" instead of CSV.
4. **`mql` campaign-event type** (migration **010**) — `mql_count`/`mqls`/`mql_rate`
   were permanently 0 (no ingestion path). Engines now POST `type:'mql'`.
5. **Contact-detail modal** in `web/index.html` — all fields + activity feed +
   add-note, opened from dashboard table rows and board cards. Funnels render in
   pipeline order; stale "Read-only" footer fixed; deal cards show contact names
   (loadDeals LEFT JOIN fallback).
6. **Merged the parallel session's work** (origin: Contacts + Companies pages,
   pipeline management UI, custom deal pipelines 008/009, opportunity→contact
   linking) and closed the integration seams: `/advance` sales, claim auto-deal
   idempotency and the sales funnel now filter `pipeline_key IS NULL OR 'sales'`;
   the nurture recycle only fires for sales-pipeline deals.

## Evidence

- Contract harness: **46/46** (`npm test`, Docker postgres:16 scratch, migrations
  002–010 from zero). Six new CP5 cases: nurture recycle ×2, dedupe ×3, CSV export,
  mql rollup.
- Code trial: **35/35** (`scratchpad/trial_run.mjs`) — 6 test contacts through six
  distinct journeys: Adi 1 full win ($15k, sourced→…→mql→handoff claim→accepted→…→won),
  Adi 2 no_show rebooking + unqualified→nurture recycle, Adi 3 nurture return loop +
  broadcast handoff lifecycle, Ben suppression terminal, Bhaskar proposal→nurture
  recycle + human escalation, Bharath webhook dedupe + follow-up. Plus guardrails
  (409/404/403), 18 multi-channel campaign events → correct rollups/funnels/stats/CSV.
- Visual trial (Chrome, localhost:4100/crm/ via dev/serve-web.js): all 7 tabs render
  live data; kanban drag-drop enforces transitions (legal move + illegal-move toast
  with allowed list); contact modal fields+feed+notes; inbox filters/escalate/
  reassign; analytics incl. MQLs=1 after migration 010; Companies page shows created
  row; Pipelines editor lists built-ins. Chat 503s gracefully without CF creds
  locally; **staging chat verified live** (answers contact counts).

## ⚠️ Staging is NOT yet on this code

Staging still runs the 2026-07-02 morning build (pre-merge). The merged code
**requires operator-applied migrations** (agent never runs DDL on the live DB):

```bash
# on the box, in order:
psql "$DENCHCLAW_DATABASE_URL" -f migrations/008_companies.sql
psql "$DENCHCLAW_DATABASE_URL" -f migrations/009_deal_pipelines.sql
psql "$DENCHCLAW_DATABASE_URL" -f migrations/010_mql_event_type.sql
cd /home/yogi/denchclaw-crm && git stash && git pull   # box git is stale @15459a3 with rsync'd files
pm2 restart denchclaw-crm && curl -s localhost:3100/health
# then rsync web/index.html → /var/www/crm/index.html (nginx serves the UI from there)
```

Do NOT deploy the code before the migrations — `pipeline_key` queries would 500.

## Follow-ups

- automation_core: stale `STAGE_TRANSITIONS` mirror + wire drift test into CI
  (pre-existing, recorded in the morning handoff).
- Engines should start emitting `type:'mql'` campaign events at MQL promotion.
- Companies table isn't auto-populated from contacts' `company_name` (only via
  deal creation / manual add) — decide whether to backfill.
- Local dev gotcha: the shared env file's `INTERNAL_API_KEYS` is not JSON — always
  set `INTERNAL_API_KEYS` explicitly when booting locally (see test/run-local.sh).
