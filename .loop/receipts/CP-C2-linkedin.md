# RECEIPT CP-C2-linkedin (cycle 8)

**Status: DONE.** Commit ``1a04bad`` on `feat/consolidation`. 10 files, +1578/−15.
**Migration 024** — the first one since 022. **Next unused: 025.**
**Suite 965 / 0** — `unit-cpc2` **88** new; **CP4a's 83 and CP-C's 29 pass unmodified**.

## What I reused, and the one thing I could not

`linkedin_gate.py` is ported almost line for line: the four concerns in upstream's order, its
verdict names (so the two systems' logs read alike), its reference caps (30 invite / 40 message /
20 InMail / 100 total daily, 100 invites weekly, 400 pending — SOP numbers, not mine), its
abandon-after-14-days rule, and its intra-window pacer. Migration 024's two tables are 038 + 039.
`unipile-send.js` is a genuine wrap: the three endpoints, their exact bodies, `X-API-KEY` auth (not
Bearer), the 300-char invite-note cap and the provider-id extraction order are upstream's.

**Unlike Twilio, the seam already existed** — upstream builds its base from `UNIPILE_DSN`, so
`UNIPILE_API_BASE` is added only because the DSN form forces https and a stub cannot be.

**What could not be reused is the orchestration**, and that is the whole reason LinkedIn was its own
checkpoint. `dispatcher.py:355-429` — resolve account → gate → send → settle lease → record state,
with three different settle paths for ineligible / skipped / sent — is inline code, not a function.
Wrapping `LinkedInAdapter.send()` gets suppression and a kill switch and **nothing else**.

## The two things you asked for explicitly

**The window is enforced at the CLAIM DOOR.** `dispatch.js` grew a generic `CHANNEL_GATES` hook that
runs inside the claim transaction, under the advisory lock it already holds — the same place A5's
quiet hours live. Channels without a gate are untouched. Two ticks therefore cannot overshoot a
daily cap any more than they can a rate limit, and **L-23 proves it** by racing two ticks against an
allowance of 2 and asserting the provider saw at most 2.

**Then a critic caught that this alone was a LOOSENING**, and it was right: a batch is processed
sequentially with a 30s provider timeout, so a tick starting at 17:58 can reach its tail after
18:00. Upstream re-checked the window before *every* send. So there is now a per-job `admitJob`
re-check immediately before the provider call, which also catches an operator pausing the account
mid-batch.

**The kill switch is per tick.** `bootGate()` runs at the top of every tick and reads `process.env`
fresh, so flipping `LIVE_SENDS_DISABLED` stops sending within one poll. It is **cross-channel**
(`lib/send-safety.js`) and ahead of the per-channel enable flag — a kill switch that only stops
LinkedIn is not a kill switch. L-1 asserts email stops too.

## Deviations from upstream — all tightenings, stated so you can overrule any of them

| Change | Why |
|---|---|
| A `message` needs POSITIVE evidence of connection (default deny) | Upstream gates only when an invite precedes it *in the same sequence*, leaving a message-only ladder aimed at strangers wide open. It catches those with a live profile resolve per prospect — a provider call each, and a checkpoint of its own (**F31**). Evidence = accepted invite, accepted/replied state, FIRST_DEGREE, or an inbound LinkedIn message. `allow_unverified_message` is the opt-out. |
| An inverted window fails CLOSED | Upstream's pacer returns `True` when `end <= start`. A misconfiguration must not become unlimited sending. |
| `active_days = []` fails CLOSED | Emptying the list would otherwise mean weekend sending. |
| An invite consults prospect state | The CRM's dedupe is `UNIQUE (enrollment_id, step_id)`, so a **second sequence** aimed at the same contact is a fresh row and would re-invite someone we already know — a real illegal action each time. |
| Per-**account-timezone** day counting | Upstream counts on the server's `CURRENT_DATE`. |
| `NURTURE_LIVE_ALLOWLIST` is **not** honoured | Sharing the kill switch is intent; silently adopting another engine's per-recipient allowlist would stop CRM sends with no operator surface. |

## Two hard refusals worth arguing with me about

**1. LinkedIn is no longer claimable over HTTP** (`channel-jobs.js`). This narrows the B4 contract,
so it needs your sign-off. The claim door gates LinkedIn correctly for *any* claimant, but the
reserve — `send_started_at` — is written by the CRM's own executor immediately before the provider
call, and the reclaim scan's entire duplicate guard is that column being non-NULL. An engine that
claims a LinkedIn invite, sends through its own path and dies before acking leaves a row that looks
exactly like "claimed but never sent", so it is re-served and a **second connection request** goes
to the same person. Ack stays open for every channel. Every other channel is unchanged (**L-28**).

