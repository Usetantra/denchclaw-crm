# TICKET CP-M-merge-main (cycle 1) — **rev 2** (post-critic)

> **Critic pass 1 of 2 — FABLE 5, lens = feature loss / security regression the criteria
> would not catch. VERDICT: FAIL on rev 1** — 1 HIGH + 4 MEDIUM + 4 LOW. All folded below and
> marked `[C:SEVERITY-n]`. The HIGH was a feature-loss instruction in **this ticket's own D4**,
> reproduced and confirmed by me against `git diff b7bd2ab feat/consolidation -- server/routes/conversations.js`.
> Pass 2 (different lens) runs on the merge diff before the verdict.

> **⚠ STEP ZERO — RE-MEASURE BEFORE YOU RESOLVE `[C:MEDIUM-2]`.** The GROUND TRUTH below was
> measured against `feat/consolidation = d8a314e`. **CP2 has since landed as `13a89c8`**
> (7 files, +1353/−39, and it touched `web/index.html` — one of the two files certified here as
> auto-merging). I re-ran the dry run against the new head: **still exactly the same 5 conflicts,
> and `contract.mjs` + `index.html` still auto-merge** — but the counts are now **10 behind / 12
> ahead**. Re-run `git merge-base`, `git rev-list --left-right --count`, and
> `git merge-tree --write-tree --name-only feat/consolidation origin/main` yourself immediately
> before resolving and record the numbers in the receipt. Do not inherit mine.

Authored by the orchestrator from `.loop/CP-M_DECISION.md`, which states verbatim:
*"This file **closes the CP-M gate**. The orchestrator may author the CP-M ticket from it
without asking again."* No further operator approval is needed to **spec** or **execute the
merge on `feat/consolidation`**. Pushing the result to `main` is pre-authorised (decision 7);
**deploying to staging is NOT and remains a shut gate.**

---

## GOAL

`feat/consolidation` is **10 behind / 11 ahead** of `origin/main`, and **`origin/main` is what
runs on staging**. Both sides carry real, shipped work. Reconcile them into one tree on the
feature branch **without losing a single feature from either side**.

Operator mandate, verbatim: *"Merge everything built so far into `main`. Avoid merge conflicts
where possible, but **absolutely do not waste any feature either side has spent time on.**"*

Therefore the governing rule of this checkpoint, above all others:

> **Conflict resolution is UNION, never selection. Every conflicting hunk keeps BOTH
> behaviours.**

**Banned outright:** `git merge -X ours` / `-X theirs`, `git checkout --ours|--theirs` on a
whole file, and "take the bigger side and move on". Each silently deletes shipped work.

---

## GROUND TRUTH (I measured every number below myself — do not re-derive)

Verified 2026-08-01 after `git fetch origin`, against `origin/main` = `9ff21cb`,
`feat/consolidation` = `d8a314e`:

- **merge-base `b7bd2ab`**; `git rev-list --left-right --count origin/main...feat/consolidation`
  → **`10  11`**.
- `git merge-tree --write-tree --name-only feat/consolidation origin/main` (real dry-run merge,
  working tree untouched) → **exactly 5 conflicted files**:
  `server/db/models/contacts.js`, `server/middleware/auth.js`, `server/routes/conversations.js`,
  `server/routes/crm.js`, `server/server.js`.
  **`test/contract.mjs` and `web/index.html` auto-merge** ("Auto-merging", no CONFLICT) despite
  being the highest-churn files.
- **7 files `origin/main` adds that the branch does not have at all** (they arrive clean, but
  see D6 — clean arrival is not the same as working):
  `server/routes/webhooks.js`, `server/lib/email-resend.js`, `server/lib/scoring.js`,
  `integrations/cloudflare-email/{worker.js,wrangler.toml,package.json,README.md}`.
- **Migrations do not collide.** `origin/main` tops out at 011; the branch owns 012–018 and CP2
  consumes 019. Nothing to renumber.

### The three findings that make this more than "just a merge"

These are semantic breaks that git will **not** flag. Two of them live in files that
**auto-merge cleanly**, which is precisely why they are dangerous.

**GT-1 — `ipAllowed` is the same name with two different implementations, and the branch's is
strictly weaker.** Both sides rewrote it from base, so it conflicts; "keep ours" silently
downgrades the IP allowlist.
- `origin/main:server/middleware/auth.js:91,127,140` — real CIDR math (`ipToBig`, `ipInCidr`,
  `ipAllowed` delegating to `ipInCidr`), exported at `:175`.
