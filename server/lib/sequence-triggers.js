'use strict';
// ─── Sequence triggers (Goal B2 + exit hooks) ─────────────────────────────────
// The glue between pipeline events and the sequence engine. Kept side-effect-safe:
// every hook is wrapped by callers so a trigger failure NEVER breaks the stage
// transition / inbound message it rode in on. Enrollment + exit both flow through
// the sequences DAL so the compliance gate and dispatcher stay the single path.
const seq = require('../db/models/sequences');

// A contact entered `stage` in `pipelineKey`. Enroll into any active sequence
// triggered by that stage, and exit active enrollments configured to stop on a
// stage change. Returns a small summary for logging/response.
async function onStageEnter(companyId, contactId, pipelineKey, stage) {
  const summary = { enrolled: [], exited: 0 };

  // Exit enrollments whose sequence says "stop when the contact changes stage",
  // except a sequence that itself triggers on THIS stage (it's (re)starting).
  const active = await seq.listEnrollments(companyId, { contactId, status: 'active' });
  for (const e of active) {
    const s = await seq.get(companyId, e.sequence_id);
    if (!s) continue;
    const ec = s.exit_conditions || {};
    if (ec.on_stage_change && !(s.trigger_stage === stage)) {
      await seq.exitEnrollment(companyId, e.id, 'stage_changed');
      summary.exited++;
    }
  }

  // Enroll into sequences triggered by this stage.
  const triggers = await seq.activeForStageTrigger(companyId, pipelineKey, stage);
  for (const s of triggers) {
    const r = await seq.enroll(companyId, s.id, contactId, { enrolledBy: 'stage_trigger' });
    if (r.created) summary.enrolled.push({ sequence_id: s.id, enrollment_id: r.enrollment.id });
  }
  return summary;
}

// A contact replied on some channel — exit enrollments configured to stop on reply.
async function onReply(companyId, contactId) {
  let exited = 0;
  const active = await seq.listEnrollments(companyId, { contactId, status: 'active' });
  for (const e of active) {
    const s = await seq.get(companyId, e.sequence_id);
    if (s && (s.exit_conditions || {}).on_reply) { await seq.exitEnrollment(companyId, e.id, 'replied'); exited++; }
  }
  return exited;
}

// A contact opted out / was suppressed — exit ALL active enrollments (a hard stop
// independent of per-sequence exit config).
async function onSuppressed(companyId, contactId) {
  return seq.exitContact(companyId, contactId, 'suppressed');
}

module.exports = { onStageEnter, onReply, onSuppressed };