**2. A LinkedIn account cannot send until an operator asserts the engine is not also dispatching on
it** (`engine_dispatch_disabled`, default `false`). This is the risk I flagged as open, and a critic
independently ranked it the single highest: the cutover is **phased**, so the engine may still be
sending on the same identity into a `linkedin_send_log` this system cannot read. Two systems each
allowing 100 actions and 100 invites a week is 200 of each, both believing they are compliant — and
that makes every other cap worthless. No query answers it from inside the CRM, so it **fails closed**
until a human says so (**L-4b**).

## The critic pass found seven real defects. All seven are fixed in this commit

Two critics, distinct lenses (account-restriction risk; regression to the channels that already
worked), run after the suite was green.

**HIGH — `releaseClaim` had no ownership guard, re-opening CP4a's duplicate send.** It cleared
`send_started_at` on any claimed row. A slow tick returning to a job a second instance had
legitimately reclaimed *and was currently sending* would hand that row back mid-flight: the ack
404s, the scan's duplicate guard is blinded, and a real person is messaged twice. **This affected
email and SMS too**, wherever the allowlist is used. Now guarded on `claimed_by` + `send_started_at
IS NULL`.

**MEDIUM — the allowlist starved the sends it exists to permit.** Released jobs kept a past
`scheduled_for` and the scan orders by it ASC, so a full batch of refused jobs was re-claimed and
re-released every tick forever and an allowlisted recipient scheduled later never surfaced. Releases
now push the job out 15 minutes (**L-27**).

**MEDIUM — deploy-order trap.** The generic release named `linkedin_account_id`; code deployed
before migration 024, with an allowlist set, would have thrown and **quarantined never-sent email**.
The column is no longer touched — a released row does not count against the ledger anyway (**L-13**).

**MEDIUM — the send window could be escaped by a slow batch** (fixed above).
**MEDIUM — an invite could re-fire across enrollments** (fixed above).
**MEDIUM — `active_days = []` failed open** (fixed above, **L-25**).
**LOW — the terminal-park `attempt` UPDATE had no ownership guard**, so it could poison a
reclaimer's live job to `attempt=3` and dead-letter it on its first ordinary failure. Guarded.
**LOW — the unknown-timezone fallback was silent** and the comment claimed it logged. It logs now.
**LOW — sends now go out on the account the claim door STAMPED**, not the one preflight resolved,
so a send can never leave on an account whose ledger did not count it.

## What the critics checked and did NOT find
Intra-batch cap overshoot · concurrent-tick cap race · in-process double send · kill-switch or
allowlist staleness · a message-to-stranger retry loop · migration 024 idempotency · any behaviour
change to email/SMS/WhatsApp in the claim door · corruption of the ack idempotency contract.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

```bash
# a Unipile stub that records what it was asked to do — never a real key
node -e '
const http=require("http");let n=0;
http.createServer(async(rq,rs)=>{const b=[];for await(const c of rq)b.push(c);
  console.log("ACTION #"+(++n), rq.url, Buffer.concat(b).toString());
  rs.writeHead(201,{"content-type":"application/json"});
  rs.end(JSON.stringify({invitation_id:"inv_"+n, chat_id:"chat_"+n}));
}).listen(3142,"127.0.0.1",()=>console.log("unipile stub on :3142"));'
```
```bash
UNIPILE_API_BASE=http://127.0.0.1:3142 UNIPILE_API_KEY=stub-not-real \
LINKEDIN_EXECUTOR_ENABLED=1 DATABASE_URL=<scratch> PORT=3102 node server/server.js
```
```sql
-- a connected identity. WITHOUT the last column NOTHING SENDS, by design.
INSERT INTO linkedin_accounts (company_id, account_id, timezone, active_start, active_end,
                               active_days, engine_dispatch_disabled)
VALUES ('<tenant>', 'acct_test', 'UTC', '00:00', '23:59',
        ARRAY['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], true);
-- a step's action: invite | message | inmail. NULL means 'message', which is refused
-- without connection evidence — the default falls the safe way on purpose.
UPDATE sequence_steps SET linkedin_action = 'invite' WHERE id = '<step>';
```