- `feat/consolidation:server/middleware/auth.js:122` — a **string-prefix hack**:
  `ALLOWED_CIDRS.some(cidr => { const [base] = cidr.split('/');
  return ip === base || ip.startsWith(base.replace(/\.\d+$/, '.')); })`.
  For `INTERNAL_API_ALLOWED_CIDRS=192.168.1.5/32` this admits **all of `192.168.1.*`** — a /32
  pin silently widened to a /24. It only bites once an operator sets the env var (the default
  `127.0.0.1/32,::1/128` is short-circuited by the early return), which is exactly why no test
  catches it.
- Nothing outside `auth.js` imports `ipAllowed`/`ipInCidr` (`git grep` over `origin/main`
  server+test returns nothing), so the *exports* are free; the *implementation* is not.

**GT-2 — the inbound-email webhook authenticates itself back into the CRM in a way the
branch's A3 auth can reject or silently re-tenant.** `server/routes/webhooks.js` is a
main-only file that merges clean and is never touched by resolution — so nobody will look at
it — yet:
- `origin/main:server/routes/webhooks.js:16,100` — it calls its own API with
  `x-internal-key: process.env.INTERNAL_API_KEY` and
  `x-company-id: <company resolved from the recipient address>`.
- `feat/consolidation:server/middleware/auth.js` `requireAuthAsync` resolves a **DB-backed
  `tenant_api_keys`** key *first*, and when it hits, **`X-Company-Id` is ignored entirely**
  (`req.auth = { companyId: dbCompanyId }`, ~`:222-227`). If `INTERNAL_API_KEY` is ever also
  issued as a DB key, every inbound email is filed under that key's tenant and main's
  recipient→tenant property (commit `b8488d7`) is destroyed **without any error**.
- If `INTERNAL_API_KEY` is instead env-bound narrowly via `INTERNAL_API_KEYS`, a
  recipient-derived company outside that set returns **403 "company not permitted for this
  key"** and inbound email dies silently.
- If the key appears in **both**, the branch's ambiguous-binding guard returns **401** and the
  webhook is fully dead.
This is a genuine cross-tenant mis-filing / silent-outage vector *created by the merge itself*.
Neither side's tests exercise both halves.

**GT-3 — `server/server.js` conflicts on the route-mount block, and a selection resolution
kills a whole feature with no test failure.** `origin/main` adds exactly
`app.use('/webhooks', webhooksRouter)`; the branch adds four mounts
(`/api/crm/{tenants,channel-jobs,sequences,api-keys}`). Resolving by selection unmounts one
side outright — inbound email, or all of A3/B1/B3/B7.

### Corrections to `.loop/CP-M_DECISION.md` (fold these in; do not propagate the originals)

- The decision file's conflict map attributes **"inbound-secret fail-closed"** and
  **"recipient-derived inbound tenant"** to `server/middleware/auth.js`. **They are not there.**
  They live in `origin/main:server/routes/webhooks.js:23-25,111-116` (fail-closed 503 when
  `INBOUND_WEBHOOK_SECRET` is unset, constant-time compare, 401 on bad secret) and `:44,58,125`
  (`resolveCompany(to)`, 422 when routing is configured and the recipient maps to nothing), plus
  `server/routes/conversations.js`. Verifying `auth.js` will **not** cover them — M5 must probe
  `webhooks.js` directly.
- The map says `contacts.js` resolution is "take consolidation's version, then re-apply main's 6
  added lines on top". Main's delta (`git diff b7bd2ab origin/main -- server/db/models/contacts.js`)
  is a `console.warn` wrapped around **`return getByIdUnscoped(id)`** in `getById` — i.e. main
  kept the unscoped fallback and merely made it loud. The branch **deleted `getByIdUnscoped`
  entirely** (A1 security fix; `git grep -c getByIdUnscoped feat/consolidation -- server` → 0).
  Re-applying main's 6 lines verbatim would **resurrect the unscoped path**. Take the *intent*
  (loud warning on a missing `companyId`) and drop the fallback. `getByIdUnscoped` has no caller
  outside `contacts.js` itself on either side, so nothing else breaks.
- Risk the decision file does not raise, now **ruled out** by measurement: the branch made
  `canonicalCompanyId` **async**. `git grep -n canonicalCompanyId origin/main -- server` outside
  `auth.js` returns **nothing**, so there is no un-awaited main-side caller. Do not spend time
  here.
