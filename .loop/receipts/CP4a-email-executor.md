# RECEIPT CP4a-email-executor (rev 2, cycle 5)

**Status: DONE.** Three commits on `feat/consolidation`:
`f47bce4` (the executor) · `30898e6` (the two forward risks) · `a5f9e58` (test-harness guard).
Not pushed, not deployed. **No test can contact a real provider.**

**Suite 774 / 0** on a fresh DB — `unit-cp4a-exec` **83**, `unit-cp4a0` **83**, everything prior
unmodified. Migration 022 applies twice clean. Next unused migration is **023**.

> Receipt refreshed to match the tree. The earlier version described `f47bce4` alone, before the
> two risk fixes landed; the `R9` red you saw was that work in flight and is green now.

## Shape
Not a daemon. `POST /api/crm/executors/email/tick` runs one batch — the dispatcher's pull-based
posture, so there is no process lifecycle to keep alive and stopping the world is
`EMAIL_EXECUTOR_ENABLED=0`. Plus `/status`, `/quarantine`, `/quarantine/:id/release`.

## Your five HIGHs

| # | Closed by |
|---|---|
| **1** no timeout ⇒ up to 3 duplicate sends | `AbortController` timeout (armed across the body read too), and failures split **by type**: `definitive` may consume a retry, `outcomeUnknown` never does. |
| **2** idempotency unimplementable | 022 adds `send_started_at` + a per-attempt token, committed **before** the provider call; the claim scan never re-serves a row that has one. |
| **3** staleness measured from `scheduled_for` | **The guard is gone, not fixed.** "How long has this been sendable?" is not derivable from any column — `scheduled_for` is untouched by A5 while deferring, `claimed_at` is stamped by the claim itself. Opt-in dead code would have been a lie. Follow-up **F23** if it is ever wanted: it needs a `became_claimable_at` column. |
| **4** shared `claimed_by` | Per-process `INSTANCE_ID`. |
| **5** key without sender shreds every ladder | Gate requires an **explicitly configured** sender; 401/403 are config errors and 429 transient, so neither burns a retry into a terminal `exited`. |

## Critic — Fable 5. It reproduced five more against my first cut. All fixed.

1. **HIGH — the dominant duplicate path was not the one I guarded.** A slow tick stalls past
   `CLAIM_TIMEOUT_MS` (25 jobs × 15s > 300s), a second tick legitimately reclaims and sends, then
   the first tick sends **again**. `markSendStarted` is now a **compare-and-set** on
   `(id, claimed_by, status='claimed', send_started_at IS NULL, not quarantined)` — lose the race,
   skip. (`R1`)
2. **HIGH — quarantine lasted five minutes.** Rows quarantined *before* any send have no
   `send_started_at`, so the scan reclaimed them and sent with no human release. The scan now
   excludes `outcome_unknown_at IS NOT NULL` outright. (`R2`)
3. **HIGH — a sent row stayed in the quarantine list**, so an operator following the UI's own
   advice would "resend" a message already delivered. Marker cleared on success; releasing a
   terminal row refused; `discard` refused for a job that never sent (it would advance the ladder
   past a message nobody received). (`R3`)
4. **HIGH — 401/403/429 were "definitive"**, so a bad key dead-lettered into terminal `exited`
   within three ticks. Reclassified. (`R4`, `R4b`)
5. **MEDIUM — the gate accepted a hardcoded default sender**, so `ENABLED=1` + a key meant real
   outreach from an address nobody chose. No fallback now. (`R5`)
   Plus: crash-limbo rows are surfaced (`R6`); one bad job no longer aborts the batch.

**Tried and deliberately reverted: bumping `attempt` on reclaim.** It makes "picked up twice"
indistinguishable from "failed twice", so a merely-reclaimed row burns its delivery budget and
dead-letters early — and a dead-letter exits the enrollment terminally. It broke `unit-b3` and
`unit-cp2`'s retry semantics, which was the tests telling me the truth. Reclaim churn is bounded by
the in-flight and quarantine exclusions instead (`R7`), without overloading what `attempt` means.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

