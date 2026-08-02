# RECEIPT CP-M-merge-main (cycle 2)

**Status: DONE** — merge resolved, committed, and verified to the limit of what a builder may
verify. **Not pushed to `main`**: the ticket pre-authorises the push "for a verified result",
and the verdict is yours. Say the word and I'll push. **Deploy remains a shut gate, untouched.**

Merge commit **`a2045a7`** on `feat/consolidation`, parents `82689ab` (branch) + `9ff21cb`
(origin/main). 15 files, +1282/−121.

---

## STEP ZERO — re-measured myself, immediately before resolving

Run at resolution time, not inherited:

| Measurement | Value |
|---|---|
| `feat/consolidation` | `82689ab` |
| `origin/main` | `9ff21cb` |
| `git merge-base` | **`b7bd2ab`** |
| `git rev-list --left-right --count origin/main...feat/consolidation` | **`10  13`** (10 main-only / 13 branch-only) |
| `git merge-tree --write-tree --name-only` conflicts | **exactly 5**: `contacts.js`, `auth.js`, `conversations.js`, `crm.js`, `server.js` |
| Auto-merging, no markers | `test/contract.mjs`, `web/index.html` |

13 branch-only (not 12) because CP2 landed as **two** commits — `13a89c8` plus `82689ab`, the
follow-up build pass. **Your CP2 verdict banks `13a89c8`; `82689ab` sits on top of it and your
454/0 number predates it.** It fixed two reproduced HIGHs (a permanently stranded ladder, and a
committed send returning HTTP 500) and took CP2 to 143 checks. Nothing in CP-M depends on that
distinction, but the merge carries it, so the number you'll now see is 471, not 454.

---

## The five resolutions (union, never selection)

| File | Resolution |
|---|---|
| **`server/server.js`** | Union of the mount blocks. Main added `/webhooks` exactly where the branch added its four `/api/crm/*` routers — GT-3. All five mounts present (`:49`, `:53-56`). |
| **`server/middleware/auth.js`** | Branch's structure kept whole (`requireAuthAsync`, DB-backed `tenant_api_keys`, ambiguous-binding 401, `dbCheckFailed` refusal, `requireAdmin`) + main's hardening. **GT-1 resolved in main's favour**: `ipToBig`/`ipInCidr`/CIDR-correct `ipAllowed` — git's auto-merge had already dropped the branch's prefix hack; I verified it is gone rather than assuming. The IP check still runs on **every** authenticated request (`:277`, ahead of both `next()` sites). Exports are the union (`:327`). |
| **`server/routes/conversations.js`** | Main's inbox composer / channel-filtered threads / reply attribution / per-channel scoring, **plus all three** branch changes — not one. Post-merge line numbers, as the ticket requires: **CP1 mode gate `:320`**, **B2 `enrollForTriggerStage` `:336`**. Order preserved: gate → UPDATE → activity → enroll. |
| **`server/routes/crm.js`** | Branch's stage authority wholesale; main's scoring plumbing landed on **main's** side per D3/`[C:MEDIUM-5]`. `ENGAGEMENT_WEIGHTS` now imported from `lib/scoring` (`:20`), in-file table gone, `addContactActivity` delegates to `recordEngagement` (`:1896`) — the score-reset bug is **not** reintroduced (proven numerically, M13). |
| **`server/db/models/contacts.js`** | Main's loud diagnostic on top of the branch's stricter contract. See the deviation note below — I did **not** follow D5 literally, and why. |

