# PLAN — pipeline stages as tags in the UI (feeds CP-I; separate plan, per operator request)

Operator, 2026-08-01: *"the CRM pipeline stages need to be displayed or integrated as tags within
the user interface so that it's visible and easy for the user. Come up with a separate plan for
this and then integrate it into the UX that you decide."*

This is that plan. Its criteria are folded into `CP-I-unified-inbox.md` as **D11 / I19–I23** so it
ships as part of the Inbox rather than as a floating design doc.

---

## GROUND TRUTH (verified on the scratch DB at migration 019 — do not re-derive)

- Stages live in `crm_pipeline_configs(key, name, funnel_type, entity_type, stages jsonb,
  automations, is_default, company_id)`.
- Each stage object is exactly: **`{ key, label, mode: "auto"|"manual", transitions: [stageKey…] }`**.
  Confirmed on `webinar_sales` (`funnel_type=webinar`, `entity_type=deal`): e.g.
  `scheduled_call` is `mode:"auto"` with `transitions:["no_show_followup_1","proposal_sent","deals","disqualified"]`;
  `no_show_followup_1` is **`mode:"manual"`**.
- Helpers already exist and are exported from `server/db/pipeline.js`:
  `getPipelineConfig`, `getPipelineTransitions` (:51), `isManualStage` (:67), `isTerminalStage` (:75).
- Stage values are carried on `deals.stage` (+ `deals.pipeline_key`) and on
  `contacts.marketing_stage` / `contacts.deal_stage`.
- **Free-form tags already exist** as `contacts.tags` (text ARRAY) — but they are **not chips
  today**: `web/index.html:632` renders them as `(c.tags||[]).join(", ")`, i.e. flat text.

---

## THE CENTRAL RISK, AND THE DECISION THAT FOLLOWS

A pipeline stage is **authoritative state governed by CP1's invariant** — the CRM must never
auto-advance a `mode:"manual"` stage, and only `transitions[]` targets are legal. A free tag is an
arbitrary user-authored label with no rules at all.

If we render both as the same chip, we invite a user to treat a stage like a tag: to look for an
`×` to remove it, or to add "Scheduled Call" as a tag by hand. Worse, any edit affordance we
attach to a stage chip silently becomes **a new stage-transition surface** — and CP1 spent a whole
checkpoint proving that surface has to be gated.

**Decision: stage chips and tag chips share a visual family so the UI reads as one system, but are
deliberately, immediately distinguishable, and a stage chip is never removable.**

| | Stage chip | Tag chip |
|---|---|---|
| Source | `crm_pipeline_configs.stages` | `contacts.tags` |
| Leading glyph | pipeline glyph (`◆`) | none |
| Remove `×` | **never** — an entity always has a stage | yes |
| Click | opens the **legal-transition menu** | filters the list by that tag |
| Styling | derived from `mode` + terminality (below) | neutral, hashed hue from the tag string |
| Authority | CP1 stage authority + mode gate | none |

## Visual language (deterministic, never arbitrary)

- **`mode:"auto"` ⇒ filled/solid chip.** The CRM drives this stage; the human is a passenger.
- **`mode:"manual"` ⇒ outlined chip + a small person glyph.** A human must act. This makes CP1's
  most important invariant *visible* — today `mode` is enforced server-side and invisible on
  screen, which is exactly why an operator cannot tell why a deal "won't move".
- **terminal (`isTerminalStage`) ⇒ muted**, and `disqualified`/lost in a red-grey.
- **Hue by stage index within its pipeline**, so the ladder reads consistently left→right on every
  surface. Position is derived from `stages[]` order — never hardcoded per stage key, or the three
  webinar pipelines and any custom pipeline drift apart.
- Chip always shows `label` (never the raw `key`), with `title` = `"<Pipeline name> · <mode>"`.
  `nice()` currently lowercases labels (CP1 follow-up F4) — stage chips must use the config's
  `label` verbatim instead.

## Interaction

Clicking a stage chip opens a menu built **from `getPipelineTransitions(pipeline, current)`**:
- **Only legal targets appear.** Illegal targets are *absent*, not greyed — a disabled-but-visible
  control that 409s on click is worse than no control.
- Each target is annotated with its own mode; choosing a `manual` target is allowed (a human is
  clicking) but is sent **without** the `automated` flag so CP1's authority records it as human.
- The menu posts to the existing `/advance` authority. **No new transition path is created** — if
  `/advance` refuses (entry rule, suppression, illegal), the chip shows the server's reason
  inline. The UI must never pre-empt or duplicate the server's decision.
- Read-only surfaces (inbox list rows, activity feed) render chips **non-interactive**.

## Where stage chips appear

1. **Inbox list row** — the contact's current stage, so triage is stage-aware without opening.
2. **Inbox right rail** — full stage chip + pipeline name + `funnel_type` badge, plus per-deal
   stage chips when the contact has several deals (ties into CP-I D6's deal selector).
3. **Contact detail** — stage chips first, then a `Tags` row of real tag chips (replacing the
   comma-joined string at `web/index.html:632`).
4. **Deals board card** — the stage chip is redundant with the column, so show only the **mode**
   marker there; that is the information the column does not already carry.
5. **Activity feed** — a stage-change entry renders **both** chips: `◆ Scheduled Call → ◆ No-Show
   Follow-up 1`, which makes the CP2 write-back and its refusals legible at a glance.

## Explicitly out of scope

Editing pipeline configs from a chip; drag-to-advance on the board; custom per-stage colours in
config; tag CRUD (rename/merge/delete) — all separate work. This plan is *display + a gated
transition menu*, nothing more.