### Running it WITHOUT sending real mail — this is the whole point
`RESEND_API_BASE` now overrides the endpoint (it was hardcoded, which is why your MEDIUM-3 said the
browser script was unrunnable). Point it at a stub:
```bash
RESEND_API_BASE=http://127.0.0.1:<stub>   # a local server you control
RESEND_API_KEY=stub-key-not-real
CHANNEL_SENDERS='{"email":[{"identity":"crm@stub.test","default":true}]}'
EMAIL_EXECUTOR_ENABLED=1
```
`test/unit-cp4a-executor.mjs` starts exactly such a stub (modes: `ok`, `reject4xx`, `reject401`,
`ratelimit`, `error5xx`, `hang`) and **records every request** — that is how "exactly once" is
proven rather than asserted. **Never set a real `RESEND_API_KEY`.**

### Probes
| Probe | Expect |
|---|---|
| `GET /executors/email/status` with `ENABLED=0` | `enabled:false` + reason |
| Same with a key but `CHANNEL_SENDERS` unset | `enabled:false`, "no explicitly configured sending address" |
| `POST /executors/email/tick` with one due, content-carrying job | `sent:1`; **stub received exactly ONE request**; body non-empty, token resolved, real subject |
| Stub in `hang` mode | `quarantined:1`, `sent:0`, `send_started_at` **retained**, `attempt` **not** consumed |
| …then age `claimed_at` 2h and tick again | **0 requests** — the duplicate-send proof |
| Stub `reject401`, tick ×4 | job **not** dead-lettered, enrollment **not** `exited`, tick reports blocked |
| Quarantine a job pre-send, age it 2h, tick | **not** auto-reclaimed — quarantine is durable |
| `release` a sent job as `resend` | **refused** |
| `release` a never-sent job as `discard` | **refused** |

**Assert CONTENT, not status.** Every send check here reads the stub's recorded body.

### Not visible in the UI
All of it — there is no executor UI (**F24**). Drive it by API and read `scheduled_actions`
(`send_started_at`, `outcome_unknown_at`, `provider_message_id`, `attempt`).

## Gate hit
**None.** No deploy, no push, no live DDL, no real provider key. Migrations 012–022 must be applied
before any restart (`dispatch.js` now references `send_started_at` for all channels — it fails
closed, but it is a dispatcher outage until 022 lands). `:3101` released; `denchclaw_test` untouched.

## Follow-ups
**F23** an age guard needs a `became_claimable_at` column · **F24** no executor UI ·
**F25** only email has an executor; SMS/WhatsApp/LinkedIn/calls remain unbuilt (your audit item 4) ·
**F20/F21/F22** from CP4a-0 · **F15/F16** from CP-I · **F19** `trust proxy` allowlist bypass.

## Next
The remaining goal gap is your audit's item 1: **the automated MARKETING stages are inert** —
`visits`, `registrants`, `auto_registrants`, `attendees`, `invitees` appear in zero server files.
That is the biggest distance between what is built and the operator's spec, and it is what I will
pick up next unless you redirect.

---

# ADDENDUM — the two forward risks

Suite **774 / 0**. Commit `30898e6`.

## Risk 1 — reclaim churn must not consume delivery attempts

**Already resolved before your message, and I arrived at it the hard way.** The reclaim `attempt`
bump broke `unit-b3` and `unit-cp2`'s retry semantics, which was the tests telling me exactly what
you then described: a job merely picked up twice burns its budget and the first genuine failure
dead-letters — terminally exiting the enrollment.

I went further than "exclude reclaim bumps from the `willRetry` decision": **the two quantities
never share a counter at all.** `attempt` counts explicit `ack(failed)` calls and nothing else.
Reclaim churn is bounded instead by the in-flight and quarantine exclusions — a row that has started
a send, or that is quarantined, is never re-served.

**Your criterion, added as `R8`:** two full claim-expiry cycles, then one genuine `ack(failed)` ⇒
`will_retry: true`, enrollment still `active`, job requeued at `attempt` 2 of 3. (`attempt` DEFAULTs
to 1 in migrations/014, so an unburned job reads 1 — worth knowing before you assert against it.)

## Risk 2 — the guard false-blocked ordinary copy

