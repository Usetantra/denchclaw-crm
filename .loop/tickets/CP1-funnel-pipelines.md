# CP1 — funnel_type dimension + seed the three webinar pipelines

Cycle 1 · Checkpoint CP1 · Author: orch · Status: BUILD · Rev 2 (critic findings folded in)
Canonical stage contract: `.loop/PIPELINES_SPEC.md` (read it first; stage names below must match it exactly).
Critic note: reviewed by the critic subagent (Codex CLI auth is DEAD — single-model review,
flagged to human; findings were file:line-verified against real code). 16 findings folded in below.

## Goal
`crm_pipeline_configs` gains a `funnel_type` dimension and is seeded (global defaults,
`company_id IS NULL`) with the three webinar pipelines from PIPELINES_SPEC.md — every stage
carrying `mode: auto|manual` and an explicit transitions map — WITHOUT breaking the legacy
`marketing`/`sales` configs (mig 003/006) or mig-009 custom pipelines. The stage
authorities (`POST /contacts/:id/advance` AND `PATCH /deals/:id`) must enforce the webinar
state machines — transitions AND mode — because every later CP (triggers, dropdowns,
sequences) references these real stage names.

## Locked design decisions (critic-reviewed; do not re-litigate in build)

1. **New rows, new keys — additive.** Three new global rows, keys `webinar_marketing`,
   `webinar_sales`, `webinar_delivery`, each `funnel_type='webinar'`. Existing rows: their
   `stages` JSONB stays byte-identical (rows DO gain the two new columns, and sales rows
   get an `entity_type` backfill — that is expected; the invariant is the stages JSONB and
   the legacy runtime behavior). Existing unique indexes untouched.
2. **`entity_type` column decides the /advance branch.**
   `entity_type TEXT NOT NULL DEFAULT 'contact' CHECK (entity_type IN ('contact','deal'))`.
   **Backfill `'deal'` for EVERY existing row with `key <> 'marketing'`** (all mig-009
   custom pipelines are deal pipelines — pipelines.js:9 — and 'sales' rows global AND
   company-scoped). Seed: webinar_marketing='contact', webinar_sales/webinar_delivery='deal'.
   `/advance` traversal is allowed ONLY for: the builtin keys (`marketing`,`sales` — exact
   legacy behavior preserved) and funnel-typed rows (`funnel_type IS NOT NULL`). An untyped
   custom key on /advance keeps today's 400 — zero behavior change for mig-009 pipelines.
3. **Mode semantics.** `mode:'auto'` = the CRM MAY set the stage programmatically AND a
   human may also set it (the spec's `disqualified (auto+manual)` is seeded `mode:'auto'`).
   `mode:'manual'` = ONLY a human. **A stage object with NO `mode` field ⇒ treated as
   `'auto'` (legacy compat — legacy configs have no mode; their automated paths, e.g.
   conversations.js auto-advance to `responded`, must keep working unchanged).**
4. **Mode enforcement seam.** `/advance` and the PATCH /deals/:id funnel-typed gate accept
   an optional body flag `automated: true`. `automated` + target stage `mode:'manual'` →
   **403** with `error_code: 'manual_stage'` (distinct from the 409 illegal-transition, so
   callers can tell them apart). Helper `isManualStage(pipeline, stageKey)` exported from
   `server/db/pipeline.js` (absent mode ⇒ false). `conversations.js` does NOT call /advance
   — its inbound auto-advance is an inline UPDATE — so apply the `isManualStage` check
   inline there before its stage write (no behavior change today since legacy stages have
   no mode; this future-proofs funnel stages). **KNOWN LIMITATION (documented, accepted):**
   the flag is honor-system — engines and humans share the same API-key auth today, and
   principal-based derivation is impossible until A7's identity work (gated). State this in
   a code comment at the check site; do not silently pretend it's a security boundary.
5. **Contact-pipeline entry rule.** Contact-entity pipelines store current stage in
   `contacts.marketing_stage` (mirrored to `deal_stage`, exactly as today). "First stage"
   = **`stages[0]` of the config's JSONB array** (formally; for webinar_marketing that is
   `prospects`). A contact whose current stage is NOT a member of pipeline P may enter P
   only at `stages[0]`, via a normal /advance call, logged as a `stage_change` activity.
   **Entry refusals:** a contact currently at `suppressed` may NOT enter (409), and a
   contact with an active all-channel suppression row (A5 `suppressions`, channel IS NULL)
   may NOT enter (409, error mentions suppression) — the entry rule must not be a
   suppression escape.
