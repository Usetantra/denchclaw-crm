# CP-B — MARKETING STAGE INGESTION

**Self-authored by the build session** (STATE.next_ticket named it; no ticket file existed).
Closes audit item 1, the largest goal gap: *"the automated MARKETING stages are inert."*

## The goal this serves (operator, verbatim — .loop/GOALS.md)

- **Visits (automated)** — "invitees that have visited the landing pages from the invites or invite emails."
- **Registrants (automated)** — "visitors on the landing page that register for the webinar from the landing page."
- **Auto-Registrants (automated)** — "invitees auto-registered as registrants **without** filling the form,
  for different invite/outreach channels." Three paths, verbatim:
  1. respond **YES / MAYBE** to cold **calendar invite** outreach
  2. **reply and express interest** for cold **email** outreach
  3. **comment below content posts** expressing interest
- **Attendees (automated)** — "Registrants (or Auto-Registrants) that attend the webinar."
- **Invitees** — "prospects that have been sent invites on different channels."

And the framing rule: the workflows are to be **borrowed from the outreach / nurturing engines**,
not reinvented.

## What exists today

`invitees`, `visits`, `registrants`, `auto_registrants`, `attendees` are declared in
`crm_pipeline_configs` (migration 018) with correct modes, and appear in **zero server files**.
Nothing ever moves a contact into them. The funnel above `prospects` is a diagram.

## Scope

One canonical ingestion path + thin adapters, giving all five automated stages a real driver.

| event_type           | → stage            | source |
|----------------------|--------------------|--------|
| `invite_sent`        | `invitees`         | CRM sender / outreach engine |
| `landing_page_visit` | `visits`           | tracked invite link redirect, or a provider click event |
| `registration`       | `registrants`      | landing-page form (public webhook) |
| `calendar_rsvp`      | `auto_registrants` | YES/MAYBE on a cold calendar invite |
| `email_reply`        | `auto_registrants` | interested reply to cold email |
| `content_comment`    | `auto_registrants` | interested comment under a content post |
| `attendance`         | `attendees`        | webinar platform roster |
| `no_show`            | (no stage move)    | roster; recorded only |

## Non-negotiables

- **The manual-stage invariant is untouched.** Ingestion never gets its own stage-writing code
  path — it goes through the SAME authority as `POST /contacts/:id/advance`, always with
  `automated: true`. A programmatic move into a manual stage must still 403.
- **Attribution before advancement.** An unattributable landing-page hit moves nobody (C4).
- **Idempotent.** Replayed provider deliveries must not double-advance or double-enroll.
- **Interest is never assumed.** Absent/ambiguous ⇒ no auto-registration (C4).
- **Content, not status flips** (C1): tests assert the contact's *stage* and the *event outcome*,
  not merely that a row was written.

## Eval criteria

- **B-1** Migration 023 applies twice cleanly; no pre-existing row changes.
- **B-2** `invite_sent` moves `prospects → invitees` and records the event.
- **B-3** `invite_sent` for a contact NOT in the webinar marketing pipeline is REFUSED — entry is
  only at `prospects`, which is **manual**, so the CRM may not place them there. Outcome `refused`.
- **B-4** A tracked invite link 302s to the destination and moves `invitees → visits`.
- **B-5** A second hit on the same link does not re-advance and does not duplicate the event.
- **B-6** An unknown/forged token 404s and moves nobody.
- **B-7** Landing-page registration (public, secret-gated) moves `visits → registrants`.
- **B-8** The registration webhook is fail-closed: no secret configured ⇒ 503; wrong secret ⇒ 401.
- **B-9** Calendar RSVP accepted/tentative → `auto_registrants`; declined → no move.
- **B-10** An email reply expressing interest → `auto_registrants`.
- **B-11** A reply that says "not interested / remove me" → **no move**, and STOP-class replies
  add a suppression.
- **B-12** An out-of-office auto-reply → no move (never mistaken for interest).
- **B-13** A reply with no interest signal → no move, outcome `not_interested`.
- **B-14** A content comment expressing interest → `auto_registrants`.
- **B-15** Attendance moves `registrants → attendees` AND `auto_registrants → attendees`.
- **B-16** Attendance for a contact who never registered does NOT force a stage; it is recorded
  and reported.
- **B-17** `no_show` records an event and moves nobody.
- **B-18** Every ingest is deduped on `(company_id, dedupe_key)`; a replay returns `duplicate` and
  runs zero side-effects.
- **B-19** A stage move made by ingestion fires sequence enrollment exactly as a manual advance
  does (same authority ⇒ same hook).
- **B-20** The manual-stage invariant survives ingestion: a marketing pipeline whose target stage
  is manual refuses the automated move with 403 / `manual_stage`.
- **B-21** Suppressed contacts are not dragged into the pipeline by ingestion.
- **B-22** Cross-tenant: an event for tenant A never touches tenant B's contact.
- **B-23** The extraction of the shared stage authority changes no existing behaviour — the full
  pre-existing suite still passes.

## Borrowed from (operator's instruction)

- `~/nurturing-engine/backend/app/events.py` — ONE canonical `ingest_event`: normalize → resolve
  contact → dedupe → log → side-effects; dedupe conflict ⇒ skip **all** side-effects.
- `~/nurturing-engine/backend/app/webhooks.py` — thin adapters, header-only shared secret, fail
  closed, per-IP sliding-window rate limit off the **last** `x-forwarded-for` hop, body-size cap,
  server-pinned `company_id` with a loud 403 on mismatch.
- `~/outreach-engine/backend/app/webhooks.py` — `classify_reply` STOP/auto/human regexes, and the
  company-scoped inbound dedupe namespace.
