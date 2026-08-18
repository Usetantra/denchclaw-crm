# Wiring Tantra Into the CRM

Engineering handoff brief — how the new CRM product should integrate with the
Tantra backend.

- **Source of truth:** `tantra-backend-v2` (NestJS, port 4000) source + its committed `CLAUDE.md`
- **Audience:** whoever builds the CRM side — developer or coding agent working in the CRM repo
- **Status:** draft for review
- **Caveat:** endpoint behaviour is read from code, not exercised against a live tenant.
  Treat request/response shapes as strong reads that still deserve one smoke test each.
  Where this document and the source disagree, the source and its tests win.

---

## 0. TL;DR

**Tantra has already solved the unified omnichannel inbox.** The CRM's job is to
consume it, not re-implement it. The expensive, subtle parts — cross-channel identity
resolution, provider webhook normalisation, idempotent mirroring, retry and
dead-lettering — exist and are covered by tests.

Two decisions must be made before any code is written:

1. **Where conversations live** (see §6, Decision A)
2. **Who owns WhatsApp sending** (see §6, Decision B)

Three things block CRM-as-inbox: message-level webhook events, payload signing, and
API-key scope enforcement. All three are Tantra-side changes (§5).

---

## 1. What Tantra already has

Live channels today: **email** (Gmail via service-account impersonation), plus
**LinkedIn, WhatsApp and Telegram** through Unipile v2.

| Capability | Where it lives | Reusable as |
|---|---|---|
| Cross-channel inbox read model | `social-inbox/services/unified-inbox.service.ts` | HTTP API |
| "Everything we said to this person" | `social-inbox/services/person-conversations.service.ts` | HTTP API |
| Identity resolution across channels | `social-inbox/services/person-identity.service.ts` | Copy the rules |
| Manual reply on any channel | `social-inbox/services/social-reply.service.ts` | HTTP API |
| Provider webhook normalisation | `unipile-core/unipile-webhook.normalizer.ts` | Leave in Tantra |
| Durable outbound webhook delivery | `email-outreach/webhooks/` | Copy the pattern |
| SSRF guard for user-supplied URLs | `webhooks/utils/webhook-url-guard.util.ts` | Copy the file |

### The architectural idea worth understanding

Email threads and social chats live in **separate collections** and are merged into one
email-shaped payload at read time, with social threads carrying an `s_` id prefix. This
is deliberate: the email collections carry required Gmail fields and idempotency indexes
protecting a revenue path, and relaxing them to host chat messages would buy nothing.

The merge is an honest N-way merge rather than a `$unionWith`, because a post-union sort
cannot use an index.

**Consequence for the CRM:** there is no durable unified conversation row and no stable
cross-channel conversation id. Nothing exists to subscribe to. The CRM must persist its
own conversation model.

### Contacts already carry CRM semantics

`leadStage` runs:

```
new → contacted → engaged → replied → positive / negative
    → meeting_booked → converted / lost / unsubscribed
```

Alongside `leadScore`, `tags`, `lists`, a `custom` field bag, and
`providerIdentities[]` mapping a person to their per-channel handles. Mirror these
rather than inventing a parallel vocabulary.

---

## 2. The integration contract — four seams

### 2.1 Authentication

`CombinedAuthGuard` is the global guard, so every route is protected by default. It
accepts an `X-API-Key` header, falling back to a Clerk JWT. Keys are `tk_live_…`, stored
hashed, managed at `/api/v1/api-keys`.

> **SECURITY — read before issuing a key**
>
> **API key scopes are stored but never enforced.** A `ScopesGuard` exists in the
> codebase and is registered nowhere, so any valid key reaches every non-public route on
> the backend — contacts, campaigns, settings, billing, all of it. Issuing the CRM a key
> today grants it full account access whatever scopes you attach.
>
> Fix this in Tantra before the CRM goes to production: register `ScopesGuard`, then add
> and enforce `inbox:read` and `messages:write`. Until then, treat the CRM's key as a
> root credential.

Two domains behave differently: `llm-providers` and `api-keys` apply a class-level JWT
guard with no API-key branch, so they require a Clerk session and are unreachable by key.

