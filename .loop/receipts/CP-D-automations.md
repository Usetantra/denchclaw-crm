# RECEIPT CP-D-automations (cycle 9)

**Status: DONE, with one named gap I am not pretending is closed.**
Commit ``537d0bb`` on `feat/consolidation`. 12 files, +1368/−19. **Migration 025.** Next unused: **026**.
**Suite 1030 / 0** — `unit-cpd` **71** new; every prior suite unchanged.

## What exists upstream, what does not, and what I did about each

| Ladder | Verdict |
|---|---|
| Invite ladders — email 0/72/120h, SMS & WhatsApp 0/72h, LinkedIn invite→3 msgs→InMail | **BORROWED** from `automation_core/channels/*.py` |
| Long-term nurture N0–N9 (~90 days) | **BORROWED** from `nurturing-engine/.../sequences.py` |
| **Sales-call No-Show ladder** | **DOES NOT EXIST UPSTREAM — AUTHORED** |
| Webinar reminder ladders (A0–A8 / S0–S4 / E0–E7 / L0–L1) | **NOT SHIPPED — see the gap below** |

**The No-Show finding is the one worth arguing with.** Every `no_show` in either engine means *did
not attend the WEBINAR* — a segment of the reminder ladder (`sequences.py:114,144,156,180`,
`dispatcher.py:131`, and `ga4.py:27` literally maps it to `webinar_no_show`). The operator's No-Show
Follow-ups 1–5 are about missing a booked **sales call**: different event, different audience,
different copy. It could not be borrowed, so it is authored and labelled `AUTHORED` in the API, so
nobody later mistakes it for reused work.

## The copy could not be pasted, and that is the checkpoint's real work

**Two systems, opposite merge syntax.** Upstream writes `{{first_name}}`. Here `{{...}}` is the
deliberate ESCAPE for writing *about* a merge field, so a paste renders the literal `{first_name}` —
and every guard correctly waves it through, **because the escape is intentional**. Every borrowed
string is converted, and D-1 asserts the conversion rather than trusting it.

**And the one that would actually have shipped.** Upstream's copy is built on `{book_url}`,
`{join_url}`, `{cta_url}`. None were known tokens, so `unresolvedTokensIn` returned nothing, the
claim door's content guard passed, and the executor would have sent **"Pick a time: {book_url}"** to
a real prospect. A token the system has never heard of does not fail loudly — **it fails silently**,
which is the failure mode this project has refused at every checkpoint. So the token set grew from 3
to 9 with a second class (`CONTEXT_TOKENS`, per-tenant), the send guard grew with it, and migration
025 gives the values somewhere to live.

**F-CP4a-1 closed on the way past** — outstanding since CP4a. The claim door's pattern was a
hardcoded `\{(first_name|company|stage)\}`, a second copy of `KNOWN_TOKENS`. Adding six tokens to a
stale copy would have let `{book_url}` straight through the door: the exact bug the guard exists to
prevent, reintroduced by duplication. It is generated once now and imported by both readers.

## `crm_pipeline_configs.automations` — the answer is "nothing", deliberately

It has been empty since migration 003 and **no code has ever read it**. The obvious move was to fill
it with stage→sequence bindings — except `sequences.trigger_stage` already IS that binding: indexed,
validated at authoring time, enforced by `enrollForTriggerStage`, covered by tests. A second source
of truth that nothing keeps in step is the identical mistake refused in CP-C (a second ledger) and
CP-C2 (a second lease); the first time they disagreed, an operator would be reading a pipeline screen
describing automations that were not running. So it is a **projection**, computed on read at
`GET /api/crm/automations/pipeline/:key`. D-10 pins the column empty.

## The invariant holds by design, not by luck
**No-Show Follow-up 1 is MANUAL and is the TRIGGER.** A human marks the no-show; that enrolment fires
the ladder; the ladder writes back only 2, 3, 4 and 5, every one `mode:"auto"`. Rung 1 writes back
nothing, because the contact is already there. Deal Follow-ups 1/2/3 have **no automation at all** —
3/7/12 days is when a human should act. Checked at install time *and* independently at runtime.

## The critic pass found three HIGHs. Every one was mine, and all three are fixed here

