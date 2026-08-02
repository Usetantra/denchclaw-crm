# Channel-executor contract (GOAL B4)

Machine-readable spec: [`channel-executor.openapi.yaml`](./channel-executor.openapi.yaml).
Runnable reference: [`examples/stub-executor.mjs`](../../examples/stub-executor.mjs) +
[`examples/mock-channel-jobs-server.mjs`](../../examples/mock-channel-jobs-server.mjs).

## What this is

The interface each engine (outreach, nurturing, content, personalization)
implements to consume channel jobs from the CRM and post results back. It is
the **pull side** of GOAL B: the CRM's always-on dispatcher (B3) will enqueue
rows into `scheduled_actions` (B1) as pipeline stages trigger sequence steps;
an engine's executor polls `POST /channel-jobs/claim` for its channel(s),
does the send/call, and reports the outcome via `POST /channel-jobs/:id/ack`.

This mirrors the existing `prospect_inbox` claim/complete pattern
(`docs/API_CONTRACT.md` § Prospect inbox) rather than inventing a new idiom —
same atomic-claim-under-concurrency guarantee, same idempotency posture.

## Why contract-first, before B1/B3 exist

B1 (data model) and B3 (dispatcher) are sequenced after this on the roadmap
precisely so every engine integration (B6) can be scoped against a stable
target instead of a moving one. Publishing the OpenAPI file now, plus a
runnable stub that proves the pull → process → ack loop is internally
consistent, means B1/B3 have an acceptance shape to build to and B6 recon
reports can assess each engine against a fixed interface.

## Key decisions worth flagging

- **Claim is channel-scoped, not sequence-scoped.** An executor asks for
  `channel: "email"` and gets a mixed batch across sequences/contacts — this
  matches how engines are organized today (one engine per channel-ish
  concern), not one engine per sequence.
- **Ack ownership is enforced.** `AckRequest.claimed_by` must match whoever
  won the `/claim` call for that job; a mismatch (or acking a never-claimed
  job) is a 404, not a 403 — no existence disclosure to a caller that didn't
  win the claim. Without this, any executor that learns a `job_id` could ack
  a job it never processed.
- **Claims expire.** A job stuck in `claimed` past `CLAIM_TIMEOUT_MS` (mock
  default 300s) becomes reclaimable by any executor — a crashed executor
  instance can't permanently strand a job. `prospect_inbox`
  (`docs/API_CONTRACT.md`) does not have this today; this is a deliberate
  improvement on that pattern, not an inherited guarantee.
- **`retry` on a `failed` ack tells the executor what happens next.**
  `will_retry` / `next_attempt_at` / `attempt` / `max_attempts` are returned
  so the executor never has to guess whether it should expect the job again.
  Retry/backoff/dead-letter policy itself still lives in the dispatcher (B3),
  not the executor — this keeps it centralized instead of duplicated per
  engine (also why "a channel failure must not stall the pipeline" from the
  B3 roadmap line is achievable at all).
- **`campaign_event` on ack is optional, not automatic.** Only sends that are
  part of a tracked campaign roll up; a one-off `stage_change`-triggered
  message may just leave a `contact_activity` with no campaign attribution.
- **Ack idempotency covers terminal outcomes: `sent`, `skipped`, and a
  `failed` that dead-letters (`will_retry: false`).** Replaying any of these
  is a no-op returning the same response; a *different* terminal status for
  the same job is rejected (409).
  **Known gap:** a `failed` ack that triggers a **retry** (`will_retry: true`)
  is NOT idempotent against a duplicate ack call — requeuing clears
  `claimed_by`/bumps `attempt`, so a retried HTTP call reporting that same
  outcome can no longer match on ownership (it 404s, or lands against a
  different attempt if someone else already reclaimed it). Solving this
  properly needs a per-attempt idempotency key on the ack call itself;
  deferred to B3, called out here rather than silently shipped as a latent
  bug.

## Verifying the contract (this iteration's proof, not a live integration)

`examples/mock-channel-jobs-server.mjs` is a minimal in-memory Express app
implementing this OpenAPI file's claim/ack **semantics** (ownership checks,
idempotency, claim-timeout reclaim, retry signaling) — it does not implement
the auth layers (`X-Internal-Key`/`X-Company-Id`) or field-level validation
the real CRM routes will have; those already exist elsewhere in this repo and
aren't what B4 is proving. Its in-memory claim loop is single-threaded JS, so
it proves the **state machine** is internally consistent; it is NOT evidence
that a real Postgres implementation is concurrency-safe under simultaneous
connections — that requires a single atomic
`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`
transaction (a naive SELECT-then-UPDATE under READ COMMITTED can double-claim
even though this mock never will).

`examples/stub-executor.mjs` is what an engine's executor loop looks like:
claim → "process" → ack, on an interval. `npm run verify:channel-contract`
boots the mock server and asserts:

- every seeded job across two channels is claimed by the right channel filter,
  by exact job-id identity (not just a count) — two stub executors race the
  same mock server for a shared pool, and both are asserted to have actually
  claimed a non-empty share (weeds out the vacuous case where one executor
  wins the entire pool before the other's request lands),
- no job is claimed twice concurrently,
- a `sent` ack is idempotent (double-ack returns the same 200, no duplicate
  side effect),
- a `failed` ack followed by a `sent` ack for the same job_id is rejected
  (409), proving the conflicting-terminal-status guard behaves as specified,
- an ack with a `claimed_by` that didn't win the claim is rejected (404) —
  the ownership-spoofing guard,
- a claim older than `CLAIM_TIMEOUT_MS` becomes reclaimable by a different
  executor,
- a `failed` ack's response carries `retry.will_retry` so the executor is
  never left guessing the outcome.

This is a contract self-test, not a live CRM/engine integration — that's B3
(dispatcher) wiring the real routes to `scheduled_actions`, and B6 (per-engine
recon + rewire) hooking up each real engine.
