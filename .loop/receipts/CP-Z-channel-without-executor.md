# RECEIPT CP-Z-channel-without-executor (cycle 13)

**Status: DONE.** Commit ``62ac44a`` on `feat/consolidation`. 5 files, +136/−1. **No migration** — 027
still free. **Suite 1096 / 0** — `unit-cpy` now **66** (11 new).

## The `ai_call` decision, which you asked me to state rather than resolve by deletion

**It stays in the whitelists.** Deleting it would have been the tidier-looking fix and the wrong one,
because **sendable and recordable are different questions** and only one of them was broken.

An AI call that happened out of band is a real event that belongs on a contact's timeline. The
inbox (`db/models/inbox.js`) and marketing-event ingestion (`lib/marketing-events.js`,
`routes/marketing.js`) accept `ai_call` for exactly that, and dropping it would have deleted the
ability to *record* something that genuinely occurs in order to fix a problem about *queuing*
something that cannot.

So the two doors that mean **"queue outbound work"** refuse it — step creation and template
authoring — and the ones that mean **"record what happened"** are untouched. When a provider is
wired, one adapter in `executors.js` makes it sendable everywhere at once, and any jobs already
sitting in the queue drain on the next tick without intervention.

## The fix

**The sendable set is `Object.keys(byChannel)`** — the executor registry's own keys, exported as
`CHANNELS` with a `canSend(channel)` predicate. It cannot drift from what exists, because it *is*
what exists. Adding a provider adapter is the only way to make a channel sendable; there is
deliberately no second list to update and forget. **Z-1 asserts the derivation itself**, not just its
current contents.

**Claim door** — refuses before any other gate, and leaves the job **`pending`**, not skipped. That
follows the reasoning this file already gives about unresolved content: a skipped ack **advances the
ladder**, so mass-skipping would fire step 3 at people who never received step 2. The job consumes no
retry either, so wiring a provider drains the queue by itself.

**Front door** — 422 on creating a step, or copy pinned to such a channel. 422 rather than 400 is
deliberate: the channel is real and the request is well-formed; the CRM simply cannot act on it yet.
Both responses name the channel **and** list what is sendable, so the message is actionable rather
than merely correct. The template *GET filter* still accepts the full vocabulary — you may
legitimately want to list copy for a channel you cannot yet send on.

**One implementation note worth knowing if you touch this:** the registry is required **lazily inside
`claimJobs`**. `lib/executors → lib/channel-executor → db/models/dispatch` is a require cycle, so a
top-level require hands back a half-built export whose `canSend` is `undefined` — which would fail
open, silently, in the one place that must not.

## Acceptance

| | Result |
|---|---|
| **Z1** a job on an executor-less channel isn't claimed, stays `pending` | **PASS** (Z-4) — driven with a job that got into the queue *before* the front door existed, which is the population that actually matters; attempt unchanged |
| **Z2** creating such a step is refused with a clear message | **PASS** (Z-3), 422 naming the channel and the sendable set; template authoring too |
| **Z3** email/sms/whatsapp/linkedin all still claim and send | **PASS** — asserted twice on purpose: at the registry (Z-2) **and through the claim door** (Z-5), because a fix that narrowed the set too far would pass a registry check and still break the product |
| **Z4** the sendable set is derived, not hand-maintained | **PASS** (Z-1) — asserted as `CHANNELS === Object.keys(byChannel)`, so the *derivation* is pinned, not a snapshot of it |
| **Z5** suite green | **PASS**, 1096/0 |

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

`scratchpad/orch-aicall-probe.mjs` should now report 422 at creation and 0 claimed.

| Probe | Expect |
|---|---|
| `POST /sequences/:id/steps {channel:'ai_call'}` | **422**, body carries `channel` + `sendable_channels` |
| `POST /templates {channel:'ai_call'}` | **422** |
| `GET /templates?channel=ai_call` | **200** — listing is not queuing |
| an `ai_call` job already in the queue, made due | **0 claimed**, row stays `pending`, `attempt` unchanged |
| the four real channels, end to end | claim and send normally — the control that matters |
| recording an `ai_call` marketing event / inbound message | **still accepted** — this is the decision, not an oversight |
| `POST /sequences/:id/steps {channel:'carrier_pigeon'}` | **400** `invalid channel` — unknown vocabulary is still a different error from unsendable |

## Gate hit
**None.** No push, no deploy, no live DDL, no secrets. `CONSOLIDATION_ROADMAP.md` left unstaged,
`scratchpad/` not committed. Noted that `.loop/` is tracked now — `STATE.json` and this receipt are
staged deliberately with the code.

## Follow-ups
**F45** — the channel *vocabulary* is still restated in five places (`routes/sequences.js`,
`routes/templates.js`, `routes/marketing.js`, `db/models/inbox.js`, `lib/marketing-events.js`) plus
three SQL CHECK constraints. CP-Z derives the SENDABLE set from one source but leaves the vocabulary
duplicated, and those five lists agreeing today is luck. Worth one exported constant.
**F44** `DEFAULT_DEAL_STAGES` vs the seeded `sales` config · **F42** no-mode stages show no UI glyph ·
**F43** `sequences.pipeline_key` is free text.

## Next
Unchanged: **F38, the anchored scheduler** — a port of `nurturing-engine/.../dispatcher.py:160-204`.
`registrants`, `auto_registrants` and `attendees` trigger nothing until it lands.
