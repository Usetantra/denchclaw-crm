# RECEIPT CP-C-channel-executors (cycle 7)

**Status: DONE for SMS + WhatsApp. LinkedIn deliberately deferred — see below.**
Commit ``27a6c01`` on `feat/consolidation`. 7 files, +763/−371. **No migration needed** — 022's
send-reserve columns already cover every channel, so **024 is still unused**.

**Suite 877 / 0** on a fresh DB — `unit-cpc` **29** new, and CP4a's **83** pass **unmodified**
against the refactored executor, which is the proof the generalisation was behaviour-preserving.

## One executor, instantiated per channel

The sharpest form of "wrap, do not rebuild" is: there must not be a second sending path. So the
email executor's logic **is** `lib/channel-executor.js`, and every channel — email included — is an
instance of it. CP4a's five properties are therefore **inherited**, not re-implemented three times:
unknown outcomes are never retried · the attempt is recorded before the send by compare-and-set ·
`claimed_by` is per-instance · the boot gate requires an explicitly configured sender · the content
guard runs immediately before the provider call.

`server/lib/email-executor.js` is now a thin instance keeping its old export names, so nothing that
imported it changed. Adding a channel means adding a provider adapter, never another executor.

## What I found in `automation_core`, and what I reused

| Borrowed verbatim | From |
|---|---|
| Auth precedence — restricted API key before account token | `integrations/twilio.py:18-23` |
| Form-encoded `/Messages.json`, `From`/`To`/`Body` | `integrations/twilio.py`, `channels/sms.py` |
| `whatsapp:` prefix on **both** ends | `channels/whatsapp.py` |
| `ContentSid` + positional `ContentVariables` for approved templates | `channels/whatsapp.py:56-69` |

**One thing could not be wrapped, and it forced a decision.** `integrations/twilio.py:34` hardcodes
`https://api.twilio.com/...` — the only occurrence in any of the three repos, with no override. So
your standing rule *"never point an executor at a real provider key in testing"* is **unsatisfiable
by reuse**: a wrapped `twilio_send` cannot be tested at all, only fired at Twilio for real. Hence a
thin client with a `TWILIO_API_BASE` seam, mirroring `RESEND_API_BASE`.

**And one thing I deliberately did not borrow: upstream's error handling.** It returns a bare
`{ok:false}` for a 400, a 429 and a timeout alike, and captures Twilio's `code` without ever reading
it. Downstream that is a live duplicate-send bug — a timeout records `event_type="error"`, which
`channel_send_state` does not count, so the dispatcher re-sends that step **every tick forever**,
against a provider with **no idempotency key**. LinkedIn is protected upstream by its lease; SMS and
WhatsApp are not. Here: 401/403 → configuration (aborts the tick, burns nothing), 429 → deferred,
other 4xx → definitive, 5xx/timeout → **unknown, therefore quarantined**.

## LinkedIn: no sender in v1, and why that is the safe answer

**The safety spine is not in the adapter.** Wrapping `LinkedInAdapter.send()` gets suppression, the
kill switch/allowlist and eligibility — and nothing else. Every rate limit (30 invites / 40 messages
/ 20 InMail / 100 total per day, 100 invites/week, 400 pending), the send window, the accept gate
and the reserve-before-send lease live in `outreach-engine/app/linkedin_gate.py` **plus the
orchestration order in `dispatcher.py:355-429`, which is not a reusable function**. Porting it means
three tables, two migrations and a three-way lease settle.

Shipping the adapter alone sends up to 400 invites in an hour, at 3am, to people who never accepted
— the exact way a real account gets restricted, and not recoverable. There is no safe partial
version, so it is a checkpoint of its own. `GET /executors/linkedin/status` returns **404** naming
the channels that do exist, rather than pretending.

**A correction to the brief, since you asked me to reuse the window rather than invent limits:**
there are **two**. The per-account **07:00–18:00 `Asia/Kolkata`** gate you named is real, but a
narrower channel default of **Tue/Wed/Thu 09:00–10:30** is what actually binds. Both must pass.

**WhatsApp is Business API only.** The Playwright mode drives one global logged-in WhatsApp Web
session with no rate limiting and no per-tenant identity, and upstream picks it by *silent
fallthrough* — multi-tenant traffic through it sends one tenant's messages from another's number
until the session is banned.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

```bash
# a stub that records what it was asked to send — never a real key
node -e '
const http=require("http");let n=0;
http.createServer(async (rq,rs)=>{const b=[];for await(const c of rq)b.push(c);
  console.log("SEND #"+(++n), Object.fromEntries(new URLSearchParams(Buffer.concat(b).toString())));
  rs.writeHead(201,{"content-type":"application/json"});rs.end(JSON.stringify({sid:"SM"+n,status:"queued"}));
}).listen(3141,"127.0.0.1",()=>console.log("twilio stub on :3141"));'
```
```bash
TWILIO_API_BASE=http://127.0.0.1:3141 TWILIO_ACCOUNT_SID=ACstub TWILIO_AUTH_TOKEN=stub-not-real \
TWILIO_PHONE=+15550001111 SMS_EXECUTOR_ENABLED=1 WHATSAPP_EXECUTOR_ENABLED=1 \
DATABASE_URL=<scratch> PORT=3102 node server/server.js
```

| Probe | Expect |
|---|---|
| `GET /executors/sms/status` with the env unset | `enabled:false` + the reason naming the env var |
| …configured but `TWILIO_PHONE` unset | `enabled:false`, "no connected sending number" |
| `POST /executors/sms/tick` with one due job | `sent:1`; stub shows **exactly one** request, real `Body`, token resolved, correct `To`/`From` |
| `POST /executors/whatsapp/tick` | `To` **and** `From` both carry `whatsapp:` |
| SMS job + a WhatsApp tick | `sent:0` — no cross-channel claiming |
| stub hangs | quarantined, `send_started_at` retained, **no retry consumed**; age `claimed_at` 2h and tick again → **zero** further requests |
| stub 400 | acked failed, `send_started_at` cleared, requeued |
| stub 429 | deferred, not failed, not quarantined, no retry burned |
| stub 401 | tick aborts as configuration; **attempt unchanged**, ladder intact |
| `GET /executors/linkedin/status` | **404** listing `email, sms, whatsapp` |

**Assert CONTENT, not status.** Every send check above reads the stub's recorded form body.

**Not visible in the UI:** all of it (**F28** — no executor UI). Drive by API; inspect
`scheduled_actions` (`send_started_at`, `outcome_unknown_at`, `provider_message_id`, `attempt`).

## Gate hit
**None.** No push, no deploy, no live DDL, no real provider key, `:3101` only.

## Follow-ups
**F28** no executor UI · **F29** Twilio credentials are process-global — there is no per-tenant
provider table upstream either (`linkedin_accounts` is the only one), so a multi-tenant deployment
sends as one number · **F30** `ai_call` still has no provider · **F-CP4a-1** claim-door token literal
still duplicates `KNOWN_TOKENS`.

## Next
**CP-C2 — LinkedIn**, as its own checkpoint: port `linkedin_gate.py` + migrations 038/039 + the
three-way lease settle, then wrap Unipile (which *is* clean, uniform and already has a
`UNIPILE_BASE_URL` seam). That is the one channel where getting it wrong is not recoverable.