- Export-surface delta, ruled benign: branch exports
  `{ requireAuth, requireAdmin, getUserCompanyId, INTERNAL_API_KEY }`; main exports
  `{ requireAuth, getUserCompanyId, INTERNAL_API_KEY, ipAllowed, ipInCidr }`. Every main-side
  importer destructures only `requireAuth`, `getUserCompanyId`, `INTERNAL_API_KEY` — all of
  which survive. Merged exports must be the **union** anyway (D2).

---

## LOCKED DECISIONS (build to these; do not re-litigate)

- **D1 — Direction.** `git merge origin/main` **into `feat/consolidation`**. No rebase (it would
  rewrite the 11 shas and invalidate the CP1 verdict banked against `d8a314e`, and replay these
  5 conflicts up to 11 times). No cherry-pick (main's 10 commits are one interdependent
  Resend+inbox+webhook+scoring feature). One merge commit, conflicts resolved by hand.

- **D2 — `server/middleware/auth.js` — the most dangerous file. Union, in this order.**
  Keep the branch's structure (`requireAuth` sync wrapper → `requireAuthAsync`, DB-backed
  tenant resolution, `tenant_api_keys`, the ambiguous-binding 401, `requireAdmin`) **and graft
  main's hardening into it**: `ipToBig`, `ipInCidr`, and main's CIDR-correct `ipAllowed`
  **replacing the branch's prefix hack** (GT-1), main's `warnIfKeyUnboundInProduction` IIFE, and
  a **union** `module.exports` that adds `ipAllowed, ipInCidr` to the branch's four. The IP check
  must still run inside `requireAuthAsync` on every request. **A single dropped check here is a
  security regression** — this file gets the critic's first and longest look (M8).

- **D3 — `server/routes/crm.js` — hardest by volume.** Keep the branch's `/advance` stage
  authority wholesale (entity_type branch, mode gating, entry rule, suppression refusals — this
  is CP1's verified invariant and it must survive byte-for-byte in behaviour). Then **re-graft
  every main side-effect *inside* that structure** so it still fires on each transition:
  contact-activity audit write, engagement/scoring update, opportunity writes. A side-effect that
  ends up outside the authority's success path is a lost feature; one that ends up before the
  mode gate is a CP1 regression. Both are failures.

  **`[C:MEDIUM-5]` "Keep the branch's version wholesale" does NOT apply to the scoring
  plumbing — that hunk must land on MAIN's side.** `addContactActivity` is byte-identical
  between merge-base and the branch; **main rewrote it** to delegate to `recordEngagement`
  because the old body recomputed the score from a `contact.activity` array that does not exist
  on a DB row, **silently resetting `lead_score_numeric` to 0 on every call**. Git auto-resolves
  this hunk to main's fix; a resolver who rebuilds `crm.js` "from the branch's file" reintroduces
  the score-reset bug. The in-file `ENGAGEMENT_WEIGHTS` deletion, the `lib/scoring` import, and
  the `addContactActivity` → `recordEngagement` delegation must all survive. See M13.

- **D4 — `server/routes/conversations.js` `[C:HIGH-1]` — REWRITTEN. The branch's delta is
  THREE changes, not one.** Rev 1 said "graft the branch's *single* surgical `isManualStage`
  gate back in" — that instruction, followed verbatim, **silently deletes B2's inbound-reply
  enrollment**, which is precisely the catastrophic outcome this ticket exists to prevent.
  Both the decision file's conflict map and rev 1 got this wrong. Verified against
  `git diff b7bd2ab feat/consolidation -- server/routes/conversations.js`, the branch adds
  **all three** of:
  1. the import — `const sequenceDb = require('../db/models/sequences');` and `isManualStage`
     added to the `../db/pipeline` destructure (branch `:9`);
  2. the CP1 mode gate — `if (allowed.includes('responded') && !isManualStage(pipeline, 'responded'))`;
  3. **the B2 hook** — `await sequenceDb.enrollForTriggerStage(companyId, conv.contact_id, 'marketing', 'responded');`
     placed *after* the `UPDATE contacts …` persists and *inside* the same success branch. The
     branch's own comment calls this "a previously missed hook point".

  Resolution: take **main's** larger inbox version wholesale (composer, channel-filtered
  threads, reply attribution, inbound secret handling), then re-graft **all three** into main's
  new inbound auto-advance block, preserving that ordering (gate → UPDATE → activity → enroll).
  **The receipt must name the post-merge line number of the gate AND of the
  `enrollForTriggerStage` call.** Safety net: `test/unit-b2-enrollment.mjs:116-125` covers this
  path, so M2 catches the loss — but only if the merged suite is run before certifying, which is
  why M2 is not sufficient on its own.

