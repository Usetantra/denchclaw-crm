#!/usr/bin/env node
// DenchClaw CRM — unit tests for the limits model (GOAL A5: per-tenant
// quotas/suppression/quiet-hours). No HTTP route exists yet (consumed by B3
// once the dispatcher lands), so this talks to Postgres directly the same
// way the other unit-*.mjs scripts do.
//
// Usage: DATABASE_URL=postgres://... node test/unit-limits.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import limitsDb from '../server/db/models/limits.js';

const RUN = process.env.RUN || String(Date.now());
const CO_A = 'lim_co_a_' + RUN;
const CO_B = 'lim_co_b_' + RUN;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO_A, name: CO_A, slug: CO_A });
  await tenantDb.create({ id: CO_B, name: CO_B, slug: CO_B });
  const contactA = await contactDb.create({ name: 'Limits A', email: `lim-a-${RUN}@example.com`, company_id: CO_A });
  const contactB = await contactDb.create({ name: 'Limits B', email: `lim-b-${RUN}@example.com`, company_id: CO_B });

  // ── suppressions ──────────────────────────────────────────────────────────
  check('suppress requires companyId', await throws(() => limitsDb.suppress(undefined, contactA.id, 'email')), 'expected a throw');
  check('suppress cannot inject another tenant\'s contact', (await limitsDb.suppress(CO_B, contactA.id, 'email')) === null, 'expected null — contactA belongs to CO_A');

  check('not suppressed by default', (await limitsDb.isSuppressed(CO_A, contactA.id, 'email')) === false, 'expected false');
  const emailSup = await limitsDb.suppress(CO_A, contactA.id, 'email', 'bounced');
  check('suppress(channel=email) inserts a row', emailSup?.channel === 'email', JSON.stringify(emailSup));
  check('isSuppressed(email) is now true', (await limitsDb.isSuppressed(CO_A, contactA.id, 'email')) === true, 'expected true');
  check('isSuppressed(sms) is still false (channel-specific, not global)', (await limitsDb.isSuppressed(CO_A, contactA.id, 'sms')) === false, 'expected false');

  const dupe = await limitsDb.suppress(CO_A, contactA.id, 'email', 'bounced again');
  check('suppress is idempotent (same row, not a duplicate)', dupe?.id === emailSup.id, `original=${emailSup.id} dupe=${dupe?.id}`);

  await limitsDb.unsuppress(CO_A, contactA.id, 'email');
  check('unsuppress(email) clears it', (await limitsDb.isSuppressed(CO_A, contactA.id, 'email')) === false, 'expected false');

  const globalSup = await limitsDb.suppress(CO_A, contactA.id, null, 'unsubscribed all');
  check('suppress(channel=null) is a global suppression', globalSup?.channel === null, JSON.stringify(globalSup));
  check('global suppression covers email', (await limitsDb.isSuppressed(CO_A, contactA.id, 'email')) === true, 'expected true');
  check('global suppression covers sms too', (await limitsDb.isSuppressed(CO_A, contactA.id, 'sms')) === true, 'expected true');
  check('global suppression covers a channel never explicitly suppressed', (await limitsDb.isSuppressed(CO_A, contactA.id, 'whatsapp')) === true, 'expected true');

  check('listSuppressions cross-tenant does not see it', !(await limitsDb.listSuppressions(CO_B)).some(s => s.contact_id === contactA.id), 'expected not present');
  check('listSuppressions same-tenant sees it', (await limitsDb.listSuppressions(CO_A, { contactId: contactA.id })).length > 0, 'expected present');
  check('contactB (CO_B) is unaffected by CO_A\'s suppression', (await limitsDb.isSuppressed(CO_B, contactB.id, 'email')) === false, 'expected false');

  // A global suppression must be the SOLE authoritative row — no stale
  // channel-specific row surviving redundantly underneath it.
  check('a global suppression leaves exactly one row (channel-specific rows cleaned up)',
    (await limitsDb.listSuppressions(CO_A, { contactId: contactA.id })).length === 1,
    JSON.stringify(await limitsDb.listSuppressions(CO_A, { contactId: contactA.id })));

  // Race: a global suppress() and a concurrent channel-specific suppress()
  // for the SAME contact must not leave the coexistence state behind — the
  // per-contact advisory lock inside suppress() serializes the insert +
  // redundant-row cleanup against any concurrent suppress() call.
  await limitsDb.unsuppress(CO_A, contactA.id, null);
  const raceContact = await contactDb.create({ name: 'Limits Race', email: `lim-race-${RUN}@example.com`, company_id: CO_A });
  await Promise.all([
    limitsDb.suppress(CO_A, raceContact.id, null, 'global'),
    limitsDb.suppress(CO_A, raceContact.id, 'linkedin', 'specific'),
  ]);
  const raceRows = await limitsDb.listSuppressions(CO_A, { contactId: raceContact.id });
  check('concurrent global + channel-specific suppress() never leaves a coexisting stale row',
    raceRows.length === 1 && raceRows[0].channel === null, JSON.stringify(raceRows));

  // unsuppress(null) must clear EVERYTHING for the contact, not just the
  // global row — symmetric with suppress(null)'s "all channels" meaning.
  await limitsDb.suppress(CO_A, contactA.id, 'sms', 'also suppress sms specifically');
  await limitsDb.unsuppress(CO_A, contactA.id, null);
  check('unsuppress(channel=null) clears ALL suppression rows for the contact, not just the global one',
    (await limitsDb.listSuppressions(CO_A, { contactId: contactA.id })).length === 0,
    JSON.stringify(await limitsDb.listSuppressions(CO_A, { contactId: contactA.id })));
  check('...so the contact is fully un-suppressed on every channel afterward',
    (await limitsDb.isSuppressed(CO_A, contactA.id, 'sms')) === false, 'expected false');

  // Concurrent suppress() calls for the same (contact, channel) must not
  // throw a raw unique-violation — both resolve, agreeing on one row.
  const [raceA, raceB] = await Promise.all([
    limitsDb.suppress(CO_A, contactA.id, 'whatsapp', 'race-a'),
    limitsDb.suppress(CO_A, contactA.id, 'whatsapp', 'race-b'),
  ]);
  check('concurrent suppress() calls both resolve without throwing and agree on one row',
    raceA?.id && raceA.id === raceB?.id, `raceA=${raceA?.id} raceB=${raceB?.id}`);
  await limitsDb.unsuppress(CO_A, contactA.id, null); // reset for the tests below

  // ── tenant_channel_limits ──────────────────────────────────────────────────
  const defaults = await limitsDb.getChannelLimits(CO_A, 'sms');
  check('getChannelLimits with no configured row returns permissive defaults',
    defaults.max_per_hour === null && defaults.max_per_day === null, JSON.stringify(defaults));
  check('isQuietHours with no configured limits is always false', (await limitsDb.isQuietHours(CO_A, 'sms')) === false, 'expected false');
  const rateNoLimit = await limitsDb.checkRateLimit(CO_A, 'sms');
  check('checkRateLimit with no configured cap is always allowed', rateNoLimit.allowed === true, JSON.stringify(rateNoLimit));

  const set = await limitsDb.setChannelLimits(CO_A, 'email', { maxPerHour: 2, maxPerDay: 5, quietHoursStart: 22, quietHoursEnd: 6, timezone: 'UTC' });
  check('setChannelLimits inserts a row', set?.max_per_hour === 2 && set?.max_per_day === 5, JSON.stringify(set));
  // Partial update: omitting quietHoursStart/End here must NOT wipe the
  // quiet-hours config just set above — only maxPerHour should change.
  const updated = await limitsDb.setChannelLimits(CO_A, 'email', { maxPerHour: 10 });
  check('setChannelLimits is a partial merge (updates maxPerHour only)', updated?.max_per_hour === 10, JSON.stringify(updated));
  check('...and does NOT silently wipe quiet_hours set by a prior call',
    updated?.quiet_hours_start === 22 && updated?.quiet_hours_end === 6, JSON.stringify(updated));
  check('...and does NOT silently wipe max_per_day set by a prior call', updated?.max_per_day === 5, JSON.stringify(updated));
  check('setChannelLimits does not affect another tenant', (await limitsDb.getChannelLimits(CO_B, 'email')).max_per_hour === null, 'expected CO_B unaffected');

  // Quiet hours: 22:00-06:00 UTC wraps midnight. Pick UTC hours guaranteed
  // inside vs. outside the window regardless of when this test actually runs.
  const insideQuiet = new Date(Date.UTC(2026, 0, 1, 23, 0, 0)); // 23:00 UTC -> inside [22,6)
  const outsideQuiet = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)); // 12:00 UTC -> outside
  check('isQuietHours is true inside a midnight-wrapping window', (await limitsDb.isQuietHours(CO_A, 'email', insideQuiet)) === true, 'expected true at 23:00 UTC');
  check('isQuietHours is false outside a midnight-wrapping window', (await limitsDb.isQuietHours(CO_A, 'email', outsideQuiet)) === false, 'expected false at 12:00 UTC');
  check('quiet_hours_start === quiet_hours_end is rejected (ambiguous config, not silently "never quiet")',
    await throws(() => limitsDb.setChannelLimits(CO_A, 'sms', { quietHoursStart: 9, quietHoursEnd: 9 })),
    'expected a CHECK-constraint violation');

  // Rate limit: schedule + mark 'sent' (with sent_at, migration 016) one email
  // action, cap is max_per_hour=10 (still allowed), then tighten the cap to 1
  // and confirm it now trips.
  const seq = await seqDb.createSequence({ companyId: CO_A, name: 'Rate Test Seq', pipelineKey: 'marketing', triggerStage: 'segmented' });
  const step = await seqDb.addStep(seq.id, CO_A, { stepOrder: 1, channel: 'email', templateRef: 'x' });
  const enrollment = await seqDb.enroll(CO_A, { sequenceId: seq.id, contactId: contactA.id });
  const action1 = await seqDb.scheduleAction(CO_A, { enrollmentId: enrollment.id, stepId: step.id, scheduledFor: new Date().toISOString() });
  await db.query(`UPDATE scheduled_actions SET status='sent', sent_at=now() WHERE id=$1`, [action1.id]);
  const rateOk = await limitsDb.checkRateLimit(CO_A, 'email');
  check('checkRateLimit counts one sent action, still under max_per_hour=10', rateOk.allowed === true && rateOk.hourlyCount === 1, JSON.stringify(rateOk));

  // An unrelated later update to the row's updated_at (e.g. a hypothetical
  // backfill/correction) must NOT affect the count — it's keyed on sent_at.
  await db.query(`UPDATE scheduled_actions SET updated_at=now() WHERE id=$1`, [action1.id]);
  const rateStillOk = await limitsDb.checkRateLimit(CO_A, 'email');
  check('checkRateLimit is keyed on sent_at, not updated_at (unaffected by an unrelated row touch)',
    rateStillOk.hourlyCount === 1, JSON.stringify(rateStillOk));

  await limitsDb.setChannelLimits(CO_A, 'email', { maxPerHour: 1, maxPerDay: 5, timezone: 'UTC' });
  const rateTripped = await limitsDb.checkRateLimit(CO_A, 'email');
  check('checkRateLimit trips once hourlyCount reaches the tightened cap', rateTripped.allowed === false, JSON.stringify(rateTripped));

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM unit-limits test — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