6. **Deal-entity pipelines: creation + BOTH stage authorities gated.**
   - `POST /deals` with a funnel-typed `pipeline_key`: initial `stage` must be a member of
     that pipeline's config (400 `{error, allowed_stages}` on non-member — explicit,
     not the silent coercion the legacy default path does); omitted stage defaults to
     `stages[0]`. Untyped/legacy pipeline_key behavior unchanged.
   - `PATCH /deals/:id`: today custom-pipeline deals "move freely" (crm.js ~918, gate only
     runs when `!deal.pipeline_key`). Extend the gate: when the deal's pipeline_key
     resolves to a **funnel-typed** config, enforce transitions (409) AND mode (403, per
     decision 4). Untyped custom pipelines keep today's free-move. Legacy sales
     (`pipeline_key IS NULL`) unchanged.
   - `/advance` deal branch: deal lookup filters on the requested pipeline_key
     (`pipeline_key = $key` for funnel-typed; legacy `sales` keeps its
     `pipeline_key IS NULL OR ='sales'` filter — do not orphan existing deals). A contact
     holding BOTH a legacy sales deal and a webinar_sales deal must have each advanced
     independently by its own key.
   - **Marketing-recycle off-ramp stays sales-only:** the `stage === 'nurture'` →
     `recycleContactToMarketingNurture` behavior fires ONLY when `pipeline_key === 'sales'`
     (never generalized to other deal pipelines).
7. **Terminal stages.** Seeded JSONB marks `"terminal": true` on `disqualified` and
   `delivery_completed`. For funnel-typed deals: the active-deal lookup excludes
   terminal-stage deals (legacy `stage NOT IN ('won','lost')` semantics preserved for
   untyped), and entering a terminal stage sets `metadata.closed_at` (same as won/lost
   does today). Stats/GET /deals treatment of non-terminal webinar stages as "open" is
   accepted for CP1 (documented), EXCEPT terminal ones which must count as closed.
8. **Pipeline override/create paths must not strip the new fields.** `pipelines.js`
   `normalizeStages` currently outputs only `{key,name,color,transitions}` — it MUST
   preserve `mode` (and `terminal`). `POST /pipelines` and the PATCH `/:key`
   override-upsert MUST inherit `entity_type` and `funnel_type` from the row being
   overridden (new custom pipelines default `entity_type='deal'`, matching their
   deals-only use). Otherwise a tenant renaming one webinar stage silently disables every
   mode gate and flips the /advance branch — this was a critic CRITICAL.
9. **Sequences validation goes config-driven.** `POST /api/crm/sequences` replaces the
   hardcoded `['marketing','sales']` (sequences.js:40) with a lookup that MUST reuse
   `getPipelineConfig(companyId, key)` (its `company_id = $2 OR company_id IS NULL`
   scoping is the tenant-isolation guarantee — tenant A can never reference tenant B's
   company-scoped key). Unknown key → 400. **Also validate `trigger_stage`**: when
   pipeline_key is given, trigger_stage must be one of that pipeline's stage keys (400
   otherwise) — today a typo'd trigger is accepted and silently never fires. Keep the
   `esc()` render defense in web/index.html. Known+accepted: the 60s config cache means a
   just-deleted pipeline validates for up to 60s.
10. **`PATCH /contacts/:id` deal_stage side door closed.** For a contact whose current
    `marketing_stage` is a member of a funnel-typed contact pipeline, direct
    `deal_stage` writes via PATCH /contacts/:id are rejected (400, error points to
    /advance) — today the resolver returns undefined for unknown stages and skips the
    gate entirely, which would let free writes corrupt the webinar board.
11. **Open items from PIPELINES_SPEC — resolved:** `prospects` = manual (import entry);
    `invitees` = auto, set when an invite dispatch is acked (wired in CP2/CP4 — CP1 only
    seeds the mode). No-show ladder reporting stage = write-back side-effect of scheduler
    steps (CP2 implements). Legacy reconciliation = additive per decision 1.
    Accepted gaps (explicit, not oversights): registrants/auto_registrants who never
    attend stay put (no marketing no-show stage in the spec); attendees→sales handoff is
    CP3/CP4c's trigger work; stage-name collisions across pipelines (e.g. delivery
    `onboarding` vs legacy sales `onboarding`) are tolerated because every stage write
    travels with its pipeline_key.

## Seeded stage tables (exact JSONB content — key, mode, terminal, transitions)

Every stage object: `{"key","label","mode","transitions"}` (+ `"terminal": true` where marked).

### webinar_marketing (entity_type=contact, funnel_type=webinar)
| key | mode | transitions |
|---|---|---|
| prospects | manual | invitees |
| invitees | auto | visits, registrants, auto_registrants |
| visits | auto | registrants, auto_registrants |
| registrants | auto | attendees |
| auto_registrants | auto | attendees |
| attendees | auto | *(none — sales pipeline takes over via CP3/CP4c)* |