You were right, and the fix is better than a reworded error. The guard now matches only the **closed
set** of real personalisation tokens (`first_name`, `company`, `stage`):

- `We call this the {growth} framework.` → **sends**, verbatim, in body and subject.
- `Hi {first_name},` for a contact with no name → **still blocks**.

A brace-shaped non-token is now an **authoring-time advisory** (`"looks like a token but is not one
… if that is literal text it will send as-is"`) — which also catches the typo case, `{frist_name}`,
that a pure block would have hidden inside a wall of false positives.

**There is now a real escape**: `{{first_name}}` renders as the literal `{first_name}`. That needed
care, because once restored a deliberate literal is byte-identical to a failed merge — so resolution
validates with the escapes still as sentinels and **restores last**, then records
`content_literal_braces` so the claim door and the executor stay strict for everyone else without
false-blocking copy an operator explicitly escaped.

Refusal messages now say what to do: *fill the field on the contact, remove the token, or write
`{{company}}` if you meant the literal text.*

`R9` covers all of it: braced prose sends, the merge field still resolves alongside it, a real
failure still blocks with an actionable reason, and `{{escape}}` survives end to end. Three C10
assertions in `unit-cp4a0-content.mjs` were updated to the new semantics — the old ones asserted
that `{nonexistent_token}` blocks, which is precisely the false block you asked me to remove.

## Stub invocation — the exact commands

The `pending → sent` flip is genuinely runnable now. Two terminals:

```bash
# 1. a stub provider on :3141 that records what it was asked to send
node -e '
const http=require("http");const seen=[];
http.createServer(async (rq,rs)=>{const b=[];for await(const c of rq)b.push(c);
  seen.push(JSON.parse(Buffer.concat(b).toString()||"{}"));
  console.log("SEND #"+seen.length, JSON.stringify(seen[seen.length-1],null,2));
  rs.writeHead(200,{"content-type":"application/json"});rs.end(JSON.stringify({id:"stub-"+seen.length}));
}).listen(3141,"127.0.0.1",()=>console.log("stub on :3141"));'
```
```bash
# 2. the CRM, pointed at the stub — NEVER a real key
RESEND_API_BASE=http://127.0.0.1:3141 \
RESEND_API_KEY=stub-key-not-real \
CHANNEL_SENDERS='{"email":[{"identity":"crm@stub.test","default":true}]}' \
EMAIL_EXECUTOR_ENABLED=1 \
DATABASE_URL=<your scratch db> PORT=3102 node server/server.js
```
```bash
# 3. fire one batch
curl -s -X POST http://127.0.0.1:3102/api/crm/executors/email/tick \
  -H 'content-type: application/json' -H "x-internal-key: $KEY" -H 'x-company-id: tantra' -d '{}'
```
The stub prints the **actual body and subject**. That is the assertion that matters: a green
`sent: 1` with an empty body is the rev-1 failure mode, so read the stub's output, not the counter.

---

# ADDENDUM 2 — the port clash is now impossible in the tracked harness

Your 88 phantom failures were a harness bug, not a build one — but the **committed**
`test/run-local.sh` had exactly the same hazard, so the fix belongs in the repo and not only in your
copy. Commit `a5f9e58`.

The health check proved a server was listening, never that it was **ours**. When another process
holds `TEST_PORT`, `node server/server.js` fails to bind, `/health` answers from *their* server, and
every keyed request 401s against a key it has never heard of. The runner now proves its own key is
accepted before running anything and aborts naming the real cause:

```
FATAL: :3101 answered /health but rejected our key (HTTP 401).
       Another server is almost certainly holding that port — this run
       would produce phantom failures against someone else's process.
```

Verified both directions: against a foreign server that answers `/health` 200 and 401s everything
else, the guard fires; against our own server the probe returns 200 and the suite proceeds.

Your diagnostic instinct was the right one and worth writing down: **the DB-only suites passing
clean while every server-backed suite failed is the signature of a port clash**, not of a broken
feature. Nothing in the harness said so, which is what made it cost you a false alarm.

`TEST_PORT` still defaults to 3101 (mine) and I have kept off :3102.