| Probe | Expect |
|---|---|
| account row absent | `blocked: linkedin gate: no_linkedin_account` |
| `engine_dispatch_disabled = false` | `engine_dispatch_not_confirmed_disabled` — **the default** |
| `status='paused'` mid-run | next tick refuses; **no restart** |
| `active_days` = tomorrow | refused, and the job is still `pending` — **never claimed** |
| `active_start='18:00', active_end='07:00'` | refused (fails closed) |
| in-window invite tick | one `POST /users/invite`, note token-resolved, `public_identifier` off the URL, `X-API-KEY` header |
| after it | `linkedin_prospect_state` = `invited` + `invite_sent_at` + `provider_id` |
| `message` step, no evidence | **zero** provider calls; job `pending`, `attempt` unchanged |
| …then set `accepted_at` | sends `POST /chats`, `api:'classic'`, `inmail` absent |
| invite to an already-accepted contact | refused at the door, **no provider call** |
| `daily_invite_limit` = today's count | next invite never claimed; a second tick sends nothing |
| `LIVE_SEND_ALLOWLIST` = someone else | no call; job `pending`, `attempt` unchanged, `scheduled_for` **pushed out ~15 min** |
| `LIVE_SENDS_DISABLED=1` | `linkedin` AND `email` both blocked, same tick, no restart |
| stub 422 | `outcome: ineligible`, job **terminal** `failed`, prospect `ineligible`, second tick silent |
| stub hangs | quarantined, `send_started_at` retained, no retry; age `claimed_at` 2h → **zero** further calls |
| stub 401 | tick aborts as configuration; `attempt` unchanged |
| `POST /channel-jobs/claim {channel:'linkedin'}` | **400** — LinkedIn is CRM-executed only |
| same for `email` | **200**, unchanged |

**Assert CONTENT and PROVIDER CALL COUNT, not status flips.** Every refusal above is proven by the
stub recording nothing.

**Not visible in the UI:** all of it (**F28**, and now **F32** — no UI to connect a LinkedIn
account, set its window/caps, or flip `engine_dispatch_disabled`; today that is raw SQL).

## The Twilio rough edge you asked about, from CP-C

You still owe an end-to-end SMS/WhatsApp send through the stub. Three things that would have cost
you time, one of which I fixed rather than warned about:

1. **`TWILIO_API_BASE` used to keep a trailing slash** — the URL appends an absolute path, so
   `http://127.0.0.1:3141/` produced `//2010-04-01/...`, which some stubs route and some do not, and
   the failure presents as a broken executor. **Fixed** (`72a8...`, one line); both seams now strip
   it.
2. **`TWILIO_TIMEOUT_MS` defaults to 15000.** Your hang probe will take 15s per job unless you set it
   — my suite uses `600`.
3. **The likeliest hour-loser: a job inserted by raw SQL will be QUARANTINED, not sent.** The claim
   door requires `payload.content_resolved = true`, which only the template/sequence path writes. If
   you hand-craft a `scheduled_actions` row you get `quarantined_content`, which reads like an
   executor bug and is not one. Build jobs through `templatesDb.upsertTemplate` → `addStep` →
   `enroll`, as `test/unit-cpc-channels.mjs:56-67` does.

Also: WhatsApp's sender falls back to `TWILIO_PHONE` with the `whatsapp:` prefix added, so setting
only `TWILIO_PHONE` is a valid WhatsApp config — and `TWILIO_WHATSAPP` is accepted with or without
the prefix, never double-prefixed.

## Gate hit
**None.** No push, no deploy, no live DDL, no real provider key, `:3101` only.

## Follow-ups
**F31** eligibility by live profile resolve (`network_distance` / `can_send_inmail`) — the columns
exist, unpopulated; needs a provider call per prospect · **F32** no LinkedIn admin UI · **F33**
`releaseQuarantine('resend')` clears `send_started_at`, so an operator resend is invisible to the
day's count · **F34** no `relation.request.accept` / `message.new` webhook yet, so `accepted_at` is
only ever set by hand — the accept gate has memory but nothing writes to it automatically ·
**F35** migration 024's `CREATE INDEX` is non-concurrent (consistent with every prior migration
here, but it briefly write-locks `scheduled_actions`) · **F28** no executor UI · **F-CP4a-1** the
claim-door token literal still duplicates `KNOWN_TOKENS`.

## Next
**F34 is the honest next checkpoint**, and it is small: without the Unipile webhook, an accepted
invite is never recorded, so the default-deny message gate holds every follow-up forever unless a
human sets `accepted_at`. The spine is built; it currently has one sense organ missing.
