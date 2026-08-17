# SESSION HANDOFF — 2026-08-17 — Real connectors, multi-tenant domains, going live

Commit `b5f6723` on `nelbin-working-branch` (pushed to origin). Working tree clean.
Full suite: **1351/1351, 29/29 suites green** (`bash test/run-local.sh`).

## Mission

Two threads, both driven by the operator's stated goal that DenchClaw CRM is a
genuine multi-tenant SaaS platform (not single-tenant software for one
company): (1) turn "go fully live" instructions into reality — remove testing
guardrails, enable disabled features, build real (not guessed-at) third-party
connectors; (2) make sending/receiving self-serve per tenant instead of
hardcoded to one operator-owned domain.

## What shipped, in order

**Going live / cleanup**
- `LIVE_SEND_ALLOWLIST` removed — any enrolled contact can now receive a real send.
- Custom auth/login gate disabled (not deleted) — Clerk will replace it wholesale later.
- Live-verified the webinar → anchored reminder email flow with a real Resend send.

**Workflows UI** — rebuilt three times on direct user feedback (modal → two-column
full page → final single-column GHL-style connected canvas), moved out of
Settings into its own top-level tab. `viewWorkflow()` opens a saved workflow
read-only (editing/reordering live steps risks destroying real enrollment
history via `scheduled_actions.step_id ON DELETE CASCADE` — no step-level
PATCH/DELETE API exists yet, flagged as future work).

**Webhook-capture harness** (`migrations/035`) — a generic
`POST /webhooks/capture/:tool` logger + Settings → Integrations viewer, built
so real connectors could be built from REAL captured payloads instead of
guessed-at docs.

**Tantra connector** (`migrations/036`) — real outbound webhook receiver, built
from `usetantra.com/help/api-and-mcp/{outbound-webhooks,webhook-event-triggers}`.
Per-company token URL. `email.replied` reuses the inbound-email conversation
path (same engaged→responded advance); `email.unsubscribed` suppresses;
`lead.stage.changed` only moves the contact if the operator has mapped
Tantra's stage name (Settings → Integrations → Tantra); everything else is
logged to the activity feed. Every delivery is captured raw regardless, for
diagnosing wrong field-name guesses.

**WebinarGeek connector** (`migrations/037`) — discovered via their real API
blueprint (`webinargeek.docs.apiary.io`) that the API is **pull-only, no
webhooks anywhere in the spec**. Built as an API-key connection + operator-
triggered "Sync now" against a chosen broadcast. `server/lib/
webinargeek-sync-engine.js` is a pure, unit-testable find-or-create +
activity/scoring function; a dedupe ledger (migration 037) means a repeat
sync only logs something when a subscriber's watched state actually changed.

**Zoom / Instantly** — Zoom confirmed a dead end for direct integration (Zoom
only ever talks to Tantra, not to this CRM) — its capture-URL code still
exists but nothing will ever call it. Instantly is untouched — no real docs
pulled yet, still just a capture-URL logger.

**Cleanup**: deleted the stale generic "Connected tools" card (it kept
showing Tantra/WebinarGeek as permanently "NOT SET UP" after they got their
own real status cards — confusing, not informative).

**Public marketing webhooks enabled** — `MARKETING_WEBHOOK_SECRET` set (was
unset/disabled since inception). Exposed and fixed a real bug: `unit-cpb-
marketing`'s B-8 "fails closed with no secret" probe spawns a child server
that's supposed to be blind to any secret, but `server.js`'s
`dotenv.config()` reads the real `./.env` from cwd regardless of the child's
explicit env — so a real secret in the repo's own `.env` was silently
leaking into a test proving the OPPOSITE. Fixed with a `DOTENV_PATH`
override (same convention as the existing `AUTOMATION_ENV_FILE`).

**Self-serve custom domains** (`migrations/038`) — the big one. Each tenant
can connect their own domain from Settings → Channels: we register it in
*our* Resend account on their behalf and hand back the DKIM/SPF/MX records
for them to paste into whatever DNS provider they use — we never touch
tenant DNS ourselves. `server/lib/resend-domains-client.js` wraps Resend's
real domain-management API (create/get/verify/update/delete), sourced from
their actual docs, not guessed.

**Wired verified domains into real sending** — the automated email executor
was the last channel still reading a single global env var
(`CHANNEL_SENDERS`) for its "From" address. It now resolves its sender
per-tenant via `preflight(companyId)`, pulling from `channel_senders` — the
same DB table SMS/WhatsApp/LinkedIn already use — exactly matching every
other channel's architecture. `POST /channels/senders` now gates a new email
sender on domain ownership (must be one of the tenant's own
connected+verified domains). `CHANNEL_SENDERS` removed from `.env` entirely;
the existing production sender (`hello@growthideapro.com`) was backfilled
into `company_domains` so it kept working under the new gate instead of
breaking on cutover.

