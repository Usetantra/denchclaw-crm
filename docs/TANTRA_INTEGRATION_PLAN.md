# Tantra ↔ DenchClaw CRM — Unified Inbox Integration Plan

Implementation plan for mirroring Tantra's omnichannel conversations into the CRM's
existing unified inbox.

- **Reference brief:** [`server/db/models/tantra.md`](../server/db/models/tantra.md) (read from `tantra-backend-v2` source)
- **Status:** draft — decisions locked, code not started
- **Next unused migration:** `039`
- **Baseline:** `303ab1c` on `nelbin-working-branch`, suite 1351/1351

---

## 0. Decisions locked

| # | Decision | Choice | Consequence |
|---|---|---|---|
| **A** | Where conversations live | **CRM is the inbox** — mirror into `conversations`/`messages` | Only option where Tantra outreach and CRM-owned WhatsApp/SMS share one timeline |
| **B** | WhatsApp ownership | **B3 — two numbers, split by purpose** | Cold outreach on Tantra's Unipile number, webinar reminders + manual follow-up on the CRM's Twilio number. **Not a preference — one number cannot do both (§2.4).** Needs a schema change (§2.3) |
| **C** | Tantra-side changes | **None — consume only** | All three of tantra.md §5's "blockers" are permanent constraints, not to-dos. This is the single most shaping answer; §1 is entirely about it |
| **D** | Contact ownership | **Two-way sync** | Needs per-field conflict rules and echo suppression, or the two systems will ping-pong forever |

---

## 1. What "consume only" forces

tantra.md lists three Tantra-side blockers. We cannot fix any of them, so each has to
become a design decision on our side instead.

### 1.1 No message-level events ⇒ the mirror is poll-driven

Tantra emits only `*.replied`-shaped events. A message we send, a second inbound message
in the same thread, a thread that opens without a reply — none of them emit anything.
**Webhooks therefore cannot be the source of truth for the mirror.**

The inversion that makes this work:

> **A webhook is a hint to poll, never a fact to write.**

An inbound `whatsapp.message.replied` does not tell us what the message *said* — it tells
us *that thread changed*. We enqueue that thread for an immediate re-read of
`GET /api/v1/email/threads/:id/messages`, which is authoritative, and write from that.

This lands two things for free:
- **Forgery becomes cheap, not dangerous** (see §1.2) — a forged event costs one wasted API call.
- **Latency without a daemon** — the webhook makes the common case near-real-time; the
  sweep catches everything the webhook can't see.

Two loops, both on the repo's existing tick pattern (`server/routes/executors.js` header:
*"Deliberately NOT a daemon: one tick = one batch, driven by cron or an operator"*):

| Loop | Reads | Cadence | Catches |
|---|---|---|---|
| **Nudge** | the one thread named by a webhook | on webhook receipt | replies, near-instant |
| **Sweep** | `GET /threads?channels=…&page=…`, newest-first, until the first page whose newest `last_message_at` predates our watermark | every 2–5 min | everything webhooks are blind to: our own sends, second inbounds, new threads |

The sweep's stopping rule is a **watermark**, not a page count — `tantra_sync_state.threads_synced_through`. On
a cold tenant it walks back to a configured backfill horizon; warm, it usually reads one page.

> **Known gap, accept explicitly:** a message that lands in an *old* thread while the sweep
> is watermarked past it is invisible until that thread surfaces in a `last_message_at`
> sort. Tantra's list *is* sorted by recency so in practice this is fine — but it is a
> real hole and belongs in the runbook, not in a comment.

### 1.2 No payload signing ⇒ the webhook body is never trusted

`tantra_webhooks` already has the right posture (migration 036: the per-company token in
the URL is the whole auth story). We keep it and add: the body is used **only** to extract
a thread id / contact identifier to poll. No stage change, no suppression entry, no message
row is ever written from webhook content.