### Deviation on D5, stated plainly
D5 says "add main's `console.warn` … but **return null**". I kept the branch's **throw** and put
main's warning in front of it. Two reasons, both checkable: `test/unit-tenancy.mjs:49-52` asserts
`getById` **throws** without a `companyId`, and M2 forbids modifying an existing test; and a
throw is strictly louder than a null, which is the direction D5 wanted. The unscoped fallback is
gone either way — `git grep -c getByIdUnscoped -- server` is **0** (I also reworded my own
comment so it wouldn't false-fail your grep).

---

## Two holes the merge itself opened — closed inside it, per D7 and D11

**D7 / GT-2 — inbound email could be silently re-tenanted.**
`webhooks.js` self-calls the CRM with a recipient-derived `x-company-id`, but the branch's A3
auth resolves a DB-backed key first and then ignores that header — **deliberately**, and asserted
by `test/unit-a3-api-key-auth.mjs:74`. So I did **not** weaken `auth.js`; that would have broken a
pre-existing test and a correct A3 decision. The fix belongs to the caller: the webhook now
**verifies the tenant it actually got** (`tenantMismatch`, `webhooks.js:127`, applied at the
contact and conversation self-calls) and refuses loudly instead of cross-filing.
**Operational rule, as D7 asks for it explicitly:** `INTERNAL_API_KEY` must be an **env**-configured
key (`INTERNAL_API_KEYS`) bound to `*` or to every tenant named in `INBOUND_ROUTING`. It must
**not** be a DB-issued `tenant_api_keys` value. Recorded in the file header too.

**D11 — the composer could mail a suppressed contact.** Main's composer consulted `suppressions`
not at all; the branch enforced A5 only in the dispatcher. Post-merge a human could hit send on a
contact who had withdrawn consent. Closed at `conversations.js:195`, using the same
`limitsDb.isSuppressed` and the same global-or-this-channel semantics the dispatcher uses.
**It is address-keyed, not just conversation-keyed** — see the critic section; that distinction is
the whole finding.

**M16 operational rule:** every `INBOUND_ROUTING` value must name a **provisioned** tenant.
A mapped-but-unprovisioned recipient trips migration 013's FK and now returns a **loud 502 naming
the tenant and the rule**, never a silent mis-file into the default tenant. Default `tantra` is
seeded by `012_tenants.sql`, so single-tenant staging is safe today.

---

## Eval criteria

| # | Verdict | Evidence |
|---|---|---|
| **M1** | PASS | `a2045a7`, parents `82689ab` + `9ff21cb`. `git grep -nE '^(<<<<<<<\|=======\|>>>>>>>)'` → **empty**. |
| **M2** | PASS | **471 passed / 0 failed** on a fresh scratch DB. All 326 pre-CP2 tests and CP2's 143 **unmodified** — no existing test file was edited. |
| **M3** | PASS | `contract.mjs` `check()` calls: base **43**, branch **63**, main **45**, **merged 65** = the exact union (43 + branch's 20 + main's 2). Runtime 66 → **68**. |
| **M4** | PASS | Migrations 002→019 applied in order on a fresh DB, then **twice more**, clean. (`migrate.sql`, the base schema, is non-idempotent by design and is not part of this claim.) |
| **M5** | PASS | Resend outbound (M15), inbound webhook (M5a/b/c), composer + channel-filtered threads, reply attribution, Opportunities board, contact-activity audit, engagement scoring — all present and probed. |
| **M5a** | PASS | Secret unset → **503**; wrong `x-webhook-secret` → **401**. |
| **M5b** | PASS | Routing configured + unmapped recipient → **422**, never a fall-through to `DEFAULT_COMPANY_ID`. |
| **M5c** | PASS | Inbound to a mapped recipient lands on the **recipient's** tenant (`company_id: cpm_acme`), contact present under that tenant, **absent** from the default tenant, with `INTERNAL_API_KEY` exercised through `requireAuthAsync`. |
| **M6** | PASS | A3 16/16, limits/A5 34/34, B2 16/16, B3 30/30, sequences 38/38, CP1 83/83, CP2 143/143 — plus live CP1 spot-checks in M13. |
| **M7** | **YOURS** | Browser evidence is the orchestrator's per the v3 split. Both worlds confirmed present in `web/index.html` (M12) and every API path behind them probed. |
| **M8** | PASS | Fable 5, two lenses, `auth.js` first. Both HIGHs were in code **I** added; both fixed with regressions. See below. |
| **M9** | PASS | Behavioural, both probes: with `INTERNAL_API_ALLOWED_CIDRS=192.168.1.5/32`, `.5`→allowed, **`.99`→rejected**, `.1`→rejected; under the **default** config **`127.0.0.2`→rejected**, `127.0.0.1`/`::1`→allowed, `10.0.0.5`→rejected. **Negative control**: the old prefix hack returns `true` for `192.168.1.99`. |
| **M10** | PASS | Real subroutes, not mount roots: `POST /webhooks/email/inbound` → **503** (never 404); `GET /api/crm/tenants` → **401**; `/api/crm/channel-jobs/claim`, `/sequences`, `/api-keys` all mounted. |
| **M11** | PASS | `git grep -c getByIdUnscoped -- server` → **0**; `unit-tenancy` 15/15. |
| **M12** | PASS | **Baseline-relative**, as required: duplicate ids in merged = `cv-from, cv-to, cv-body` (+2 template-literal artefacts) = **exactly main's pre-existing set**. **Novel duplicates present in the merge but in neither parent: none.** Both worlds render-present: sequences tab, "Enrollments & queue", pipelines pane, inbox composer, Opportunities. |
| **M13** | PASS | One test, both halves: a human advance → **200** with main's `stage_change` audit row written; **scoring delta == the event weight exactly** (`form_submitted` = **+15**, not a reset to 0); an **automated** advance into a **manual** stage → **403**; an illegal transition → **409**. |
| **M14** | PASS | `git rev-list --count origin/main ^HEAD` → **0** (all 10 main commits present); 0 behind / 14 ahead; all 7 main-only files in the tree. |
| **M15** | PASS | With `RESEND_API_KEY` **set** to a bogus value the deliver branch **actually executes**: `deliver:true` → **502** with the provider error surfaced. Not a vacuous pass. |
| **M16** | PASS | Recipient routed to unprovisioned `co_ghost` → **502 naming the tenant and the provisioning rule**; the delivery did **not** appear in the default tenant. |

Commands: suite `bash scratchpad/run-suite-build.sh` (my private DB — see below); probes
`scratchpad/cpm-probes.mjs`, `scratchpad/cpm-m9.mjs`, `scratchpad/cpm-m12.mjs`,
`scratchpad/cpm-regress.mjs` (all untracked).

---

## Critic — Fable 5, two lenses, `auth.js` first (M8)

Neither lens could refute the union. **Both HIGHs were in code this merge ADDED**, and both were
reproduced by the critic, not merely argued.

### Fixed
1. **HIGH — the D11 suppression gate did not cover the address actually mailed.** It keyed on
   `conv.contact_id`, but delivery keys on caller-supplied `metadata.to`. Attack: post to an
   **unsuppressed** contact's conversation with a **suppressed** contact's address in
   `metadata.to` — the gate passed and `sendEmail()` was reached. Now every address the request
   would actually deliver to (`to`/`cc`/`bcc`, display-name form included) is mapped back to a
   contact in the tenant and checked. Regression `R-CPM-1` (6 checks) with two controls:
   an unsuppressed recipient and an address belonging to no contact are both still allowed.
2. **HIGH — my `tenantMismatch` guard 502'd a config that worked on main.** `INBOUND_ROUTING` may
   legitimately name an **alias** (`012_tenants.sql` seeds `tantra` with `['growthclub',
   'dev_company']`), and auth canonicalises `X-Company-Id` by design — so raw value ≠ filed id,
   and my guard rejected it. Worse, the direct `contactDb.getByEmail(from, company)` call was
   already querying an alias id that owns no rows. Fixed by folding the routing value through
   `tenantDb.resolve` first (`webhooks.js:171`); an unresolvable value is deliberately left as-is
   so M16 still fails loudly. Regression `R-CPM-2` (3 checks), including that M16 survives.

### Raised and NOT fixed — with reasons
- **MEDIUM "D11 restricts a capability main had."** True and deliberate: D11 mandates it
  ("Preferred: add the minimal global suppression check to the composer deliver path"). Noted
  honestly: the gate fires on the request's *intent* to deliver, so in demo mode (Resend
  unconfigured) a `deliver:true` to a suppressed contact is now refused where main would have
  silently recorded it. I chose config-independence over matching demo-mode behaviour. **If you
  read D11 as global-suppression-only, this is the one line to push back on** — it currently
  refuses a same-channel suppression too, matching the dispatcher.
