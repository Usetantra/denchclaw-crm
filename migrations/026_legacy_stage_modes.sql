-- DenchClaw CRM — Migration 026: declare `mode` on the legacy pipelines (CP-Y)
-- Additive/idempotent.
--
-- THE DEFECT THIS CLOSES, stated plainly because it reached a real deal shape:
-- a sequence step moved a $50,000 deal to **Won**, with no human involved.
--
-- `applyStageWriteback` asked `isManualStage(...)` — "is this stage declared
-- manual?" — which answers FALSE for a stage that declares nothing. Migration
-- 003 created the legacy `marketing` and `sales` pipelines with NO `mode` on any
-- stage, so on those two pipelines the automation gate was open and the only
-- remaining guard was transition legality. `onboarding → won` is legal.
--
-- The code fix is the important half: `mayAutomationSetStage` asks the POSITIVE
-- question, so absent mode now means "a human owns it" and the hole is closed
-- for any pipeline anyone ever creates, including ones that predate this file.
-- This migration is the other half — saying out loud which legacy stages a robot
-- may set, so the answer is a decision on the record rather than a default.
--
-- HOW EACH MODE WAS CHOSEN. Not invented: every legacy stage is matched to the
-- stage that plays its role in the operator's own funnel-typed pipelines
-- (migration 018), where the operator declared the modes themselves.
--
--   marketing/* → ALL auto. These are the engines' own funnel stages —
--     sourced/enriched/segmented/queued are ingestion and routing; `engaged` is
--     "we sent something"; `responded` is an inbound reply (and MUST stay auto —
--     conversations.js advances to it on every inbound message, which
--     unit-cp1 E5 asserts); `mql` follows lead scoring; `suppressed` is an
--     opt-out and has to take effect without waiting for a person.
--
--   sales/accepted, contacted, qualified → auto. Engine-set on a reply or a
--     send; `qualified` mirrors `qualification_form_fills`, which the operator
--     declared auto because a form drives it.
--   sales/booked → auto (added by migration 006), mirroring `scheduled_call`:
--     "all attendees that scheduled the sales call" — a booking tool sets it.
--   sales/nurture → auto (also migration 006), matching marketing/nurture: a
--     routing decision the engines make, not a judgement a person renders.
--   sales/unqualified → auto, mirroring `disqualified` ("Automated + Manual",
--     declared auto — criteria decide it, and a human can still set it too).
--   sales/no_show → MANUAL, mirroring `no_show_followup_1`: "the sales team
--     marks these manually".
--   sales/proposal → MANUAL, mirroring `proposal_sent`.
--   sales/negotiation → MANUAL. No counterpart, and negotiating is a person.
--   sales/onboarding → MANUAL, mirroring the delivery pipeline's `onboarding`.
--   sales/won, sales/lost → MANUAL. Money changed hands, or it did not. That is
--     the single most consequential fact in the system and a human confirms it.
--
-- Applied to the GLOBAL rows and to any tenant copy, but ONLY to stages that do
-- not already declare a mode — a tenant who has already made a deliberate choice
-- keeps it.

BEGIN;

-- Rewrites `stages`, preserving every other key on each stage object and filling
-- in `mode` only where it is absent. Unknown stage keys (a tenant's own addition
-- to a legacy pipeline) are left completely untouched, so this cannot
-- accidentally declare something automatable that nobody described.
WITH modes(pipeline_key, stage_key, mode) AS (
  VALUES
    ('marketing','sourced','auto'),    ('marketing','enriched','auto'),
    ('marketing','segmented','auto'),  ('marketing','queued','auto'),
    ('marketing','engaged','auto'),    ('marketing','responded','auto'),
    ('marketing','mql','auto'),        ('marketing','nurture','auto'),
    ('marketing','suppressed','auto'),
    ('sales','accepted','auto'),       ('sales','contacted','auto'),
    ('sales','booked','auto'),         ('sales','nurture','auto'),
    ('sales','qualified','auto'),      ('sales','unqualified','auto'),
    ('sales','no_show','manual'),      ('sales','proposal','manual'),
    ('sales','negotiation','manual'),  ('sales','onboarding','manual'),
    ('sales','won','manual'),          ('sales','lost','manual')
),
rewritten AS (
  SELECT c.id,
         jsonb_agg(
           CASE
             WHEN st ? 'mode' THEN st
             WHEN m.mode IS NOT NULL THEN st || jsonb_build_object('mode', m.mode)
             ELSE st
           END
           ORDER BY ord
         ) AS stages
    FROM crm_pipeline_configs c
    CROSS JOIN LATERAL jsonb_array_elements(c.stages) WITH ORDINALITY AS e(st, ord)
    LEFT JOIN modes m ON m.pipeline_key = c.key AND m.stage_key = st->>'key'
   WHERE c.key IN ('marketing','sales')
   GROUP BY c.id
)
UPDATE crm_pipeline_configs c
   SET stages = r.stages, updated_at = now()
  FROM rewritten r
 WHERE c.id = r.id AND c.stages IS DISTINCT FROM r.stages;

COMMIT;
