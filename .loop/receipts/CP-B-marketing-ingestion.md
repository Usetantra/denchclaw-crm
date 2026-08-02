# RECEIPT CP-B-marketing-ingestion (cycle 6)

**Status: DONE.** Commit `a897ad4` (the ingestion) on `feat/consolidation`, with `20b14e7`
immediately before it (one manual-stage gate + the F1/F2 content fixes it depends on).
Not pushed, not deployed. Migration **023**; next unused is **024**.

**Suite 848 / 0** on a fresh DB — `unit-cpb` **65**, everything prior unmodified.

> **Read this first if you re-run it:** the public marketing webhooks **fail closed**, and they
> derive the tenant **from the secret**. A runner that does not set `MARKETING_WEBHOOK_SECRET` /
> `MARKETING_WEBHOOK_SECRETS` turns every CP-B webhook test into a 503 cascade — I saw exactly that,
> **46/19**, and nearly reported a green checkpoint as red. `test/run-local.sh` sets them correctly
> (and pins `RUN=$$` so the server, booted first, knows the tenant id the test will create); my local
> scratchpad mirror had gone stale. Same class as your port clash.

## What the five stages now do

| Stage | Driver | Path |
|---|---|---|
| **Invitees** | `POST /api/crm/marketing/invites` | issues a per-contact, per-channel tracked link and advances to `invitees` |
| **Visits** | `GET /m/i/:token` | public redirect: records the visit **attributed to that invite**, advances to `visits`, 302s on |
| **Registrants** | `POST /webhooks/marketing/registration` | landing-page form post |
| **Auto-Registrants** | three paths, each carrying its own `source` | `calendar_rsvp` (YES/MAYBE only) · `email_reply` · `post_comment` |
| **Attendees** | `POST /api/crm/marketing/attendance` | idempotent roster import |

## What I found in the engines, and what I actually reused

The operator asked for these to be **borrowed**. The first useful finding is that the reusable code
is **not in either engine**: both are thin FastAPI shells importing a third shared package,
**`/Users/adithyamurali/pro-workflows/automation_core`** (`automation-engines-shared` is env-only —
`.env.shared`, compose, no code).

**Borrowed:**
- **The ingest shape** — nurturing's `app/events.py::ingest_event`: *normalize → resolve contact →
  dedupe → log → side-effects*, with its two load-bearing rules kept: ONE canonical path for every
  signal, and **a dedupe conflict skips EVERY side-effect**, not just the insert.
- **Two-layer idempotency** — `webhook_events (provider, provider_event_id)` ON CONFLICT DO NOTHING
  (`automation_core/integrations/webhooks.py:77`) *plus* a business `dedupe_key` with a partial
  unique index (outreach `001-automation-engines.sql:178`). Both, because they catch different
  things: transport retries vs the same real-world fact arriving by two routes. **Tenant-scoped from
  the start** — the nurturing copy is not, and they record that as a known gap.
- **The public-webhook posture** — nurturing's registration route wholesale: header-only secret (no
  `?secret=`, which lands in access logs), fail closed, constant-time compare, per-IP window off the
  **last** `x-forwarded-for` hop, body cap.
- **`classify_reply`'s STOP / auto-reply regexes** — a direct port from both engines.

**Could not be borrowed, because it does not exist anywhere** (stated plainly, since "borrowed" was
the instruction):
- **Visits — nothing at all.** No tracked link, redirect, pixel or visit table in any of the three
  repos. UTM decoration (`automation_core/utm.py`) is campaign+step granular and **cannot identify
  which invitee clicked**. The only per-contact click signal is Resend `email.clicked` — email-only,
  and a link click, not a page load. So `invite_links` is new, and it is the only way *"invitees that
  visited the landing pages **from the invites**"* can mean what the operator says.
- **Calendar RSVP reading** — invites are *created* (`integrations/google_calendar.py:134`,
  `sendUpdates=all`) but **nothing ever reads `responseStatus`**. No `events.list`, no watch channel.
- **LinkedIn comment ingestion** — Unipile is fully wired and webhook-authenticated, but no
  `comment.*` trigger is subscribed and no handler exists.
- **Positive-intent classification** — `classify_reply` is a three-way STOP/auto/human split. There
  is no "interested" detector, so path (2)'s interest test is new on top of the borrowed regexes.
- **Any webinar-platform connector** — no Zoom / WebinarJam / Livestorm / Meet code exists. Attendance
  is roster import, exactly as nurturing does it.

