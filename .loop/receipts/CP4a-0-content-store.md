# RECEIPT CP4a-0-content-store (cycle 4)

**Status: DONE.** Commit `a29e18d` on `feat/consolidation`, on top of CP-I `b97b7c5`.
13 files, +944/−25. Not pushed, not deployed. Nothing from `scratchpad/`; roadmap left unstaged.

**Your audit's blocking finding is closed: there is now something to send.**

## What it does

| File | Why |
|---|---|
| `migrations/021_message_content.sql` **(NEW)** | `message_templates` (tenant-scoped, UNIQUE(company_id, ref), NOT NULL body) + inline `sequence_steps.subject/body` + **a backfill** + the readiness index. |
| `server/db/models/templates.js` **(NEW)** | CRUD, resolution, precedence, the payload freeze, readiness. Precedence lives here and nowhere else. |
| `server/routes/templates.js` **(NEW)** | Authoring surface + `POST /preview` (renders against a real contact, sends nothing). |
| `server/db/models/sequences.js` | Both `scheduled_actions` writers now freeze resolved content into `payload`; `addStep` carries inline content. |
| `server/db/models/dispatch.js` | **The enforcement point** — the claim door refuses a job with no content. |
| `server/routes/sequences.js` | `GET /sequences/:id/content` — "is this safe to switch on?" |
| `server/routes/inbox.js` | Templates tab reads real content (closes CP-I **F17**). |

**The contract, now true in code rather than in comments:** a queued job either carries resolved
content, or it is explicitly flagged as carrying none. No third state; no path where `""` is a message.

## Eval criteria (C1–C14, mine — there was no ticket file)

**69 new checks, all passing.** C1 migration idempotent (3×) + a blank body refused by the DB itself
+ pre-existing rows untouched · C2 tenant-scoped, cross-tenant 404, blank body 400, upsert-not-duplicate ·
C3 inline beats template, subject follows its body's source · C4 tokens resolve per-contact, and the
same step resolves differently for a different contact · **C5 the payload is no longer empty** —
`content_resolved:true`, non-blank body, subject present, tokens substituted · C6 unresolvable copy
does not block enrolment, is flagged, carries `body:null` (never `""`), names the missing ref, and
another tenant's template does **not** resolve · C7 the **claim response itself** carries the body,
and the ack-materialised next step does too · C8 `scheduleAction` freezes content and **a caller
cannot forge a body** · C9 readiness: sendable true/false, names the offending step, zero-step
sequence not sendable, cross-tenant 404 · C10 blocking rules · **C13 the claim door refuses a
content-less job, leaves it PENDING, and the same job flows once the copy is authored** ·
**C14 a row with no `content_resolved` key at all is not claimable, and 021 backfills it.**

## Tests
**677 passed / 0 failed** on a fresh DB (608 prior + 69 new). Migration 021 applies **three times** clean.
```bash
node scratchpad/reset-db.mjs && DATABASE_URL_TEST=postgres://denchclaw@127.0.0.1:54339/denchclaw_test node scratchpad/apply-sql.mjs && bash scratchpad/run-suite.sh
```

## Critic — Fable 5. It was right about the thing that mattered.

Its verdict on my first cut: **"the contract has zero enforcement in code."** Correct. I had
established it everywhere except where it was enforced. Fixed:

1. **HIGH — legacy rows were a third state.** Every pre-021 row had **no `content_resolved` key**;
   an executor written as `=== false` sees `undefined` and **sends**, while the readiness index
   (matching literal `'false'`) reports nothing wrong. `ON CONFLICT DO NOTHING` meant they'd never
   be upgraded. **021 now backfills them.** (C14)
2. **HIGH — `claimJobs` served blank jobs.** Refusal lived only in comments and in an executor
   nobody had written. **The claim door now refuses**, with `COALESCE(..., false)` so absent reads
   as unsafe. Left **PENDING**, not skipped — a skipped ack advances the ladder, and mass-skipping
   missing copy would fire "step 2" at people who never got step 1. (C13)
3. **HIGH — `content_resolved:true` with a literal `{first_name}`.** Detected, warned, and sent
   anyway. **Now blocking**, along with a missing or whitespace-only email subject. (C10)
4. Fixed too: the `btrim` CHECK stripped spaces but not `\n\t`; callers could forge
   `content_error`; `deleteTemplate` didn't trim its ref.

**Accepted, documented:** deleting a template referenced by an active sequence silently stalls that
rung (**F20**); the inbox templates endpoint is N+1 (**F21**); deploying code before applying 021
breaks enrolments — the standing migrations-before-restart hazard.

## Pre-existing tests I modified — declared, per your rule

- **`test/unit-b3-dispatcher.mjs` — a latent time bomb, not my change.** Its quiet-hours fixture set
  `start: 0, end: (nowHour + 1) % 24`; at **23:00–00:00 UTC** those are equal and migration 016's
  `chk_..._quiet_hours_distinct` rejects the row, crashing the suite. **It has done this for one hour
  every day since B3 landed, and it went off during this session.** Window is now
  `[nowHour, nowHour+1)` — never equal, still covers "now", wrap handled.
- **`unit-b3`, `unit-cp2`, `unit-cpi` fixtures now supply content** (one helper each). A step with
  nothing to send is deliberately no longer claimable, so fixtures written before the content store
  must provide copy — exactly as real usage must. No assertion was weakened.
- **`unit-cpi` I12i** now authors a real template and clears the inline body, because inline
  deliberately wins. Its template uses only `{first_name}`: that contact has no `company_name`, and
  copy that would ship a literal `{company}` is now refused.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

