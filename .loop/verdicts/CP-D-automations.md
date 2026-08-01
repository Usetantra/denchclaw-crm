# VERDICT — CP-D automation definitions → **PASS**

**Commit:** `537d0bb` · **Verified by:** orchestrator/tester, 2026-08-01 · **Evidence:** `.loop/EVIDENCE/CP-D/`

## What this closes
The last unbuilt item in `.loop/GOALS.md`. The operator asked for automations *"borrowed from the
existing automation workflows we've created within the outreach engine or the nurturing engine"*.
Before CP-D, `crm_pipeline_configs.automations` was empty on every row and every sequence in the
database was a test fixture — nothing an operator could switch on.

## Verified against the operator's own spec — 8 passed / 0 failed
Seeded the real ladder and read back what landed:

```
#1 email  +0d  →  (no write-back)
#2 email  +3d  →  no_show_followup_2
#3 email  +3d  →  no_show_followup_3
#4 email  +3d  →  no_show_followup_4
#5 email  +7d  →  no_show_followup_5
```
- **D3** per-step `0/3/3/3/7` ⇒ **cumulative `0 / +3d / +6d / +9d / +16d`** — exactly the operator's
  ladder. (`delay_seconds` is per-step because CP2 schedules the next rung at *ack time* + delay.)
- **D4 rung 1 writes back NOTHING.** Follow-up 1 is MANUAL and is what *triggered* the ladder, so
  writing it back would be the CRM touching a manual stage. The invariant is respected in the
  **design**, not merely caught at runtime.
- **D5** rungs 2–5 mirror `no_show_followup_2..5`. **D6** triggered by the MANUAL stage a human marks.
- **D7** the copy carries merge tokens and resolves **per contact at schedule time** — so rung 5,
  sixteen days later, reflects who the contact is when it actually goes out.
- **D8** seeding twice does not duplicate (`already_installed`, left untouched).

Six definitions ship: four invite ladders (email/SMS/WhatsApp/LinkedIn) on `webinar_marketing`, the
No-Show ladder on `webinar_sales`, and a 10-step long-term nurture.

## The borrowing answer, which is the honest part
`webinar_sales_no_show` is labelled **`source: 'AUTHORED — no sales-call no-show ladder exists in
either engine; every upstream no_show means "did not attend the webinar", which is a different
event entirely'`**. That distinction is sharp and correct, and it is the second time this project
has reported "there is nothing upstream to borrow, and here is why the thing that looks like it
isn't it" — the first being Visits in CP-B. That is worth more than a plausible port.

## F-CP4a-1 — closed, and it had already come true
I filed after CP4a: *"the claim door's token list is a hardcoded SQL literal duplicating
KNOWN_TOKENS. They agree today and will drift the first time a token is added."* CP-D added six
tokens and they **did** drift. It is now generated **once** in `templates.js` as
`UNRESOLVED_TOKEN_RE` and imported by both readers. Verified behaviourally: all nine tokens block,
while braced prose (`{growth}`) is still allowed.

## Regression checks
- **Suite 971 passed / 0 failed across 17 suites** (CP-D contributes 71).
- Migration 025 adds `crm_merge_defaults` (per-tenant `key`/`value`) as the source for the new
  context tokens; `GET /automations/merge-defaults` reports which are set.

## Anomalies — both were mine
1. **D3 units.** I compared the operator's *cumulative* ladder against *per-step* `delay_seconds`
   and read `[0,3,3,3,7]` as wrong. It is right: it sums to the specified ladder.
2. **D7 wrong table.** I looked for copy in `sequence_steps.subject/body`, found NULL, and read it
   as "no content". The copy lives in `message_templates` via `template_ref` — CP4a-0's own design.

## Verdict
**PASS.** The operator's real automations now exist as seedable definitions with the specified
timings, the manual-stage invariant honoured by design, per-contact resolution at send time, and
an honest account of what could not be borrowed.
