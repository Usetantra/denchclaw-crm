# SESSION HANDOFF — 2026-08-19 — Tantra mirror, scale limits, workflow editing, ops visibility

Branch `nelbin-working-branch`. Full suite: **1520/1520, 34/34 suites** (`bash test/run-local.sh`).
Migrations **039–043**. Not pushed.

> **READ THIS BEFORE PUSHING.** The repository is **public**
> (`github.com/Usetantra/denchclaw-crm`) and two committed documents contain things
> that probably should not be: `server/db/models/tantra.md` carries a real person's
> email and Clerk user id plus the Clerk instance name (§Appendix A), and both it and
> `docs/TANTRA_INTEGRATION_PLAN.md` describe three **unfixed** vulnerabilities in the
> Tantra backend (unenforced API-key scopes, unsigned webhooks, a billing seam that
> grants add-ons free). Committing is local and reversible; pushing is not, and GitHub
> caches. Decide one of: make the repo private, drop these two files from the commit,
> or redact them. This was raised twice during the session and never settled.

---

## What shipped

### 1. Tantra mirror — plan Phases 1–4 (`039`, `040`)

Decisions locked with the operator: **consume-only** (no changes to `tantra-backend-v2`),
**CRM is the inbox**, **B3 two WhatsApp numbers**, **two-way contact sync**.

Consume-only is the shaping constraint. Tantra's webhook catalogue is *reply-shaped* —
nothing fires for our own sends, a second inbound, or a new thread — so a webhook-driven
mirror would be silently, permanently incomplete. The mirror is therefore **poll-driven,
and a webhook is only a hint to poll now**. That also disarms the fact that Tantra signs
nothing: every persisted byte comes from an authenticated API read, so a forged event
costs one wasted request and can inject nothing.

| File | Role |
|---|---|
| `server/lib/tantra-client.js` | The only file allowed to call Tantra. Owns the `/api/v1` prefix, `X-API-Key` auth, and builds bodies key-by-key (their `forbidNonWhitelisted` 400s on one unknown key). |
| `server/lib/tantra-normalize.js` | **The quarantine.** Tantra's DTO is email-shaped on every channel — a WhatsApp message carries `gmailMessageId` and `mailboxEmail` holds a phone number. A static test asserts those two names appear in no other server file. |
| `server/lib/tantra-sync-engine.js` | Contact resolution + writes. Idempotency is structural: writes carry `provider_message_id` and let `uq_messages_provider_id` decide, because the nudge and sweep paths overlap by design. |
| `server/lib/tantra-executor.js` | Sweep + resumable backfill, on the repo's tick convention. |
| `server/routes/tantra.js` | `/api/crm/tantra` — connect, status, tick, backfill, identity review. Separate router because `routes/executors.js`'s `/:channel` wildcards would swallow it. |

**Migration 040 is the B3 grain** and was nearly a breaking change: two live sites use
`ON CONFLICT (contact_id, channel) WHERE status != 'closed'`, which infers that exact
index. Both call sites were updated in the same commit, and the column is
`NOT NULL DEFAULT ''` rather than a `COALESCE` expression index specifically so the
inference stays a plain column list.

**Sending is refused, not rerouted.** A Tantra-owned conversation replies through Tantra;
if Tantra is unreachable it is a **409**. Falling through to the CRM's provider would
bypass their suppression and pacing while looking like success to the rep.

### 2. Scale limits (`server/lib/query-limits.js`)

Nine endpoints loaded every contact a tenant owned into memory. Against the 256 MB pm2
ceiling a large tenant hitting export or the pipeline board was **killed mid-request**,
taking other in-flight requests with it. That ceiling — not Postgres — was the product's
real capacity limit.

Export streams keyset batches (a 250k export costs the same memory as 500 rows); lists
paginate with a selectable page size; imports cap at 1000/request with a 413 naming the
limit; `findOrCreateContact`'s no-email path is an indexed lookup instead of a full table
scan **per inbound webhook**; the inbox list's per-row deals query is now one per page.
`max_memory_restart` raised 256M → 768M.

**Nothing truncates silently** — every cap paginates, streams, or refuses.

### 3. Workflow triggers (`041`) and editing (`042`)

Six event triggers added — contact created, replies, event registered/attended/no-showed,
unsubscribed — each proven to fire from the **real product path**, not a synthetic call.
Task-overdue was deliberately excluded: nothing detects it, and a trigger that silently
never runs is indistinguishable from a broken one. `GET /sequences/trigger-events` serves
the catalogue so the builder cannot offer a trigger the server does not fire.

