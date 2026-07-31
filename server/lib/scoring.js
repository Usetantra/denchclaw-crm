'use strict';
// ─── Lead scoring — single authority ─────────────────────────────────────────
// Product spec: "Engagement & the Unified AI Inbox". Both the activity feed and
// the Unified AI Inbox feed the lead score through recordEngagement() so there
// is exactly one place that owns the weight table and the label thresholds.

const { query } = require('../db/index');
const contactDb = require('../db/models/contacts');

// Each qualifying engagement event bumps the numeric lead score by its weight.
// Events not listed here (notes, stage_change, personalization context, message
// sends) are still logged to the activity feed but score 0.
const ENGAGEMENT_WEIGHTS = {
  email_opened: 2,
  email_clicked: 5,
  email_replied: 10,
  whatsapp_read: 3,
  whatsapp_replied: 10,
  sms_replied: 8,
  linkedin_connection_accepted: 5,
  linkedin_message_replied: 10,
  video_watched: 15,
  video_completed: 20,
  call_booked: 25,
  call_completed: 30,
  form_submitted: 15,
  registered: 15,
  cta_clicked: 10,
  proposal_viewed: 15,
  payment: 50,
};

// Log an activity entry to the contact's append-only feed and, when the entry is
// a scoring engagement event, bump the numeric lead score (capped at 100) and
// ratchet the label up: score crossing 80 → hot; a cold contact crossing 50 →
// warm. The ratchet is upgrade-only (it never downgrades a label). Tenant-scoped:
// returns false if the contact is missing or belongs to another company.
async function recordEngagement(contactId, companyId, entry) {
  const timestamped = { ...entry, timestamp: entry.timestamp || new Date().toISOString() };

  // addActivity is the tenant guard: false ⇒ missing/cross-tenant ⇒ don't score.
  const ok = await contactDb.addActivity(contactId, timestamped, companyId);
  if (!ok) return false;

  const weight = ENGAGEMENT_WEIGHTS[entry.type] || 0;
  const bumped = await query(
    `UPDATE contacts
        SET lead_score_numeric = LEAST(COALESCE(lead_score_numeric, 0) + $1, 100),
            updated_at = now()
      WHERE id = $2 AND company_id = $3
      RETURNING lead_score_numeric, lead_score`,
    [weight, contactId, companyId]
  );
  const row = bumped.rows[0];
  if (!row) return true; // activity logged; contact vanished mid-call — nothing to score

  const es = row.lead_score_numeric;
  const current = row.lead_score;
  let label = null;
  if (es >= 80 && current !== 'hot') label = 'hot';
  else if (es >= 50 && current === 'cold') label = 'warm';
  if (label) {
    await query(
      `UPDATE contacts SET lead_score = $1, updated_at = now() WHERE id = $2 AND company_id = $3`,
      [label, contactId, companyId]
    );
  }
  return true;
}

module.exports = { ENGAGEMENT_WEIGHTS, recordEngagement };
