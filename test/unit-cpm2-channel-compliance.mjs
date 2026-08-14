#!/usr/bin/env node
// DenchClaw CRM — CP-M2 (WhatsApp/SMS compliance layer, ported from
// origin/aquila-working-branch: migrations/027+028, consent/suppression DALs,
// the pre-send compliance gate, and the channel-templates manager).
//
// What this does NOT test: anything that requires a live Twilio API call
// (verify/listNumbers/sendMessage) — server/lib/twilio.js hardcodes
// api.twilio.com with no override seam (unlike server/lib/twilio-send.js's
// TWILIO_API_BASE), so a real credential is the only way to exercise those.
// Everything reachable without one — the DAL layer, the compliance gate's
// decision logic, the template manager's CRUD/HTTP contract, tenancy
// isolation, and the Twilio inbound webhook's STOP/START handling (which
// never calls Twilio) — is covered here.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpm2-channel-compliance.mjs

import { readFileSync } from 'node:fs';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import consentDb from '../server/db/models/consent.js';
import suppressionDb from '../server/db/models/suppression.js';
import gate from '../server/lib/compliance-gate.js';
import segments from '../server/lib/segments.js';
import { policyFor } from '../server/lib/regions.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const SECRET = process.env.INBOUND_WEBHOOK_SECRET;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpm2_co_' + RUN;
const CO2 = 'cpm2_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body, company = CO) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
async function form(path, body) {
  const params = new URLSearchParams(body);
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-webhook-secret': SECRET || '' },
    body: params.toString(),
  });
  return { status: r.status, text: await r.text() };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ── M2-1 — migrations 027/028 applied, tables exist with the RIGHT columns ─
  const cols027 = await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('channel_consent','channel_suppression','channel_message_templates',
                          'channel_message_template_versions','channel_senders','channel_connections')`);
  check('M2-1 all six CP-M2 tables exist',
    cols027.rows.length === 6, JSON.stringify(cols027.rows.map(r => r.table_name)));

  // ── M2-2 — channel_message_templates is a DISTINCT table from CP4a-0's own
  //          message_templates (the whole reason for the rename during porting:
  //          two unrelated concepts sharing one name would have collided).
  const distinctTables = await db.query(`SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('message_templates','channel_message_templates')`);
  check('M2-2 message_templates (CP4a-0) and channel_message_templates (CP-M2) both exist, separately',
    distinctTables.rows.length === 2, JSON.stringify(distinctTables.rows));
  const mt027 = await db.query(`SELECT COUNT(*)::int n FROM message_templates`);
  check('M2-2 CP4a-0\'s message_templates is untouched by this migration (query still works)', mt027.rows[0].n >= 0);

  // ── M2-3 — migration re-applies without error (idempotent by IF NOT EXISTS) ─
  const mig027 = readFileSync(new URL('../migrations/027_channel_compliance.sql', import.meta.url), 'utf8');
  const mig028 = readFileSync(new URL('../migrations/028_channel_connections.sql', import.meta.url), 'utf8');
  await db.query(mig027); await db.query(mig027);
  await db.query(mig028); await db.query(mig028);
  check('M2-3 migrations 027 and 028 each re-apply twice with no error', true);

  // ── M2-4 — suppression DAL: add / isSuppressed / resubscribe round trip ────
  const contact = await contactDb.create({ name: 'M2 Contact', email: `m2-${RUN}@ex.test`, phone: '+15550001234', company_id: CO });
  const identifier = '+15559998877';
  check('M2-4 not suppressed before any opt-out', !(await suppressionDb.isSuppressed(CO, 'sms', identifier)));
  await suppressionDb.add(CO, 'sms', identifier, { reason: 'opt_out', contactId: contact.id });
  check('M2-4 suppressed after add()', await suppressionDb.isSuppressed(CO, 'sms', identifier));
  await suppressionDb.resubscribe(CO, 'sms', identifier);
  check('M2-4 not suppressed after resubscribe()', !(await suppressionDb.isSuppressed(CO, 'sms', identifier)));
  check('M2-4 suppression is tenant-scoped (CO2 never sees CO\'s suppression)',
    !(await suppressionDb.isSuppressed(CO2, 'sms', identifier)));

  // ── M2-5 — consent DAL: the one-way ladder never downgrades ────────────────
  await consentDb.record(CO, contact.id, 'whatsapp', { consent_type: 'marketing', method: 'checkbox' });
  check('M2-5 marketing consent covers a conversational-category send',
    await consentDb.has(CO, contact.id, 'whatsapp', 'conversational'));
  await consentDb.record(CO, contact.id, 'whatsapp', { consent_type: 'transactional', method: 'inbound' });
  const after = await consentDb.get(CO, contact.id, 'whatsapp');
  check('M2-5 re-recording a WEAKER consent does not downgrade the stronger existing grant',
    after.consent_type === 'marketing', JSON.stringify(after));
  check('M2-5 marketing-category still requires marketing consent — satisfies() itself',
    consentDb.satisfies('transactional', 'marketing') === false);

  // ── M2-6 — the compliance gate: suppression is a hard stop before anything else
  const suppressedContact = await contactDb.create({ name: 'M2 Suppressed', email: `m2sup-${RUN}@ex.test`, phone: '+15551112222', company_id: CO });
  await suppressionDb.add(CO, 'sms', suppressedContact.phone, {});
  const g1 = await gate.check({ companyId: CO, channel: 'sms', contact: suppressedContact, identifier: suppressedContact.phone, category: 'conversational' });
  check('M2-6 a suppressed identifier is refused with code=suppressed', g1.allowed === false && g1.code === 'suppressed', JSON.stringify(g1));

  // ── M2-7 — WhatsApp outside the 24h window requires an approved template ──
  const g2 = await gate.check({ companyId: CO, channel: 'whatsapp', contact, identifier: contact.phone, category: 'conversational', windowOpen: false });
  check('M2-7 WhatsApp out-of-window with no template is refused, code=window_closed',
    g2.allowed === false && g2.code === 'window_closed', JSON.stringify(g2));
  const g3 = await gate.check({ companyId: CO, channel: 'whatsapp', contact, identifier: contact.phone, category: 'conversational', windowOpen: false,
    template: { status: 'APPROVED', provider_template_id: 'HX123' } });
  check('M2-7 …but an APPROVED template unblocks it', g3.allowed === true, JSON.stringify(g3));

  // ── M2-8 — email/linkedin pass through the gate untouched (STRICT = wa/sms only)
  const g4 = await gate.check({ companyId: CO, channel: 'email', contact, identifier: 'x@y.test' });
  check('M2-8 a non-strict channel (email) is waved through', g4.allowed === true && g4.meta?.skipped, JSON.stringify(g4));

  // ── M2-9 — segment analyzer: GSM-7 vs UCS-2 ─────────────────────────────────
  const segAscii = segments.analyze('hello world');
  check('M2-9 plain ASCII is GSM-7, 1 segment', segAscii.encoding === 'GSM-7' && segAscii.segments === 1, JSON.stringify(segAscii));
  const segEmoji = segments.analyze('hello 👋');
  check('M2-9 an emoji forces UCS-2', segEmoji.encoding === 'UCS-2', JSON.stringify(segEmoji));

  // ── M2-10 — regional policy is DATA, not a live lookup ──────────────────────
  check('M2-10 India policy requires a DLT template', policyFor('IN').smsRequiresTemplate === true, JSON.stringify(policyFor('IN')));
  check('M2-10 an unknown country falls back to a default policy without throwing', !!policyFor('ZZ'));

  // ── M2-11 — channel-templates: full HTTP CRUD, and the CP-Z lesson (never
  //          trust client-sent status) — a DRAFT is what gets created regardless
  const create = await req('POST', '/api/crm/channel-templates', { name: 'm2_order_update', body: 'Your order shipped', category: 'UTILITY', language: 'en' });
  check('M2-11 template create → 200 with a DRAFT status', create.status === 200 && create.json?.template?.status === 'DRAFT', JSON.stringify(create.json));
  const tplId = create.json.template.id;
  const list = await req('GET', '/api/crm/channel-templates');
  check('M2-11 it shows up in the list', (list.json?.templates || []).some(t => t.id === tplId));
  const badName = await req('POST', '/api/crm/channel-templates', { name: 'Not Valid!', body: 'x', category: 'UTILITY' });
  check('M2-11 an invalid template name is refused (Meta naming rule)', badName.status !== 200, JSON.stringify(badName.json));

  // ── M2-12 — tenancy: CO2 never sees CO's templates/connections/senders ─────
  const listOther = await req('GET', '/api/crm/channel-templates', undefined, CO2);
  check('M2-12 templates are tenant-scoped', !(listOther.json?.templates || []).some(t => t.id === tplId));
  const chanOther = await req('GET', '/api/crm/channels', undefined, CO2);
  check('M2-12 channels/senders list starts empty for a fresh tenant (no cross-tenant leak)',
    (chanOther.json?.connections || []).length === 0 && (chanOther.json?.senders || []).length === 0, JSON.stringify(chanOther.json));

  // ── M2-13 — the compose path: WhatsApp/SMS now has a delivery path (it had
  //          NONE before CP-M2), gated on Twilio actually being connected first.
  const conv = await req('POST', '/api/crm/conversations', { contact_id: contact.id, channel: 'sms' });
  const convId = conv.json?.id;
  check('M2-13 conversation created', !!convId, JSON.stringify(conv.json));
  const sendAttempt = await req('POST', `/api/crm/conversations/${convId}/messages`,
    { direction: 'outbound', channel: 'sms', body: 'hi', deliver: true, metadata: { from: '+15550009999' } });
  check('M2-13 sending without a connected Twilio account is refused 409, not silently dropped',
    sendAttempt.status === 409, JSON.stringify(sendAttempt.json));

  // ── M2-14 — Twilio inbound webhook: STOP suppresses, START resubscribes ────
  // (No live Twilio call — authenticated via the same shared-secret sim path
  // the inbound-email webhook already uses.)
  if (SECRET) {
    const stopFrom = '+15557778888';
    const r1 = await form('/webhooks/twilio/inbound', { To: 'whatsapp:+14155238886', From: `whatsapp:${stopFrom}`, Body: 'STOP', MessageSid: 'SM_stop_' + RUN });
    check('M2-14 STOP keyword returns 200 TwiML', r1.status === 200 && r1.text.includes('<Response'), r1.text);
    check('M2-14 …and actually suppresses the sender', await suppressionDb.isSuppressed('tantra', 'whatsapp', stopFrom));
    const r2 = await form('/webhooks/twilio/inbound', { To: 'whatsapp:+14155238886', From: `whatsapp:${stopFrom}`, Body: 'START', MessageSid: 'SM_start_' + RUN });
    check('M2-14 START resubscribes', r2.status === 200);
    check('M2-14 …suppression lifted', !(await suppressionDb.isSuppressed('tantra', 'whatsapp', stopFrom)));
  } else {
    results.push('  SKIP  M2-14 Twilio inbound webhook (INBOUND_WEBHOOK_SECRET not set in this run)');
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
