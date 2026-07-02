# Spec: T1 — Pipeline Data-Model (Marketing + Sales) Correction
**Status:** Ready to build  
**Date:** 2026-07-02  
**Scope:** Corrective migration 006 to fix transition maps seeded by migration 003

---

## Goal
The two-pipeline schema (Option B) is in place from migration 003. The seeded
transition maps are incorrect based on post-analysis: the sales pipeline is
missing the `booked` stage (making `no_show` semantically broken), and several
transitions are either too permissive (nurture→sourced re-enriches already-enriched
contacts) or too restrictive (unqualified→lost loses recyclable prospects; sourced
can't skip straight to segmented for pre-enriched imports).

**Decision this drives:** What exact JSONB transition maps live in
`crm_pipeline_configs` for the global defaults — the `/advance` endpoint enforces
these at runtime, so getting them right is the authoritative contract for the
outreach engine and all future API consumers.

---

## Architecture (confirmed Option B)
- `contacts.marketing_stage` — the contact's current position in the marketing pipeline
- `deals` row — represents an independent sales journey; a contact can have one active
  deals row (sales pipeline) while simultaneously being at any marketing stage
- `crm_pipeline_configs` JSONB `stages[].transitions` — the single source of truth for
  allowed transitions; `/advance` validates against this at request time
- No code changes required; this spec is data-only (migration 006)

---

## Confirmed Stage Maps

### Marketing pipeline (`key = 'marketing'`)
| Stage | Label | Transitions |
|---|---|---|
| `sourced` | Sourced | `enriched`, **`segmented`** *(new direct path)*, `suppressed` |
| `enriched` | Enriched | `segmented`, `suppressed` |
| `segmented` | Segmented | `queued`, `nurture`, `suppressed` |
| `queued` | Queued | `engaged`, `nurture`, `suppressed` |
| `engaged` | Engaged | `responded`, `nurture`, `suppressed` |
| `responded` | Responded | `mql`, `nurture`, `suppressed` |
| `mql` | MQL | `nurture`, `suppressed` |
| `nurture` | Nurture | `segmented`, `suppressed` *(drop `sourced` — re-enrichment avoided)* |
| `suppressed` | Suppressed | *(terminal)* |

### Sales pipeline (`key = 'sales'`)
| Stage | Label | Transitions | Notes |
|---|---|---|---|
| `accepted` | Accepted | `contacted`, `lost` | MQL handoff received |
| `contacted` | Contacted | `booked`, `unqualified`, `nurture`, `lost` | First sales touch sent |
| **`booked`** | **Booked** *(new)* | `qualified`, `no_show`, `contacted` | Meeting accepted |
| `qualified` | Qualified | `proposal`, `unqualified`, `nurture`, `lost` | Discovery done |
| `proposal` | Proposal | `negotiation`, `nurture`, `lost` | Scope doc sent |
| `negotiation` | Negotiation | `onboarding`, `lost` | Terms being discussed |
| `onboarding` | Onboarding | `won`, `lost` | Contract signed |
| `won` | Won | *(terminal)* | |
| `lost` | Lost | `accepted` | Re-entry w/ cooldown guard |
| `no_show` | No Show | `contacted`, `booked`, `lost` | *(reschedule path added)* |
| `unqualified` | Unqualified | `nurture`, `lost` | *(nurture path added)* |

---

## What to build

### Migration 006 (`migrations/006_pipeline_stage_corrections.sql`)
Single migration that UPDATEs the two global-default `crm_pipeline_configs` rows:

1. Replace the marketing `stages` JSONB entirely with the corrected map above
2. Replace the sales `stages` JSONB entirely with the corrected map above (including `booked`)
3. Both updates scoped to `WHERE key = 'marketing'|'sales' AND company_id IS NULL`
4. Idempotent — safe to run twice (UPDATE is naturally idempotent on exact-match WHERE)

No schema changes, no backfill — `booked` is a new stage no existing deals row can be
at, so existing data is unaffected.

---

## Code changes (crm.js — beyond data-only)

Codex identified that adding `booked`, `accepted`, `nurture` as sales stages requires two code-level fixes:

1. **`DEFAULT_DEAL_STAGES` (line 18)** — added `accepted`, `booked`, `nurture`. Fixes `GET /deals` pipeline grouping (was silently dropping those stages) and `POST /deals` stage validation (was mapping `accepted` → `lead`).
2. **`GET /pipeline?pipeline_key=sales` hardcoded fallback (line 854)** — added `booked`, `nurture` to the fallback list used when JSONB config is unavailable.

**Known bypasses (not fixed in T1 scope):**
- `PATCH /deals/:id` accepts a `stage` field with no transition enforcement (Codex issue #3)
- `PATCH /contacts/:id` validates via `DEFAULT_STAGE_TRANSITIONS` (hardcoded map), not JSONB (Codex issue #8)
- `addContactActivity` not scoped to `company_id` in the advance route (pre-existing bug, tracked for T2)
- `lost → accepted` re-entry has no cooldown guard in data or code; application layer must enforce via `recycled_from` tag

---

## Out of scope (handled in T2–T5)
- `POST /contacts/:id/advance` logic changes
- Conversation/messages model (T4)
- Analytics rollup schema (T5)
- UI changes (T6)

---

## Verification plan

1. **Apply 006 on scratch DB** (from `migrate.sql` baseline + 001–005):  
   Assert both pipeline rows updated; query JSONB to confirm `booked` exists in sales  
   and `sourced.transitions` contains `segmented`; confirm `nurture.transitions`  
   does NOT contain `sourced`.

2. **Advance endpoint smoke test** (legal paths):  
   - Marketing: `sourced → segmented` → must be allowed (409 before fix, 200 after)  
   - Marketing: `nurture → sourced` → must be rejected 409 (was allowed before fix)  
   - Sales: `contacted → booked → qualified` → must be allowed end-to-end  
   - Sales: `unqualified → nurture` → must return 200 (was 409 before)

3. **Regression: verify_cp4.py** stays green — migration 006 touches only the configs
   JSONB, not `contacts` schema or `deal_stage` mirror; no regression risk.

4. **Codex critic** — run the draft migration past the `critic` subagent before applying.
