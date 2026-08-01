# Goal-conformance audit — operator's pipeline spec vs what is actually built
Run 2026-08-01 by the orchestrator against the live schema and code. Every line verified.

## ✅ CONFORMS — the pipeline SPINE is built and matches your spec exactly

**Marketing (`webinar_marketing`, funnel_type=webinar, entity=contact)** — 6 stages:
`prospects` (manual) → `invitees` (auto) → `visits` (auto) → `registrants` (auto) →
`auto_registrants` (auto) → `attendees` (auto). Matches.

**Sales (`webinar_sales`, entity=deal)** — all 13 stages, **every mode exactly as specified**:
`qualification_form_fills` auto · `scheduled_call` auto · `no_show_followup_1` **manual** ·
`no_show_followup_2..5` auto · `proposal_sent` **manual** · `disqualified` auto ·
`deals` **manual** · `deal_followup_1..3` **manual**.

**Delivery (`webinar_delivery`, entity=deal)** — 5 stages: `onboarding`, `funnel_delivery`,
`coaching_delivery`, `renewed`, `delivery_completed`. Matches.

**No-Show ladder timing matches:** FU1 immediate, +3d, +3d, +3d, +1 week ⇒ cumulative
0 / +3d / +6d / +9d / +16d. Verified live by measuring `scheduled_for` deltas (CP2 E13).

**Deal follow-ups are manual with no timers** — correct per spec ("the sales team will mark
leads as Deal Followup N manually as needed").

**The manual/automated distinction is enforced, not decorative.** Verified repeatedly: the CRM
returns `403 "Stage 'no_show_followup_1' is manual — only a human may set it"` to a programmatic
advance, while a human advance succeeds. That invariant survives the scheduler (CP2 E9) and the
new stage-chip UI (CP-I I23).

## ❌ DOES NOT CONFORM — the automation LIMBS are largely not built

1. **The automated MARKETING stages are inert.** `visits`, `registrants`, `auto_registrants`,
   `attendees` and `invitees` appear in **ZERO server files** (`git grep` over `server/`).
   Nothing ever moves a contact into them. The spec calls all of them "(automated)" — today they
   are declared in config and nothing drives them. The whole marketing funnel above
   `prospects` is currently a diagram, not a mechanism. **This is the single biggest goal gap.**
   Needed: landing-page visit ingestion, registration-form ingestion, the three auto-registrant
   paths (calendar YES/MAYBE, cold-email interest reply, content-post comment), and webinar
   attendance ingestion.

2. **Nothing sends, on any channel.** No polling executor exists; `sendEmail` is called only from
   human-facing routes. 32 email jobs sit due-and-pending with nobody to send them.

3. **There is no message content.** `scheduled_actions.payload` is `'{}'::jsonb`;
   `sequence_steps` carries only `template_ref TEXT`; no subject or body exists anywhere in the
   schema. This blocks (2) — an executor would send blank mail.

4. **No EP/provider integrations for non-email channels.** `email`, `sms`, `whatsapp`,
   `linkedin`, `ai_call` are declared as valid channels, but the only provider in the CRM is
   Resend (email) plus a Cloudflare inbound-email worker. Unipile (LinkedIn), Twilio (SMS/
   WhatsApp) and any AI-call provider are **not wired**. The goal names "different EP integrations
   and different providers for different channels" — that is unbuilt.

5. **No real automations are configured.** `crm_pipeline_configs.automations` is empty on every
   row (0 configs carry automations); every sequence in the DB is a test fixture.

## Honest summary

**The system of record is real and verified. The orchestration brain is half-built:** it decides
correctly (stages, modes, gating, laddering, timing) and it can show a human what happened, but it
cannot yet observe the world (marketing-stage ingestion) or act on it (sending). Goal B's
"always-on orchestration brain firing every outreach automation" is **not achieved yet**, and the
ordered path to it is: content store → email executor → per-channel executors → marketing-stage
ingestion.