### 2.2 Reading conversations

```
GET  /api/v1/email/threads?channels=email,whatsapp,linkedin&page=1&limit=25
GET  /api/v1/email/threads/:threadId
GET  /api/v1/email/threads/:threadId/messages
GET  /api/v1/email/threads/:threadId/person      ← cross-channel person view
GET  /api/v1/email/threads/unread-count
GET  /api/v1/email/threads/filters/campaigns
GET  /api/v1/email/threads/filters/mailboxes
```

Filters are optional and AND-combined: `mailboxEmail`, `emailCampaignId`, `unreadOnly`,
`channels`, `search`.

All routes sit under the global `/api/v1` prefix. `GET /health` is the exception and sits
outside it. Swagger is at `GET /api/docs`.

> **The DTO is email-shaped, on every channel**
>
> A WhatsApp message still arrives with `gmailMessageId`, and `mailboxEmail` may hold a
> phone number or a LinkedIn handle. This kept the existing frontend working unchanged
> across channels. **Do not let the CRM's domain model inherit these names.** Translate
> at the boundary, or add a channel-neutral v2 payload in Tantra first.

### 2.3 Receiving events

Tantra POSTs to endpoints registered at `/api/v1/webhooks`. Delivery is a durable
outbox — a log row, a Bull retry queue with exponential backoff, dead-lettering after the
attempt cap, and a recovery cron for orphans. Deduplication is a
`sha256(eventType + dedupeKey)` event id.

```
POST <your-url>
Content-Type:      application/json
User-Agent:        Tantra-Webhook/1.0
X-Tantra-Event:    email.replied
X-Tantra-Event-Id: <sha256 — use this for idempotency>
```

> **Outbound webhooks are unsigned**
>
> There is no HMAC signature header. Any host that learns the URL can forge events into
> the CRM. Until Tantra signs them, the receiving endpoint must carry a long unguessable
> path segment or a shared secret, and must be treated as untrusted input. Adding signing
> on the Tantra side is a small change and worth doing.

Subscribable today — note the catalogue is reply-shaped, not message-shaped:

```
calendar.rsvp.yes | .no | .maybe
email.bounced | email.clicked | email.replied | email.unsubscribed
linkedin.connection.accepted | linkedin.message.replied
whatsapp.message.replied
telegram.message.replied
```

> **Already built, currently gated off**
>
> The dispatcher also constructs `email.sent`, `email.sequence.completed`,
> `lead.stage.changed` and `email.intent.classified`, but `webhookAcceptsEvent()` returns
> `false` for them so they never leave the building. Exposing them is a change to one
> switch statement and the trigger type — far cheaper than it looks, and
> `lead.stage.changed` is exactly what CRM stage sync needs.

### 2.4 Sending

```
POST /api/v1/email/threads/:threadId/messages/reply
     { bodyText?: string, bodyHtml?: string }
  → { gmailMessageId, threadId, messageIdHeader }
```

One route replies on every channel; the social path returns the same envelope keys as the
email path deliberately. Automated sending is campaign enrolment rather than a send
call — the CRM enrols a contact into an `EmailCampaign` whose sequence steps may mix email
and social.

> **Anything Tantra owns must send through Tantra**
>
> Suppression, one-click unsubscribe, warmup pacing, per-account quota reservation, domain
> health and human-looking send pacing all live in Tantra. A second system sending on a
> Tantra-owned channel bypasses every one of them — that is burned sending domains and
> messages to unsubscribed contacts, which is a legal exposure rather than a bug. The
> CRM's own channels are fine; it must own equivalent suppression for them.

---

## 3. Traps that each cost a day

### Local webhooks to the CRM will not connect

Every outbound POST runs through an SSRF guard that blocks loopback, private and
link-local ranges — and it re-checks at socket-connect time, so DNS rebinding and
redirects do not get around it. `http://localhost:4001` is refused, and a blocked target
is **dead-lettered, not retried**. Use a tunnel for local development; `NGROK_URL` is
already in the backend env for this.

### An unknown JSON field is a 400