**HIGH — the cadence was wrong, and my test enshrined it.** I wrote the operator's CUMULATIVE figures
(0/+3/+6/+9/+16) into `delay_seconds`, which this engine measures **from the predecessor's ack**
(`dispatch.js:627-629`). The ladder would have fired on days 0/3/9/18/**34** — "Should I close your
file?" arriving weeks late, and the `no_show_followup_5` write-back landing on the sales board more
than two weeks after it should. Same bug, worse, in the nurture drip: upstream's column is explicitly
*"delay_hours since previous"*, I copied its day labels, and a ~90-day ladder became **~335 days** —
the cadence being the one thing I claimed to be borrowing. **D-3 asserted the column and called it
cumulative, which is why it passed.** It now reconstructs the total, and **D-3b walks two real rungs
and measures an actual `scheduled_for` delta**.

**HIGH — overwrite would have destroyed the send ledger.** `scheduled_actions.step_id` is
`ON DELETE CASCADE` — my own comment asserted the opposite. Replacing the steps of a ladder that had
run would cascade-delete every sent/claimed/quarantined row, which means: **the LinkedIn daily and
weekly caps read zero** (CP-C2 counts them off `scheduled_actions` — that ledger is the caps), an
in-flight `send_started_at` record vanishes while the message physically went out, and every
mid-ladder contact survives as `active` with a NULL current step — never materialised again, never
resumable, and blocked from re-enrolling. Overwrite is now **refused once a ladder has run**, naming
what it would have destroyed.

**HIGH (research critic) — I under-sold the deferred work.** F38 is a **translation, not a design**:
`nurturing-engine/backend/app/dispatcher.py:160-204` already implements exactly the anchored
scheduler I proposed — `parse_webinar_at`, `anchored_state`, `step_due_state`, grace hours, and
skip-past-as-MISSED rather than sent-late — with tests. Also found: the spec doc at
`/Users/adithyamurali/YOGI/WEBINAR_REMINDER_SEQUENCES_2026_06_12.md` (carries rules not in code —
stagger SMS 10–15 min after the matching WhatsApp, skip-past for late registrants) and the eight
production HTML bodies at `nurturing-engine/backend/app/assets/webinar-reminder-emails/`.

**MEDIUM, also fixed:** a cold WhatsApp is business-initiated and needs an **approved content
template** — upstream's approved SIDs belong to the reminder ladder, not this invite copy, so the
WhatsApp ladder now installs **PAUSED** with the reason (D-14) · the LinkedIn borrow took the delays
but left behind upstream's **Tue/Wed/Thu 09:00–10:30 send window**, which is narrower than CP-C2's
account default and is the one that binds — carried as an install instruction · seed identity moved
off a mutable, non-unique display name onto `sequences.automation_key`, so a rename no longer creates
a duplicate and a human's own same-named sequence cannot be clobbered (D-16) · a job frozen **before**
the token set grew was refused at the door forever while readiness reported the ladder healthy — the
re-resolve pass now retries anything the door would refuse (D-17).

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

```bash
curl -s -H "x-internal-key: $KEY" -H "x-company-id: $CO" \
  http://127.0.0.1:3102/api/crm/automations | jq '.available[] | {key, source, installed, installs_paused}'
```
```bash
curl -s -X PUT -H "x-internal-key: $KEY" -H "x-company-id: $CO" -H 'content-type: application/json' \
  -d '{"book_url":"https://usetantra.com/book","unsubscribe_url":"https://x.test/u","sender_name":"Adithya"}' \
  http://127.0.0.1:3102/api/crm/automations/merge-defaults
```
```bash
curl -s -X POST -H "x-internal-key: $KEY" -H "x-company-id: $CO" \
  http://127.0.0.1:3102/api/crm/automations/webinar_sales_no_show/seed
```

| Probe | Expect |
|---|---|
| seed **before** setting merge defaults | succeeds, `missing_merge_tokens:["book_url",…]` |
| …then resolve a step | `content_resolved:false`, reason names the **tenant setting**, not the contact |
| set the defaults, re-resolve | resolves, real URL substituted, no brace |
| move a deal/contact into `no_show_followup_1` | enrolled; rung 1 queued **due now**, payload carries the contact's name AND the URL |
| ack rung 1 sent, measure rung 2 | **+3 days from the ACK** — measure, don't read the column |
| walk all five | cumulative **0 / 3 / 6 / 9 / 16** days; writebacks FU2→FU5 |
| any step writing a MANUAL stage | must not exist; the seeder refuses at install |
| re-seed | `already_installed`, copy untouched, still one sequence |
| `overwrite:true` after a send | **refused**, naming sent jobs + live enrolments |
| WhatsApp ladder | installs **`paused`**; a queued rung is **not claimed** |
| a payload carrying `{webinar_date}` with none set | **not claimed** |
| `POST /sequences/:id/steps` with `linkedin_action:'invite'` on an email step | **400** |

**Assert measured timing and provider-visible CONTENT.** The cadence bug passed a column assertion.

**Not visible in the UI** (**F39**): no automations screen — catalogue, seed, merge defaults and the
pipeline projection are all API-only.

## Gate hit
**None.** No push, no deploy, no live DDL, no real provider key, `:3101` only. `pro-workflows` was
read-only throughout.

## Follow-ups
**F38 — the anchored scheduler**, and it is a PORT: `enrollments.anchor_at` +
`sequence_steps.anchor_offset_seconds` + grace + skip-past-as-missed, then the A/S/E/L reminder
ladders and their eight production HTML bodies land almost for free. `registrants`,
`auto_registrants` and `attendees` trigger **nothing** until it exists · **F39** no automations UI ·
**F40** WhatsApp needs approved template SIDs before its ladder can leave `paused` ·
**F41** upstream staggers SMS 10–15 min after the matching WhatsApp touch; not modelled ·
**F37** a missing recipient QUARANTINES and therefore **STALLS** a ladder rather than skipping the
rung — the reason the No-Show ladder is email-only.

## Next
**F38.** It is the last thing standing between the marketing funnel and being real: the stages
`registrants` → `attendees` exist, are marked automated, and currently have nothing attached to them.