**Assert content, not status** — that was the failure mode on CP4a rev 1.

| Probe | Expect |
|---|---|
| `POST /api/crm/templates {ref:'t1',channel:'email',subject:'Hi {first_name}',body:'Hello {first_name}.'}` | 201 |
| `POST /api/crm/templates {ref:'x',body:'   '}` | **400** |
| `GET /api/crm/templates/t1` as another tenant | **404** |
| Enrol a contact into a step using `t1`, then read `scheduled_actions.payload` | `content_resolved:true`, **real body with the name substituted**, non-null subject |
| Same with a step whose `template_ref` matches nothing | `content_resolved:false`, **`body:null`**, `content_error` naming the ref |
| `POST /channel-jobs/claim` with that unresolved job due | the job is **absent**, and stays **`pending`** (not `skipped`) |
| Author the missing template, re-schedule, claim again | the **same job** appears, carrying the real body |
| `GET /sequences/:id/content` | `sendable` true/false + per-step reasons |
| A template whose body needs `{company}` + a contact with none | `resolved:false` — never "About {company}." |

**What "working" looks like:** the CRM refuses to hand an executor anything it cannot send, and says
exactly why, instead of quietly mailing a blank.

**Not visible in the UI:** all of it — there is no template authoring UI yet (**F22**). Inspect via
the API and `scheduled_actions.payload`. The claim-door refusal is only observable as an absence
from the claim response plus the row staying `pending`.

## Gate hit
**None.** No deploy, no push, no live DDL, no provider key in testing — the runners now blank
`RESEND_API_KEY`/`CLOUDFLARE_AI_TOKEN`, so no test can make a real send. `:3101` released;
`denchclaw_test` untouched (used `denchclaw_build_cpi`). **Next unused migration is 022.**

## Next
**CP4a rev 2 (executor)** is now unblocked. Your five surviving HIGHs are the spec I will build to:
no-timeout duplicate sends, the unimplementable idempotency marker, the staleness guard measuring
from `scheduled_for`, the shared `claimed_by`, and the key-without-sender path that dead-letters
into terminal `exited` and shreds every active ladder. Note CP4a-0 already softens the last one:
a job with no resolvable content is never handed out at all, so it cannot burn retries.

## Follow-ups
**F20** deleting an in-use template silently stalls a rung · **F21** inbox templates endpoint is N+1 ·
**F22** no template authoring UI · **F15/F16** carried from CP-I · **F19** `trust proxy` allowlist bypass.

---

# ADDENDUM — legacy queue + the two channel decisions (commit `4e47245`)

Both of your follow-ups. Suite now **690** (608 prior + **82** CP4a-0).

## The legacy queue — already handled, now PROVEN

All three asks shipped in `a29e18d`; what was missing was the criterion that stops them regressing.
Verified two ways.

**Out-of-band, in the real-world order** — applied `migrate.sql` + 002–020, created a job in exactly
the shape you describe (`pending`, DUE, `payload='{}'`), held **021 back until after** the row
existed, then applied it:

| Moment | Observed |
|---|---|
| Before 021 | `payload = {}`, **no `content_resolved` key** — the third state |
| After 021 | `content_resolved=false`, `body=null`, reason: *"queued before the message content store existed (migration 021); re-schedule this step to resolve its copy"* |
| Executor claims (job is DUE) | **0 jobs handed over** |
| Row afterwards | still **`pending`** — not `skipped`, so the ladder is not advanced past a step nobody received |
| `GET /sequences/:id/content` | `sendable=false`, names the ref that resolves to nothing — **without touching a sender** |

**In-suite as C15**, so it is checked on every run. Your three points map to:

1. `resolveStepContent` has a **defined** content-less outcome — `resolved:false`, `body:null`
   (never `""`), a string `reason` naming the ref. Not an exception the executor must guess about.
2. **No third state, including pre-021 rows** — the migration backfills them, *and* the claim door's
   `COALESCE(..., false)` treats "absent" as unsafe even if the backfill were skipped. Two
   independent guards, not one.
3. **Identifiable as content-less without calling the sender** — via `resolveStepContent`, the
   payload flag, the claim-door omission, and readiness. Four ways, no provider involved.

## The two decisions

- **`message_templates.channel` NULL = ANY CHANNEL.** Copy that is not channel-specific. A non-NULL
  value pins the template to that channel. Now stated in the migration and in the model rather than
  left to be inferred. C16 proves one NULL-channel template used on both email and WhatsApp.
- **Step/template channel mismatch is a CONFIG-TIME 400**, following CP2's `stage_writeback`
  precedent. Two deliberate boundaries: a ref that does not resolve **yet** is **not** an error —
  copy is routinely authored after the ladder is laid out, and readiness reports that gap instead —
  and resolution does **not** re-check the pin, because by then the job is queued and refusing would
  strand a contact mid-ladder for a config mistake.

**Migration 022 left clear** for CP4a rev 2's send-attempt marker: no column was added to
`scheduled_actions`, and the expiry-reclaim `UPDATE` in `dispatch.js` is untouched.

## Test brief delta

Add to the probes above:

| Probe | Expect |
|---|---|
| Build a job with `payload='{}'` and `scheduled_for` in the past, then claim | **0 jobs**, row still **`pending`** |
| `POST /sequences/:id/steps` `{channel:'email', template_ref:<sms-pinned>}` | **400** naming both channels |
| Same with `{channel:'sms'}` | **201** |
| Same with a NULL-channel template, on any channel | **201** |
| `POST /sequences/:id/steps` with a ref that does not exist yet | **201** — not an error; readiness reports it |
