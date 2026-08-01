'use strict';
// ─── The contact-entity stage authority, in ONE place ────────────────────────
//
// This is the body of `POST /api/crm/contacts/:id/advance`'s contact branch,
// lifted out verbatim so that it has exactly one implementation.
//
// WHY IT WAS EXTRACTED (CP-B):
// Marketing-stage ingestion has to move contacts into `visits`, `registrants`,
// `auto_registrants` and `attendees` on its own initiative. There were only three
// ways to give it that ability:
//
//   1. Duplicate the gates in the ingest path. Rejected outright — this is the
//      exact failure mode of "enforce at the door, not in comments". Two copies
//      of a rule that is allowed to drift is one copy of the rule.
//   2. Have the ingest self-call /advance over HTTP loopback (the pattern
//      routes/webhooks.js uses). Rejected: that path needs INTERNAL_API_KEY, so
//      marketing ingestion would silently fail closed in any deployment that
//      hadn't set it, and it would put a second authentication surface in front
//      of a call that already knows its own tenant.
//   3. Extract. Done.
//
// THE INVARIANT THIS FILE PROTECTS, above every other consideration:
//   THE CRM MUST NEVER AUTO-ADVANCE A MANUAL STAGE.
// `automated: true` marks a programmatic caller, and a funnel-typed stage with
// mode:'manual' then refuses with 403 / `manual_stage`. That check runs BEFORE
// transition legality, because "a robot may not set this" is the stronger rule:
// a legal transition into a manual stage is still forbidden.
//
// KNOWN LIMITATION, unchanged by this extraction and stated here so it is not
// rediscovered as a bug: the `automated` flag is honour-system. Engines and
// humans share one API-key auth today, so a caller that simply omits the flag is
// indistinguishable from a human. Principal-based derivation needs A7's identity
// work. This is a correctness seam for well-behaved automation — every CRM-owned
// programmatic caller (the CP2 scheduler, and now CP-B's marketing ingest) sets
// it — NOT a security boundary. Do not treat it as one.
//
// Returns a result object carrying BOTH an HTTP-shaped `{status, body}` (so the
// route stays byte-identical to its pre-extraction responses) and the structured
// fields a non-HTTP caller needs (`changed`, `previous`, `code`).

const { query } = require('../db/index');
const { getPipelineTransitions, isManualStage } = require('../db/pipeline');
const sequenceDb = require('../db/models/sequences');
const limitDb = require('../db/models/limits');

/**
 * Advance a contact through a contact-entity pipeline.
 *
 * @param {object}   o
 * @param {string}   o.companyId
 * @param {object}   o.contact         a contacts row (needs id + marketing_stage)
 * @param {string}   o.pipelineKey
 * @param {object}   o.pipeline        a getPipelineConfig() result
 * @param {string}   o.stage           the target stage key
 * @param {boolean}  o.automated       true ⇒ programmatic caller; manual stages 403
 * @param {string=}  o.reason
 * @param {string=}  o.actor
 * @param {function} o.recordActivity  (contactId, companyId, entry) => Promise
 *        Injected rather than imported: the activity recorder lives on the crm
 *        router (it also does engagement scoring), and importing a route module
 *        from a lib is how you get a require cycle.
 */
/**
 * THE INVARIANT, in one function.
 *
 * "The CRM must never auto-advance a manual stage" applied to four call sites
 * with genuinely different mechanics: the contact branch of /advance (which
 * this file owns end to end), the DEAL branch of /advance, deal CREATION, and
 * PATCH /deals/:id stage. The deal paths cannot call advanceContactStage —
 * they move `deals.stage`, not `contacts.marketing_stage`, and their
 * surrounding lookup, activity and write-back differ.
 *
 * What they CAN share is the rule itself. Four copies of the check and four
 * copies of the 403 body is four chances to drift, on the one invariant that
 * outranks everything else in this system — and the failure mode of drift here
 * is the CRM silently advancing a stage a human was supposed to own.
 *
 * Returns null when the caller may proceed, or a ready-to-send
 * `{ status, body }` refusal. Callers that already differ in shape stay
 * different; only the decision is centralised.
 */
function manualStageRefusal({ pipeline, pipelineKey, stage, automated }) {
  if (!automated) return null;              // a human may set anything legal
  if (!isManualStage(pipeline, stage)) return null;
  return {
    status: 403,
    body: {
      error: `Stage '${stage}' is manual — only a human may set it`,
      error_code: 'manual_stage', pipeline_key: pipelineKey, requested: stage,
    },
  };
}

