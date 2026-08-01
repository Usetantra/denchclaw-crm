# THE GOALS — operator's own words, verbatim. THIS FILE IS THE SOURCE OF TRUTH.

> Written 2026-08-01 after the operator said, for the third time, that the goals were not being
> produced or explained. **Root cause, verified:** `.loop/PIPELINES_SPEC.md` — the file every
> session was told to read first — was written in MY vocabulary (snake_case stage keys) and had
> LOST the operator's definitions. Six stage labels were absent verbatim; the three auto-registrant
> paths were absent; and the instruction to reuse the outreach/nurturing engines' automations with
> per-channel EP integrations appeared **nowhere** in any canonical doc — only in my own audit and
> log. That is why the automation limbs were never built: no builder was ever told to build them.
>
> **RULE: this file is quoted verbatim into every session prompt. Never paraphrase it, never
> replace it with a link, never let a stage key stand in for the operator's definition.**

---

## Framing (operator, verbatim)

"Here is way more context and detail about the different marketing and sales pipeline stages, on
the basis of which the automation workflows have to be designed **or borrowed from the existing
automation workflows that we've created within the outreach engine or the nurturing engine, with
different EP integrations and different providers for different channels**."

"All lead stages marked as 'automated' are automatically updated in the Denchclaw CRM setup, and
all lead stages marked as 'manual' are manually updated by different team members."

---

## Marketing Pipeline
*"These stages are specifically for webinars, so we also need to have a funnel type that defines
different types of marketing and sales pipelines."*

- **Prospects** — prospects from outreach lists that we can use for outreach.
- **Invitees** — prospects that have been sent invites on different channels.
- **Visits (automated)** — invitees that have visited the landing pages from the invites or invite emails.
- **Registrants (automated)** — visitors on the landing page that register for the webinar from the landing page.
- **Auto-Registrants (automated)** — invitees auto-registered as registrants **without** filling the
  form, for different invite/outreach channels. **Three paths, verbatim:**
  1. Invitees that respond **YES / MAYBE** to cold **calendar invite** outreach.
  2. Invitees that **reply and express interest** in joining the webinar for **cold email** outreach.
  3. Prospects that **comment below content posts** expressing interest in joining the webinar.
- **Attendees (automated)** — Registrants (or Auto-Registrants) that attend the webinar.

## Sales Pipeline

- **Qualification Form Fills (automated)** — anyone who fills the qualification form and is
  qualified, but hasn't scheduled the sales call yet.
- **Scheduled Call (automated)** — all attendees that scheduled the sales call.
- **No-Show Followup 1 (MANUAL)** — first followup for sales call bookers that are a no-show. The
  sales team marks these manually; **followups are sent immediately after the no-show or sales call**.
- **No-Show Followup 2 (automated)** — **3 days after** No-Show Followup 1.
- **No-Show Followup 3 (automated)** — **3 days after** No-Show Followup 2.
- **No-Show Followup 4 (automated)** — **3 days after** No-Show Followup 3.
- **No-Show Followup 5 (automated)** — fifth and final, **1 week after** No-Show Followup 4.
- **Proposal Sent (MANUAL)** — leads we sent the proposal to; sales team marks manually.
- **Disqualified (Automated + Manual)** — attendees who filled the qualification form and were
  disqualified on criteria; **the sales team can also mark any lead in the pipeline as disqualified**.
- **Deals (MANUAL)** — leads we've completed calls with that convert to clients and pay us. Marked
  manually once a lead expresses interest in proceeding.
- **Deal Followup 1 (MANUAL)** — for Deals that express interest but don't proceed to payment /
  don't respond **for 3 days** after becoming a deal.
- **Deal Followup 2 (MANUAL)** — same, **7 days** after they become a deal.
- **Deal Followup 3 (MANUAL)** — same, **12 days** after they become a deal.

## Delivery Pipeline

- **Onboarding** — new clients that became a deal with confirmed payment, onboarded to the Pro
  Delivery process.
- **Funnel Delivery** — post-Onboarding; funnel engineering and experimentation over a **2/4 month** period.
- **Coaching Delivery** — post-Funnel Delivery; coaching to scale and grow the funnel for **8 months**
  (net **12 months** access to coaching, community and learning material).
- **Renewed** — post-Coaching Delivery; the client renews the subscription to retain access.
- **Delivery Completed** — post-Coaching Delivery; the client chooses **not** to renew.

---

## Derived timing (do not re-derive)
No-Show ladder, cumulative from FU1: **0 / +3d / +6d / +9d / +16d**.
Deal followups are **MANUAL** — the 3/7/12-day figures describe *when a human should act*, not timers.

## Status against these goals, 2026-08-01
**BUILT AND VERIFIED:** all three pipelines with `funnel_type='webinar'`; all 24 stages; every
manual/automated mode exactly as above; the No-Show ladder timing proven by measured deltas; the
manual-stage invariant genuinely enforced (403 to a programmatic advance); enrollment on stage
change; step scheduling; unified inbox; message content store; email executor.

**NOT BUILT — and this is what remains:**
1. **Every automated MARKETING stage is inert.** `visits`, `registrants`, `auto_registrants`,
   `attendees`, `invitees` appear in **zero server files**. Nothing ingests landing-page visits,
   form registrations, the three auto-registrant paths, or webinar attendance. The marketing funnel
   above `prospects` is a diagram, not a mechanism.
2. **No EP integrations / per-channel providers.** `email`, `sms`, `whatsapp`, `linkedin`, `ai_call`
   are declared valid channels; only Resend (email) exists. Unipile (LinkedIn), Twilio (SMS/
   WhatsApp) and any AI-call provider are unwired.
3. **No automations borrowed from the outreach/nurturing engines** — the operator asked for this
   explicitly and it has never been scoped.
4. `crm_pipeline_configs.automations` is empty on every row.
