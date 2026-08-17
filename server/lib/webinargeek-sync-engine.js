'use strict';
// ─── WebinarGeek sync engine ────────────────────────────────────────────────
// Pure processing of a page of WebinarGeek `subscription` objects (see
// server/lib/webinargeek-client.js) into CRM contacts + activity. Split out
// of the settings.js route so it's testable against real DB models with fake
// subscription data — no network call needed to exercise this logic.
async function processSubscriptions(companyId, subscriptions, { findOrCreateContact, addContactActivity, getState, upsertState }) {
  let seen = 0, newContacts = 0, newAttendances = 0;
  for (const sub of subscriptions) {
    seen++;
    if (!sub.email) continue; // Subscription Base requires email; stay defensive anyway.
    const existing = await getState(companyId, sub.id);
    const { contact, created } = await findOrCreateContact(String(sub.email).trim().toLowerCase(), {
      company_id: companyId,
      name: [sub.firstname, sub.surname].filter(Boolean).join(' ') || undefined,
      company: sub.company || undefined,
      title: sub.job_title || undefined,
      phone: sub.phone || undefined,
      source: 'webinargeek',
      tags: ['webinargeek'],
    });

    if (!existing) {
      if (created) newContacts++;
      await addContactActivity(contact.id, companyId, { type: 'registered', message: 'Registered via WebinarGeek' });
      if (sub.watched) {
        newAttendances++;
        await addContactActivity(contact.id, companyId, { type: 'webinar_attended', message: `Attended via WebinarGeek (${Math.round((sub.watch_duration || 0) / 60)} min)` });
      }
    } else if (!existing.watched && sub.watched) {
      // The only case a REPEAT sync should still log something: this subscriber
      // has moved from registered to watched since the last sync.
      newAttendances++;
      await addContactActivity(contact.id, companyId, { type: 'webinar_attended', message: `Attended via WebinarGeek (${Math.round((sub.watch_duration || 0) / 60)} min)` });
    }
    await upsertState(companyId, sub.id, { contactId: contact.id, watched: !!sub.watched });
  }
  return { seen, newContacts, newAttendances };
}

module.exports = { processSubscriptions };
