# Channel-executor contract (roadmap B4)

The interface an external engine (outreach / nurturing / content / personalization)
implements to send a sequence's channel steps and report results back to the CRM.
The CRM owns orchestration (sequences, enrollment, scheduling, compliance); an
executor owns the actual send for the channel(s) it's assigned.

## Execution modes

Each channel is executed by **exactly one** worker:

- **Built-in (default).** The CRM's dispatcher sends the step itself through its own
  compliance gate + provider adapters. This is today's behavior for every channel.
- **External.** List the channel in `SEQUENCE_EXTERNAL_CHANNELS` (comma-separated,
  e.g. `whatsapp,linkedin`). The built-in dispatcher then **skips** that channel and
  leaves its jobs in the queue for an executor to claim. No double-send: the built-in
  dispatcher excludes external channels; the job API only hands out the requested one.

## Auth & tenancy

All endpoints are under `/api/crm` behind the standard internal auth:
`X-Internal-Key: <key>` + `X-Company-Id: <company>`. An executor acts for one
company at a time; claims are scoped to that company. A key bound to a company set
(`INTERNAL_API_KEYS`) may only claim for companies in its set.

## The loop

```
loop forever:
  POST /api/crm/sequences/jobs/claim   { channel, limit }      → { jobs: [...] }
  for each job:
     send it on <channel> using job.message + job.contact
     POST /api/crm/sequences/jobs/{job_id}/result  { status, provider_message_id?, error? }
  sleep(poll_interval)
```

### 1. Claim due jobs — `POST /api/crm/sequences/jobs/claim`

Request: `{ "channel": "whatsapp", "limit": 10 }` (`limit` ≤ 50, default 10).

Atomically claims up to `limit` **due** (`run_at ≤ now`) pending jobs for that
channel and marks them in-flight (`status = 'claimed'`). Concurrent claimers never
receive the same job (`FOR UPDATE SKIP LOCKED`). A claimed job that is never acked
is returned to the queue after 15 min (stale-claim reaper), so **treat delivery as
at-least-once** and dedupe on `job_id` if your send isn't idempotent.

Response:

```json
{ "jobs": [
  {
    "job_id": "uuid",
    "channel": "whatsapp",
    "step_order": 2,
    "run_at": "2026-08-10T05:39:58Z",
    "attempts": 0,
    "contact": { "id": "uuid", "name": "...", "email": "...", "phone": "+1…",
                 "wa_id": "…", "destination_country": "US" },
    "message": { "body": "Hi {{1}}", "subject": null, "template_id": "uuid|null",
                 "category": "marketing", "template_variables": { "1": "Alex" } }
  }
] }
```

`template_id` (when set) references an **approved** template — required for
out-of-window WhatsApp / India SMS. Honor the recipient's country compliance; the
CRM's suppression/consent record is authoritative (query `/api/crm/compliance`).

### 2. Report the result — `POST /api/crm/sequences/jobs/{job_id}/result`

Request: `{ "status": "sent", "provider_message_id": "SMxx…", "error": null }`.

`status` ∈ `sent | delivered | failed | skipped` (`delivered`→treated as `sent`).
Any terminal status **advances the enrollment** to the next step and schedules it,
so one un-sendable step never freezes a contact. `404` if the `job_id` isn't the
caller's. Report exactly once per claimed job.

## Reporting engagement back (already-existing surfaces)

Independent of the job loop, engines post outcomes through the stable CRM API so the
pipeline/score/inbox stay in sync (see `docs/API_CONTRACT.md`):

- Inbound reply → `POST /api/crm/conversations/{id}/messages` `{ direction: "inbound", … }`
  (dedupes on `provider_message_id`; auto-advances marketing stage; exits stop-on-reply
  sequences).
- Campaign metrics → `POST /api/crm/campaign-events` (`send|open|click|reply|mql|…`).
- Stage moves → `POST /api/crm/contacts/{id}/advance` `{ pipeline_key, stage }`.

## Reference executor

`scripts/reference-executor.mjs` is a minimal, dependency-free implementation of the
loop above (claims, no-op "sends", acks `sent`). Run it against a local CRM:

```
CRM_API_BASE=http://127.0.0.1:3100 INTERNAL_API_KEY=<key> COMPANY=tantra \
  CHANNEL=whatsapp node scripts/reference-executor.mjs
```

(with the CRM started under `SEQUENCE_EXTERNAL_CHANNELS=whatsapp` so the built-in
dispatcher leaves whatsapp jobs for it).