async function advanceContactStage({
  companyId, contact, pipelineKey, pipeline, stage,
  automated = false, reason = null, actor = null, recordActivity,
}) {
  const currentStage = contact.marketing_stage || 'sourced';

  // Already there. Idempotent, and NOT a stage change — so it must not fire
  // sequence enrollment. A re-delivered provider webhook lands here constantly.
  if (currentStage === stage) {
    return {
      ok: true, changed: false, code: 'no_change', previous: currentStage, stage,
      status: 200,
      body: { contact_id: contact.id, pipeline_key: pipelineKey, stage, previous: currentStage, changed: false },
    };
  }

  // Mode gate FIRST — see the header. Stronger than transition legality.
  // The decision lives in manualStageRefusal() so the deal paths in crm.js
  // enforce the identical rule rather than their own copy of it.
  const refusal = manualStageRefusal({ pipeline, pipelineKey, stage, automated });
  if (refusal) {
    return {
      ok: false, changed: false, code: 'manual_stage', previous: currentStage, stage,
      status: refusal.status, body: refusal.body,
    };
  }

  const stageKeys = pipeline.stages.map(s => s.key);
  if (stageKeys.includes(currentStage)) {
    const allowed = getPipelineTransitions(pipeline, currentStage);
    if (!allowed.includes(stage)) {
      return {
        ok: false, changed: false, code: 'illegal_transition', previous: currentStage, stage,
        status: 409,
        body: { error: 'Illegal stage transition', current: currentStage, requested: stage, allowed },
      };
    }
  } else {
    // Entry rule (CP1 decision 5): a contact currently outside pipeline P may
    // enter P only at its first stage. Refusals: a 'suppressed' contact, and an
    // active all-channel suppression row (A5) — entering a new pipeline must
    // not be a suppression escape.
    if (currentStage === 'suppressed') {
      return {
        ok: false, changed: false, code: 'suppressed', previous: currentStage, stage,
        status: 409,
        body: {
          error: `Contact is suppressed and may not enter pipeline '${pipelineKey}'`,
          current: currentStage, requested: stage, allowed: [],
        },
      };
    }
    if (await limitDb.isSuppressed(companyId, contact.id, null)) {
      return {
        ok: false, changed: false, code: 'suppressed', previous: currentStage, stage,
        status: 409,
        body: {
          error: `Contact has an active all-channel suppression and may not enter pipeline '${pipelineKey}'`,
          current: currentStage, requested: stage, allowed: [],
        },
      };
    }
    if (stage !== stageKeys[0]) {
      return {
        ok: false, changed: false, code: 'not_in_pipeline', previous: currentStage, stage,
        status: 409,
        body: {
          error: `Contact is not in pipeline '${pipelineKey}' — entry is only allowed at its first stage`,
          current: currentStage, requested: stage, allowed: stageKeys.length ? [stageKeys[0]] : [],
        },
      };
    }
  }

  // Update both marketing_stage and the legacy deal_stage mirror
  await query(
    `UPDATE contacts SET marketing_stage=$1, deal_stage=$1, updated_at=now() WHERE id=$2 AND company_id=$3`,
    [stage, contact.id, companyId]
  );

  if (recordActivity) {
    await recordActivity(contact.id, companyId, {
      type: 'stage_change',
      message: `${pipelineKey === 'marketing' ? 'Marketing stage' : `Stage (${pipelineKey})`}: ${currentStage} → ${stage}${reason ? ' (' + reason + ')' : ''}`,
      agent: actor || 'system',
      channel: null,
      data: { pipeline_key: pipelineKey, from: currentStage, to: stage, reason: reason || null },
    });
  }

  // GOAL B2: a real (non-idempotent) stage transition auto-enrolls the contact
  // into any active sequence configured to trigger on this stage. Ingestion
  // reaching this line is the whole point of CP-B — an observed registration
  // must start the same follow-up ladder a hand-typed one starts.
  const sequenceEnrollments = await sequenceDb.enrollForTriggerStage(companyId, contact.id, pipelineKey, stage);

  return {
    ok: true, changed: true, code: 'advanced', previous: currentStage, stage,
    sequence_enrollments: sequenceEnrollments,
    status: 200,
    body: {
      contact_id: contact.id, pipeline_key: pipelineKey, stage, previous: currentStage, changed: true,
      ...(sequenceEnrollments.length ? { sequence_enrollments: sequenceEnrollments } : {}),
    },
  };
}

module.exports = { advanceContactStage, manualStageRefusal };