### webinar_sales (entity_type=deal, funnel_type=webinar)
| key | mode | transitions |
|---|---|---|
| qualification_form_fills | auto | scheduled_call, disqualified |
| scheduled_call | auto | no_show_followup_1, proposal_sent, deals, disqualified |
| no_show_followup_1 | manual | no_show_followup_2, scheduled_call, disqualified |
| no_show_followup_2 | auto | no_show_followup_3, scheduled_call, disqualified |
| no_show_followup_3 | auto | no_show_followup_4, scheduled_call, disqualified |
| no_show_followup_4 | auto | no_show_followup_5, scheduled_call, disqualified |
| no_show_followup_5 | auto | scheduled_call, disqualified |
| proposal_sent | manual | deals, disqualified |
| disqualified | auto, **terminal** | *(none)* |
| deals | manual | deal_followup_1, disqualified |
| deal_followup_1 | manual | deal_followup_2, disqualified |
| deal_followup_2 | manual | deal_followup_3, disqualified |
| deal_followup_3 | manual | disqualified |

(No-show ladder note: FU stages deliberately have no direct →proposal_sent — the intended
exit is rebooking → scheduled_call, per PIPELINES_SPEC "Exit on reply or rebooking".
The `disqualified` exits from deals/deal_followup_* are the loss path for a client who
backs out post-agreement.)

### webinar_delivery (entity_type=deal, funnel_type=webinar) — all manual
| key | mode | transitions |
|---|---|---|
| onboarding | manual | funnel_delivery |
| funnel_delivery | manual | coaching_delivery |
| coaching_delivery | manual | renewed, delivery_completed |
| renewed | manual | funnel_delivery, coaching_delivery, delivery_completed |
| delivery_completed | manual, **terminal** | *(none)* |

## Files
- `migrations/018_funnel_pipelines.sql` (NEW — next unused from origin; re-verify with
  `git fetch origin` at build time, parallel sessions push here)
- `server/db/pipeline.js` (mode/terminal/entity_type/funnel_type through the freeze/cache;
  `isManualStage`)
- `server/routes/crm.js` (/advance generalization + entry rule + automated flag;
  POST /deals initial-stage validation; PATCH /deals funnel-typed gate; PATCH /contacts
  deal_stage side-door; terminal-aware active-deal lookup + closed_at)
- `server/routes/conversations.js` (inline `isManualStage` check at the auto-advance write)
- `server/routes/sequences.js` (config-driven pipeline_key + trigger_stage validation)
- `server/routes/pipelines.js` (list global funnel-typed rows; normalizeStages preserves
  mode/terminal; create/override inherit entity_type/funnel_type)
- `web/index.html` (Pipelines tab renders the new pipelines + manual badges; keep esc())
- `test/` (new unit file for CP1 + all 243 existing green)

## Build steps
1. Migration 018: add `funnel_type TEXT` + `entity_type` (new column with DEFAULT +
   CHECK is safe on existing rows); `UPDATE ... SET entity_type='deal' WHERE key <> 'marketing'`;
   seed the three rows `INSERT ... WHERE NOT EXISTS` (mig-003 idiom) with the EXACT JSONB
   above. Idempotent on re-run.
2. `pipeline.js`: carry the new fields (frozen); `isManualStage` (absent mode ⇒ false).
3. `crm.js`: decisions 2, 4, 5, 6, 7, 10. Legacy request shapes byte-for-byte unchanged.
4. `pipelines.js`: decision 8 + list global funnel-typed rows (minus tenant overrides —
   a company-scoped override of `webinar_sales` must appear once, the override winning,
   same precedence as getPipelineConfig).
5. `sequences.js` (decision 9), `conversations.js` (decision 4), web UI exposure.
6. Tests + browser script + screenshots to `.loop/EVIDENCE/CP1-*`.

## EVAL CRITERIA (verify pass checks every one; number your receipt against these)
- **E1** Migration 018 applies cleanly TWICE on scratch Postgres (2nd run: no dup rows, no
  errors). Exactly 3 new global rows; every seeded stage object matches the tables above
  exactly (keys, modes, terminal flags, transitions).
- **E2** Legacy stages-JSONB untouched: global `marketing` + `sales` `stages` byte-identical
  before/after (literal compare in test). A company-scoped `sales` override created before
  the migration gets `entity_type='deal'` backfilled; a mig-009-style custom pipeline row
  also gets `entity_type='deal'`.
- **E3** `isManualStage`: manual→true, auto→false, **absent mode→false**, unknown stage
  safe. Unit tests.
