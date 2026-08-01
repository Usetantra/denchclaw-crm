# CP-Z — a job can be claimed on a channel nothing can send

**Low severity, general fix.** Found during the goal-conformance re-audit.

    step create on ai_call:      HTTP 201     ← accepted
    claim door hands out:        1 job        ← handed to a worker
    job state after claim:       status=claimed   ← stranded; no executor exists

`ai_call` is accepted by five whitelists (`routes/sequences.js:17`, `routes/templates.js:21`,
`routes/marketing.js:97`, `db/models/inbox.js:36`, `lib/marketing-events.js:81`) but
`lib/executors.js` wires only Resend, Twilio and Unipile. The operator's GOALS.md never asks for
AI calls, so **nothing here is a goal failure** — this is the CP-Y shape again: accepted at the
front door with nothing behind it.

## Fix — general, not a special case

Do **not** hardcode `ai_call`. Derive the sendable set from the executor registry so this cannot
recur when someone adds a channel later:

1. Export the set of channels `executors.js` can actually build an executor for.
2. **Claim door** (`claimJobs`): refuse to hand out a job whose channel has no executor, and leave
   it `pending` rather than consuming it — the same treatment the LinkedIn gate already gives an
   unsendable job.
3. **Front door**: reject a sequence step / template on a channel with no executor at creation
   time (422 with a message naming the channel), so an operator is told immediately rather than
   discovering it as a silently stuck queue.
4. Decide `ai_call` explicitly: either drop it from the whitelists until a provider exists, or
   leave it listed and let (2)+(3) refuse it. **State which you chose and why in the receipt** —
   I don't want this resolved by deletion without a note.

## Acceptance criteria

- Z1 a job queued on a channel with no executor is **not** claimed, and stays `pending`.
- Z2 creating a step on such a channel is refused at the front door with a clear message.
- Z3 **POSITIVE CONTROL** — email, sms, whatsapp and linkedin all still claim and send normally.
  A fix that narrows the sendable set too far would pass Z1/Z2 and break the product.
- Z4 the sendable set is derived from the executor registry, not a second hand-maintained list
  that can drift from it.
- Z5 full suite green.

Repro: `scratchpad/orch-aicall-probe.mjs`. Receipt to `.loop/receipts/CP-Z-channel-without-executor.md`.