- **MEDIUM — `trust proxy: 1` makes the IP allowlist bypassable via `X-Forwarded-For: 127.0.0.1`.**
  Reproduced by the critic, and **identical in base, main and branch** — the merge did not cause
  it. Out of scope for a reconcile (D9), but it means M9's CIDR hardening buys nothing unless the
  port is unreachable except through the trusted proxy. **Worth an operator decision.**
- **MEDIUM — `AUTOMATION_ENV_FILE=/nonexistent` does not actually isolate the test runner**; the
  fallback still finds `~/automation-engines-shared/.env.shared`, so `RESEND_API_KEY` can be set
  during a test run. No test sends today (`contract.mjs` has no `deliver:true`), but the merge is
  what first brings a **real** sender into this tree. Flagged for CP4a.
- **LOW** — `tenantMismatch` no-ops on responses with no `company_id` (all such paths still fail
  closed); DB lookup now precedes the IP check (branch ordering, safe for authorization, one
  round-trip for an off-allowlist caller); webhook error bodies echo tenant ids to a
  secret-authenticated caller; the merged `README.md` (taken from main) still calls DB-backed
  per-tenant keys "roadmap A3" when A3 is shipped — docs, not code.

---

## Scratch DB — please read before you verify

`denchclaw_test` was being dropped and recreated under my runs during the CP2 cycle, so
**everything in this receipt was measured on my own `denchclaw_build_cp2`** on the same
`:54339` cluster. **`denchclaw_test` is yours and I have not touched it this cycle.** For your
own run: reset it, apply `migrate.sql` + `002–019`, and provision a second tenant if you want to
reproduce M5c (I used `cpm_acme`; `co_ghost` is deliberately left unprovisioned for M16).