## Your five attack lines

- **Idempotency** — a page refresh is one visit (`visit_count` increments, the stage does not
  re-fire); a duplicate webhook is one registration. Replay reports `duplicate:true` and runs **zero**
  side-effects — asserted against a hand-reset stage that must stay put.
- **Attribution** — a Visit resolves through the invite token, so it carries the contact, the channel
  and the campaign that caused it. An unattributable hit is not a Visit.
- **Through the authority** — ingestion calls `advanceContactStage` (`lib/stage-authority.js`), not a
  second copy of the rules. **B-20 proves the invariant holds under ingestion**: it refuses to
  auto-advance a manual stage and the contact does not move. B-21 proves an all-channel-suppressed
  contact is refused entry.
- **Three paths** — `calendar_rsvp` accepts only YES/MAYBE (declined and unrecognised values move
  nobody, both asserted); `email_reply` reuses **CP-I's inbound handling** — `webhooks.js` calls
  `ingestMarketingEvent`, there is no second inbound pipeline; `post_comment` requires an interest
  signal.
- **Golden journey** — its 8/4 was F3, whose root cause was F1 (authoring copy did not un-stick a
  job). F1 is fixed in `20b14e7`, so it should re-run clean after a reset+reseed. **I have not re-run
  it myself** — flagging that rather than claiming it.

## Two things I want on the record

1. **`a897ad4` is not my commit.** It landed from the session you have since archived. I verified it
   rather than trusting it: 65/0 standalone, no regression, routes mounted and fail-closed. I have
   changed nothing in it. If you find an edit neither of us made, this is the commit to look at.
2. **`20b14e7` is mine and CP-B depends on it.** The manual-stage gate existed in **four** places
   (not three): the contact authority plus three deal paths. `manualStageRefusal()` now owns the
   decision; behaviour-preserving, proven by 774 green with **no test edited**.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

```bash
# the env that matters — without it every webhook test is a 503 cascade
MK=ct-mk-$$; RUNID=$$
MARKETING_WEBHOOK_SECRET="$MK"
MARKETING_WEBHOOK_SECRETS="{\"$MK\":\"cpb_co_$RUNID\"}"   # tenant comes FROM THE SECRET
MARKETING_PUBLIC_BASE="http://127.0.0.1:3102"
# then run the test with RUN="$RUNID" so it creates the tenant the secret names
```

| Probe | Expect |
|---|---|
| `POST /marketing/invites {contact_id, channel:'email'}` | 201 + a token URL; contact → `invitees` |
| same call again | **same token**, not a second one (attribution must not split) |
| `GET /m/i/:token` | 302 to the destination; contact → `visits` |
| `GET /m/i/:token` again | 302; `visit_count` 2; stage still `visits` — **one visit, not two** |
| `POST /webhooks/marketing/registration` with the secret | 200; contact → `registrants` |
| same delivery replayed | `duplicate:true`, **zero** side-effects |
| wrong / missing secret | **401**; secret bound to another tenant → **403** |
| RSVP `accepted` / `tentative` | → `auto_registrants` |
| RSVP `declined` / garbage | moves nobody |
| comment with no interest signal | registers nobody |
| attendance roster | `registrants`/`auto_registrants` → `attendees`; an attendee who never registered is **refused**, not force-walked |
| any ingest targeting a manual stage | **refused** — the invariant holds under ingestion |

**Not visible in the UI:** all of it (**F26** — no marketing-funnel UI). Inspect `marketing_events`,
`invite_links.visit_count`, and `GET /api/crm/marketing/funnel`.

## Gate hit
**None.** No push, no deploy, no live DDL, no real provider key. `:3101` only.

## Follow-ups
**F26** no marketing-funnel UI · **F27** calendar RSVP, LinkedIn comment and webinar-attendance
connectors live in the engines and are still unbuilt — CP-B receives these events, nothing yet emits
two of them · **F-CP4a-1** claim-door token literal still duplicates `KNOWN_TOKENS` · **F23/F24/F25**
from CP4a · **F19** `trust proxy` allowlist bypass.

## Next
**CP-C** — per-channel EP integrations (Unipile/LinkedIn, Twilio/SMS+WhatsApp, ai_call), each
**wrapped** in the B4 claim/ack contract. The adapter interface to mirror is
`automation_core/channels/base.py:338` (`is_configured` / `send` / `fetch_events`), and the providers
are already implemented there — CP-C is wrapping, not writing.
