
## CP-B (marketing ingestion) — 2026-08-01

- **DECIDED BY DEFAULT: extract the contact-branch stage authority into
  `server/lib/stage-authority.js` and have BOTH `/advance` and the marketing ingest call it,
  rather than having the ingest self-call `/advance` over HTTP loopback.** Because: the loopback
  form (used by `webhooks.js`) depends on `INTERNAL_API_KEY`, so marketing ingestion would
  fail-closed in every deployment that has not set it, and it would double the auth surface for a
  call that already knows its tenant. Duplicating the gate instead was never an option (C3). The
  774-test suite is the regression proof for the extraction.
- **DECIDED BY DEFAULT: ingestion never walks more than one stage hop.** The nurturing engine's
  `advance_stage` walks intermediate stages; ours must not, because every hop fires
  `enrollForTriggerStage`, so a walk would send a "you registered!" email to someone who has
  already attended. One hop, or a recorded refusal.
- **DECIDED BY DEFAULT: attendance by a contact who never registered does not force a stage.**
  The operator's definition is "Registrants (or Auto-Registrants) that attend". A raw attendee is
  recorded with outcome `refused` + the transition detail and surfaced in the response, rather
  than silently dropped or force-walked. Reversible: a human can advance them.
- **DECIDED BY DEFAULT: interest is opt-in, never inferred by default.** `interested: true|false`
  in the payload wins when present. When absent the CRM classifies conservatively; STOP-class and
  auto-reply-class NEVER auto-register, an explicit negation NEVER auto-registers, and no positive
  match ⇒ `not_interested` with no stage move (C4 — absent reads as unsafe).
- **DECIDED BY DEFAULT: the tracked-invite redirect validates its destination at CONFIG time**
  (http/https only, no embedded credentials), defaulting to the webinar's `landing_page_url`. A
  host allowlist was NOT made mandatory because the destination is written only by an
  authenticated internal caller, not by the internet; `MARKETING_LINK_HOST_ALLOWLIST` is honoured
  when set.

### Added by the build session after re-reading the code (2026-08-01, post-handoff)
Two calls the orchestrator said it would probe that were not yet written down. Both are read off
the committed code, not reconstructed from intent.

- **DECIDED BY DEFAULT: a distinct Visit is keyed on the LINK, not the hit.**
  `deriveDedupeKey` returns `mk:visit:tok:<token>` (`server/lib/marketing-events.js:243`), so the
  second, fifth and fiftieth click of the same invite all collapse to one marketing event and the
  stage moves once. **Why:** the operator's definition is *"invitees that have visited the landing
  pages from the invites"* — a state about a person, not a counter of page loads. A refresh is not a
  new fact. The raw count is not lost: `invite_links.visit_count` still increments, so attribution
  and engagement volume remain visible while the funnel stays honest.
  *Consequence worth knowing:* a contact invited on two channels has two tokens, so a visit from each
  is two events. That is deliberate — it is how per-channel attribution stays real — but it means
  "visits" counts (contact, channel) pairs, not contacts.

- **DECIDED BY DEFAULT: an unknown or forged invite token is a plain 404 that moves nobody, and the
  redirect never depends on the funnel succeeding.**
  `GET /m/i/:token` 404s an unrecognised token (`server/routes/marketing-public.js:191`) — there is
  nothing to attribute and nobody to advance, and inventing a contact from an unauthenticated URL
  would be a public write primitive. Conversely, when the token IS valid the redirect fires **even if
  the stage move is refused or the DB is unhappy** (`:182-186`, `:216`). **Why:** the prospect clicked
  our link; landing on the page is their business and the CRM's bookkeeping is not their problem. The
  failure mode is a missing funnel event, never a broken landing page — and a missing event is
  recoverable, a lost prospect is not.

## 2026-08-01 ~06:05 — CP4a addendum findings (second orchestrator pass)

**DECIDED BY DEFAULT: F1+F2 are filed as a follow-up ticket for the builder, NOT a CP4a rejection,
because CP4a's own contract (send once, never blank) holds and the defect is inherited from CP4a-0.
Operator may override and demand a CP4a re-open.**

- **F1 (MEDIUM-HIGH)** — `content_resolved` is FROZEN into `scheduled_actions.payload` at
  `materializeNextStep()` (`sequences.js:291-342`) and nothing re-resolves it, so a job queued
  before its copy exists is **permanently unclaimable**. Authoring the copy afterwards does NOT
  un-stick it, contradicting the claim door's own comment. Reproduced.
- **F2 (HIGH)** — `sequenceContentReadiness()` resolves STEPS, not queued rows, so after authoring
  it reports `sendable:true` while the queued row stays dead. The operator is told the ladder is
  safe to switch on while it silently will never send. Reproduced.
