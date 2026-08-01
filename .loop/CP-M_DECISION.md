# CP-M — operator decision: reconcile `feat/consolidation` with `main`

Decided 2026-08-01 by the operator. This file **closes the CP-M gate**. The orchestrator
may author the CP-M ticket from it without asking again.

## The situation
`feat/consolidation` is **11 ahead / 10 behind** `origin/main`. Both sides carry real,
wanted work:

- **`origin/main`** (10 commits, PR #5 `aquila-working-branch`) — Resend outbound email +
  inbound webhook, GHL-style multi-channel inbox composer + channel-filtered threads,
  "which email a reply answers", unified Opportunities board + live analytics, full
  contact activity audit log, engagement scoring authority + inbox-fed lead score,
  auth/tenant hardening, inbound-secret fail-closed, inbound tenant resolved from
  recipient. **This is what actually runs on staging.**
- **`feat/consolidation`** (11 commits) — A1 tenancy-leak closure, A2 tenants entity, A3
  per-tenant API keys, A5 limits/quotas/suppression, B1 sequence data model, B2
  stage-triggered enrollment, B3 dispatcher claim/ack, B4 channel-executor contract, B7
  sequence-builder UI, CP1 funnel pipelines. Migrations **012–018**.

## THE MANDATE (operator, verbatim intent)
> Merge everything built so far into `main`. Avoid merge conflicts where possible, but
> **absolutely do not waste any feature either side has spent time on.**

Therefore: **conflict resolution is UNION, never selection.** Every conflicting hunk keeps
*both* behaviours. This is the single most important rule in this checkpoint.

**Banned outright:** `git merge -X ours` / `-X theirs`, `git checkout --ours/--theirs` on a
whole file, and "take the bigger side and move on". Any of these silently deletes shipped
work. Resolve every hunk by hand and prove both behaviours survive with a test.

## Locked decisions (do not re-litigate)

1. **Direction: merge `origin/main` INTO `feat/consolidation`.** Resolve, verify, and
   evidence the result on the feature branch. Only once it is green does it go to `main`
   (PR, or fast-forward if clean). Rationale: `main` is what staging runs — it must never
   hold a half-resolved tree. The risky work happens on the branch.
2. **No rebase.** Rebasing rewrites all 11 shas, which would invalidate the CP1 verdict
   just banked against `d8a314e` and would replay the same 5 conflicts up to 11 times.
3. **No cherry-picking.** `main`'s 10 commits are one interdependent feature (Resend +
   inbox + webhooks + scoring); splitting them risks a half-wired email path.
4. **Migrations: no collision.** `origin/main` tops out at **011**; 012–018 are
   uncontested. Nothing to renumber. **Next new migration is 019.**
5. **CP-M is a real checkpoint** — its own ticket, eval criteria up front, full verify
   pass, critic pass, browser evidence. It is not "just a merge".
6. **CP4a is rescoped by this merge.** `main` already ships the Resend sender and the
   inbound webhook. CP4a must **wrap** them in the B4 claim/ack executor contract — not
   rebuild them. The orchestrator rewrites the CP4a ticket accordingly after CP-M lands.
7. **Push to `main` is authorised** for the reconciled, verified result.
   **Deploying is NOT.** Staging deploys are a separate human action (`git pull` +
   `pm2 restart`); merging to `main` does not itself deploy. That gate stays shut.

## Conflict map — 7 overlapping files, 5 genuinely conflicting
`test/contract.mjs` and `web/index.html` **auto-merge cleanly** — but both sides added
cases/UI to them, so still assert both sides' additions survived.

| File | main | consolidation | Resolution strategy |
|---|---|---|---|
| `server/routes/crm.js` | +87 / −51 | +359 / −66 | **Hardest.** consolidation rewrote the `/advance` stage authority (entity_type branch, mode gating, entry rule, suppression); main added activity-audit + scoring + opportunity writes on the same routes. Keep consolidation's authority structure and **re-graft every main side-effect inside it** (audit-log write, score update) so they still fire on each transition. |
| `server/middleware/auth.js` | +72 / −6 | +160 / −12 | **Most dangerous — both rewrote auth.** consolidation added DB-backed tenant resolution + `tenant_api_keys`; main added tenant hardening, inbound-secret fail-closed, recipient-derived inbound tenant. Union both: DB-backed resolution as the path, with main's fail-closed checks preserved. **A single missed check here is a security regression.** Mandatory critic focus. |
| `server/routes/conversations.js` | +74 / −6 | +14 / −2 | **Easy.** consolidation's change is one surgical `isManualStage` gate before the inbound auto-advance. Take main's much larger inbox version wholesale, then graft that gate back in. |
| `server/db/models/contacts.js` | +6 / −1 | +24 / −38 | Take consolidation's version (it deleted `getByIdUnscoped` and made `companyId` mandatory — that was the A1 security fix; **do not resurrect the unscoped path**), then re-apply main's 6 added lines on top. |
| `server/server.js` | +2 | +8 | Trivial — union both route-mount blocks. |

## Eval criteria the CP-M ticket MUST carry (feature-preservation proof)
- **M1** Merge commit exists on `feat/consolidation`; no conflict markers anywhere
  (`git grep -nE '^(<<<<<<<|=======|>>>>>>>)'` returns nothing).
- **M2** The **full consolidation suite still passes: 326/326.**
- **M3** `main`'s own `test/contract.mjs` cases pass too — run the merged `contract.mjs` and
  confirm the count is ≥ the union of both sides' cases, not just consolidation's.
- **M4** Every migration 002→018 applies in order on a fresh scratch DB, **twice**.
- **M5** *Each* `main` feature is proven alive after the merge, by name: Resend outbound
  send, inbound webhook (incl. **fail-closed on unconfigured secret** and
  **recipient-derived tenant**), inbox composer + channel-filtered threads, reply-to
  attribution, Opportunities board + analytics, contact activity audit log, engagement
  scoring / inbox-fed lead score.
- **M6** *Each* consolidation feature still works: A3 API-key auth, A5 limits/suppression,
  B2 enrollment on stage change, B3 claim/ack, B7 builder UI, and CP1's E1–E14 spot-checked
  (mode gating, entry rule, illegal-transition 409, seeded webinar pipelines).
- **M7** Browser evidence for both worlds in one session: the CP1 pipelines/enrollment/409
  screens **and** main's inbox/opportunities screens, in `.loop/EVIDENCE/CP-M/`.
- **M8** Critic pass on the merge diff, **auth.js first** — brief it explicitly to hunt for
  a dropped security check or a lost feature branch-side.

## Then
On CP-M pass → open the PR to `main` (or fast-forward), append the roadmap progress note,
rewrite the CP4a ticket per decision 6, and continue CP2 → CP3 → CP4a.