- **D5 — `server/db/models/contacts.js`.** Take the branch's version (mandatory `companyId`,
  no `getByIdUnscoped`). Add main's loud `console.warn` for a missing `companyId`, but
  **return null / keep it scoped — do not resurrect the unscoped fallback.** See the correction
  above.

- **D6 — `server/server.js` and the 7 clean-arriving main-only files.** Union both mount blocks:
  the merged `server.js` must expose **`/webhooks` AND all four** of
  `/api/crm/{tenants,channel-jobs,sequences,api-keys}`. Then treat "arrived clean" as **unproven**
  — `webhooks.js`, `email-resend.js` and `scoring.js` are the files most likely to be broken by
  the merge precisely because nobody edits them (GT-2).

- **D7 — GT-2 must be closed, not just documented.** The merged tree must make the inbound
  webhook's recipient-derived tenant survive the branch's auth. Minimum acceptable: an explicit,
  tested statement of which key `webhooks.js` uses and proof that a recipient-derived
  `x-company-id` is honoured end-to-end (M5c). If closing it needs a code change, keep it
  **minimal and inside the merge** — do not open a new feature.

- **D8 — Auto-merged does not mean verified.** `test/contract.mjs` and `web/index.html` merge
  with no markers, but **both sides added to both**. Assert both sides' additions are present
  and functional (M3, M7) — in `index.html` specifically, check for duplicate element IDs or two
  competing render paths for the same pane, which is how a clean textual merge produces a broken
  UI.

- **D11 — `[C:MEDIUM-4]` The merge opens an outbound path that bypasses A5 suppression. Close
  it or log it — do not let it pass silently.** Main's inbox composer delivers mail directly
  (`origin/main:server/routes/conversations.js:162-180`, `deliver:true` → `resendEmail.sendEmail`)
  and checks **nothing** in `suppressions`. The branch enforces suppression only in the
  dispatcher claim path (`server/db/models/dispatch.js:113-160`) and at pipeline entry
  (`server/routes/crm.js:748-760`). Post-merge, a human can send to a **globally suppressed**
  contact from the composer. M6 tests A5 through branch paths only and would pass vacuously.
  This is a consent/compliance hole, not a style issue. **Preferred: add the minimal global
  suppression check to the composer deliver path, inside this merge** (same spirit as D7 —
  minimal, no new feature). If deferred instead, it must be named explicitly in the receipt
  **and** written into the CP4a ticket as a known open hole. Silence is a fail.

- **D9 — Scope.** CP-M reconciles. It does **not** add features, refactor beyond what a hunk
  forces, or touch the content engine, task manager or Slack tooling. CP4a's rescope (wrap
  main's Resend sender in the B4 claim/ack contract rather than rebuild it) is a **later**
  ticket, not this one.

- **D10 — Sequencing.** CP-M cannot start until **CP2 is committed**: the working tree currently
  carries 687 uncommitted CP2 insertions across 6 files, and merging onto a dirty tree is
  unsafe. CP2 banks first, then CP-M merges on top of it.

---

## FILES TO TOUCH

Resolution only, in the 5 conflicted files: `server/middleware/auth.js` (D2),
`server/routes/crm.js` (D3), `server/routes/conversations.js` (D4),
`server/db/models/contacts.js` (D5), `server/server.js` (D6).
Plus, only if D7 forces it, a minimal change in `server/routes/webhooks.js`.
Everything else arrives via the merge untouched.

---

## EVAL CRITERIA — I check every one; number the receipt against these

Operator-mandated (from `CP-M_DECISION.md`), kept verbatim in intent:

- **M1** A merge commit exists on `feat/consolidation` with both parents; no conflict markers
  anywhere — `git grep -nE '^(<<<<<<<|=======|>>>>>>>)'` returns nothing.
- **M2** The full consolidation suite still passes — **326 pre-CP2 tests, plus CP2's, all
  unmodified**. Report the total.
- **M3** The **merged** `test/contract.mjs` runs and its case count is **≥ the union of both
  sides'** — not just consolidation's. State both sides' pre-merge counts and the merged count.
