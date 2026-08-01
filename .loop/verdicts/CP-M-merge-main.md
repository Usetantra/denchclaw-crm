# VERDICT — CP-M-merge-main → **PASS**

**Ticket:** `.loop/tickets/CP-M-merge-main.md` rev 2 · **Receipt:** `.loop/receipts/CP-M-merge-main.md`
**Merge commit:** `a2045a7` — `origin/main` (9ff21cb) merged INTO `feat/consolidation` (82689ab)
**Verified by:** orchestrator/tester, 2026-08-01, independently of the builder
**Evidence:** `.loop/EVIDENCE/CP-M/`

The governing rule was **UNION, never selection**. The question this verdict answers is not "does it
build" but **"did either side lose a feature or a security check"**.

---

## Criterion-by-criterion

| # | Criterion | Result | Evidence I captured myself |
|---|---|---|---|
| **M1** | Merge commit exists, no conflict markers | **PASS** | Both parents present. `git grep -nE '^(<<<<<<<\|=======\|>>>>>>>)'` over the tree returns **nothing**. |
| **M2** | Full consolidation suite still passes | **PASS** | My own rebuilt DB: **471 passed / 0 failed** — contract 68, tenancy 15, tenants 12, sequences 38, b2 16, limits 34, b3 30, api-keys 16, a3 16, cp1 83, cp2 143. |
| **M3** | Merged `contract.mjs` ≥ the union of both sides | **PASS** | **66 → 68.** Main's two extra contract cases survived; this is the union, not just our side. |
| **M4** | Every migration applies in order on a fresh DB, twice | **PASS** | Fresh DB, full chain applied, then the migration set re-applied: **19/19 clean on the 2nd pass**. |
| **M5** | Each `main` feature alive by name | **PASS** | Resend sender, inbound webhook, inbox composer, Opportunities/analytics, contact-activity audit, engagement scoring — all present and exercised (M5a–c, M7, M13). |
| **M5a** | Inbound fails **closed** | **PASS** | Secret unset → **503** `{"error":"inbound webhook not configured"}`. Wrong secret → **401**. Missing header → **401**. |
| **M5b** | Recipient-derived tenant | **PASS** | Correct secret + mapped recipient → **200**, `company_id:"tantra"`, contact + conversation created on that tenant. |
| **M5c** | **GT-2** — inbound end-to-end under the branch's A3 auth | **PASS** | This was the merge's biggest hidden risk: `webhooks.js` self-calls with `x-internal-key` + a recipient-derived `x-company-id`, and the branch's `requireAuthAsync` ignores `X-Company-Id` for a DB-backed key. Proven behaviourally: the message landed on **tantra**, inbound/email, **not 401, not 403, not re-tenanted**. |
| **M6** | Each consolidation feature still works | **PASS** | A3 16/16, limits 34/34, b2 16/16, b3 30/30, cp1 83/83, cp2 143/143 — all green on the merged tree. Plus the golden journey below. |
| **M7** | Browser evidence for **both worlds in one session** | **PASS** | My own driver through my own shim: 8 tabs present — `pipelines`+`sequences` (consolidation) **and** `inbox`+`analytics`+`board` (main). All five render content. **0 console errors.** 5 PNGs in `.loop/EVIDENCE/CP-M/`. |
| **M8** | Critic pass on the merge diff, auth.js first | **PASS** | **FABLE 5 → PASS, no HIGH.** It traced every auth check to its **call path**, not just its definition: missing-key 401 (`:215`), DB-backed key resolution (`:226`→`:286`, ignoring `X-Company-Id`), ambiguous-binding 401 (`:254`), fail-closed-on-DB-error 401 (`:258`), unknown-key 401 (`:272`), **main's real CIDR allowlist called at `:277-280` ahead of BOTH `next()` sites** with the branch's prefix hack confirmed absent, DB canonicalization (`:290`), env key→company 403 (`:292`), `warnIfKeyUnboundInProduction` running as a load-time IIFE (`:120`), `requireAdmin` (`:313`), union exports (`:327`). It also proved `test/contract.mjs` and `web/index.html` are **empirically exact line-unions** (zero parent-added lines missing; check-name union 74 = 72 branch ∪ 54 main) and that nothing main shipped is dead. |
| **M9** | **GT-1** — CIDR math, proven behaviourally | **PASS** | With `INTERNAL_API_ALLOWED_CIDRS=192.168.1.5/32`: `192.168.1.5`→allowed, **`192.168.1.99`→REJECTED** (the branch's prefix hack would have admitted it — a /32 widened to a /24). Under the **DEFAULT** config: `127.0.0.1`→allowed, **`127.0.0.2`→REJECTED** (the critic's LOW-6 case). Main's `ipToBig`/`ipInCidr` present at `auth.js:141,177,193`; union exports at `:327`. |
| **M10** | All five mounts, probed as **real subroutes** | **PASS** | `POST /webhooks/email/inbound`→503, `GET /api/crm/tenants`→200, `/sequences`→200, `/api-keys`→400, `POST /api/crm/channel-jobs/claim`→**200**. See anomaly 1 — my first probe was wrong, not the code. |
| **M11** | `getByIdUnscoped` still gone | **PASS** | `git grep -c getByIdUnscoped -- server` → **0**. A1's tenancy fix was not resurrected by re-applying main's lines. |
| **M12** | `index.html` merged clean **and** works, baseline-relative | **PASS** | **Zero duplicate ids in the live DOM** across all five tabs. (Main ships source-level dupes inside mutually-exclusive composer template branches; the criterion is merge-created dupes, and there are none.) |
| **M13** | CP1 invariant **and** main's side-effects both fire | **PASS** | An auto `/advance` → 200, deal moved, `stage_change` activity written (CP1 authority) **and** main's audit row present. Scoring proven alive separately: a weighted `email_clicked` moved `lead_score_numeric` **0 → 5**, exactly its weight — so main's `addContactActivity → recordEngagement` delegation survived and the old score-resetting body is gone (`crm.js:20,1901`). |
| **M14** | No feature file lost | **PASS** | All 7 main-only files present (`email-resend.js`, `scoring.js`, `webhooks.js`, 4× `integrations/cloudflare-email/`). **All 10 main commits are ancestors of HEAD (10/10).** |