This is a strict tightening of today's handler, which writes messages and suppressions
directly from unsigned bodies ([webhooks.js:563-587](../server/routes/webhooks.js#L563)).

### 1.3 No scope enforcement ⇒ the Tantra API key is a root credential

`ScopesGuard` is registered nowhere in Tantra, so any `tk_live_…` key reaches contacts,
campaigns, settings and billing. Therefore:

- Store it encrypted via the existing `server/lib/crypto-box.js`, in `channel_connections`
  with `provider='tantra'` — the same treatment Twilio/Unipile/Resend credentials already get.
- **Never** return it to the client; `listConnections()` already excludes secrets.
- The key is minted by the tenant in Tantra's own dashboard and pasted in — it cannot be
  minted programmatically, because Tantra's `api-keys` domain rejects API-key auth by design
  and requires a Clerk session.
- Settings UI must say plainly what the key grants. A tenant handing us a root credential
  deserves to be told it is one.

---

## 2. Schema work

### 2.1 What already fits, unchanged

| Need | Existing surface |
|---|---|
| Unified per-contact thread | `conversations` (one row per contact×channel) + `inbox.listInbox()` merge |
| Sends that write no `messages` row | `getThread()`'s `contact_activity` UNION |
| Inbound dedupe | `uq_messages_provider_id` on `(company_id, provider_message_id)` — **this is the mirror's idempotency key**; write Tantra's `gmailMessageId` into it |
| Read/unread, starring | `conversations.last_read_at` / `starred` (migration 020) |
| Encrypted per-tenant credentials | `channel_connections` (migration 028) |
| Webhook receipt + raw capture | `tantra_webhooks` (036) + `webhook_captures` (035) |

The mirror writes through `POST /api/crm/conversations/:id/messages`, which is **already
idempotent on `provider_message_id`** ([conversations.js:328-331](../server/routes/conversations.js#L328)) —
so replayed events and overlapping sweep pages are safe by construction. Do not add a
second insert path.

### 2.2 Migration 039 — external identity + sync state

```sql
-- Per-contact external refs. NOT a column on contacts: a contact can hold a
-- Tantra id AND a per-channel provider identity, and two-way sync needs to
-- record which side last wrote each one.
CREATE TABLE IF NOT EXISTS external_identities (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  system         TEXT NOT NULL,              -- 'tantra'
  kind           TEXT NOT NULL,              -- 'contact' | 'email' | 'whatsapp' | 'linkedin' | 'telegram'
  value          TEXT NOT NULL,              -- the id/handle, normalised
  confidence     TEXT NOT NULL DEFAULT 'exact',   -- 'exact' | 'heuristic'
  linked_by      TEXT NOT NULL DEFAULT 'sync',    -- 'sync' | 'operator'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_identities
  ON external_identities (company_id, system, kind, value);
CREATE INDEX IF NOT EXISTS idx_external_identities_contact
  ON external_identities (contact_id);

-- Sweep watermarks + backfill cursor, one row per tenant.
CREATE TABLE IF NOT EXISTS tantra_sync_state (
  company_id              TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  threads_synced_through  TIMESTAMPTZ,
  backfill_cursor_page    INT,
  backfill_complete       BOOLEAN NOT NULL DEFAULT false,
  last_sweep_at           TIMESTAMPTZ,
  last_error              TEXT,
  stats                   JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Two-way contact sync ledger: what we pushed, and what we received, so an
-- echo is recognisable and never bounced back. Without this, two-way sync
-- oscillates indefinitely.
CREATE TABLE IF NOT EXISTS contact_sync_log (
  id           BIGSERIAL PRIMARY KEY,
  company_id   TEXT NOT NULL,
  contact_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction    TEXT NOT NULL CHECK (direction IN ('push','pull')),
  field        TEXT NOT NULL,
  value_hash   TEXT NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_sync_log_lookup
  ON contact_sync_log (company_id, contact_id, field, at DESC);
```

`confidence='heuristic'` exists specifically because Tantra matches WhatsApp on the
**last 10 digits** of a free-form phone. We record such a link as heuristic and never let
it silently merge two CRM contacts — it surfaces as a review item instead.

### 2.3 Migration 040 — the B3 blocker (unique index collision)

**This is the one decision-B consequence that is not optional.**

`migrations/004` carries:

```sql
CREATE UNIQUE INDEX uq_conversations_contact_channel
  ON conversations (contact_id, channel) WHERE status != 'closed';
```

Choice B3 means one contact has **two open WhatsApp conversations** — Tantra's number and
ours. The second insert violates that index. So:

```sql
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_account TEXT;  -- NULL = the CRM's own
DROP INDEX IF EXISTS uq_conversations_contact_channel;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_contact_channel_account
  ON conversations (contact_id, channel, COALESCE(channel_account, ''))
  WHERE status <> 'closed';
```

Backfill is a no-op (existing rows get `NULL` = CRM-owned), and `inbox.js` groups by
*contact*, so both conversations already collapse into one thread with no query change.
The thread and list panes need the owning account rendered on each message, or a rep
cannot tell which number a reply will go out from — see §5.

The same collision applies to **LinkedIn**: the CRM already sends LinkedIn via Unipile
([`server/lib/unipile-send.js`](../server/lib/unipile-send.js)) and so does Tantra, against a
different Unipile account. That was not covered by the Decision-B answer — see §7 Q1.

### 2.4 Why one WhatsApp number is not available

The intended setup was **one number connected to both systems** — Tantra doing cold
outreach on it, the CRM doing webinar reminders and manual follow-up. The *split of
purpose* is right and the integration preserves it. The *shared number* is blocked by
three independent facts, so B3 is the only configuration in which both jobs work.

**1. The two systems are on different WhatsApp platforms, and a number can live on only one.**

| | CRM | Tantra |
|---|---|---|
| Provider | **Twilio — WhatsApp Business Platform** | **Unipile** |
| Evidence | [`twilio-compliant-provider.js`](../server/lib/twilio-compliant-provider.js); the 24h customer-service window + approved-template gate at [compliance-gate.js:50-54](../server/lib/compliance-gate.js#L50); `contacts.cs_window_expires_at` (migration 027) | tantra.md §3 — live WhatsApp is Unipile in `channels/social`; the Meta Graph folder is legacy and unreachable |
| Mechanism | Number is **registered onto** the Business Platform | Pairs as a **linked companion device** to a WhatsApp/WA-Business *app* account |

Business-Platform registration migrates the number off the consumer app — that is what
registration does. Unipile requires it to be on the app. Mutually exclusive.
**Confirm against Unipile's own docs before banking anything on it**, but this is the
expected position.

**2. Tantra has no cold-start send, so it cannot send the CRM's reminders.**

tantra.md §2.4 exposes exactly one send route —
`POST /api/v1/email/threads/:threadId/messages/reply` — which requires a thread that
already exists. Everything else is campaign enrolment. A webinar reminder goes to a
registrant who may never have messaged us on WhatsApp: no thread, nothing to reply into.
Under Decision C we cannot add such a route.

**3. The platforms already split along these exact use cases.**

Cold outreach is not viable on the Business Platform — a first message outside the 24h
window needs an approved template, and cold prospecting templates do not get approved.
The gate at `compliance-gate.js:52` blocks it correctly. Conversely, reminders to
opted-in registrants are the Business Platform's canonical use case. The provider split
mirrors the purpose split.

**Consequences to hold onto:**

- The rep never sees two systems. `inbox.js` groups by **contact**, so both numbers'
  history collapses into one timeline; the sending identity is labelled per message
  (§2.3, §5).
- The **contact** does see two numbers from one company. They must read as deliberately
  different identities — outreach vs. support — not as a mistake.
- Blast-radius upside, unplanned but real: a block or report earned by cold outreach
  cannot take down the reminder channel.

### 2.5 Channel vocabulary

`inbox.js:36` — `CHANNELS = ['email','sms','whatsapp','linkedin','ai_call','call']`.

- **Telegram** is a live Tantra channel and absent here. Add `'telegram'` to `CHANNELS`,
  or drop Telegram threads at the boundary. Adding it is cheap and lossless; dropping
  silently is not. **Recommend: add it.**
- **SMS** stays wholly CRM-side, per tantra.md §5 — Tantra's channel unions are hardcoded
  to three values across schemas, DTOs and the webhook catalogue, and we cannot change them.

---

## 3. New code

### 3.1 `server/lib/tantra-client.js` — the read seam

Thin HTTP wrapper. `X-API-Key` auth, `TANTRA_API_BASE` overridable so tests can point at a
plain-http stub (same convention `unipile-send.js` established with `UNIPILE_API_BASE`).

```
listThreads({ channels, page, limit, updatedSince })   GET /api/v1/email/threads
getThread(threadId)                                    GET /api/v1/email/threads/:id
getMessages(threadId)                                  GET /api/v1/email/threads/:id/messages
getThreadPerson(threadId)                              GET /api/v1/email/threads/:id/person
reply(threadId, { bodyText, bodyHtml })                POST /api/v1/email/threads/:id/messages/reply
```

Three things this file must own, none of them optional:

1. **The global `/api/v1` prefix**, and that `GET /health` sits outside it.
2. **`forbidNonWhitelisted`** — Tantra's global `ValidationPipe` 400s on a single unknown
   key. Request bodies are built explicitly, never spread from our own objects.
3. **Nothing else in the CRM may call Tantra.** One file, one place to add retry/backoff.

### 3.2 `server/lib/tantra-normalize.js` — the translation boundary

> tantra.md's loudest warning: the read DTO is **email-shaped on every channel**. A WhatsApp
> message arrives carrying `gmailMessageId`, and `mailboxEmail` may hold a phone number or
> a LinkedIn handle.

A pure, unit-testable function — same shape as `webinargeek-sync-engine.js`, which is the
repo's established pattern for exactly this. `gmailMessageId` and `mailboxEmail` **must not
appear anywhere outside this file.** A static test asserts that.

```
normalizeThread(tantraThread)  → { externalThreadId, channel, accountRef, participants[] }
normalizeMessage(tantraMsg)    → { direction, channel, body, providerMessageId, sentAt, accountRef }
```

Channel detection: the `s_` id prefix marks a social thread; `channels` on the list request
is the reliable discriminator. Never infer channel from whether `mailboxEmail` looks like
an address.

### 3.3 `server/lib/tantra-sync-engine.js` — pure mirror logic

Pure find-or-create + upsert, no HTTP, no `req`. Given normalised threads/messages and the
current sync state, returns the writes to perform. This is what the tests drive.

Resolution order for a message → CRM contact:
1. `external_identities` exact hit on `(tantra, contact, <tantraContactId>)`
2. `external_identities` exact hit on the channel handle
3. `contacts.email` case-insensitive
4. E.164 phone exact
5. **no match ⇒ create**, and record the identity as `exact`

Tantra's own `contactId` is stored as a **hint**, never as the join key — its WhatsApp
suffix matching will eventually merge two different people, and we must not inherit that.

### 3.4 `server/lib/tantra-executor.js` + routes

Follows `server/routes/executors.js` exactly:

```
POST /api/crm/executors/tantra/tick    → one sweep batch for this tenant
GET  /api/crm/executors/tantra/status  → connected? backfilled? watermark? last error?
POST /api/crm/executors/tantra/backfill → operator-triggered, resumable via backfill_cursor_page
```

A blocked tick is `200 { ok:false, reason }`, not a 500 — the house convention.

### 3.5 Rewritten `POST /webhooks/tantra/:token`

Reduced to: authenticate token → capture raw → dedupe on `X-Tantra-Event-Id` → extract a
thread id → enqueue a nudge → `200`. Per §1.2 it writes no domain state from the body.

**`X-Tantra-Event-Id` is currently ignored entirely** — today's handler has no idempotency
at all, so a redelivered `email.replied` writes a duplicate activity row. Tantra
dead-letters after its attempt cap and runs a recovery cron for orphans, so redelivery is
expected, not exceptional.

`lead.stage.changed` keeps its operator-defined `stage_map` (migration 036 got this right)
but is re-read from the API before applying, per §1.2. Note it is **gated off in Tantra**
(`webhookAcceptsEvent()` returns false) and we cannot un-gate it — so under consume-only
this path is dormant. Stage changes must be pulled from the contact sync (§4) instead.

---

## 4. Two-way contact sync

The expensive half of Decision D. Rules, written down before code:

**Field ownership** — a per-field owner beats a global "last write wins":

| Field | Owner | Why |
|---|---|---|
| `email`, `phone`, `name` | **CRM** | It has explicit merge/unmerge and an audit trail |
| `tags`, `lead_score` | **CRM** | Scoring engine lives here (`server/lib/scoring.js`) |
| `marketing_stage` | **CRM**, pull-only from Tantra via `stage_map` | Stage authority is already enforced by `server/lib/stage-authority.js` and the manual-stage gate — a remote system must not bypass it |
| suppression / unsubscribe | **union of both, never a diff** | See below |
| Tantra `leadStage`, `leadScore` | **Tantra**, read-only into a `metadata` namespace | Do not overwrite CRM stage with it |

**Echo suppression:** before pushing field `f` for contact `c`, check `contact_sync_log`
for a `pull` of the same `(contact, field, value_hash)`. If the value we're about to push
is the one we just received, skip. Without this the two systems oscillate forever.

**Suppression is a union, never a diff.** Tantra holds `suppression_entries` (901 rows on
the reference dataset) and owns one-click unsubscribe on its own channels. An unsubscribe
seen in *either* system suppresses in *both*, and neither ever resubscribes the other.
This is the compliance-risk item in tantra.md §9 Q5, and it is the one rule in this
document that must not be relaxed for convenience.

---

## 5. Sending under B3

One outbound record shape regardless of route. A `channel_ownership` resolution — per
tenant, per channel — decides the route:

| Route | Path |
|---|---|
| Tantra-owned (its WhatsApp/LinkedIn/email threads) | `POST /api/v1/email/threads/:id/messages/reply` via `tantra-client.js` |
| CRM-owned (our WhatsApp, SMS, our LinkedIn) | existing `server/lib/channel-executor.js` dispatch |

Guardrails, from tantra.md's "anything Tantra owns must send through Tantra":

- The CRM **never** sends on a Tantra-owned account. Suppression, warmup pacing, quota
  reservation and domain health all live in Tantra, and a second sender bypasses all of them.
- The CRM **does** own equivalent suppression for its own channels — it already does, via
  `channel_suppression` + `server/lib/compliance-gate.js`.
- The inbox composer must show **which identity a reply goes out from** before it's sent.
  With two WhatsApp numbers on one contact, a rep silently replying from the wrong number
  is the exact failure mode B3 was chosen to make legible. This is a UI requirement, not
  a nice-to-have.
- Outreach automation stays **campaign enrolment in Tantra**. We do not re-implement pacing.
- **The two WhatsApp numbers do not obey the same rules**, and the composer must reflect it:
  a CRM-routed message hits `compliance-gate.js`'s 24h-window / approved-template check,
  while a Tantra-routed one has no such constraint. Same channel badge, different
  affordances — surface the window state and the template requirement only on the
  CRM-owned account, or reps will read a legitimate block as a bug.

`inbox.js:278`'s delivery-honesty rule extends unchanged: a Tantra-routed reply reports
`delivered=true` only on a real `{ gmailMessageId }` envelope back.

---

## 6. Phasing

Each phase ships on its own and is independently useful.

| Phase | Scope | Done when |
|---|---|---|
| **0 — Prove the seam** | Mint a key against the live tenant, call `GET /threads?channels=whatsapp,linkedin` and `/person`. Capture real payloads into `webhook_captures`. No CRM writes. | We have real response bodies. tantra.md is explicit that its shapes are read from source, *not exercised* — every field name below is a guess until this runs |
| **1 — Connection + read client** | Migration 039, `tantra-client.js`, Settings → Integrations connect/test/disconnect card, key encrypted at rest | "Test connection" returns a live thread count for the tenant |
| **2 — Normalise + mirror, read-only** | `tantra-normalize.js`, `tantra-sync-engine.js`, executor tick, resumable backfill. Nothing sends. | A Tantra WhatsApp thread appears in the CRM inbox, correctly attributed, and a replayed sweep page creates zero duplicate rows |
| **3 — Webhook nudge** | Rewrite the receiver per §3.5, `X-Tantra-Event-Id` dedupe, tunnel for local dev | A reply in Tantra appears in the CRM inbox in seconds, and a forged POST changes nothing but a poll counter |
| **4 — B3 sending** | Migration 040, ownership resolution, composer identity picker | A rep replies on both a Tantra-owned and a CRM-owned WhatsApp thread; both land in one contact timeline and the sending number was visible before sending |
| **5 — Two-way contacts** | `contact_sync_log`, field ownership, echo suppression, suppression union | A CRM tag reaches Tantra, a Tantra unsubscribe suppresses here, and neither bounces back |

**Phase 0 is not optional and is not a formality.** Building 1–2 against guessed field
names, then discovering the envelope differs, is the single most likely way this plan
loses a week.

---

## 7. Open questions

1. **LinkedIn has the same two-account problem as WhatsApp, and wasn't covered by Decision B.**
   Both systems send LinkedIn through Unipile against different accounts. Same B1/B2/B3
   choice, same consequences. §2.3 assumes B3 there too — confirm or override.

2. **Is the CRM's Tantra the hosted `usetantra.com` or a self-hosted `tantra-backend-v2`?**
   Today's connector was built from `usetantra.com/help/api-and-mcp/*` and its payload
   extractor walks `campaign.events[].attendees[]`
   ([webhooks.js:510](../server/routes/webhooks.js#L510)) — a shape that appears nowhere in
   tantra.md's catalogue. Either the docs describe a different envelope from the source, or
   these are two different products. **This determines whether the existing connector is a
   foundation or a rewrite**, and Phase 0 answers it.

3. ~~What backs the CRM's WhatsApp?~~ **Answered: Twilio, WhatsApp Business Platform** (§2.4).
   The remaining action is to **confirm with Unipile that a Business-Platform-registered
   number cannot also be linked as a companion device.** That is the load-bearing external
   fact under Decision B, and it is a docs read, not an experiment. If it turns out to be
   possible, §2.4 blocker 1 falls away — but blockers 2 and 3 stand on their own, so B3
   survives regardless.

4. **Backfill horizon?** The reference dataset is 121 email threads / 14 social chats — days,
   not weeks. A real tenant may be far larger, and `dump/` contains unencrypted contact data
   we should not be replicating casually.

5. **Who runs the sweep cron?** `ecosystem.config.js` is a single pm2 process with no
   scheduler; `executors` ticks are driven externally today. Adding a per-tenant sweep means
   deciding where that trigger lives before Phase 2 ships.

---

## 8. Test plan

House convention: one `test/unit-<code>-<name>.mjs`, registered in `test/run-local.sh`,
asserting against a real Postgres. New suite `unit-tsy-tantra-sync`.

Non-obvious cases that must be covered:

- **Idempotency** — the same thread page swept twice creates exactly one message row.
  Then the same message arriving via *both* a webhook nudge and a sweep — still one row.
- **The email-shaped DTO** — a WhatsApp message carrying `gmailMessageId` produces a CRM
  message with `channel='whatsapp'`, and a static scan asserts `gmailMessageId` /
  `mailboxEmail` appear in no file but `tantra-normalize.js`.
- **B3 two-number collision** — two open WhatsApp conversations on one contact both insert,
  both appear in one `getThread()`, and a reply routes to the right account.
- **Forged webhook** — an unsigned POST with a valid token and fabricated content writes no
  message, no suppression and no stage change.
- **Replayed `X-Tantra-Event-Id`** — second delivery is a no-op.
- **Heuristic identity** — a phone matching only on the last 10 digits links as
  `confidence='heuristic'` and does **not** merge two existing CRM contacts.
- **Echo suppression** — a pulled tag is not pushed back.
- **Suppression union** — a Tantra unsubscribe blocks a CRM send on that channel, and a CRM
  resubscribe does not silently re-enable a Tantra-side suppression.
- **Tenancy** — every new endpoint 404s cross-tenant; a sweep for tenant A writes nothing
  visible to tenant B. `unit-cpi-inbox`'s I14 is the model.
- **Regression** — `unit-cpi-inbox` (137 checks) and `unit-cptw-tantra-webhook` pass
  unmodified, or the diff to them is justified in the receipt.

**Local dev gotcha:** Tantra's SSRF guard blocks loopback and private ranges and re-checks
at socket-connect time, so `http://localhost:3100` is refused and **dead-lettered, not
retried**. Use a tunnel; `NGROK_URL` already exists in the Tantra backend env for this.