The global `ValidationPipe` sets `whitelist`, `transform` and `forbidNonWhitelisted`.
Sending one extra key fails the whole request, which reads like a schema mismatch and is
not one.

### Tantra's WhatsApp is not the WhatsApp you may expect

`domains/channels/whatsapp` is a Meta Graph API integration and is **legacy** — reachable
only from a step executor no live engine uses. Live WhatsApp runs through Unipile in
`channels/social`. If the CRM already uses Meta Cloud API, the two are unrelated code
paths against different accounts. Do not read that folder as the current implementation.

### Social channels are a paid add-on, server-enforced

LinkedIn, WhatsApp and Telegram each require an active add-on at $10/month, checked both
when connecting an account and when a campaign activates. Webhook delivery for a social
event *also* checks the add-on. In an environment missing the Dodo product ids the billing
seam silently binds a no-op that grants add-ons free — so a channel working locally proves
nothing about production.

### Identity resolution is heuristic

- **email** — case-insensitive exact against `Contact.email`
- **linkedin** — `providerIdentities` → `linkedinPublicId` → normalised `Contact.linkedin`
- **whatsapp** — E.164 digits, else **last-10-digit suffix** of the free-form phone
- **telegram** — `providerIdentities` only; the provider exposes no username or phone lookup

The WhatsApp suffix fallback is a defensible call for outreach and a liability at CRM
scale — it will eventually merge two different people. The CRM should keep its own
identity table with explicit merge/unmerge plus an audit trail, and treat Tantra's
`contactId` as a hint.

---

## 4. Channel ownership — the conflict to resolve

The CRM has its own working WhatsApp and a dormant SMS channel. Tantra sends WhatsApp too,
through Unipile. These are different provider accounts and almost certainly different
numbers, and neither system can see the other's messages.

**Failure mode if left unresolved:** a contact receives an outreach message from Tantra's
number and a reminder from the CRM's number. Each system shows half the history. A rep
replies in the CRM without knowing a sequence is mid-flight, and the contact gets two
conversations from one company — while Tantra's reply-stops-sequence logic never fires,
because the reply landed somewhere it cannot see.

---

## 5. Gaps — what has to be built

| Gap | Side | Why it blocks you | Priority |
|---|---|---|---|
| Message-level webhook events | Tantra | Only replies emit today; CRM cannot mirror conversations in real time | **blocker** |
| Scope enforcement on API keys | Tantra | CRM's key is effectively root until `ScopesGuard` is registered | **blocker** |
| Signed webhook payloads | Tantra | Events are forgeable by anyone who learns the URL | **blocker** |
| Channel-neutral read payload | Tantra | Stops CRM inheriting `gmailMessageId` on a WhatsApp message | high |
| Durable conversation + activity model | CRM | Unification is in-memory at read time; nothing persists to build a timeline on | high |
| SMS as a first-class channel | Both | Absent from Tantra entirely; channel enums hardcoded to three values | high |
| Identity table with merge/unmerge | CRM | Suffix phone matching will mis-merge people at volume | high |
| Deals, tasks, notes, pipelines | CRM | No CRM objects exist in Tantra; net-new product surface | normal |
| Org / team tenancy | Both | Tenancy is a bare `userId` string — no shared inboxes or ownership | normal |

### On SMS specifically

`sms` appears in the backend only as a two-factor delivery option during account connect.
Channel unions are spelled `'linkedin' | 'whatsapp' | 'telegram'` across schemas, DTOs, the
webhook trigger catalogue and the channel/action matrix — and the matrix must stay
identical to the frontend's copy. Adding SMS to Tantra touches all of them.

Since the CRM already has SMS scaffolded, **keeping SMS wholly on the CRM side is the
cheaper path** unless SMS needs to appear as a sequence step.

---

## 6. Options

### Decision A — where conversations live

