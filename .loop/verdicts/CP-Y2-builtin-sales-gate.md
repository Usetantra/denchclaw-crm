# CP-Y2 — verdict: **ACCEPTED**

Verified independently at `f899c2d` on a virgin DB from HEAD, over HTTP. Because this defect
class had already survived two fixes, I did not re-test only the two paths I reported — I swept
every deal write path in the router.

## 8 passed / 0 failed

| # | Check | Result |
|---|---|---|
| B0 | POSITIVE CONTROL — a built-in sales deal exists at `onboarding` | PASS |
| B1 | PATCH automated → `won` on a **NULL-pipeline_key** deal → 403 `manual_stage` | PASS |
| B1b | …and the deal did NOT move | PASS |
| B2 | `POST /deals` creating directly at `won` with `automated:true` → 403 | PASS |
| B3 | **POSITIVE CONTROL** — automated PATCH to a declared-`auto` stage still applies (200, moved) | PASS |
| B4 | a HUMAN PATCH to `won` still 200 and moves the deal | PASS |
| S1 | create at `won` via an **explicit** `pipeline_key` also refused | PASS |
| S2 | a **re-key + manual stage in one automated PATCH** refused, deal unmoved | PASS |

S1 and S2 are mine, beyond the ticket: the previous fix failed precisely because one arm of a
branch was left open, so "the arm I reported is closed" was never going to be sufficient evidence.

**B3 is the one worth naming.** Last round my P5 "positive control" passed only because that path
was *ungated* — it asserted nothing. Now that the gate exists, B3 tests it for real for the first
time, and an automated write to an `auto` stage still works. The fix gates robots without
crippling automation.

## Full suite: 1071 passed / 0 failed, 19/19 suites reported

## New finding — `automated` coercion fails OPEN (dispatched as CP-Y3)

    PATCH /deals/:id {stage:'won', automated:"true"}  →  200, deal moved to `won`

All three gate sites read `req.body.automated === true` (crm.js:750, 950, 1116), so the **string**
`"true"` is not `true` and the caller is treated as a **human**. This is the same fail-open shape
as CP-Y itself: an unexpected value opens the gate instead of closing it.

**Severity: hardening, not a live break.** Every in-repo caller sends a real boolean (checked;
`inbox.js:299` is `r.source === 'sequence'`). It matters because the internal API is called over
HTTP by the outreach and nurturing engines, and a loosely-typed or form-encoded client sending
`"true"` would silently acquire human authority. Dispatched as CP-Y3 rather than folded in here —
CP-Y2 met every criterion it was given.

**Verdict: accepted.** Every deal write path now refuses automation into a manual stage, and
automation into an `auto` stage still works.
