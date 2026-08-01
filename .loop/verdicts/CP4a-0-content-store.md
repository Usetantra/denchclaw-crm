# VERDICT — CP4a-0-content-store → **PASS**

**Commit:** `a29e18d` · **Receipt:** `.loop/receipts/CP4a-0-content-store.md`
**Verified by:** orchestrator/tester, 2026-08-01, independently · **Evidence:** `.loop/EVIDENCE/CP4a-0/`

## Why this checkpoint existed
CP4a rev 1 was withdrawn because **there was nothing to send**: `payload` was `'{}'::jsonb`,
`sequence_steps` carried only `template_ref TEXT`, and no subject or body existed anywhere in the
schema. CP4a-0 had to make that false before any executor could be built.

## What I verified myself

| Check | Result | Evidence |
|---|---|---|
| Full suite, my own rebuilt DB | **690 passed / 0 failed** | **Higher than the receipt's 677** — the builder kept hardening after writing it (`unit-cpi4a0` is 82, not 69). Nothing pre-existing regressed. |
| Migration 021 applies 2nd **and** 3rd time | **PASS** | Both clean; `message_templates` present; `sequence_steps` gained `subject`,`body`. |
| **The claim door refuses a job with NO `content_resolved` key** (the pre-021 shape) | **PASS** | Reproduced the legacy shape by stripping the key; the job was **not served**. `COALESCE(...,false)` makes "absent" read as unsafe. |
| …and leaves it **PENDING, not skipped** | **PASS** | Correct, and the reasoning is CP2's: a `skipped` ack **advances** the ladder, so mass-skipping missing copy would fire "step 2" at people who never received step 1. |
| Explicit `content_resolved:false` refused | **PASS** | Not claimable, stays pending. |
| **Positive control** — a content-carrying job IS claimable | **PASS** | Proves the guard is not over-aggressive. |
| …and the claimed job **carries the copy** | **PASS** | Payload served: `{"body":"Real body, no tokens left.","subject":"Real subject","content_resolved":true}` — an executor reads one row and never reaches around the contract. |
| Whole-queue sweep | **PASS** | Across 63 content-less due rows, **zero** were served. |
| Unresolved tokens blocked | **PASS** | Tested through the **real** `resolveStepContent` path: `{company}` unsatisfiable → `resolved:false` with a precise reason; satisfiable → `"Hi Ada at Acme."`; whitespace-only email subject → blocked ("the provider would substitute (no subject)"); chat channel with no subject → correctly **allowed**. |

## The builder's own critic pass — verified, not taken on trust
Its receipt reports three HIGHs it found and fixed in its first cut, and the shipped code matches:
legacy rows were a **third state** (`undefined` ≠ `false`, so an executor checking `=== false`
would send) and 021 now backfills them; `claimJobs` was serving blank jobs because refusal lived
only in comments; and `content_resolved:true` could still carry a literal token. All three are
closed in the code I probed.

## Anomalies — **all three were mine**, traced before being reported
1. A "guard too aggressive" failure: my probe picked a row whose enrollment was `completed`, whose
   sequence was `paused`, and which wasn't the current step — correctly unclaimable for three CP2
   reasons unrelated to content.
2. The same failure again after a partial fix: my `ELIGIBLE` query **never filtered `company_id`**,
   so I picked another tenant's job and claimed as `tantra`. That returning nothing is **tenancy
   working correctly**.
3. A "token not blocked" failure: I hand-forged `content_resolved:true` **with** tokens via raw
   SQL — a state no code path can produce, because `resolveStepContent` returns `resolved:false`
   first. My assumption that the *claim door* re-checks tokens was mine, not the ticket's.

## Follow-up (hardening, not a defect)
**F-CP4a0-1** — the claim door trusts `content_resolved` without re-validating tokens. Unreachable
today since resolution is the only writer, but a belt-and-braces token check at the door would
make the contract self-enforcing even if a future writer misbehaves. Cheap; worth doing when
CP4a rev 2 touches this query.

## Verdict
**PASS.** The blocking finding that killed CP4a rev 1 is closed: there is now something to send,
and — more importantly — **a job with nothing to send cannot be handed to an executor at all**.
CP4a rev 2 is unblocked. Next unused migration is **022**.
