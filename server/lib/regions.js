'use strict';
// ─── Regional policy layer ────────────────────────────────────────────────────
// Compliance rules that differ by destination region are expressed as data, so a
// new region is a config entry — not a code change. Keyed by ISO-2 country code
// with sensible group fallbacks. Consumed by the pre-send compliance gate and the
// UI to decide sender type, required registrations, and consent expectations.
//
// Scope decided: US + EU + India first. Anything else resolves to DEFAULT.

const EU_ISO2 = new Set([
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV',
  'LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','GB', // GB grouped for consent posture
]);

// Per-region policy. `smsSender` = preferred sender types in priority order.
// `smsRegistration` = what must be registered/approved before A2P SMS may send.
// `requiresTemplate` (SMS) flags markets (India DLT) where every SMS body must map
// to a pre-approved template. WhatsApp rules are globally uniform (only price varies),
// so WA policy is not region-forked here beyond consent.
const REGIONS = {
  US: {
    label: 'United States',
    smsSender: ['short_code', 'a2p_10dlc_long_code', 'toll_free'],
    smsRegistration: ['a2p_brand', 'a2p_campaign'],   // 10DLC brand+campaign mandatory
    smsAllowsAlphanumeric: false,
    smsRequiresTemplate: false,
    marketingConsent: 'written',                       // TCPA: prior express written consent
    stopKeywordsAuto: true,
    notes: 'A2P 10DLC brand+campaign required for long code; toll-free needs verification.',
  },
  EU: {
    label: 'European Union / UK',
    smsSender: ['alphanumeric', 'long_code'],
    smsRegistration: [],                               // some countries need sender-ID pre-registration (per-country)
    smsAllowsAlphanumeric: true,                       // one-way; STOP not auto-handled → inject opt-out text
    smsRequiresTemplate: false,
    marketingConsent: 'explicit',                      // GDPR: explicit opt-in
    stopKeywordsAuto: false,                           // alphanumeric one-way → provide manual opt-out
    notes: 'GDPR opt-in; alphanumeric sender IDs one-way, must include manual opt-out instructions.',
  },
  IN: {
    label: 'India',
    smsSender: ['dlt_sender_id'],
    smsRegistration: ['dlt_entity', 'dlt_sender_id', 'dlt_template'],
    smsAllowsAlphanumeric: true,                       // registered header only
    smsRequiresTemplate: true,                         // DLT: every SMS must map to an approved template
    marketingConsent: 'explicit',                      // DPDP + DLT
    stopKeywordsAuto: true,
    notes: 'TRAI DLT: Entity ID + Sender/Header + approved content Template ID required per send (SMS only, not WhatsApp).',
  },
  DEFAULT: {
    label: 'Other',
    smsSender: ['long_code'],
    smsRegistration: [],
    smsAllowsAlphanumeric: false,
    smsRequiresTemplate: false,
    marketingConsent: 'explicit',
    stopKeywordsAuto: true,
    notes: 'Default posture; verify local requirements before enabling.',
  },
};

function regionKeyFor(iso2) {
  const cc = String(iso2 || '').toUpperCase();
  if (cc === 'US') return 'US';
  if (cc === 'IN') return 'IN';
  if (EU_ISO2.has(cc)) return 'EU';
  return 'DEFAULT';
}

function policyFor(iso2) {
  return REGIONS[regionKeyFor(iso2)];
}

module.exports = { policyFor, regionKeyFor, REGIONS, EU_ISO2 };