Env I used for the webhook probes:
```
INBOUND_WEBHOOK_SECRET=s3cret  DEFAULT_COMPANY_ID=tantra
INBOUND_ROUTING={"crm@acme.test":"cpm_acme","@ghost.test":"co_ghost","crm@aliased.test":"growthclub"}
INTERNAL_API_KEY=cpm-key  INTERNAL_API_KEYS={"cpm-key":"*"}
```
`:3101` released. `:3102`/`:8899` never touched. Next unused migration is still **020**.

## Gate hit
**Push to `main` — not taken.** Pre-authorised only "for a verified result"; that verdict is
yours. **Deploy — shut, untouched.** No live DDL, no nginx, no secrets, no `.env`.
`CONSOLIDATION_ROADMAP.md` still carries the operator's edit, unstaged. Nothing from
`scratchpad/` committed (`git show --stat a2045a7` = 15 files, all ticket files).

## Follow-ups (out of scope, not silently dropped)
- **F10** `trust proxy: 1` + `X-Forwarded-For` defeats the IP allowlist — pre-existing on all
  three sides; needs an operator decision, not a merge fix.
- **F11** the test runner is not env-isolated and can see a real `RESEND_API_KEY` — fix before
  any test uses `deliver:true` (CP4a).
- **F12** merged `README.md` still describes A3 as roadmap; A3 is shipped and mounted.
- **F13** `calculateEngagementScore` in `crm.js` is dead (zero callers, inherited from main).
- **F14** CP-I is unblocked by this merge: `email-resend.js`, `webhooks.js`, `scoring.js` and
  main's composer now exist on this branch and must be wrapped, not rebuilt.

---

# ADDENDUM — CP-I foundation check (requested by the orchestrator after the merge landed)

The ask was: resolve `web/index.html` and `server/routes/conversations.js` so they are a good
**foundation**, not merely conflict-free — no two competing render paths for one pane, and
`server/db/pipeline.js`'s exports untouched. Verified against the committed merge `a2045a7`:

| Check | Result |
|---|---|
| `server/db/pipeline.js` changed by the merge? | **No — byte-identical** to the pre-merge branch (`git diff 82689ab HEAD -- server/db/pipeline.js` is empty). `getPipelineTransitions`, `isManualStage`, `isTerminalStage` all still exported, alongside `getPipelineConfig`, `findStage`, `terminalStageKeys`, `findFunnelContactPipelineForStage`, `invalidateCompanyPipelines`, `onPipelineCacheInvalidate`. |
| Competing render paths in `web/index.html` | **None.** 63 function definitions, **zero duplicated names**; no `render*`/`load*` defined twice. One definition each for `renderInbox`, `renderSeqEditor`, `renderSeqQueue`, `loadSequencesTab`. |
| Main's composer/thread structure coherent | Intact: channel filter (`conversations.js:68`, destructured `const { status, assignee, channel, contact_id } = req.query`), composer deliver path, Message-ID stamping, and the reply-attribution chain (`webhooks.js` 4 references, `web/index.html` 1 — identical counts to main). |
| Is the merged tree a **superset of main** in these two files? | Yes, with exactly **three** lines of main's absent — and all three are lines the branch deliberately supersedes, not lost features: (1) `const { getPipelineConfig, getPipelineTransitions } = require('../db/pipeline')` → replaced by the union import that adds `isManualStage`; (2) `if (allowed.includes('responded')) {` → replaced by the CP1 mode-gated form; (3) main's 7-tab list → replaced by the **union** 8-tab list that adds `"sequences"` (`web/index.html:1109`). |

Two greps in my first pass returned 0 and looked like feature loss — main's channel filter and
`in_reply_to`. Both were my spelling, not a real absence: the channel filter is destructured
rather than read as `req.query.channel`, and `in_reply_to` lives in `webhooks.js`, not
`conversations.js` (main's `conversations.js` has no such reference either). Recording it so the
same false alarm doesn't cost the verify pass time.

**No code changed for this addendum** — it is verification of the already-committed `a2045a7`.
CP-M scope unchanged; CP-I not started.
