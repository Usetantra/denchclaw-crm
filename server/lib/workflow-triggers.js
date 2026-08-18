'use strict';
// ─── Workflow trigger firing sites ───────────────────────────────────────────
// One place every domain event calls to say "this happened to this contact".
//
// WHY A WRAPPER RATHER THAN CALLING THE MODEL DIRECTLY
//
// These calls sit inside request paths that have already SUCCEEDED — the
// contact is created, the inbound message is stored, the unsubscribe is
// recorded. A workflow failing to enrol must never undo or fail any of that, so
// every call here is fire-and-forget with its own error containment. Doing that
// at each of the seven call sites invites one of them to be written without the
// `.catch`, and that one becomes a 500 on an unsubscribe.
//
// It is deliberately NOT awaited by callers. Enrolment writes several rows and
// materialises a queue; blocking an inbound-message webhook on that adds
// latency to a path whose whole job is to store a message quickly.

const sequenceDb = require('../db/models/sequences');

// Every event the UI can offer. Kept in lockstep with migration 041's CHECK and
// with the builder's dropdown — a value here with no firing site is exactly the
// failure mode (a trigger that silently never runs) this list exists to prevent,
// so each entry names where it fires.
const TRIGGER_EVENTS = Object.freeze({
  contact_created:    { label: 'A contact is created',            firesAt: 'POST /api/crm/contacts (incl. lead webhooks & imports)' },
  reply_received:     { label: 'A contact replies',               firesAt: 'inbound message on any channel', config: ['channel'] },
  webinar_registered: { label: 'A contact registers for an event', firesAt: 'marketing event: registration' },
  webinar_attended:   { label: 'A contact attends an event',      firesAt: 'marketing event: attendance' },
  webinar_no_show:    { label: 'A contact no-shows an event',     firesAt: 'marketing event: no_show' },
  unsubscribed:       { label: 'A contact unsubscribes',          firesAt: 'suppression added (STOP, one-click, manual)', config: ['channel'] },
});

const EVENT_KEYS = Object.freeze(Object.keys(TRIGGER_EVENTS));

// Fire-and-forget. Returns nothing on purpose: no caller should branch on
// whether a workflow happened to be listening.
function fire(companyId, contactId, event, config = {}) {
  if (!companyId || !contactId || !EVENT_KEYS.includes(event)) return;
  Promise.resolve()
    .then(() => sequenceDb.enrollForTriggerEvent(companyId, contactId, event, config))
    .catch((err) => {
      // enrollForTriggerEvent already contains its own failures and writes them
      // to the contact timeline; this is the last-resort net so an unexpected
      // throw can never become an unhandled rejection that takes the process
      // down under pm2.
      console.error(`[CRM][workflow-trigger] ${event} failed for ${contactId}: ${err.message}`);
    });
}

module.exports = { fire, TRIGGER_EVENTS, EVENT_KEYS };
