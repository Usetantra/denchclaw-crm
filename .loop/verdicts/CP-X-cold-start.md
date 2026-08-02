# CP-X — COLD START verdict (orchestrator, independent)

**Question.** Every green number this session came from a database I had been shaping all
session. A deploy gets none of that. So: does the **committed** tree, applied to a **virgin**
database in the documented order, stand up and serve authenticated traffic — and does the
invariant that outranks every other rule still hold there?

Schema was read with `git show HEAD:` — never the working tree — so nothing uncommitted leaked in.

## Result: 11 passed / 0 failed

| # | Check | Result |
|---|---|---|
| X1 | all 25 committed schema files apply cleanly to a virgin DB, in order | PASS |
| X2 | every table the app fails-closed on exists after a cold apply (16/16) | PASS |
| Y1 | a contact can be created on a cold deploy | PASS |
| Y2 | entry into a pipeline at its FIRST stage is accepted | PASS |
| Y3 | a LEGAL onward transition is accepted | PASS |
| Y4 | an ILLEGAL skip is refused **for the skip**, not for a missing entry | PASS |
| Z1 | the ENGINE may advance through AUTO stages (positive control) | PASS |
| Z2 | the ENGINE is REFUSED entry into a MANUAL stage — 403 `manual_stage` | PASS |
| Z3 | …and nothing was written — the refusal is atomic, not a half-move | PASS |
| Z4 | a HUMAN may set the same manual stage | PASS |
| Z5 | the mode gate OUTRANKS transition legality | PASS |

## The deploy hazard, re-tested cold

`.loop/DEPLOY_RUNBOOK.md` records that `/health` returns 200 while every authenticated request
401s when migrations are missing. On the correctly-ordered cold apply:

    /health                → 200
    GET /api/crm/contacts  → 200      ← the one that 401s when schema is missing
    GET /api/crm/pipelines → 200
    no key                 → 401      ← still fails closed

So the runbook's ordering is not just documented, it is now **demonstrated in both directions**.

## Stage modes are server-driven, not a frontend fiction

The browser evidence showed a person glyph for manual stages. That glyph is only honest if the
mode comes from the server. On the cold DB, `GET /api/crm/pipelines` returns per-stage `mode`,
and it matches the operator's spec exactly:

- `webinar_marketing` — **manual:** `prospects` · **auto:** invitees, visits, registrants, auto_registrants, attendees
- `webinar_sales` — **manual:** `no_show_followup_1`, `proposal_sent`, `deals`, `deal_followup_1..3` · **auto:** qualification_form_fills, scheduled_call, no_show_followup_2..5, disqualified
- `webinar_delivery` — **manual:** all five

**Recorded caveat, not a defect:** the legacy `marketing` and `sales` pipelines declare no `mode`
on any stage. The mode gate applies to funnel-typed pipelines, and those two predate CP1's
funnel_type dimension. The invariant therefore does not constrain the legacy pipelines — there is
nothing there for it to constrain. Worth knowing before anyone assumes blanket coverage.

## Three probe defects of my own, corrected before they became false confidence

1. Contacts are born at `sourced` (migration 003's default), so my "legal" `prospects → invitees`
   was refused by CP1's **entry rule**. My illegal-skip check then "passed" for that same entry
   reason rather than for the skip — a **vacuous pass**. Fixed by entering at the first stage first;
   the refusal now names the skip and returns the allowed targets.
2. The stage graph lives at `/pipeline/transitions` (singular) and returns the **legacy** deal-stage
   graph; the funnel graph with modes is `/api/crm/pipelines`.
3. `advanceContactStage` takes a **contact object** plus a resolved `pipeline`, and **returns**
   `{ok, code, status, body}` rather than throwing. Rev 1 passed an id and read a TypeError as a
   refusal — so its "the engine was blocked" result proved nothing at all.

There is no migration `001`: `migrate.sql` is the tracked base schema and the committed harness
applies it first. Checked because a missing base schema would be a genuine cold-start defect.

**Verdict: the committed tree is deploy-ready on its own merits.** Nothing here changes the
operator decisions still owed.