- **M4** Every migration 002→019 applies in order on a fresh scratch DB, **twice**.
- **M5** Each `main` feature proven alive **by name**: Resend outbound send; inbound webhook;
  inbox composer + channel-filtered threads; reply-to attribution; Opportunities board +
  analytics; contact-activity audit log; engagement scoring / inbox-fed lead score.
  - **M5a** Inbound webhook **fails closed**: with `INBOUND_WEBHOOK_SECRET` unset → **503**;
    with it set and a wrong `x-webhook-secret` → **401**
    (`webhooks.js:23-25,111-116` — *not* `auth.js`).
  - **M5b** Recipient-derived tenant: with routing configured, an unmapped recipient → **422**,
    never a silent fall-through to `DEFAULT_COMPANY_ID` (`webhooks.js:44,58,125`).
  - **M5c** `[GT-2]` **End-to-end inbound under the branch's A3 auth**: an inbound delivery to a
    mapped recipient lands on the **recipient's** tenant, with `INTERNAL_API_KEY` exercised
    through `requireAuthAsync`. Prove it is not 401/403 and not re-tenanted by a DB key.
- **M6** Each consolidation feature still works: A3 API-key auth, A5 limits/suppression, B2
  enrollment on stage change, B3 claim/ack, B7 builder UI, CP2's scheduler, and CP1's E1–E14
  spot-checked (mode gating, entry rule, illegal-transition 409, the 3 seeded webinar pipelines).
- **M7** Browser evidence for **both worlds in one session**, in `.loop/EVIDENCE/CP-M/`: the CP1
  pipelines / enrollment / 409 screens **and** main's inbox + Opportunities screens. Console
  error-free apart from deliberate refusal probes.
- **M8** Critic pass on the merge diff, **`auth.js` first**, briefed explicitly to hunt a dropped
  security check or a lost branch-side feature.

Added by me from the ground truth above — these are the ones a normal merge review misses:

- **M9** `[GT-1]` `[C:LOW-6]` The merged `ipAllowed` is main's **CIDR-correct** implementation,
  with `ipToBig`/`ipInCidr` present. Prove behaviourally, not by reading — **two probes**:
  (a) with `INTERNAL_API_ALLOWED_CIDRS=192.168.1.5/32`, a call from `192.168.1.99` is
  **rejected**; (b) **under the DEFAULT config** (`127.0.0.1/32,::1/128`), a call from
  `127.0.0.2` is **rejected**. The branch's prefix hack accepts both. Rev 1's caveat that this
  "only bites once an operator sets the env var" was **wrong** — the early return short-circuits
  only the three exact loopback literals, so the widening exists under defaults too.
- **M10** `[GT-3]` `[C:LOW-7]` The merged `server.js` mounts **all five**: `/webhooks` **and**
  `/api/crm/{tenants,channel-jobs,sequences,api-keys}`. Probe **real subroutes, not mount
  roots** — `webhooksRouter` defines only `POST /email/inbound`, so `GET /webhooks` 404s even on
  a correct merge. Use: `POST /webhooks/email/inbound` expecting **503 or 401** (never 404), and
  e.g. `GET /api/crm/tenants` expecting **401/403** without a key (never 404).
- **M11** `[D5]` `getByIdUnscoped` is **still gone** — `git grep -c getByIdUnscoped -- server`
  is 0 — and `contacts.getById(id)` without a `companyId` does **not** return another tenant's
  row. A1's fix must not be undone by re-applying main's lines.
- **M12** `[D8]` `[C:MEDIUM-3]` `web/index.html` merged clean **and** works: both sides' panes
  render and no two render paths write the same pane. **The duplicate-ID assertion must be
  BASELINE-RELATIVE, not absolute** — `origin/main:web/index.html` *already* ships duplicate ids
  (`cv-from` ×2, `cv-to` ×2, `cv-body` ×3, around `:916-937`) inside mutually-exclusive composer
  template-literal branches. An absolute "no duplicate ids" check **false-fails on a perfect
  merge**, and the resulting hand-waving is exactly how a genuinely merge-created duplicate slips
  through. Assert only ids that are duplicated in the **merge result but not in either parent**,
  or assert over the **live rendered DOM** per pane rather than over source text.
- **M13** `[D3]` `[C:MEDIUM-5]` CP1's invariant survives `crm.js`: **the CRM still never
  auto-advances a manual stage** after the merge, *and* main's audit-log + scoring side-effects
  fire on a successful auto transition. Both halves in one test — this is the criterion that
  proves the union actually unioned. **Pin the expected score**: assert the numeric delta equals
  the event's weight and that the label ratchets at the 80/50 thresholds. "A score is visible" is
  not enough — a score reset to 0 by the reverted `addContactActivity` body would satisfy a
  careless look.
