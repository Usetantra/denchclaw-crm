# Cross-engine research prompts — consolidation planning (2026-07-05)

> **Decided lens (2026-07-05):** the target is a **productized, multi-tenant** platform
> (each customer org is a tenant), consolidating workflow *definitions* + *orchestration*
> into the always-on DenchClaw CRM, leaving engines as thin channel *executors*. Weight
> the **Tenancy** and **Channel credentials** sections heavily — every place the engine
> assumes a single tenant, or reads a global secret / global rate-limit, is a productization
> blocker we must catalog now.

Run **one per engine repo** (outreach, nurturing, content, and automation_core/shared).
Open a Claude Code session **inside that repo** and paste the matching block. Each
asks for a structured report I can synthesize into the consolidation spec. Save each
report as `CONSOLIDATION_RECON_<engine>.md` and share it back.

---

## TEMPLATE (works for any engine — fill the {ENGINE} name)

> You are doing architecture reconnaissance on the **{ENGINE}** for a consolidation
> decision: we are evaluating moving workflow *definitions* and *orchestration* out of
> the individual engines and into the always-on DenchClaw CRM (system of record),
> leaving each engine as a thin, stateless channel *executor*. Do NOT change any code.
> Produce a single markdown report `CONSOLIDATION_RECON_{ENGINE}.md` with these sections,
> each backed by concrete file:line references and real snippets (no hand-waving):
>
> 1. **Workflow / sequence inventory** — every sequence, campaign, journey, or drip this
>    engine can run. For each: where it's defined (hardcoded / DB rows / config file),
>    its steps, channels, timing/delays, and entry/exit conditions.
> 2. **Trigger model** — what actually starts and advances a sequence: a stage change? a
>    webhook? a cron tick? a manual call? How does the engine learn a prospect's pipeline
>    stage — does it read DenchClaw, or keep its own copy of stage/state?
> 3. **State & data model** — list every DB table this engine owns (schema + purpose),
>    especially prospect_inbox / campaigns / campaign_events / enrollments / schedules.
>    Mark which columns duplicate data that DenchClaw is authoritative for.
> 4. **Tenancy** — is there ANY company_id / tenant / workspace concept? Is it hardcoded
>    single-tenant? How are config, secrets, and rate limits scoped — globally or per
>    tenant? Quote the exact code that would break if two tenants ran on one deployment.
> 5. **Channel integrations** — for each channel (email, WhatsApp, SMS, AI calling,
>    LinkedIn, other): the provider/SDK used, where the actual send happens (file:line),
>    how credentials are supplied, and any rate-limit / quiet-hours / suppression logic.
> 6. **Autonomous runtime** — the always-on machinery: schedulers, workers, cron jobs,
>    queues, pollers. What process runs, how often, with what concurrency, and what
>    happens if it's down.
> 7. **DenchClaw coupling** — every inbound/outbound call to the CRM (endpoints, the
>    automation_core CRM client, prospect_inbox push/poll). What it reads vs writes.
> 8. **Executor delta** — split this engine's code into (a) ORCHESTRATION/decision logic
>    that could move to a central brain, and (b) pure CHANNEL EXECUTION that must stay
>    near the provider. Estimate rough LOC/%, and name the top 3 things that would break
>    if orchestration moved to the CRM.
>
> Be exhaustive and precise. Use the codebase-memory graph / search first, then read the
> hot files. End with a 5-bullet "consolidation readiness" summary.

---

## Per-engine emphasis (add to the template for that engine)

**Outreach engine** — also cover: the prospect-sourcing/scraping path, LinkedIn
automation (Expandi/headless?), the `push_prospect` / `_handoff_to_nurturing` handoff
producer, and how a "campaign" maps to pipeline stages.

**Nurturing engine** — also cover: the `dispatcher.drain_handoffs` consumer, campaign
enrollment + `campaign_events` writes, the marketing-stage advancement logic, and
whether ANY nurturing feature does NOT need to be always-on.

**Content engine** — also cover: is this request/response (generate an asset on demand)
or does it run autonomous loops? What would it look like purely as a service the central
orchestrator calls for generated content mid-sequence?

**automation_core / automation-engines-shared** — also cover: the shared
`automation_core.campaigns` (push/poll/mark — memory says 0 callers) and any shared CRM
client interface; is this the natural home for a shared "sequence engine" contract, or
should that live in DenchClaw?

---

## What I'll do with these
Synthesize a single target architecture + phased migration spec: what moves into
DenchClaw (workflow definitions + orchestration + multi-tenant state), what stays as a
channel executor, the CRM-owned data model (sequences / steps / enrollments /
scheduled_actions, all company_id-scoped), and the cutover order that never takes the
pipeline offline.
