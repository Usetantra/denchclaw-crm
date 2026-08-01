# CP-Z — verdict: **ACCEPTED**

Verified independently at `62ac44a` on a virgin DB from HEAD.

## 10 passed / 0 failed

| # | Check | Result |
|---|---|---|
| Z1 | an `ai_call` job is **not claimed** and stays `pending` (not consumed) | PASS |
| Z1b | …and the refusal **does not burn a retry** — `attempt` still at its column default | PASS |
| Z2 | creating an `ai_call` step is refused at the **front door**, 422, naming the channel and listing `sendable_channels` | PASS |
| Z3 | **POSITIVE CONTROL** — email, sms, whatsapp **and linkedin** all still claim normally | PASS ×4 |
| Z4 | the sendable set is **derived** — `Object.keys(byChannel)`, and `canSend('ai_call')` is false | PASS |
| R1 | an `ai_call` that happened **out of band** is still recordable on the timeline | PASS |
| R2 | listing templates by `ai_call` still works — listing is not queuing | PASS |

**Z1b is mine, beyond the ticket.** If a refused claim had incremented `attempt`, a job that was
never even attempted would climb toward `MAX_ATTEMPTS` and dead-letter itself — a slow failure
that would look like a delivery problem rather than a configuration one. It doesn't.

**Z4 is what stops this recurring.** `CHANNELS = Object.keys(byChannel)` cannot drift from what
exists; adding a provider adapter is the only way to make a channel sendable. There is
deliberately no second list to update and forget — which is exactly how `ai_call` got into five
whitelists in the first place.

## The builder improved on the ticket

I offered two options for `ai_call`: drop it from the whitelists, or leave it and refuse. They
took neither, and were right to: **sendable is not the same question as recordable.** An AI call
that happened out of band is a real event worth logging, so inbox and marketing-event ingestion
still accept `ai_call`; what the CRM will no longer do is *queue one to be sent*. I verified both
directions (R1, R2) rather than just the refusal — a fix that had also blocked recording would
have passed every criterion I wrote and quietly removed a capability.

The refusal is also loud in the right place:

    [CRM][dispatch] refusing to claim 'ai_call' jobs — no executor exists for that channel
                    (have: email, sms, whatsapp, linkedin)

## Full suite: 1102 passed / 0 failed, 19/19 suites reported

## Two probe defects of mine, both refusals for the wrong reason

1. My LinkedIn positive control failed twice before I got it honest. First the fixture had no
   `linkedin_accounts` row, so the **CP-C2 safety spine** refused it — correct behaviour I had
   myself verified a few ticks earlier. Then the step had no `linkedin_action`, which defaults to
   `message` and requires connection evidence (CP-C2's L-7 — a lesson already in my own notes).
   Both times the refusal was real but had nothing to do with CP-Z. **A control that fails for the
   wrong reason is worse than no control**: it would have sent the builder chasing a regression
   that did not exist.
2. The DB rebuild failed silently mid-run because the server still held a connection; the probe
   then ran against stale state. Now terminates backends first.

**Verdict: accepted.**