## Key architectural notes for next session

- **Multi-tenant sending is real now.** Every channel (email/SMS/WhatsApp/
  LinkedIn) resolves its sender per-company from the DB via `preflight()`.
  There is no more single shared identity anywhere in the send path.
- **Inbound routing is NOT domain-aware yet.** Receiving still resolves the
  tenant via the static `INBOUND_ROUTING` env var (server/routes/
  webhooks.js), not by looking up the recipient's domain against
  `company_domains`. A second tenant's connected domain can now send fine,
  but a reply won't route back to them without a manual env-var edit. This
  is the natural next step in the domain work.
- **Resend account-level limit**: the real Resend account is on a plan that
  caps domains — verified live (`"You have reached the domain limit of your
  plan"`) when testing the connect flow against the real API. Doesn't block
  the code (fully tested via stub), but means a second real domain can't
  actually be added until the plan is upgraded.
- **Company_domains status ≠ fully verified.** The gate on adding an email
  sender accepts `verified` OR `partially_verified` (Resend's own
  vocabulary) — `partially_verified` can mean sending DKIM/SPF are fine but
  inbound MX is still pending, or vice versa. Resend's own send-time
  behavior is the real backstop if a sender is added prematurely.

## Verification

- Full local suite: **1351/1351 passed, 29/29 suites reported, SUITE GREEN**.
- New suites this session: `unit-cpwc-webhook-captures` (12), `unit-cptw-
  tantra-webhook` (22), `unit-cpwg-webinargeek` (21), `unit-cpcd-company-
  domains` (21). All hit local HTTP stubs, never a real provider (same rule
  `unit-cp4a-executor` documents for Resend) — except the domain-connect
  flow, which was ALSO manually verified against the real Resend API
  end-to-end (got back a real, correctly-surfaced plan-limit error).
- `unit-cp4a-executor` rewired for the CHANNEL_SENDERS retirement: sender
  checks now assert against `tick()`'s per-tenant `blocked` field via a real
  DB `channel_senders` row, plus a new explicit multi-tenant check (one
  tenant's missing sender must never block another's send).
- Playwright-verified every new UI surface (Workflows canvas incl.
  reordering-persistence, Integrations panel incl. all three connector
  cards, Domains card incl. real Resend error surfacing).

## Pending / next steps

1. **Instantly connector** — needs real docs pulled (same treatment as
   Tantra/WebinarGeek), currently just a dead capture-URL logger.
2. **Zoom capture-URL code** — dead end, confirmed. Should probably be
   deleted rather than left as working-but-pointless.
3. **`growthideapro.com` inbound MX record** — Resend side enabled via API
   (`capabilities.receiving: enabled`); the actual DNS record
   (`growthideapro.com MX 10 inbound-smtp.us-east-1.amazonaws.com`) still
   needs adding in Cloudflare (where the domain's nameservers point).
   Blocked on a Cloudflare API token from the operator, or manual entry.
4. **Inbound routing → domain-aware** (see architectural note above) — the
   natural next step to finish the multi-tenant domain story.
5. **Live verification** — Tantra, WebinarGeek, and the domain-connect flow
   are all built/tested against stubs but none proven against a real
   external account/event yet.
6. **Clerk auth** — still disabled, waiting on Clerk API keys.
7. **Hosting/domain decision** — blocks a real public HTTPS URL, which
   blocks Resend inbound routing and matters for any tenant actually using
   self-serve domains in production.
8. **SMS/WhatsApp live-send verification** — only email has been proven with
   a real send so far this whole project.

## Gotchas hit + resolved this session

- Shell-sourcing `.env` before `node server/server.js` leaks exported vars
  into `test/run-local.sh`'s spawned test server in the same shell — never
  shell-source `.env` for the main dev server; `server.js` already calls
  `dotenv.config()` itself.
- `dotenv.config()` reads `./.env` from **cwd**, not from where `server.js`
  lives — a test spawning a child server with a deliberately-restricted env
  object still silently inherits whatever secrets are in the real repo
  `.env` unless the new `DOTENV_PATH=/nonexistent` override is set.
- Resend's domain-update API needs the **nested** shape
  (`{"capabilities":{"receiving":"enabled"}}`, string not boolean) — a
  flat `{"receiving":true}` silently no-ops with a 200, no error, which
  wasted real time earlier in the project before this session traced it
  properly via their actual API docs.
