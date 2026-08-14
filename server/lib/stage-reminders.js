'use strict';
// ─── Stage-linked follow-up reminders ──────────────────────────────────────
// A pipeline stage may carry an optional `reminder_days` number (stored right
// in crm_pipeline_configs.stages JSONB — additive, no migration needed for
// that half). Landing on such a stage auto-creates a PENDING task due that
// many days out. This is the missing piece behind the operator's own
// decision that deal follow-ups are manual, not automated: the CRM has never
// SURFACED that a human should act, only recorded that they should
// eventually. This never sends anything itself — it only creates a reminder
// a human sees and acts on (or ignores).
const tasksDb = require('../db/models/tasks');

async function maybeCreateStageReminder({ companyId, contactId, dealId, contactName, dealTitle, pipeline, pipelineKey, stage }) {
  const stageCfg = (pipeline.stages || []).find(s => s.key === stage);
  const days = stageCfg && Number(stageCfg.reminder_days);
  if (!days || days <= 0) return null;

  const dueAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const who = dealTitle || contactName || 'this contact';
  const title = `Follow up — ${who} is in "${stageCfg.name || stage}"`;
  try {
    return await tasksDb.createAutoIfAbsent(companyId, {
      contactId, dealId, title, dueAt, sourcePipelineKey: pipelineKey, sourceStageKey: stage,
    });
  } catch (e) {
    // A reminder failing to create must never block or roll back the stage
    // advance itself — the stage change is the real event, the reminder is a
    // convenience on top of it.
    console.error('[stage-reminders] failed to create auto reminder:', e.message);
    return null;
  }
}

module.exports = { maybeCreateStageReminder };
