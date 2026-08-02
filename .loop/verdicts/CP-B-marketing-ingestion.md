# VERDICT — CP-B marketing-stage ingestion → **PASS**

**Commit:** `a897ad4` (2,084 lines) · **Verified by:** orchestrator/tester, 2026-08-01, independently
**Receipt:** `.loop/receipts/CP-B-marketing-ingestion.md` — **CORRECTION.** An earlier draft of this
verdict said the receipt was not written. That was wrong: it landed at 06:24 while I was mid-probe
and this verdict was written at 06:28. Everything below is still independently mine, but the receipt
existed and I have now read it. It answers the operator's reuse question in full — see below.

## Why this checkpoint mattered most
`.loop/GOALS.md`: the operator specified Visits, Registrants, Auto-Registrants and Attendees as
**automated**. For six weeks `visits`, `registrants`, `auto_registrants`, `attendees` and `invitees`
appeared in **ZERO server files** — the marketing funnel above `prospects` was a diagram, not a
mechanism. This is the checkpoint that makes it real.

## THE HEADLINE — the funnel moves end to end
`scratchpad/orch-cpb-positive.mjs`, **10 passed / 0 failed** on a fixture chain I built myself:

| Operator's stage | Verified |
|---|---|
| **Invitees** | sending an invite advances `prospects → invitees` |
| **Visits (automated)** | following the real invite link advances → `visits` |
| **Registrants (automated)** | a landing-page registration advances → `registrants` |
| **Auto-Registrants (automated) path 1** | **YES to a cold CALENDAR invite** auto-registers |
| **Auto-Registrants (automated) path 3** | an interested **COMMENT under a content post** auto-registers |
| **Attendees (automated)** | attendance advances a registrant → `attendees` |

Live funnel after the run: `auto_registrants=5, prospects=3, registrants=3, visits=3, attendees=1`.

## Security — the first PUBLIC surface in this system, so it got the hardest look
`marketing-public.js` is mounted **outside `requireAuth`** at `/m` and `/webhooks/marketing`.
- **Secret enforced**: `/registration`, `/rsvp`, `/comment` each return **401** with no secret, and 401 with a wrong one.
- **The tenant cannot be forged**: a caller supplying `company_id: 'co_attacker'` got **403** and created **zero** rows under that tenant. The tenant is decided server-side — which is the only thing that makes one shared public secret safe.
- Design choices I checked and agree with: header-only secret (no `?secret=` because query strings land in logs), constant-time compare, per-IP rate limit from the last `x-forwarded-for` hop, and the invite redirect deliberately **not** secret-gated because it is a public link whose token is the capability, with an unknown token a plain 404.
- **Idempotency**: three hits on the same invite link increment `visit_count` but produce **one** stage advance and **one** activity row. A refresh is not three visits.
- **The invariant holds through the new door**: no ingestion path moved a deal onto a MANUAL stage.

## Suite
**783 passed / 0 failed** on my own rebuilt DB (up from 774). Migration 023 applies a **2nd and 3rd**
time clean, creating `crm_webinars`, `crm_invite_links`, `crm_marketing_events`.

## Anomalies — **all four were mine**, traced before reporting
1. Flat payloads (`{email}`) 400'd because ingestion needs the **webinar → invite → token** chain;
   my early "passes" for idempotency and the manual-stage guard were **vacuous** and I said so.
2. Contacts are born at `sourced` (the LEGACY marketing pipeline). CP1's **entry rule** correctly
   refuses a mid-funnel jump into `webinar_marketing`, whose first stage is `prospects`.
3. `prospects → invitees` is the **only** legal first move, so Registrants/Comment/Attendees
   failed until I invited each contact first — the pipeline refusing illegal jumps, exactly as
   the operator's funnel describes.
4. The attendance endpoint takes `attended`, not `attendees`.

## Not driven by me — stated rather than glossed
- **Auto-Registrant path 2** ("reply and express interest" to cold email). It routes through
  `reply-classify.js` and CP-I's inbound handling; I verified paths 1 and 3 live but not this one.
  **First target next pass**, together with confirming it reuses CP-I's pipeline rather than a
  second inbound path.
- The **golden journey** was not re-run this pass; it must still read 12/0/0.
- ~~Whether anything was borrowed from the engines~~ — **ANSWERED by the receipt, and it is the most
  operationally useful thing in it.** The reusable code is **not in either engine**: both are thin
  FastAPI shells importing a third shared package, `/Users/adithyamurali/pro-workflows/automation_core`.
  **Borrowed:** the ingest shape from nurturing's `app/events.py::ingest_event` (normalize → resolve →
  dedupe → log → side-effects), keeping its rule that *a dedupe conflict skips EVERY side-effect*;
  two-layer idempotency (`webhook_events (provider, provider_event_id)` ON CONFLICT DO NOTHING **plus**
  a business `dedupe_key` partial unique index) because they catch different things — transport retries
  vs the same real-world fact arriving by two routes — and made **tenant-scoped from the start**, which
  the nurturing copy is not; the public-webhook posture wholesale; and `classify_reply`'s STOP/auto-reply
  regexes ported directly.
  **Could NOT be borrowed because it does not exist anywhere** (stated plainly, which is the right
  answer to "borrow"): **Visits — nothing at all**, no tracked link, redirect, pixel or visit table in
  any of the three repos, and `automation_core/utm.py` is campaign+step granular so it *cannot identify
  which invitee clicked*; **calendar RSVP reading** — invites are created but nothing ever reads
  `responseStatus`; **LinkedIn comment ingestion** — Unipile is wired but no `comment.*` trigger is
  subscribed; **positive-intent classification** — `classify_reply` is a three-way STOP/auto/human split
  with no "interested" detector; and **no webinar-platform connector** exists at all, so attendance is
  roster import exactly as nurturing does it.
  I verified the builder only **read** `pro-workflows` — that shared checkout is unmodified.

## Verdict
**PASS.** The operator's automated marketing stages advance for the first time, the public
ingestion surface refuses unauthenticated writes and tenant forgery, ingestion is idempotent, and
CP1's invariant survives the new door.
