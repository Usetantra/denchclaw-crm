# DEPLOY RUNBOOK — feat/consolidation → staging

**Status: DEPLOY IS A SHUT GATE.** This document does not open it. It records what must be true
before anyone does, and it exists because the failure mode below is **silent**.

## THE HAZARD, PROVEN — not a theory

I built a database at staging's actual schema level (≤011), booted the **current** code against it,
and measured what happens:

```
/health                          → 200      ← the deploy looks SUCCESSFUL
GET /api/crm/contacts (with key) → 401      ← every real request is dead
```
Server log:
```
[Auth] DB-backed API key resolution failed: relation "tenant_api_keys" does not exist
[Auth] SECURITY: DB key-collision check unavailable (DB error) for an env-bound key —
       refusing rather than risk an undetected collision
```

**Why it happens.** `server/middleware/auth.js` resolves DB-backed per-tenant keys against
`tenant_api_keys` (created by **migration 017**). When that table is absent the collision check
cannot run, and the code **deliberately fails closed** — refusing rather than risking an
undetected key collision. That is correct security behaviour. It is also total: **every
authenticated request 401s.**

**Why it is dangerous rather than merely broken.** `initDatabase()` does **not** run migrations, and
`/health` does not touch `tenant_api_keys`. So a health-checked deploy reports success while the
API is entirely dead. Anything watching `/health` will say the rollout is fine.

## MANDATORY ORDER

1. **Apply DDL first.** Migrations **012 → 025** in order, against the staging database, *before*
   any process restart. Applying DDL to a live database is an operator action and a gate — this
   runbook does not authorise it.
2. **Verify the schema landed** before restarting anything:
   ```sql
   SELECT to_regclass('public.tenant_api_keys'),  -- 017, the one that 401s everything
          to_regclass('public.tenants'),          -- 012
          to_regclass('public.scheduled_actions'),-- 014
          to_regclass('public.message_templates'),-- 021
          to_regclass('public.linkedin_accounts');-- 024
   ```
   Every result must be non-NULL.
3. **Then restart** the serving process.
4. **Verify with an AUTHENTICATED request, not `/health`.** `/health` returning 200 proves nothing:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "x-internal-key: $INTERNAL_API_KEY" -H 'x-company-id: tantra' \
     https://staging.usetantra.com/crm/api/contacts
   ```
   Expect **200**. A **401 means the migrations did not land** — roll back the restart.

## SENDING IS OFF BY DEFAULT — and must be turned on deliberately

Nothing sends unless explicitly enabled. Leave it that way until the DDL is verified:
- `EMAIL_EXECUTOR_ENABLED`, `SMS_EXECUTOR_ENABLED`, `WHATSAPP_EXECUTOR_ENABLED`,
  `LINKEDIN_EXECUTOR_ENABLED` — each per channel, all off unless `=1`.
- Each also requires an **explicitly configured sender** (`CHANNEL_SENDERS`); the boot gate refuses
  to fall back to a built-in address, so nobody sends from an identity they did not choose.
- **`LIVE_SENDS_DISABLED`** is the global kill-switch. It is read **fresh on every claim**, so
  flipping it stops sending within one tick — no restart. It uses the engines' own variable name,
  so one setting stops the CRM *and* the engines together.
- **LinkedIn additionally refuses** until `linkedin_accounts.engine_dispatch_disabled = true` —
  i.e. until an operator confirms the outreach engine is not also sending on that account. Two
  systems driving one LinkedIn account is how it gets restricted.

## BEFORE FIRST SEND, per tenant
- Populate `crm_merge_defaults` (`book_url`, `sender_name`, `join_url`, `unsubscribe_url`,
  `webinar_date`, `webinar_time`). A missing default leaves an unresolved token, which marks the
  content unsendable and **the claim door refuses the job** — safe, but the ladder will sit still
  and the reason is only visible on the readiness surface.
- Seed the automations deliberately: `POST /api/crm/automations/:key/seed`. Re-seeding is
  idempotent (`already_installed`, left untouched).
- **Check the backlog before enabling any executor.** There are queued `scheduled_actions` from
  testing; enabling a channel against an old backlog would fire stale messages at real people.

## What is NOT covered
Rollback of the migrations themselves. 012–025 are additive, but no down-migrations exist and I
have not tested a reversal. Treat the DDL as forward-only.

---

## Send-safety preconditions (added after the CP-Y fail-open sweep, 2026-08-01)

Three consecutive defects (CP-Y/Y2/Y3) were all one shape: **a guard that opens when its
configuration is absent.** I swept the remaining send guards at the claim door for the same
shape. Result: **no new defect — but one asymmetry that must be known before live sends.**

### LinkedIn fails CLOSED. Verified 5/0.

| Condition | Claim door |
|---|---|
| no `linkedin_accounts` row at all | **refuses** |
| account present but `disconnected` | **refuses** |
| connected, but `engine_dispatch_disabled = false` | **refuses** |
| fully configured (positive control) | **claimable** |

A LinkedIn send with no configured account is impossible, not merely capped. The refusals leave
jobs `pending` rather than consuming them — confirmed, because the positive control then claimed
the accumulated backlog.

### Email / SMS / WhatsApp fail OPEN — **by design, and this is the precondition**

`getChannelLimits` returns `DEFAULT_LIMITS` when no row exists (`server/db/models/limits.js:115`),
and those are `max_per_hour: null, max_per_day: null`. `checkRateLimit` reads
`limits.max_per_hour == null || …` — so **null means uncapped**. The code says so deliberately:
"Absent row is a valid, permissive state (no limit configured)".

That is a defensible choice — a tenant that configured no cap is uncapped by intent — but it
means:

> **On deploy, if the tenant has no `tenant_channel_limits` row, email/SMS/WhatsApp sending is
> UNCAPPED, and `LIVE_SENDS_DISABLED` is the only brake.**

LinkedIn is not exposed this way; its own spine fails closed independently.

**Before enabling live sends:** confirm a `tenant_channel_limits` row exists for every channel
you intend to send on, or accept uncapped throughput knowingly. Verify with:

    SELECT channel, max_per_hour, max_per_day FROM tenant_channel_limits WHERE company_id = '<tenant>';

An empty result means uncapped, not "safe defaults".