---

## The golden journey — the test that was missing

Every checkpoint so far was verified against its own criteria in isolation, and **nothing tested
the chain**, which is the product. `scratchpad/orch-golden-journey.mjs` now walks one real
operator path across every checkpoint at once. On the merged tree:

**7 passed, 0 failed, 4 skipped.**

- **L1–L6 pass** — human `/advance` → enrollment → step materialises → executor claims → ack(sent)
  advances the ladder → stage mirrors → **a manual stage is refused while the send still counts**.
- **L7–L10 skip** — "CP-I not built yet, `/inbox` returns 404". The machine half works end to end;
  the human-facing half does not exist yet. When CP-I lands this should read **11/0**.

---

## Anomalies — traced to root cause before being called defects

1. **`GET /api/crm/channel-jobs` → 404.** **My probe, not the code.** That router defines only
   `POST /claim` and `POST /:job_id/ack` (`channel-jobs.js:17,44`); it is mounted at
   `server.js:55`, and `POST /claim` returns **200**. This is exactly the trap the ticket's own
   M10 warned about — probe subroutes, not mount roots — and I walked into it.
2. **`lead_score_numeric` stayed 0 across a stage advance.** **Correct by design, not a MEDIUM-5
   regression.** `scoring.js:11` explicitly excludes `stage_change` from the weight table. Proven
   by posting a weighted event instead: score moved 0 → 5.

---

## 🚧 DEPLOY-BLOCKING HAZARD — found by M8, verified by me

**Deploying this merge to staging before applying migrations 012–019 will 401 the entire API.**
`server/middleware/auth.js:258-271` deliberately fails **closed** when the `tenant_api_keys`
collision check cannot run; `tenant_api_keys` is created by **migration 017**; and
`initDatabase` (`server/db/index.js`) does **not** run migrations. Staging is at **≤011**. So the
code would load, every env-key request would take the `dbCheckFailed` branch, and every caller
would get `401 Missing or invalid X-Internal-Key`.

**Mandatory deploy order, for the operator's runbook: apply DDL 012–019 FIRST, restart SECOND.**
Deploy remains a shut gate; this is what must be true before that gate is ever opened.

Two smaller operational notes from the same pass, both recorded rather than fixed:
`webhooks.js:17` self-calls with the literal `INTERNAL_API_KEY`, so an operator who configures
only `INTERNAL_API_KEYS` without that key will 401 inbound email; and `app.set('trust proxy', 1)`
(`server.js:29`) combined with `ipAllowed('')===true` means a proxy-injected
`X-Forwarded-For: 127.0.0.1` satisfies the allowlist — **pre-existing identically in base, main
and branch**, so out of merge scope, but it deserves its own ticket.

---

## Verdict

**PASS on all of M1–M14.**
Every one of the three risks the ticket was written around is closed *behaviourally*, not by
reading: **GT-1** the CIDR downgrade did not happen (M9, both configs); **GT-2** inbound email
still resolves its tenant from the recipient under the new auth (M5c); **GT-3** both mount blocks
survive (M10). The feature-loss the Fable critic caught in **my own rev-1 D4** did not occur —
B2's `enrollForTriggerStage` inbound hook survives at `server/routes/conversations.js:336`.

### On pushing to `main`

Push was pre-authorised **for the verified CP-M result**, and CP-M is now verified. **I am still
holding it**, for a reason the operator would want raised rather than assumed: the branch has
since advanced to **`b97b7c5` (CP-I)**, which is **not yet verified** — no browser pass, no
verdict. Pushing the branch now would ship unverified work to `main` under an authorisation that
was granted for something else. The push goes out once CP-I is verified, or immediately against
`a2045a7` alone if the operator wants CP-M on `main` now.

Deploy remains a shut gate regardless — and see the hazard above before it is ever opened.

**The two-pass critic policy earned its keep here in a way worth noting:** the critic's own
"NOT PROVEN" list says its verification was *static only* (it was barred from running servers),
while my pass was *behavioural* (471/0, live CIDR probes, live webhook probes, live scoring
delta). Neither pass alone would have covered this merge; together they do.
