'use strict';
// ─── Pre-send compliance gate ─────────────────────────────────────────────────
// The single chokepoint every outbound message passes through. Returns
// { allowed, reason, code, meta } — the caller must not send when allowed=false.
// Channel-agnostic; the strict checks apply to whatsapp/sms. email/linkedin have
// their own consent models (unsubscribe / connection) and are passed through here,
// so wiring this gate in front of them is non-breaking.
const consent = require('../db/models/consent');
const suppression = require('../db/models/suppression');
const { policyFor } = require('./regions');

const STRICT = new Set(['whatsapp', 'sms']);

// category → required consent tier
function neededConsent(category) {
  if (category === 'marketing') return 'marketing';
  if (category === 'authentication' || category === 'utility' || category === 'transactional') return 'transactional';
  return 'conversational';
}

function block(code, reason, meta) { return { allowed: false, code, reason, meta: meta || {} }; }
function pass(meta) { return { allowed: true, meta: meta || {} }; }

// ctx: { companyId, channel, contact, identifier, category, program,
//        windowOpen (wa), template (wa/india), clientSendKey, destinationCountry }
async function check(ctx) {
  const { companyId, channel, contact } = ctx;
  if (!STRICT.has(channel)) return pass({ skipped: 'non-strict channel' });

  const identifier = suppression.norm(ctx.identifier || (contact && (contact.phone || contact.wa_id)) || '');
  if (!identifier) return block('no_identifier', `no ${channel} address for this contact`);

  // 1) Suppression — hard stop (STOP/opt-out/hard-fail).
  if (await suppression.isSuppressed(companyId, channel, identifier)) {
    return block('suppressed', 'recipient has opted out / is suppressed on this channel');
  }

  // 2) Consent — must cover the message category (never auto-escalate).
  const category = ctx.category || 'conversational';
  const need = neededConsent(category);
  if (need !== 'conversational') {
    const ok = contact && await consent.has(companyId, contact.id, channel, need, ctx.program || 'default');
    if (!ok) return block('no_consent', `no valid ${need} consent on ${channel} for a ${category} message`);
  }

  // 3) Channel-specific messaging rules.
  const region = policyFor(ctx.destinationCountry || (contact && contact.destination_country));

  if (channel === 'whatsapp') {
    // Outside the 24h customer-service window → template-only (approved template required).
    if (!ctx.windowOpen) {
      if (!ctx.template) return block('window_closed', 'outside the 24h window — an approved template is required', { requiresTemplate: true });
      if (ctx.template.status !== 'APPROVED' && ctx.template.status !== 'FLAGGED') {
        return block('template_not_approved', `template is ${ctx.template.status}, not APPROVED`, { requiresTemplate: true });
      }
    }
  }

  if (channel === 'sms') {
    // India DLT: every SMS must map to an approved template.
    if (region.smsRequiresTemplate && !(ctx.template && ctx.template.status === 'APPROVED')) {
      return block('dlt_template_required', 'India DLT requires an approved template for every SMS', { region: 'IN' });
    }
  }

  // 4) Idempotency — caller supplies a stable client_send_key; the DB unique index
  //    is the real guard, this is an advisory field passed through.
  return pass({ identifier, category, need, region: region.label, windowOpen: !!ctx.windowOpen });
}

module.exports = { check, neededConsent, STRICT };