- **F3 (MEDIUM)** — the standing golden journey is 8/4, stale since CP4a-0; its fixture never
  authors copy for the ladder steps. **Blocked on F1** — the new gate link cannot be written until
  authoring copy actually un-sticks a job.

**Suggested fix, cheapest first:** re-resolve at the claim door for `content_resolved=false` rows
(the resolver is already reachable from there); or make readiness count queued unresolved rows so
`sendable` cannot lie. A one-shot re-resolve endpoint unblocks operators but leaves the trap armed.

**RESOLVED — 2026-08-01 06:14:56, commit `20b14e7`** ("fix(crm): one manual-stage gate, and authoring
copy actually un-sticks a ladder"), about 10 minutes after this entry was filed. Both parts of the
suggested fix landed, not just one: `server/db/models/dispatch.js`'s claim door now calls the new
`templatesDb.reresolveUnresolvedJobs()` (`server/db/models/templates.js`) before claiming, so authoring
copy after the fact really does un-stick a frozen job (closes F1); and
`sequenceContentReadiness()` (`templates.js`) now also counts queued `pending`/`claimed` rows with
`content_resolved=false`, so `sendable` can no longer lie (closes F2, comment explicitly marked "F2" in
that function). Covered by a dedicated F1/F2 block in `test/unit-cp4a0-content.mjs` (freeze → readiness
correctly refuses → copy alone unsticks it via the claim door → negative control proves a still-copyless
job stays stuck). Re-verified independently this session: full suite 1102/1102 passing, 19/19 suites,
including that block. This entry was left as an open ticket in the doc for a while after the fix
shipped — recorded here so it isn't re-discovered and re-investigated as if still open. **F3 was not
independently re-verified as fixed** and should be checked on its own before being assumed done, though
its stated blocker (F1) is gone.

**Why it matters for the GOALS:** this lands hardest on exactly the work the operator asked for —
borrowing the outreach/nurturing engine automations will materialise jobs before their copy exists
in the new content store, and every one of those ladders would be silently dead while readiness
reported them healthy.

## CP-C (per-channel EP integrations) — 2026-08-01, from a read-only survey of automation_core

- **DECIDED BY DEFAULT: LinkedIn does NOT ship a sender in v1. It gets its own checkpoint.**
  The survey's load-bearing finding: **the LinkedIn safety spine is not in the adapter.** Wrapping
  `LinkedInAdapter.send()` gets you suppression, the kill switch/allowlist and eligibility — and
  *nothing else*. Every rate limit, the 07:00–18:00 IST window, the accept gate and the
  reserve-before-send lease live in `outreach-engine/backend/app/linkedin_gate.py` plus the
  **orchestration order in `dispatcher.py:355-429`**, which is not a reusable function. Porting it
  means three tables (`linkedin_accounts`, `linkedin_prospect_state`, `linkedin_send_log`),
  migrations 038+039, and a three-way lease settle (`park_send` / `release_send` / `complete_send`).
  **Why deferred rather than half-built:** shipping the adapter alone sends up to 400 invites in an
  hour, at 3am, to people who have not accepted — the exact scenario that gets a real account
  restricted. There is no safe partial version. **Reversible:** nothing is built, so the next
  checkpoint starts clean.
  *Correction to the brief worth recording:* the window I was told to respect is real but there are
  **two** — the per-account 07:00–18:00 `Asia/Kolkata` gate, and a narrower channel default of
  **Tue/Wed/Thu 09:00–10:30** which is what actually binds. Both must pass.

- **DECIDED BY DEFAULT: SMS and WhatsApp get a thin CRM-side Twilio client, not `twilio_send`.**
  `automation_core/integrations/twilio.py:34` **hardcodes** `https://api.twilio.com/...` with no
  override anywhere in any of the three repos. The rule "never point an executor at a real provider
  key in testing" is therefore unsatisfiable by reuse — a wrapped `twilio_send` **cannot be tested at
  all**. So the CRM gets its own minimal client with a `TWILIO_API_BASE` seam, mirroring what
  `RESEND_API_BASE` did. Everything else is borrowed: auth precedence (API-key SID/secret before
  account SID/token), the form-encoded body, the `whatsapp:` prefix, and the `ContentSid` +
  positional `ContentVariables` template handling.

- **DECIDED BY DEFAULT: WhatsApp Business API only. The Playwright browser mode is NOT wrapped.**
  It drives a **single global logged-in WhatsApp Web profile** (`BROWSER_PROFILE_DIR`) with no rate
  limiting and no per-tenant identity, so multi-tenant CRM traffic through it sends tenant A's
  messages from tenant B's number until the session is banned. Upstream also chooses the mode with a
  **silent fallthrough** (`mode = cfg.get("mode") or "business"`, then any unrecognised value or an
  unset `TWILIO_WHATSAPP` drops into the browser path). The CRM will fail **loudly** instead.

- **DECIDED BY DEFAULT: the send-reserve is CP4a's `send_started_at`, not a new lease table.**
  Neither Twilio nor Unipile supports an idempotency key, so a client-side reserve is the only
  mechanism — and migration 022 already has exactly that, with the compare-and-set that closed the
  slow-tick/reclaim race. This also closes a live upstream bug we would otherwise inherit: a Twilio
  timeout there records `event_type="error"`, which `channel_send_state` does not count, so the
  dispatcher **re-sends the same step every tick forever**. LinkedIn is protected by its lease; SMS
  and WhatsApp upstream are not.

## CP-C2 (LinkedIn) — 2026-08-01

**DECIDED BY DEFAULT: no second lease table; the CLAIM is the reserve** because upstream's
`linkedin_send_log` is two things at once (a rate ledger AND a reserve-before-send lease) and the
CRM already has a reserve — `status='claimed'`/`claimed_by` plus migration 022's `send_started_at`.
Two independent reservations for one send is a duplicate-send bug waiting for them to disagree. The
ledger is `scheduled_actions` itself, made countable per account by two columns. A stale claim stops
counting on its own, which is upstream's LEASE_TTL for free.

**DECIDED BY DEFAULT: the gate runs at the CLAIM DOOR, not in the executor** because a job claimed
at 17:59 and sent at 18:05 has left the window. Refusing to hand the job out is the only way a
window means anything. It also inherits the per-(company,channel) advisory lock the claim door
already holds, so two ticks cannot overshoot a LinkedIn daily cap any more than they can overshoot a
rate limit. Implemented as a generic `CHANNEL_GATES` hook — channels without one are untouched.

**DECIDED BY DEFAULT: the accept gate is STRICTER than upstream — default deny** because upstream
gates a `message` step only when an `invite` precedes it in the same sequence
(`linkedin_gate.py:57-65`), which leaves the commonest illegal action wide open: a message-only
ladder aimed at strangers. Upstream catches those with a live profile resolve per prospect, which
costs a provider call each and is a checkpoint of its own (F31). So a `message` needs POSITIVE
evidence of connection — an accepted invite, a state of accepted/replied, FIRST_DEGREE, or an
inbound LinkedIn message from them. `allow_unverified_message` on the account is the operator's
opt-out. `inmail` never gates; needing no connection is its point.

**DECIDED BY DEFAULT: an inverted window (end <= start) fails CLOSED** because upstream's pacer
treats that case as "always allow" (`_window_pace_ok`: `if e <= s: return True`). A misconfiguration
must not become unlimited sending.

**DECIDED BY DEFAULT: `active_days` defaults to weekdays, not Tue/Wed/Thu** because the narrow
channel default is what actually binds upstream, but shipping it as the DEFAULT would silently
refuse to send on four days out of seven — which presents to an operator as a bug, not as a safety
limit. Operators narrow it deliberately. Both windows must pass when both are set.

**DECIDED BY DEFAULT: the kill switch and the allowlist are CROSS-CHANNEL** (`lib/send-safety.js`,
checked in `bootGate`, which every tick calls) because upstream's are — they live on
`channels/base.py`, not on the LinkedIn adapter. A kill switch that only stops LinkedIn is not a
kill switch, and an allowlist that only constrains the channel you remembered is how a verification
run contacts a real customer. `LIVE_SENDS_DISABLED` keeps upstream's name so ONE setting stops the
CRM and the engines together.

**DECIDED BY DEFAULT: an ineligible action is TERMINAL via the existing dead-letter path** (force
`attempt` to the ceiling, then ack failed) rather than a new terminal state, because a doomed retry
loop against LinkedIn is the account-restriction path, and inventing a fourth status the rest of the
system does not understand is worse than reusing the one that already ends a ladder.

**DECIDED BY DEFAULT: Unipile is genuinely WRAPPED, not rebuilt** — unlike Twilio. Upstream already
builds its base from `UNIPILE_DSN`, so the seam existed; `UNIPILE_API_BASE` is added only because
the DSN form forces https and a stub cannot be. Endpoints, bodies, `X-API-KEY` auth, the 300-char
invite-note cap and the provider-id extraction order are upstream's verbatim.

**OPEN — needs the operator, not me: TWO SYSTEMS, ONE ACCOUNT.** The CRM's caps count CRM sends.
If the outreach engine is also dispatching LinkedIn on the SAME connected account, the two ledgers
cannot see each other and the aggregate exceeds every cap while both believe they are compliant.
This is the one CP-C2 risk I cannot close in code. Recommendation: the engine's LinkedIn dispatch
must be OFF wherever the CRM sends.

## CP-D (automations) — 2026-08-01

**DECIDED BY DEFAULT: `crm_pipeline_configs.automations` stays EMPTY, and becomes a computed
projection instead** because `sequences.trigger_stage` already IS the stage→sequence binding —
indexed, validated at authoring time, enforced by `enrollForTriggerStage`, and covered by tests.
Writing the same fact into a JSONB column would be a second source of truth that nothing keeps in
step: the identical mistake refused in CP-C (a second ledger) and CP-C2 (a second lease). The first
time they disagreed, an operator would be reading a pipeline screen describing automations that were
not running. `GET /api/crm/automations/pipeline/:key` computes it on read.

**DECIDED BY DEFAULT: the No-Show ladder is AUTHORED, not borrowed** because it does not exist to
borrow. Every `no_show` in either engine means "did not attend the WEBINAR" — a segment of the
reminder ladder. The operator's No-Show Follow-ups 1–5 are about missing a booked SALES CALL:
different event, different audience, different copy. Marked `AUTHORED` in the definition and in the
API so nobody later mistakes it for reused work.

**DECIDED BY DEFAULT: the No-Show ladder is EMAIL-ONLY** because a missing recipient QUARANTINES the
job, and a quarantined job is never acked, so the enrolment never advances — the ladder STALLS at
that rung (F37). Everyone who books a sales call has an email address; not everyone has a phone
number on file. A seeded default that silently freezes a real follow-up ladder for every contact
without a phone is a bad default. Per-channel steps still exist and are exercised by the invite
ladders; an operator adds SMS for a segment they know has numbers.

**DECIDED BY DEFAULT: one sequence PER CHANNEL for the invite ladders** because that is how upstream
runs them — a campaign there fires its channels in PARALLEL, each with its own cadence — and
`enrollForTriggerStage` already supports several sequences sharing one trigger stage. Collapsing
four channels into one linear ladder would have changed the behaviour while claiming to borrow it.

**DECIDED BY DEFAULT: the long-term nurture has NO trigger stage** because the operator's marketing
pipeline has no stage meaning "not ready, keep warm". Inventing an automatic trigger would be putting
words in their mouth about their own funnel. It installs and is enrolled manually.

**DECIDED BY DEFAULT: re-seeding NEVER overwrites copy** because by then a human may have rewritten
it, and silently reverting their words is the worst thing a "seed" button can do. Re-seeding reports
`already_installed` and changes nothing; `overwrite:true` is a separate, explicit act.

**DECIDED BY DEFAULT: seeded copy resolves through `message_templates`, not inline step content**
because a template row is editable through the API that already exists, and `reresolveUnresolvedJobs`
(CP4a-0 F1) means editing the copy genuinely un-sticks a ladder blocked on it. Inline content would
have been fewer rows and a dead end for the operator.

**OPEN — needs the operator: the webinar REMINDER ladder is not shipped, and cannot be yet.**
The nurturing engine's A0–A8 / S0–S4 / E0–E7 / L0–L1 ladders are ANCHORED to `webinar_at` with
NEGATIVE offsets ("one week before", "one hour before"). The CRM's scheduler only knows "delay from
enrolment / previous step". Porting them into relative delays would be a lie, and a half-port that
fires every already-past reminder at once would blast four messages at a real prospect in one
minute. It needs an anchored-scheduling capability (`enrollments.anchor_at` +
`sequence_steps.anchor_offset_seconds`, plus a rule that a rung whose anchored time has already
passed is SKIPPED rather than sent late). That is its own checkpoint — see F38.

**DECIDED BY DEFAULT (recorded on request): Deal Follow-ups 1/2/3 have NO automation, and that is a
decision rather than an omission.** All three are MANUAL in the operator's own definitions, and the
3/7/12-day figures describe *when a human should act* after a lead becomes a Deal — they are not
timers. Scheduling anything against them would auto-advance a manual stage, which the invariant
forbids outright; even a send-without-writeback would be the CRM deciding when a salesperson chases a
signed deal. `.loop/GOALS.md:78` already states this ("Deal followups are MANUAL — the 3/7/12-day
figures describe *when a human should act*, not timers"), and `test/unit-cpd-automations.mjs` D-2
asserts that no definition triggers on, or writes back to, any `deal_followup_*` stage — so the
absence is enforced, not merely intended.
