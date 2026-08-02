# Critic policy — Fable 5 is the standing critic (operator decision, 2026-07-31)

The verification loop (Karpathy Layer 2) requires an **independent** critic on anything
touching migrations, auth, tenancy, money-adjacent send-gating, or a public HTTP surface —
both when pressure-testing a spec and when reviewing a diff before a checkpoint is banked.

## Decision
**The critic for this project is Fable 5.** The OpenAI Codex CLI is NOT used — the operator
has decided against depending on an external app for review. Do not ask for `codex login`,
do not attempt `codex exec`, do not treat Codex's absence as a blocker or a gate.

## How to run the critic
Spawn an independent review with the Agent tool:
- `subagent_type: general-purpose`, `model: 'fable'`
- Adversarial brief, verbatim in spirit: *"Try to REFUTE this spec / this diff. Assume it is
  wrong until proven right. Cite file:line for every claim. Default to 'not proven' when
  unsure."*
- Feed it the exact spec or `git diff` under review, plus the eval criteria.
- Run it TWICE per checkpoint: once on the ticket (spec time) and once on the diff (verify
  time).

## Compensating for same-family blind spots
Fable 5 is in the Claude family, so it is a weaker form of independence than a different
vendor's model. Compensate with process, not with a second vendor:
- Give each critic pass a **distinct lens** rather than repeating the same brief — e.g.
  (1) correctness/state-machine, (2) tenancy/security, (3) does the browser evidence
  actually prove the automation fired.
- Prefer **empirical refutation over opinion**: when the critic claims a bug, reproduce it
  against the scratch DB before accepting it, and when it clears something, spot-check the
  claim yourself.
- A critic launched while the suite or the evidence is still in flight will report them as
  "missing" — re-check its blockers against reality before treating them as findings.

## Logging
Every critic pass records the model and verdict in `.loop/LOG.md`, e.g.:
`[orch] CP2 critic: FABLE-5 — 3 findings, 2 folded, 1 refuted.`

## History
CP1 was reviewed by Fable 5 (initial verdict FAIL; 5 findings fixed with 12 regression
checks, 3 LOWs accepted). Under this policy that is a **complete** review — the earlier note
about "re-review with Codex once auth is restored" is void.