**Bug fixed:** a contact created *with* a tag never started a tag-triggered workflow —
exactly the lead-webhook path the builder's help text promises.

Workflows are now editable: steps can be added, edited, reordered and removed, and
workflows paused or deleted. Removal **archives** anything with history and hard-deletes
only what never ran, because `scheduled_actions.step_id` is `ON DELETE CASCADE` and a
plain delete would erase the record of messages already sent. Enrolments parked on a
removed step move forward rather than stranding.

### 4. Operational visibility (`043`)

The reason this exists: the product is fail-closed everywhere and its executors are
cron-driven rather than daemons, which produces one failure mode — **it looks healthy and
does nothing** — and that is the *expected* state until someone installs the cron.

- `ops_channel_state` records the tick heartbeat. Everything else (queue depth,
  quarantine, integration health) was already derivable; the one fact nobody stored was
  *"did a tick happen, and when."*
- `GET /api/crm/ops/health`, `/quarantine`, `/fleet` (admin-only).
- **Settings → System health** plus a **Dashboard alarm** shown unprompted when the
  engine has never run or has stopped.
- A *blocked* tick still counts as a heartbeat — sending is off by default, so treating
  that as "not running" would cry wolf on every new tenant. `last_ok_at` separates
  "blocked briefly" from "blocked for a fortnight".

### 5. Six bugs found and fixed in this session's own code

1. **Tantra watermark stepped over failed threads** — silent data loss. The watermark *is*
   the sweep's stopping rule, so a thread that failed to sync was never read again. Now it
   moves only to the newest thread actually written that is older than the oldest
   unresolved one, with transient vs decided skips distinguished.
2. **Social threads could be filed as email.** `detectChannel` returns null for an `s_`
   thread with no explicit channel and the upsert defaulted to `'email'`. Since Phase 0
   never ran, whether Tantra sends that field is unverified. Now skipped loudly.
3. **The ownership guard was side-steppable** — replying with an unknown `channel_account`
   *created* a CRM-owned conversation labelled with Tantra's number, then sent locally.
4. **Filtered lists reported the wrong total, twice** — `countMatching` ignored its filters,
   and the paginated branch used unfiltered `getStats()`, so the pager showed
   "1–50 of 4,312" for a search matching three.
5. `list()` hardcoded a 500 cap while the UI validated against the env-tunable constant.
6. `removeSequence` swallowed an error on columns that provably exist.

### 6. Interface

The workflow trigger card's layout problem was a **global stylesheet gap** — bare form
controls inherited no size, padding or border. Fixing it at the root repaired every
unstyled control in the app. Also: one shared pager replaced two drifting copies, page
size is selectable and remembered, free-text tag/stage fields became pickers (a typo'd
stage produced a workflow that silently advanced nobody), and the pipeline board says
"showing 100 of 4,312" when a stage is capped.

---

## Still blocking launch

1. **There is no login.** nginx injects the API key, so anyone who loads the URL is fully
   authenticated. Per-user auth is built but unmounted pending Clerk. Put a VPN, proxy
   basic-auth or an IP allowlist in front and the largest risk is contained today.
2. **Nothing turns the crank.** No scheduler exists. Until executor + Tantra ticks are on
   cron, nothing sends — the System health page now says so out loud.
3. **`CREDENTIALS_KEY` is unset.** Rotating `INTERNAL_API_KEY` would make every stored
   provider credential permanently undecryptable.
4. **`.env.example` documents 5 of 63 settings.**

Then: rate limits on the lead/Tantra/capture webhooks, the spoofable `X-Forwarded-For`
allowlist, a migration runner, and backups.

## Still pending

- **Tantra Phase 0** — the mirror has never seen a live payload. Every field name is a
  strong read, not a verified fact. Needs an API key against a real tenant. Do this before
  trusting the mirror.
- **Tantra contact push** — Tantra documents no contact-write endpoint.
- **Instantly** — capture-only until real payloads exist.
- **F15** — a backdated inbound can be born already-read; needs a monotonic sequence
  instead of a timestamp watermark. Deferred deliberately: it rewrites unread computation
  across the most heavily-tested code in the repo.

## Local environment

Postgres 16 was started via `brew services start postgresql@16` and a scratch role/db
created (`denchclaw` / `denchclaw_test`) so the suite could run. Both were **stopped at
end of session**; restart with `brew services start postgresql@16`.

```bash
DATABASE_URL_TEST="postgres://denchclaw:test@127.0.0.1:5432/denchclaw_test" bash test/run-local.sh
```

The UI is verifiable end to end with `node dev/serve-web.js` against `npm run dev`; the
dev shim injects the auth header nginx supplies in production.

## Next unused migration: **044**