- **M15** `[C:LOW-8]` **The Resend delivery branch must actually execute.** With `RESEND_API_KEY`
  unset, `isConfigured()` is false and the composer records without delivering
  (`origin/main:server/routes/conversations.js:165`, `server/lib/email-resend.js:9-11`) — so
  `sendEmail`, its 502 mapping, and the **Message-ID stamping that reply-to attribution depends
  on** never run, and M5's "Resend outbound send proven alive" passes vacuously. Exercise
  `deliver:true` with a bogus key and assert the 502 mapping, or mock fetch and assert the
  Message-ID header persists.
- **M16** `[C:LOW-9]` **`INBOUND_ROUTING` (env) and `tenants` (DB) are two unsynchronised tenant
  registries.** Migration 013 FKs `contacts`/`conversations`/`messages.company_id → tenants(id)`,
  while the webhook writes under whatever company `INBOUND_ROUTING` names
  (`origin/main:server/routes/webhooks.js:123-149`). A **mapped-but-unprovisioned** recipient
  therefore hits FK 23503 → `isTenantNotProvisioned` → a 502. M5b covers unmapped→422 and M5c
  uses a provisioned tenant; this in-between case is untested. Add one probe: route a recipient
  to `co_ghost` and expect a **loud, documented 5xx — never a silent mis-file into the default
  tenant**. Record the operational rule "every `INBOUND_ROUTING` value must be a provisioned
  tenant" in the receipt. (Default `tantra` **is** seeded by `migrations/012_tenants.sql`, so
  single-tenant staging is safe today.)
- **M14** No feature file was lost: `git diff --stat origin/main...HEAD` after the merge shows
  none of main's 7 added files deleted, and `git log --oneline HEAD ^d8a314e` contains all 10
  main commits.

---

## BROWSER TEST SCRIPT — I run this myself; resolve so it can pass

1. **Both worlds load.** Dashboard opens with no console errors; the CP1 **Pipelines** tab and
   main's **Inbox** and **Opportunities** tabs are all present and render.
   → `CPM-01-both-worlds.png`
2. **CP1 invariant intact.** Advance a `webinar_sales` deal through an auto stage, then attempt
   an illegal/manual transition. EXPECT: auto advance 200, manual refused, **409** on the illegal
   one — same as the CP1 verdict. → `CPM-02-cp1-invariant.png`
3. **Main's audit + scoring fired on that same advance** (D3/M13): the contact-activity entry
   and the updated score are visible on screen for the transition just made.
   → `CPM-03-audit-and-score.png`
4. **Inbox composer + channel-filtered threads** render and a thread shows reply attribution.
   → `CPM-04-inbox.png`
5. **Inbound webhook, three probes** (M5a/M5b/M5c): unset secret → 503; wrong secret → 401;
   good secret + mapped recipient → message lands on the **recipient's** tenant.
   → `CPM-05-inbound-fail-closed.png`
6. **Sequences/queue still alive** (CP2 survived the merge): the enrollments & queue block
   renders with a real enrollment. → `CPM-06-sequences-survived.png`
7. Console: **zero** errors beyond deliberate refusal probes.

---

## OUT OF SCOPE

CP4a's Resend-wrapping rescope; the content engine; the task manager; Slack tooling; any
staging deploy; any new feature. Anything a hunk does not force.

---

## CONSTRAINTS

- **CP2 must be committed first (D10).** Do not merge onto the dirty tree.
- `git fetch origin` before any commit. Resolve and verify on **`feat/consolidation` only**.
  Push to `main` is pre-authorised **only after this ticket passes**; **deploy is a GATE — stop
  and surface.**
- Scratch Postgres only (embedded PG `:54339`). Never the live `denchclaw` DB, no live DDL, no
  nginx, no secrets/`.env`/`*.pem`.
- `CONSOLIDATION_ROADMAP.md` may carry an uncommitted operator edit — leave it unstaged.
- Nothing from `scratchpad/` gets committed.
- **EXECUTOR — DECIDED (operator delegated the call to the orchestrator, 2026-08-01):
  the BUILDER resolves the merge; the ORCHESTRATOR verifies it.** Rationale: the v3 role split
  exists so the author never certifies its own work, and union-resolving 5 files — two of them
  security-critical — is substantial code, not a clerical merge. The orchestrator must stay
  uncontaminated to check M1–M16 independently. This supersedes the 2026-08-01 log line that
  said CP-M was the orchestrator's to execute. Not to be re-litigated.
