# CP-Y3 — verdict: **ACCEPTED**

Verified independently at `ee9e4f1` on a virgin DB from HEAD, over HTTP.

## 15 passed / 0 failed

| # | Check | Result |
|---|---|---|
| C1 | `"true"`, `1`, `"TRUE"`, `" True "`, `"yes"`, `true` — **all six** treated as a ROBOT → 403, deal unmoved | PASS ×6 |
| C2 | `false`, `"false"`, `"0"`, `""` — explicit "no" → human, 200 | PASS ×4 |
| C3 | **POSITIVE CONTROL** — **no `automated` field at all** (what the UI sends) is still a HUMAN → 200 | PASS |
| C4 | a robot may still write a declared-`auto` stage (string flag now recognised) → 200 | PASS |
| S1 | the **CREATE** path coerces identically | PASS |
| S2 | the **`/advance`** path coerces identically → 403 `manual_stage` | PASS |
| S2b | **POSITIVE CONTROL** — the same advance with no flag is accepted → 200 | PASS |

C3 is the criterion that protects the product: the UI sends no `automated` field, so a coercion
that resolved "absent" to automated would have locked every real user out of their own board.
S2b exists because S2's 403 could otherwise have been a transition or entry refusal rather than
the coercion working — the paired positive control is what makes it evidence.

## Code audit

All three gate sites now call the shared helper (crm.js:750, 950, 1116); **no raw
`automated === true` comparison remains anywhere in `server/`.** The asymmetry is implemented
exactly as specified — absent ⇒ human, present-but-unrecognisable ⇒ automated.

The builder added a caveat I want on the record because it is correct and it limits what this
checkpoint claims: **the flag is not a security boundary.** It is self-declared and honour-system.
CP-Y3 makes it mean what it says for a well-behaved caller; it does not stop a caller that lies.
Anything stronger is identity work, not a coercion fix.

## Full suite: 1091 passed / 0 failed, 19/19 suites reported

## One probe defect of mine

S2 rev 1 got a 404 — `webinar_sales` is a **deal**-entity pipeline, so `/advance` needs an active
deal on it and my fixture never created one. A refusal for the wrong reason proves nothing about
coercion; fixed, and paired with S2b so it cannot silently regress into a vacuous pass.

**Verdict: accepted.** The three-checkpoint arc that began with a robot marking a $50,000 deal Won
is closed: the write-back path, every deal write path, and now the flag those gates read.