- **E4** /advance traversal proofs: (a) contact `sourced`→`prospects` entry-rule 200;
  (b) `prospects`→`invitees` 200 changed:true; (c) `prospects`→`attendees` 409 with
  `allowed`; (d) webinar_sales deal `qualification_form_fills`→`scheduled_call` 200;
  (e) `scheduled_call`→`deals` 200; (f) `qualification_form_fills`→`deals` 409;
  (g) all existing marketing/sales advance tests pass UNMODIFIED; (h) an untyped mig-009
  custom key on /advance still 400; (i) a contact with BOTH a legacy sales deal and a
  webinar_sales deal: /advance with each key moves the correct deal.
- **E5** Mode enforcement: automated→manual 403 `error_code:'manual_stage'`;
  automated→auto 200; human→manual 200; the 403 is distinct from the 409 shape.
  conversations.js inline check proven present (test or assertion).
- **E6** Entry-rule refusals: contact at `suppressed` refused entry (409); contact with an
  active all-channel A5 suppression refused (409, mentions suppression).
- **E7** PATCH /deals/:id gate: funnel-typed deal illegal jump
  (`qualification_form_fills`→`deals`) 409; automated→manual 403; untyped custom pipeline
  still moves freely; legacy sales PATCH behavior unchanged. POST /deals: funnel-typed +
  non-member stage 400 with `allowed_stages`; omitted stage → `stages[0]`.
- **E8** Terminal semantics: advancing a webinar_sales deal to `disqualified` sets
  closed_at and the deal no longer blocks/appears as the active deal for that
  (contact, pipeline); a new webinar_sales deal for the same contact can then be created
  and advanced.
- **E9** Override safety: PATCH /pipelines/webinar_sales renaming one stage label →
  re-read config: `mode`/`terminal` preserved on every stage, `entity_type` still 'deal',
  funnel_type still 'webinar', mode gates still enforced for that tenant.
- **E10** Sequences: POST accepts `webinar_sales`+`no_show_followup_1`; rejects
  `bogus_pipeline` 400; rejects `webinar_sales`+`bogus_stage` 400; tenant A cannot
  reference tenant B's company-scoped pipeline key (400); esc() defense still in
  web/index.html. B2 carry-through: that sequence auto-enrolls when a webinar_sales deal
  is humanly advanced into `no_show_followup_1` — enrollment row proven via API.
- **E11** GET /pipelines returns the three global funnel-typed configs (with funnel_type +
  per-stage mode); a tenant override appears once with override precedence; DELETE of a
  global key still 404s.
- **E12** PATCH /contacts/:id with `deal_stage` while the contact sits at a webinar
  marketing stage → 400 pointing to /advance.
- **E13** Full suite green (243 existing + new); report the total in the receipt.
- **E14** Browser evidence (below) in `.loop/EVIDENCE/`, referenced from the receipt.

## BROWSER TEST SCRIPT (exact actions → expected on-screen results)
1. Boot the scratch stack (Docker PG :5434 + inline-env server, per the established
   verification recipe; if the dashboard needs the local nginx-shim used for B7's
   verification, apply it temporarily and REVERT before commit).
2. Dashboard → **Pipelines tab**. EXPECT: `Webinar Marketing`, `Webinar Sales`,
   `Webinar Delivery` listed alongside legacy pipelines; stages in seeded order; manual
   stages visibly badged "manual". Screenshot → `CP1-pipelines-tab.png`.
3. **Sequences tab** → create: name `No-show recovery (test)`, pipeline `webinar_sales`
   (EXPECT in dropdown), trigger stage `no_show_followup_1` → Save. EXPECT: listed with
   the trigger rendered, escaped. Screenshot → `CP1-sequence-created.png`.
4. Create a contact + `webinar_sales` deal (UI or curl), advance
   `qualification_form_fills`→`scheduled_call`→`no_show_followup_1` (human, no automated
   flag). Open the sequence detail → **Enrollments**. EXPECT: the contact listed as an
   active enrollment. Screenshot → `CP1-enrollment.png`.
5. Attempt an illegal move in whatever surface is quickest (curl fine):
   `qualification_form_fills`→`deals` → EXPECT 409 surfaced. Note/screenshot →
   `CP1-illegal-transition.png`.
6. Browser console: EXPECT zero errors across all of the above. Note in the receipt.

## Constraints
- Scratch Docker Postgres only (:5434 recipe) — NEVER the live denchclaw DB or engines' DBs.
- `git fetch origin` before committing; branch `feat/consolidation` only; no push to main.
- No edits to `.env`/secrets/`.git`; revert any local nginx-shim before commit.
- Scope: NO content-engine / task-manager / Slack coupling. No CP2 scheduler work — CP1
  ends at "stages exist, are traversable, mode-gated on every stage authority, and
  sequences can reference them".
