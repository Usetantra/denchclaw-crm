# Goal-conformance audit — operator's spec vs what is actually built
**Re-run 2026-08-01 ~12:1x against the LIVE system.** The previous version of this file was
written at 04:39, before CP-B, CP-C, CP-C2, CP-D and the entire CP-Y arc. It listed four things as
not built. Every claim below is checked against **behaviour on a virgin DB**, not against
checkpoint names.

## Result: 10 passed / 0 failed. All four gaps are closed.

### Gap 1 — "every automated MARKETING stage is inert" → **CLOSED**

The funnel above `prospects` is now a mechanism, not a diagram. Each of these drove a real
contact through the real public endpoints:

| Goal (operator's words) | Result |
|---|---|
| **Visits** — invitees that visited the landing page from the invite | `stage='visits'` |
| **Registrants** — visitors who register from the landing page | `stage='registrants'` |
| **Auto-Registrants path 1** — YES/MAYBE to a cold **calendar invite** | `stage='auto_registrants'` |
| **Auto-Registrants path 2** — **reply expressing interest** to cold email | `stage='auto_registrants'` |
| **Auto-Registrants path 3** — **comment below a content post** | `stage='auto_registrants'` |
| **Attendees** — registrants who attend | `stage='attendees'` |

All **three** auto-registrant paths work — the specific detail that had been paraphrased out of
the old spec file and was therefore never built.

### Gap 2 — "no EP integrations / per-channel providers" → **CLOSED**
`email-resend.js`, `twilio-send.js` (SMS + WhatsApp), `unipile-send.js` (LinkedIn), all wired
through `executors.js`. LinkedIn executor status endpoint returns 200.

### Gap 3 — "no automations borrowed from the outreach/nurturing engines" → **CLOSED**
All six seed cleanly (200), across four channels:

    webinar_sales_no_show · webinar_marketing_invite_email · webinar_marketing_invite_sms
    webinar_marketing_invite_whatsapp · webinar_marketing_invite_linkedin · marketing_long_term_nurture

Seeded shape: Long-term nurture 10 steps (email) · LinkedIn invite 5 · SMS 2 · WhatsApp 2 ·
email invite 3 · No-Show ladder 5.

### Gap 4 — "`crm_pipeline_configs.automations` is empty on every row" → **NOT A GOAL VIOLATION**
Still empty (0 on all three webinar pipelines) — and that is correct. This was **my own** note
about an unused column, never something the operator asked for. The automations are implemented in
`sequences` + `sequence_steps`, which is the mechanism the dispatcher actually reads. I am
retracting this as a gap rather than leaving a scary zero in the record.

### Derived timing and the delivery pipeline
- **No-Show ladder** cumulative `[0, 3, 6, 9, 16]` days — exactly the operator's 0/+3d/+6d/+9d/+16d.
- **Delivery pipeline** all five stages: `onboarding · funnel_delivery · coaching_delivery ·
  renewed · delivery_completed`.

---

## One loose end found during this audit (NOT a goal violation)

`ai_call` is accepted by **five** whitelists — `sequences.js`, `templates.js`, `marketing.js`
invites, `inbox.js`, `marketing-events.js` — but `executors.js` wires only Resend, Twilio and
Unipile. Measured:

    step create on ai_call:      HTTP 201     ← accepted
    claim door hands out:        1 job        ← handed to a worker
    job state after claim:       status=claimed

So a job can be created and **claimed** on a channel nothing can send, and then strand. GOALS.md
never asks for AI calls, so this is not a conformance failure — it is the same shape as the CP-Y
class: **accepted at the front door with nothing behind it.** Dispatched as CP-Z, with a general
fix (refuse any channel that has no executor) rather than special-casing `ai_call`.
