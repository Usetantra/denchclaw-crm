# VERDICT — CP-C channel executors (SMS + WhatsApp) → **PASS**

**Commit:** `27a6c01` · **Receipt:** `.loop/receipts/CP-C-channel-executors.md`
**Verified by:** orchestrator/tester, 2026-08-01, independently · **Evidence:** `.loop/EVIDENCE/CP-C/`

## Scope, and the split
The builder split CP-C rather than doing all four channels at once — Twilio (SMS + WhatsApp) here,
**LinkedIn deferred**. That was pre-authorised by me and it is the right cut: one provider covers
two channels, and LinkedIn is the highest-risk because a mistake there gets an account restricted.

## WRAP, not rebuild — verified structurally
- `server/lib/email-executor.js` collapsed from ~370 lines to **32**. It is now a thin wrapper, not
  a fork. The shared logic lives in `channel-executor.js` (254 lines) with a per-channel registry in
  `executors.js`.
- **Every CP4a guarantee is present in the shared executor**: `send_started_at` (11 refs),
  `INSTANCE_ID` per-instance claim identity (9), `definitive`/`outcomeUnknown` split (4/2),
  `bootGate` (3), `content_resolved` (1).
- `twilio-send.js` carries a **`TWILIO_API_BASE` seam explicitly modelled on `RESEND_API_BASE`**,
  so the send path is testable without a real provider — the constraint I set up front.
- Per-channel enable flags (`EMAIL_/SMS_/WHATSAPP_EXECUTOR_ENABLED`), so switching one channel on
  never switches another on by accident.
- **No migration required** — the channel work reuses the existing `scheduled_actions` contract.
  Migration 024 is still free.

## The check that mattered: did the refactor break CP4a?
Re-ran my own no-double-send probe **against the generalised executor**: stub provider hanging 9s
with a 2s claim timeout so the claim expires **mid-send**, then a second instance ticks.
**4 passed / 0 failed** — `send_started_at` stamped before the provider call, the second instance
refused the in-flight job, **exactly one physical send** reached the provider for the contact under
test, and the job settled `sent`. CP4a's hardest-won guarantee survives being generalised.

## Suite
**812 passed / 0 failed** — and that number is only trustworthy because I fixed my own runner
first (see below). CP-C contributes 29.

## THREE FLAWS IN MY OWN TOOLING, FOUND THIS TICK
This is the honest headline of this verdict. None were in the build.
1. **My suite mirror was missing `unit-cpc-channels.mjs` entirely.** It reported "783/0" — a green
   number that had executed **zero CP-C tests**. I would have passed CP-C without testing it.
   Fixed, and I added a **DRIFT GUARD**: the mirror now diffs itself against `test/run-local.sh`
   and **aborts** if the real runner has a suite it does not. A verification tool that drifts from
   what it claims to verify is worse than no tool.
2. **My port-ownership guard fired correctly** — `run-suite.sh` aborted with ":3102 is serving
   someone else (our key is rejected)" because I had a stale server up. That guard exists because
   of the earlier 88-phantom-failure incident, and it just prevented a repeat.
3. **My no-double-send probe counted sends GLOBALLY.** With more than one eligible job in the
   queue, two ticks legitimately send two *different* people, and my probe read that as a double
   send — **twice**. Now scoped to the target contact's address. A false "double send" alarm is
   nearly as damaging as missing a real one.

## Not driven by me — stated, not glossed
- ~~An actual SMS/WhatsApp send through the Twilio stub~~ — **NOW DONE.** I stood up a stub Twilio
  on :8901 and drove real messages through `twilio-send.js`: SMS `+15550001111 → +15557654321`
  returned `{id:'SM00000001', providerStatus:'queued'}`, and WhatsApp went out carrying the required
  `whatsapp:` prefix on **both** ends (`whatsapp:+1555…` → `whatsapp:+1555…`), with the auth header
  present on both. `TWILIO_API_BASE` genuinely diverts the send — no real account was touched.
  Evidence: `.loop/EVIDENCE/CP-C/twilio-stub-sends.json`.
  Worth recording from the source comments: `twilio-send.js` notes Twilio has **no idempotency
  key**, so preventing a duplicate is entirely the CRM's job — which is exactly why the
  `send_started_at` reservation matters more here than it did for email.
- **LinkedIn** — deferred by the builder, correctly, and still owed. When it comes, the outreach
  engine's safety spine (kill-switch, allowlist, 07:00–18:00 IST window) must be REUSED, not
  reinvented.
- ~~Golden journey not re-run after `27a6c01`~~ — **NOW DONE: 12 passed / 0 failed / 0 skipped**,
  on a rebuilt DB with templates authored. The channel-executor generalisation did not disturb the
  full chain.

## Verdict
**PASS.** SMS and WhatsApp now send through the same executor as email, with no second sending
path, no duplicated guarantees, a stub seam per provider, and CP4a's no-double-send proven intact
after the generalisation.
