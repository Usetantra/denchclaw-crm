#!/usr/bin/env node
// DenchClaw CRM — CP-TW: Tantra outbound webhook receiver
// (POST /webhooks/tantra/:token + GET/PATCH /api/crm/settings/tantra-webhook).
// Real, documented payload shape/events — see migrations/036_tantra_webhooks.sql
// and server/routes/webhooks.js's Tantra section for sourcing.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cptw-tantra-webhook.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import suppressionDb from '../server/db/models/suppression.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cptw_co_' + RUN;
const CO2 = 'cptw_other_' + RUN;
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
// Tantra itself carries no internal key — the token in the URL is the auth.
async function tantra(token, body, headers = {}) {
  const r = await fetch(`${BASE}/webhooks/tantra/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ── provisioning ────────────────────────────────────────────────────────
  const got1 = await req('GET', '/api/crm/settings/tantra-webhook');
  check('GET tantra-webhook auto-provisions a row', got1.status === 200 && !!got1.json?.webhook?.token, JSON.stringify(got1.json));
  const token = got1.json.webhook.token;
  const got2 = await req('GET', '/api/crm/settings/tantra-webhook');
  check('...and is idempotent (same token on a second GET)', got2.json.webhook.token === token, JSON.stringify(got2.json));

  const noAuth = await fetch(`${BASE}/api/crm/settings/tantra-webhook`);
  check('reading the webhook config without auth is refused', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));

  // ── unknown token ───────────────────────────────────────────────────────
  const bad = await tantra('not-a-real-token', { event: 'email.sent' }, { 'x-tantra-event': 'email.sent' });
  check('an unknown token is refused with 404', bad.status === 404, JSON.stringify(bad.json));

  // ── plain activity-only event: email.sent ──────────────────────────────
  const email1 = `tw1-${RUN}@ex.test`;
  const sent = await tantra(token, {
    campaign: { id: 'campaign_1', name: 'Q3 Outreach' },
    recipient_email: email1,
    sender_email: 'sender@ex.test',
    timestamp: new Date().toISOString(),
  }, { 'x-tantra-event': 'email.sent' });
  check('email.sent responds 200 and matches one contact', sent.status === 200 && sent.json?.contacts_matched === 1, JSON.stringify(sent.json));

  const c1 = await contactDb.getByEmail(email1, CO);
  check('a new contact was created for the recipient', !!c1 && c1.source === 'tantra', JSON.stringify(c1));
  const activity1 = await contactDb.getActivity(c1.id, 10, CO);
  check('the event was logged to the activity feed', activity1.some(a => a.type === 'tantra_event' && /email\.sent/.test(a.message)), JSON.stringify(activity1));

  // ── email.replied advances marketing stage (engaged → responded) ───────
  const email2 = `tw2-${RUN}@ex.test`;
  const created2 = await contactDb.create({ company_id: CO, email: email2, name: 'TW Two', source: 'manual' });
  await contactDb.update(created2.id, { marketing_stage: 'engaged' }, CO);
  const replied = await tantra(token, {
    campaign: { id: 'campaign_1', name: 'Q3 Outreach' },
    recipient_email: email2,
    text: 'Sounds great, let\'s talk.',
  }, { 'x-tantra-event': 'email.replied' });
  check('email.replied responds 200', replied.status === 200, JSON.stringify(replied.json));
  const c2 = await contactDb.getById(created2.id, CO);
  check('...and advances the contact from engaged to responded', c2.marketing_stage === 'responded', c2.marketing_stage);

  // ── email.unsubscribed suppresses the contact ───────────────────────────
  const email3 = `tw3-${RUN}@ex.test`;
  const unsub = await tantra(token, { recipient_email: email3, campaign: { name: 'Q3 Outreach' } }, { 'x-tantra-event': 'email.unsubscribed' });
  check('email.unsubscribed responds 200', unsub.status === 200, JSON.stringify(unsub.json));
  const suppressed = await suppressionDb.isSuppressed(CO, 'email', email3);
  check('...and the contact is now suppressed on the email channel', suppressed === true, String(suppressed));

  // ── lead.stage.changed: unmapped stage is logged, NOT applied ──────────
  const email4 = `tw4-${RUN}@ex.test`;
  const created4 = await contactDb.create({ company_id: CO, email: email4, name: 'TW Four', source: 'manual' });
  const unmapped = await tantra(token, { recipient_email: email4, stage: 'qualified_lead' }, { 'x-tantra-event': 'lead.stage.changed' });
  check('lead.stage.changed (unmapped) responds 200', unmapped.status === 200, JSON.stringify(unmapped.json));
  const c4 = await contactDb.getById(created4.id, CO);
  check('...and does NOT change marketing_stage without a configured mapping', c4.marketing_stage === 'sourced', c4.marketing_stage);
  const activity4 = await contactDb.getActivity(created4.id, 10, CO);
  check('...but logs the raw stage name so it is visible', activity4.some(a => /qualified_lead/.test(a.message) && /no mapping/.test(a.message)), JSON.stringify(activity4));

  // ── lead.stage.changed: mapped stage IS applied ─────────────────────────
  await req('PATCH', '/api/crm/settings/tantra-webhook', { stage_map: { qualified_lead: 'engaged' } });
  const email5 = `tw5-${RUN}@ex.test`;
  const created5 = await contactDb.create({ company_id: CO, email: email5, name: 'TW Five', source: 'manual' });
  // 'sourced' → 'engaged' is not a legal single hop on the marketing pipeline
  // (sourced → enriched/segmented/suppressed only); 'queued' → 'engaged' is.
  await contactDb.update(created5.id, { marketing_stage: 'queued' }, CO);
  const mapped = await tantra(token, { recipient_email: email5, stage: 'qualified_lead' }, { 'x-tantra-event': 'lead.stage.changed' });
  check('lead.stage.changed (mapped) responds 200', mapped.status === 200, JSON.stringify(mapped.json));
  const c5 = await contactDb.getById(created5.id, CO);
  check('...and DOES advance marketing_stage per the configured mapping', c5.marketing_stage === 'engaged', c5.marketing_stage);

  // ── disabling the webhook refuses further deliveries ────────────────────
  await req('PATCH', '/api/crm/settings/tantra-webhook', { enabled: false });
  const disabled = await tantra(token, { recipient_email: email1 }, { 'x-tantra-event': 'email.sent' });
  check('a disabled webhook refuses with 403', disabled.status === 403, JSON.stringify(disabled.json));
  await req('PATCH', '/api/crm/settings/tantra-webhook', { enabled: true });

  // ── token regeneration invalidates the old token ────────────────────────
  const regen = await req('POST', '/api/crm/settings/tantra-webhook/regenerate');
  const newToken = regen.json.webhook.token;
  check('regenerate returns a different token', newToken && newToken !== token, newToken);
  const oldTokenNow = await tantra(token, { recipient_email: email1 }, { 'x-tantra-event': 'email.sent' });
  check('...and the old token is refused (404)', oldTokenNow.status === 404, JSON.stringify(oldTokenNow.json));
  const newTokenWorks = await tantra(newToken, { recipient_email: email1 }, { 'x-tantra-event': 'email.sent' });
  check('...while the new token works', newTokenWorks.status === 200, JSON.stringify(newTokenWorks.json));

  // ── cross-tenant: a webhook only ever touches its own company's contacts ──
  const got3 = await req('GET', '/api/crm/settings/tantra-webhook', undefined, CO2);
  const token2 = got3.json.webhook.token;
  const crossEmail = `tw-cross-${RUN}@ex.test`;
  await tantra(token2, { recipient_email: crossEmail }, { 'x-tantra-event': 'email.sent' });
  const inCO = await contactDb.getByEmail(crossEmail, CO);
  const inCO2 = await contactDb.getByEmail(crossEmail, CO2);
  check('a contact created via CO2\'s token lands in CO2, not CO', !inCO && !!inCO2, JSON.stringify({ inCO, inCO2 }));

  // ── no X-Tantra-Event header: captured but not acted on ────────────────
  const noHeader = await tantra(newToken, { recipient_email: email1 }, {});
  check('a delivery with no X-Tantra-Event header is captured-only, not an error', noHeader.status === 200 && !noHeader.json?.event, JSON.stringify(noHeader.json));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