| Option | What it means | Best case | Real cost |
|---|---|---|---|
| **1. CRM is the inbox** | Tantra pushes events; CRM stores and renders everything | Reps live in one product; one true timeline | Blocked on the three Tantra changes |
| **2. Tantra is the inbox** | CRM calls Tantra's thread APIs on demand, or embeds the view | Working in days, not weeks | CRM's own WhatsApp/SMS stay invisible; outreach history, not a CRM inbox |
| **3. CRM as a Tantra domain** | Build it inside `tantra-backend-v2`, shared Mongo | Cheapest integration by far — no contract, no auth seam, no webhooks | Kills "separate product"; one deploy, one blast radius, CRM schema frozen to Tantra's |
| **4. Extract a conversation service** | Both products call a new shared service | Cleanest at 3+ products | Premature; months of work for a problem you don't have yet |

**Recommendation: option 2 now, option 1 as the target.** They are not exclusive — option
2 is genuinely a stepping stone, because the backfill code written to read Tantra's
threads is the same code option 1 needs. Option 3 is the honest choice if the CRM is
really a Tantra feature rather than a product; be clear-eyed about which it is.

### Decision B — who sends WhatsApp

Independent of A, and the one with no free lunch.

- **B1 — Tantra owns all WhatsApp**, CRM triggers sends over the API. One number, one
  history, suppression enforced. The CRM's existing WhatsApp code gets shelved.
- **B2 — CRM owns all WhatsApp**, including outreach. Requires rebuilding pacing and
  suppression CRM-side. Only sane if the CRM's provider is materially better than Unipile
  for your volume.
- **B3 — Two numbers, split by purpose.** Outreach from Tantra's, reminders/support from
  the CRM's. Honest and legible to the contact *if* the numbers are clearly different
  identities. Pragmatic middle ground.

**What does not work is one number driven by two systems.**

---

## 7. Things to try this week

The local stack runs with real data — 904 contacts, 121 email threads, 356 messages, 14
social chats, 3 channel accounts — so these are hours, not sprints.

| # | Experiment | Proves | Effort |
|---|---|---|---|
| 1 | Mint an API key, call `GET /api/v1/email/threads?channels=whatsapp,linkedin` and the `/person` route | The read seam; exposes the email-shaped DTO problem immediately | ~1 hour |
| 2 | Start a tunnel, register a webhook, hit `POST /api/v1/webhooks/:id/test` | The event seam; confirms delivery, headers, SSRF behaviour | ~1 hour |
| 3 | Un-gate `lead.stage.changed` in `webhookAcceptsEvent()` + trigger type | Real CRM stage sync end-to-end; validates the whole pattern | ~half a day |
| 4 | Spike `message.received` for one channel | The actual blocker for CRM-as-inbox | ~1–2 days |
| 5 | Throwaway mirror script: pull threads → write into CRM tables | Whether the CRM's model can hold Tantra's data, cheaply | ~1 day |

Experiments 1 and 2 are pure upside: an afternoon each, and they answer questions that
otherwise turn into architecture arguments.

**Note on #1:** minting the key needs a Clerk session, because `api-keys` rejects API-key
auth by design.

---

## 8. Sequenced plan

Each phase is shippable.

### Phase 1 — Make Tantra integrable

Entirely inside Tantra, no CRM code. Add `message.received`, `message.sent` and
`conversation.created`; un-gate `lead.stage.changed`. Sign payloads. Register
`ScopesGuard` and add the two new scopes.

*Done when:* a tunnelled test endpoint receives a signed event for every inbound message
on every channel.

### Phase 2 — Mirror into the CRM, read-only

Persist conversations, messages and contact identities in the CRM. Backfill through the
thread APIs, then stay current via webhooks. Render the unified inbox. Nothing sends yet.

*Done when:* a Tantra conversation appears in the CRM within seconds and survives a
replayed duplicate event.

### Phase 3 — Turn on sending

Manual replies route by channel owner — Tantra's channels via its reply endpoint, the
CRM's own WhatsApp and SMS direct. One outbound record shape regardless of route.

*Done when:* a rep replies from the CRM on both a Tantra-owned and a CRM-owned channel and
both land in one timeline.

### Phase 4 — Automate

Reminders and follow-ups on CRM channels. Outreach automation stays campaign enrolment in
Tantra so suppression and pacing are not duplicated.

### Phase 5 — CRM-native objects

