# DenchClaw pipelines — canonical spec (funnel_type = "webinar")

Model note: add a `funnel_type` dimension above pipeline_key so a tenant can run multiple
pipeline variants. Seed these three as funnel_type="webinar". Each stage has mode:
auto = CRM advances it (from an event or a timer); manual = only a team member sets it,
and it serves as an enrollment trigger. The CRM must NEVER auto-advance a manual stage.

## Marketing pipeline (webinar)
1. prospects        (manual)  entry; imported from outreach lists
2. invitees         (auto)    set when an invite is dispatched on any channel
3. visits           (auto)    invitee visited the landing page from an invite/email
4. registrants      (auto)    visitor registered for the webinar on the landing page
5. auto_registrants (auto)    registered WITHOUT the form, from a channel signal:
                              - YES/MAYBE reply to a cold calendar invite
                              - "interested" reply to a cold email
                              - comment on a content post expressing interest
6. attendees        (auto)    registrant/auto-registrant attended the webinar

## Sales pipeline
- qualification_form_fills (auto)   filled qual form AND qualified, no call booked yet
- scheduled_call           (auto)   attendee booked the sales call
- no_show_followup_1        (manual) sales marks a no-show; FU sent immediately
- no_show_followup_2        (auto)   +3 days after FU1
- no_show_followup_3        (auto)   +3 days after FU2
- no_show_followup_4        (auto)   +3 days after FU3
- no_show_followup_5        (auto)   +1 week after FU4 (final)
- proposal_sent            (manual) sales marks when proposal is sent
- disqualified             (auto+manual) auto from qual criteria; sales may also set
- deals                    (manual) lead agrees to proceed / becomes paying client
- deal_followup_1          (manual) rep guidance: ~3 days after becoming a deal
- deal_followup_2          (manual) rep guidance: ~7 days
- deal_followup_3          (manual) rep guidance: ~12 days

## Delivery pipeline
- onboarding         (manual) paid client onboarded to Pro Delivery
- funnel_delivery    (manual) funnel engineering/experimentation, ~2-4 months
- coaching_delivery  (manual) coaching to scale, ~8 months (12 months total access)
- renewed            (manual) client renews subscription
- delivery_completed (manual) client does not renew

## Automation mappings (how stages drive sequences)
- No-Show ladder: entering no_show_followup_1 (manual) enrolls a "no-show recovery"
  sequence with steps at +0 / +3d / +6d / +9d / +16d. As each step fires, mirror the
  reporting stage to no_show_followup_1..5. Exit on reply or rebooking.
- Deal followups: MANUAL single sends per stage — no timer automation. Entering
  deal_followup_1/2/3 fires one message; the rep decides timing.
- Auto-Registrant: inbound channel event → interest classifier → set auto_registrants →
  enroll a "webinar reminder" sequence to drive attendance.
- attendees → enroll "qualification invite" sequence.
- qualification_form_fills (qualified) → "book your call" nudges; disqualified → disqualified.

## Open items the orchestrator must lock in spec (with the Codex critic), not guess:
- prospects/invitees mode (import vs set-on-send) — confirm auto-on-send for invitees.
- Whether followup-ladder steps write back the reporting stage as a step side-effect, or
  the stage is derived from the enrollment's current step (recommend: write-back side-effect,
  reusing CP2's scheduler, so the board reflects reality).
- Reconciliation with the legacy seeded stage names (mig 003/006) — ADD funnel-typed
  configs, do NOT rename/break the existing marketing/sales configs.