Deals, pipelines, tasks and notes on the timeline the earlier phases established.

---

## 9. Open questions

1. **Is the CRM a separate deployable, or a module inside Tantra's backend?**
   Everything here assumes separate services over HTTP. A module inside the monolith would
   share Mongo directly and most of the contract collapses.

2. **Which system owns WhatsApp — and is it one number or two?**
   Nothing downstream is safe to build until this is settled.

3. **What provider backs the CRM's WhatsApp and SMS?**
   Meta Cloud API and Twilio have different template, session-window and opt-out rules.
   Tantra's Unipile path has none of the 24-hour template constraints Meta imposes.

4. **Does the CRM get its own contact store, or read Tantra's?**
   Determines whether contact sync is one-way, two-way, or absent — and who wins a
   conflict.

5. **Who honours unsubscribes across both systems?**
   Tantra holds suppression today. A CRM that sends independently needs to read it or keep
   its own — silence here is the compliance risk.

---

## Appendix A — Local environment

State of the local workspace as set up on 2026-08-18.

### Services

| Service | Version | How it runs |
|---|---|---|
| MongoDB | 8.3.7 | `brew services start mongodb-community` |
| Redis | 8.10.1 | `brew services start redis` |
| Backend | — | `npm run start:dev` in `tantra-backend-v2` (port 4000) |
| Frontend | Next 15.5.10 | `npm run dev` in `tantra-frontend-v2` (port 3000) |

### Restored database

`mongodb://localhost:27017/tantra_dev_local` — 61 collections, 3,570 documents, 362
indexes, restored from `dump/` and verified against `dump/manifest.json`.

Notable counts: `contacts` 904, `suppression_entries` 901,
`zoom-webinar-registrants` 532, `email_messages` 356, `step_renderings` 355,
`email_enrollments` 125, `email_threads` 121, `social_messages` 16, `social_chats` 14,
`channel_accounts` 3, `webhooks` 0, `api_keys` 0.

Both integration seams are therefore **completely untested on this data** — zero webhooks
and zero API keys exist.

### Setup gotchas hit during setup

1. **Env files are named `env.local`, not `.env.local`.** Neither app loads them under that
   name — NestJS `ConfigModule` looks for `.env`, `.env.development`, `.env.local`, and
   Next.js only reads `.env.local`. Symlinks now bridge this in both apps; both are
   gitignored.
2. **Redis 8's bundled `redis.conf` aborts on startup.** It references four module `.so`
   files Homebrew does not ship. Those `loadmodule` lines are commented out; backup at
   `/opt/homebrew/etc/redis.conf.bak-preclaude`.
3. **Use `http://127.0.0.1:3000`, not `http://localhost:3000`.** `CORS_ORIGIN` is set to the
   127.0.0.1 form and `main.ts` builds the allowed-origin list from that single string. A
   preflight from `localhost:3000` returns no `Access-Control-Allow-Origin` header, so every
   API call is blocked and it presents as a broken login.
4. **MongoDB needed `brew trust mongodb/brew`.** Homebrew now blocks third-party taps by
   default and MongoDB Community is not in homebrew-core.
5. **npm 11 skips install scripts.** `sharp`, `esbuild`, `@nestjs/core`, `@clerk/shared`,
   `fsevents`, `msgpackr-extract` were all skipped. Verified working regardless; if something
   fails at runtime, `npm approve-scripts --allow-scripts-pending`.

### Auth

Clerk instance `mature-filly-33.clerk.accounts.dev`; publishable and secret keys match
across both apps. The restored database contains **one** user —
`anya.m@shift-xr.co`, `clerkId: user_3GtDi2FLy3AulEyeOmeDSBP0YWq`. Signing in as any other
Clerk identity authenticates but finds no matching app record.

Backend and frontend disagree on the post-login destination — backend env says
`/campaigns`, frontend says `/dashboard`. Harmless, since `/dashboard` redirects to
`/campaigns`.

### Data handling

`dump/` contains unencrypted contact and email data. Keep it out of git, off shared drives
and out of cloud sync folders; delete it when the task that needed it is done.
