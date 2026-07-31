#!/usr/bin/env node
// DenchClaw CRM — CP1 (funnel_type dimension + webinar pipelines) verification.
// Numbered against the CP1 ticket's eval criteria E1–E12 (E13 is the suite
// total; E14 is browser evidence). Mixes HTTP (the real stage authorities:
// /advance, PATCH /deals/:id, POST /deals, PATCH /contacts/:id, /pipelines,
// /sequences) with direct DB access (migration re-apply, seeded-row asserts).
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cp1-funnel-pipelines.mjs

import { readFileSync } from 'node:fs';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import seqDb from '../server/db/models/sequences.js';
import limitsDb from '../server/db/models/limits.js';
import pipelineLib from '../server/db/pipeline.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cp1_co_' + RUN;        // main traversal/mode/terminal/sequence tenant
const CO_OVR = 'cp1_ovr_' + RUN;   // E9 override-safety tenant (override FIRST, fresh cache)
const CO_CONV = 'cp1_conv_' + RUN; // E5 conversations.js inline-gate tenant
const CO_E11 = 'cp1_e11_' + RUN;   // E11 listing/DELETE tenant (DELETE checked pre-override)
const CO_MIG = 'cp1_mig_' + RUN;   // E2 backfill-on-reapply tenant
const CO_CACHE = 'cp1_cache_' + RUN; // F3/F4 critic-fix tenant (cache invalidation, name collisions)

if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body, companyId = CO) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': companyId },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

// Canonical stringify (recursively sorted object keys) — jsonb normalizes key
// order, so a naive JSON.stringify comparison of literals would false-fail.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// The legacy stage maps, verbatim, as amended through mig 007 (which added
// no_show → booked on top of mig 006) — E2's byte-identity baseline.
const LEGACY_MARKETING = [
  { key: 'sourced', label: 'Sourced', transitions: ['enriched', 'segmented', 'suppressed'] },
  { key: 'enriched', label: 'Enriched', transitions: ['segmented', 'suppressed'] },
  { key: 'segmented', label: 'Segmented', transitions: ['queued', 'nurture', 'suppressed'] },
  { key: 'queued', label: 'Queued', transitions: ['engaged', 'nurture', 'suppressed'] },
  { key: 'engaged', label: 'Engaged', transitions: ['responded', 'nurture', 'suppressed'] },
  { key: 'responded', label: 'Responded', transitions: ['mql', 'nurture', 'suppressed'] },
  { key: 'mql', label: 'MQL', transitions: ['nurture', 'suppressed'] },
  { key: 'nurture', label: 'Nurture', transitions: ['segmented', 'suppressed'] },
  { key: 'suppressed', label: 'Suppressed', transitions: [] },
];
const LEGACY_SALES = [
  { key: 'accepted', label: 'Accepted', transitions: ['contacted', 'lost'] },
  { key: 'contacted', label: 'Contacted', transitions: ['booked', 'unqualified', 'nurture', 'lost'] },
  { key: 'booked', label: 'Booked', transitions: ['qualified', 'no_show', 'contacted'] },
  { key: 'qualified', label: 'Qualified', transitions: ['proposal', 'unqualified', 'nurture', 'lost'] },
  { key: 'proposal', label: 'Proposal', transitions: ['negotiation', 'nurture', 'lost'] },
  { key: 'negotiation', label: 'Negotiation', transitions: ['onboarding', 'lost'] },
  { key: 'onboarding', label: 'Onboarding', transitions: ['won', 'lost'] },
  { key: 'won', label: 'Won', transitions: [] },
  { key: 'lost', label: 'Lost', transitions: ['accepted'] },
  { key: 'no_show', label: 'No Show', transitions: ['contacted', 'booked', 'lost'] },
  { key: 'unqualified', label: 'Unqualified', transitions: ['nurture', 'lost'] },
  { key: 'nurture', label: 'Nurture', transitions: ['contacted', 'lost'] },
];

// The CP1 ticket's seeded stage tables (key/mode/terminal/transitions).
const EXPECT_WEBINAR = {
  webinar_marketing: {
    entity_type: 'contact',
    stages: [
      ['prospects', 'manual', false, ['invitees']],
      ['invitees', 'auto', false, ['visits', 'registrants', 'auto_registrants']],
      ['visits', 'auto', false, ['registrants', 'auto_registrants']],
      ['registrants', 'auto', false, ['attendees']],
      ['auto_registrants', 'auto', false, ['attendees']],
      ['attendees', 'auto', false, []],
    ],
  },
  webinar_sales: {
    entity_type: 'deal',
    stages: [
      ['qualification_form_fills', 'auto', false, ['scheduled_call', 'disqualified']],
      ['scheduled_call', 'auto', false, ['no_show_followup_1', 'proposal_sent', 'deals', 'disqualified']],
      ['no_show_followup_1', 'manual', false, ['no_show_followup_2', 'scheduled_call', 'disqualified']],
      ['no_show_followup_2', 'auto', false, ['no_show_followup_3', 'scheduled_call', 'disqualified']],
      ['no_show_followup_3', 'auto', false, ['no_show_followup_4', 'scheduled_call', 'disqualified']],
      ['no_show_followup_4', 'auto', false, ['no_show_followup_5', 'scheduled_call', 'disqualified']],
      ['no_show_followup_5', 'auto', false, ['scheduled_call', 'disqualified']],
      ['proposal_sent', 'manual', false, ['deals', 'disqualified']],
      ['disqualified', 'auto', true, []],
      ['deals', 'manual', false, ['deal_followup_1', 'disqualified']],
      ['deal_followup_1', 'manual', false, ['deal_followup_2', 'disqualified']],
      ['deal_followup_2', 'manual', false, ['deal_followup_3', 'disqualified']],
      ['deal_followup_3', 'manual', false, ['disqualified']],
    ],
  },
  webinar_delivery: {
    entity_type: 'deal',
    stages: [
      ['onboarding', 'manual', false, ['funnel_delivery']],
      ['funnel_delivery', 'manual', false, ['coaching_delivery']],
      ['coaching_delivery', 'manual', false, ['renewed', 'delivery_completed']],
      ['renewed', 'manual', false, ['funnel_delivery', 'coaching_delivery', 'delivery_completed']],
      ['delivery_completed', 'manual', true, []],
    ],
  },
};

async function createContact(name, companyId = CO) {
  const r = await req('POST', '/api/crm/contacts', { name, email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${RUN}@example.com`, source: 'manual' }, companyId);
  return r.json?.id;
}

async function main() {
  await db.initDatabase();
  for (const co of [CO, CO_OVR, CO_CONV, CO_E11, CO_MIG, CO_CACHE]) {
    await tenantDb.create({ id: co, name: co, slug: co });
  }

  // ── E1 + E2: migration 018 re-apply (idempotency + backfill) ───────────────
  // run-local.sh already applied 018 once. Plant "pre-migration-shaped" rows
  // (entity_type at its 'contact' default, funnel_type NULL), then apply the
  // migration a SECOND time and assert: no dup seeds, seeds untouched,
  // planted rows backfilled to 'deal'.
  await db.query(
    `INSERT INTO crm_pipeline_configs (company_id, key, name, stages)
     VALUES ($1, 'sales', 'Sales Override (pre-mig)', $2::jsonb),
            ($1, 'cp1_custom_009', 'Mig-009-style Custom', '[{"key":"new","name":"New","transitions":[]}]'::jsonb)`,
    [CO_MIG, JSON.stringify(LEGACY_SALES)]
  );
  // Simulate pre-migration state explicitly (the ALTER default already set
  // 'contact', but be explicit so the assert can't pass vacuously).
  await db.query(`UPDATE crm_pipeline_configs SET entity_type = 'contact' WHERE company_id = $1`, [CO_MIG]);

  const migrationSql = readFileSync(new URL('../migrations/018_funnel_pipelines.sql', import.meta.url), 'utf8');
  let secondApplyOk = true, secondApplyErr = '';
  try { await db.query(migrationSql); } catch (e) { secondApplyOk = false; secondApplyErr = e.message; }
  check('E1: migration 018 applies cleanly a SECOND time', secondApplyOk, secondApplyErr);

  const globals = await db.query(
    `SELECT key, name, entity_type, funnel_type, stages FROM crm_pipeline_configs
     WHERE company_id IS NULL AND funnel_type IS NOT NULL ORDER BY key`
  );
  check('E1: exactly 3 global funnel-typed rows after double-apply', globals.rows.length === 3,
    `got ${globals.rows.length}: ${globals.rows.map(r => r.key).join(',')}`);
  for (const [key, expect] of Object.entries(EXPECT_WEBINAR)) {
    const row = globals.rows.find(r => r.key === key);
    if (!row) { check(`E1: seeded row ${key} exists`, false, 'missing'); continue; }
    check(`E1: ${key} funnel_type='webinar' entity_type='${expect.entity_type}'`,
      row.funnel_type === 'webinar' && row.entity_type === expect.entity_type,
      `${row.funnel_type}/${row.entity_type}`);
    const got = (row.stages || []).map(s => [s.key, s.mode, s.terminal === true, s.transitions]);
    check(`E1: ${key} stage keys/modes/terminal/transitions match the ticket table exactly`,
      canon(got) === canon(expect.stages), `got ${canon(got)}`);
  }

  const legacy = await db.query(
    `SELECT key, stages FROM crm_pipeline_configs WHERE company_id IS NULL AND key IN ('marketing','sales')`
  );
  const legacyMkt = legacy.rows.find(r => r.key === 'marketing');
  const legacySls = legacy.rows.find(r => r.key === 'sales');
  check('E2: global marketing stages JSONB identical to the mig-006 literal',
    canon(legacyMkt?.stages) === canon(LEGACY_MARKETING), canon(legacyMkt?.stages));
  check('E2: global sales stages JSONB identical to the mig-006+007 literal',
    canon(legacySls?.stages) === canon(LEGACY_SALES), canon(legacySls?.stages));
  const backfilled = await db.query(
    `SELECT key, entity_type FROM crm_pipeline_configs WHERE company_id = $1 ORDER BY key`, [CO_MIG]
  );
  check('E2: pre-existing company-scoped sales override backfilled entity_type=deal',
    backfilled.rows.find(r => r.key === 'sales')?.entity_type === 'deal', JSON.stringify(backfilled.rows));
  check('E2: pre-existing mig-009-style custom row backfilled entity_type=deal',
    backfilled.rows.find(r => r.key === 'cp1_custom_009')?.entity_type === 'deal', JSON.stringify(backfilled.rows));
  const seededMkt = globals.rows.find(r => r.key === 'webinar_marketing');
  check('E1: re-run did NOT flip webinar_marketing to deal (backfill excludes funnel-typed rows)',
    seededMkt?.entity_type === 'contact', seededMkt?.entity_type);

  // ── E3: isManualStage semantics ────────────────────────────────────────────
  const { isManualStage } = pipelineLib;
  const fakePipe = { stages: [{ key: 'a', mode: 'manual' }, { key: 'b', mode: 'auto' }, { key: 'c' }] };
  check('E3: manual → true', isManualStage(fakePipe, 'a') === true, '');
  check('E3: auto → false', isManualStage(fakePipe, 'b') === false, '');
  check('E3: absent mode → false (legacy compat)', isManualStage(fakePipe, 'c') === false, '');
  check('E3: unknown stage → false, no throw', isManualStage(fakePipe, 'zzz') === false, '');
  check('E3: null pipeline safe', isManualStage(null, 'a') === false, '');

  // ── E4: /advance traversals ────────────────────────────────────────────────
  const cA = await createContact('CP1 Walk A');
  const a1 = await req('POST', `/api/crm/contacts/${cA}/advance`, { pipeline_key: 'webinar_marketing', stage: 'prospects' });
  check('E4a: sourced → prospects entry-rule 200 changed:true', a1.status === 200 && a1.json?.changed === true, JSON.stringify(a1));
  const a2 = await req('POST', `/api/crm/contacts/${cA}/advance`, { pipeline_key: 'webinar_marketing', stage: 'invitees' });
  check('E4b: prospects → invitees 200 changed:true', a2.status === 200 && a2.json?.changed === true, JSON.stringify(a2));

  const cB = await createContact('CP1 Walk B');
  await req('POST', `/api/crm/contacts/${cB}/advance`, { pipeline_key: 'webinar_marketing', stage: 'prospects' });
  const a3 = await req('POST', `/api/crm/contacts/${cB}/advance`, { pipeline_key: 'webinar_marketing', stage: 'attendees' });
  check('E4c: prospects → attendees 409 with allowed', a3.status === 409 && Array.isArray(a3.json?.allowed), JSON.stringify(a3));

  const cD = await createContact('CP1 Deal D');
  const d1 = await req('POST', '/api/crm/deals', { title: 'CP1 Webinar Deal', contact_id: cD, pipeline_key: 'webinar_sales' });
  check('E7: POST /deals omitted stage defaults to stages[0]', d1.status === 201 && d1.json?.stage === 'qualification_form_fills', JSON.stringify(d1.json));
  const a4 = await req('POST', `/api/crm/contacts/${cD}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
  check('E4d: qualification_form_fills → scheduled_call 200', a4.status === 200 && a4.json?.changed === true, JSON.stringify(a4));
  const a5 = await req('POST', `/api/crm/contacts/${cD}/advance`, { pipeline_key: 'webinar_sales', stage: 'deals' });
  check('E4e/E5: scheduled_call → deals (manual, human caller) 200', a5.status === 200 && a5.json?.changed === true, JSON.stringify(a5));

  const cF = await createContact('CP1 Deal F');
  await req('POST', '/api/crm/deals', { title: 'CP1 Illegal Jump', contact_id: cF, pipeline_key: 'webinar_sales' });
  const a6 = await req('POST', `/api/crm/contacts/${cF}/advance`, { pipeline_key: 'webinar_sales', stage: 'deals' });
  check('E4f: qualification_form_fills → deals 409', a6.status === 409 && Array.isArray(a6.json?.allowed) && a6.json?.error_code === undefined, JSON.stringify(a6));

  const custom = await req('POST', '/api/crm/pipelines', { name: `CP1 Untyped ${RUN}`, stages: [{ name: 'One' }, { name: 'Two' }] });
  const customKey = custom.json?.key;
  check('setup: untyped custom pipeline created', custom.status === 201 && !!customKey, JSON.stringify(custom));
  const a7 = await req('POST', `/api/crm/contacts/${cA}/advance`, { pipeline_key: customKey, stage: 'two' });
  check('E4h: untyped mig-009 custom key on /advance still 400', a7.status === 400, JSON.stringify(a7));

  // E4i: one contact, BOTH a legacy sales deal and a webinar_sales deal.
  const cI = await createContact('CP1 Both Deals');
  const legacyDeal = await req('POST', '/api/crm/deals', { title: 'CP1 Legacy', contact_id: cI, stage: 'accepted' });
  const webinarDeal = await req('POST', '/api/crm/deals', { title: 'CP1 Webinar', contact_id: cI, pipeline_key: 'webinar_sales' });
  const iSales = await req('POST', `/api/crm/contacts/${cI}/advance`, { pipeline_key: 'sales', stage: 'contacted' });
  check('E4i: /advance sales moves the legacy deal', iSales.status === 200 && iSales.json?.deal_id === legacyDeal.json?.id, JSON.stringify(iSales.json));
  const iWeb = await req('POST', `/api/crm/contacts/${cI}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
  check('E4i: /advance webinar_sales moves the webinar deal', iWeb.status === 200 && iWeb.json?.deal_id === webinarDeal.json?.id, JSON.stringify(iWeb.json));
  const bothRows = await db.query(`SELECT id, stage FROM deals WHERE contact_id = $1`, [cI]);
  check('E4i: each deal advanced independently by its own key',
    bothRows.rows.find(r => r.id === legacyDeal.json?.id)?.stage === 'contacted'
    && bothRows.rows.find(r => r.id === webinarDeal.json?.id)?.stage === 'scheduled_call',
    JSON.stringify(bothRows.rows));

  // ── E5: mode enforcement on /advance ───────────────────────────────────────
  const cM = await createContact('CP1 Mode');
  await req('POST', '/api/crm/deals', { title: 'CP1 Mode Deal', contact_id: cM, pipeline_key: 'webinar_sales' });
  const m1 = await req('POST', `/api/crm/contacts/${cM}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call', automated: true });
  check('E5: automated → auto stage 200', m1.status === 200 && m1.json?.changed === true, JSON.stringify(m1));
  const m2 = await req('POST', `/api/crm/contacts/${cM}/advance`, { pipeline_key: 'webinar_sales', stage: 'no_show_followup_1', automated: true });
  check('E5: automated → manual stage 403 error_code manual_stage', m2.status === 403 && m2.json?.error_code === 'manual_stage', JSON.stringify(m2));
  const m3 = await req('POST', `/api/crm/contacts/${cM}/advance`, { pipeline_key: 'webinar_sales', stage: 'no_show_followup_1' });
  check('E5: same target, human caller → 200', m3.status === 200 && m3.json?.changed === true, JSON.stringify(m3));
  const cM2 = await createContact('CP1 Mode Contact');
  const m4 = await req('POST', `/api/crm/contacts/${cM2}/advance`, { pipeline_key: 'webinar_marketing', stage: 'prospects', automated: true });
  check('E5: contact-pipeline automated → manual entry stage 403', m4.status === 403 && m4.json?.error_code === 'manual_stage', JSON.stringify(m4));
  check('E5: 403 shape (error_code) distinct from the 409 shape (allowed array)',
    m2.json?.allowed === undefined && a6.json?.error_code === undefined, `403=${JSON.stringify(m2.json)} 409=${JSON.stringify(a6.json)}`);

  // conversations.js inline gate: a tenant override marking 'responded'
  // manual must stop the inbound-reply auto-advance (legacy tenants have no
  // mode — proven unchanged by the existing B2 suite).
  const mktOverrideStages = LEGACY_MARKETING.map(s => ({
    key: s.key, name: s.label, transitions: s.transitions,
    ...(s.key === 'responded' ? { mode: 'manual' } : {}),
  }));
  const ovr = await req('PATCH', '/api/crm/pipelines/marketing', { stages: mktOverrideStages }, CO_CONV);
  check('setup: marketing override with responded:manual saved', ovr.status === 200
    && ovr.json?.stages?.find(s => s.key === 'responded')?.mode === 'manual', JSON.stringify(ovr.json));
  const cR = await createContact('CP1 Reply', CO_CONV);
  for (const st of ['enriched', 'segmented', 'queued', 'engaged']) {
    await req('POST', `/api/crm/contacts/${cR}/advance`, { pipeline_key: 'marketing', stage: st }, CO_CONV);
  }
  const conv = await req('POST', '/api/crm/conversations', { contact_id: cR, channel: 'email' }, CO_CONV);
  const inbound = await req('POST', `/api/crm/conversations/${conv.json?.id}/messages`, { direction: 'inbound', channel: 'email', body: 'hi' }, CO_CONV);
  check('setup: inbound message accepted', inbound.status === 201, JSON.stringify(inbound));
  const cRAfter = await req('GET', `/api/crm/contacts/${cR}`, undefined, CO_CONV);
  check('E5: conversations.js inline gate — manual responded NOT auto-advanced (stays engaged)',
    cRAfter.json?.marketing_stage === 'engaged', cRAfter.json?.marketing_stage);

  // ── E6: entry-rule refusals ────────────────────────────────────────────────
  const cS = await createContact('CP1 Suppressed Stage');
  await req('POST', `/api/crm/contacts/${cS}/advance`, { pipeline_key: 'marketing', stage: 'suppressed' });
  const s1 = await req('POST', `/api/crm/contacts/${cS}/advance`, { pipeline_key: 'webinar_marketing', stage: 'prospects' });
  check('E6: contact at suppressed refused entry (409)', s1.status === 409, JSON.stringify(s1));
  const cS2 = await createContact('CP1 Suppression Row');
  await limitsDb.suppress(CO, cS2, null, 'cp1 test');
  const s2 = await req('POST', `/api/crm/contacts/${cS2}/advance`, { pipeline_key: 'webinar_marketing', stage: 'prospects' });
  check('E6: active all-channel suppression refused entry (409, mentions suppression)',
    s2.status === 409 && /suppress/i.test(s2.json?.error || ''), JSON.stringify(s2));

  // ── E7: PATCH /deals/:id gates + POST /deals validation ────────────────────
  const cP = await createContact('CP1 Patch Deal');
  const pd = await req('POST', '/api/crm/deals', { title: 'CP1 Patch', contact_id: cP, pipeline_key: 'webinar_sales' });
  const p1 = await req('PATCH', `/api/crm/deals/${pd.json?.id}`, { stage: 'deals' });
  check('E7: PATCH funnel-typed illegal jump 409', p1.status === 409 && Array.isArray(p1.json?.allowed_transitions), JSON.stringify(p1.json));
  const p2 = await req('PATCH', `/api/crm/deals/${pd.json?.id}`, { stage: 'scheduled_call', automated: true });
  check('E7: PATCH automated → auto stage 200', p2.status === 200 && p2.json?.stage === 'scheduled_call', JSON.stringify(p2.json));
  const p3 = await req('PATCH', `/api/crm/deals/${pd.json?.id}`, { stage: 'no_show_followup_1', automated: true });
  check('E7: PATCH automated → manual stage 403 manual_stage', p3.status === 403 && p3.json?.error_code === 'manual_stage', JSON.stringify(p3.json));
  const cU = await createContact('CP1 Untyped Deal');
  const ud = await req('POST', '/api/crm/deals', { title: 'CP1 Untyped', contact_id: cU, pipeline_key: customKey });
  const p4 = await req('PATCH', `/api/crm/deals/${ud.json?.id}`, { stage: 'two' });
  const p5 = await req('PATCH', `/api/crm/deals/${ud.json?.id}`, { stage: 'one' });
  check('E7: untyped custom pipeline still moves freely', p4.status === 200 && p5.status === 200, `${p4.status}/${p5.status}`);
  const cL = await createContact('CP1 Legacy Patch');
  const ld = await req('POST', '/api/crm/deals', { title: 'CP1 Legacy Patch', contact_id: cL, stage: 'accepted' });
  const p6 = await req('PATCH', `/api/crm/deals/${ld.json?.id}`, { stage: 'contacted' });
  const p7 = await req('PATCH', `/api/crm/deals/${ld.json?.id}`, { stage: 'won' });
  check('E7: legacy sales PATCH behavior unchanged (legal 200, illegal 409)', p6.status === 200 && p7.status === 409, `${p6.status}/${p7.status}`);
  const badStage = await req('POST', '/api/crm/deals', { title: 'CP1 Bad Stage', contact_id: cP, pipeline_key: 'webinar_sales', stage: 'not_a_stage' });
  check('E7: POST /deals funnel-typed non-member stage 400 with allowed_stages',
    badStage.status === 400 && Array.isArray(badStage.json?.allowed_stages), JSON.stringify(badStage.json));
  const contactPipeDeal = await req('POST', '/api/crm/deals', { title: 'CP1 Contact-pipe deal', contact_id: cP, pipeline_key: 'webinar_marketing' });
  check('E7: POST /deals into a contact-entity funnel pipeline rejected 400', contactPipeDeal.status === 400, JSON.stringify(contactPipeDeal.json));

  // ── E8: terminal semantics ─────────────────────────────────────────────────
  const cT = await createContact('CP1 Terminal');
  const td = await req('POST', '/api/crm/deals', { title: 'CP1 Terminal', contact_id: cT, pipeline_key: 'webinar_sales' });
  const t1 = await req('POST', `/api/crm/contacts/${cT}/advance`, { pipeline_key: 'webinar_sales', stage: 'disqualified' });
  check('E8: advance to terminal disqualified 200', t1.status === 200 && t1.json?.changed === true, JSON.stringify(t1));
  const tdAfter = await req('GET', `/api/crm/deals/${td.json?.id}`);
  check('E8: terminal stage set closed_at', !!tdAfter.json?.closed_at, JSON.stringify(tdAfter.json));
  const t2 = await req('POST', `/api/crm/contacts/${cT}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
  check('E8: terminal deal no longer the active deal (404 on next advance)', t2.status === 404, JSON.stringify(t2));
  const td2 = await req('POST', '/api/crm/deals', { title: 'CP1 Terminal 2', contact_id: cT, pipeline_key: 'webinar_sales' });
  check('E8: a NEW webinar_sales deal can then be created', td2.status === 201, JSON.stringify(td2.json));
  const t3 = await req('POST', `/api/crm/contacts/${cT}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
  check('E8: ...and advanced', t3.status === 200 && t3.json?.deal_id === td2.json?.id, JSON.stringify(t3.json));

  // ── E9: override safety (fresh tenant — override lands before any cache) ──
  const ovrStages = EXPECT_WEBINAR.webinar_sales.stages.map(([key]) => ({
    key, name: key === 'scheduled_call' ? 'Call Booked (renamed)' : key,
    // deliberately NO mode/terminal fields sent — inheritance from prev must fill them
  }));
  const e9 = await req('PATCH', '/api/crm/pipelines/webinar_sales', { stages: ovrStages }, CO_OVR);
  check('E9: PATCH /pipelines/webinar_sales (rename one stage) 200', e9.status === 200, JSON.stringify(e9.json));
  const e9List = await req('GET', '/api/crm/pipelines', undefined, CO_OVR);
  const e9Pipe = (e9List.json?.pipelines || []).find(p => p.key === 'webinar_sales');
  const e9Modes = Object.fromEntries((e9Pipe?.stages || []).map(s => [s.key, s.mode]));
  check('E9: re-read — every stage kept its mode after the rename',
    canon(e9Modes) === canon(Object.fromEntries(EXPECT_WEBINAR.webinar_sales.stages.map(([k, m]) => [k, m]))),
    canon(e9Modes));
  check('E9: re-read — terminal preserved on disqualified',
    e9Pipe?.stages?.find(s => s.key === 'disqualified')?.terminal === true, JSON.stringify(e9Pipe?.stages));
  check('E9: re-read — funnel_type webinar + applies_to deal + appears once',
    e9Pipe?.funnel_type === 'webinar' && e9Pipe?.applies_to === 'deal'
    && (e9List.json?.pipelines || []).filter(p => p.key === 'webinar_sales').length === 1
    && e9Pipe?.overridden === true,
    JSON.stringify(e9Pipe));
  const dbOvr = await db.query(`SELECT entity_type, funnel_type FROM crm_pipeline_configs WHERE company_id = $1 AND key = 'webinar_sales'`, [CO_OVR]);
  check('E9: override ROW inherited entity_type=deal + funnel_type=webinar',
    dbOvr.rows[0]?.entity_type === 'deal' && dbOvr.rows[0]?.funnel_type === 'webinar', JSON.stringify(dbOvr.rows));
  const cO = await createContact('CP1 Ovr', CO_OVR);
  await req('POST', '/api/crm/deals', { title: 'CP1 Ovr Deal', contact_id: cO, pipeline_key: 'webinar_sales' }, CO_OVR);
  await req('POST', `/api/crm/contacts/${cO}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' }, CO_OVR);
  const e9Gate = await req('POST', `/api/crm/contacts/${cO}/advance`, { pipeline_key: 'webinar_sales', stage: 'no_show_followup_1', automated: true }, CO_OVR);
  check('E9: mode gate still enforced for the overriding tenant (403 manual_stage)',
    e9Gate.status === 403 && e9Gate.json?.error_code === 'manual_stage', JSON.stringify(e9Gate.json));

  // ── E10: sequences validation + B2 carry-through ───────────────────────────
  const sq1 = await req('POST', '/api/crm/sequences', { name: 'CP1 No-show recovery', pipeline_key: 'webinar_sales', trigger_stage: 'no_show_followup_1' });
  check('E10: POST accepts webinar_sales + no_show_followup_1', sq1.status === 201 && !!sq1.json?.id, JSON.stringify(sq1.json));
  const sq2 = await req('POST', '/api/crm/sequences', { name: 'CP1 Bogus Pipe', pipeline_key: 'bogus_pipeline', trigger_stage: 'x' });
  check('E10: bogus pipeline_key 400', sq2.status === 400, JSON.stringify(sq2));
  const sq3 = await req('POST', '/api/crm/sequences', { name: 'CP1 Bogus Stage', pipeline_key: 'webinar_sales', trigger_stage: 'bogus_stage' });
  check('E10: webinar_sales + bogus trigger_stage 400', sq3.status === 400, JSON.stringify(sq3));
  // Cross-tenant: CO_OVR-scoped custom key must not validate for CO.
  const foreignPipe = await req('POST', '/api/crm/pipelines', { name: `CP1 Foreign ${RUN}` }, CO_OVR);
  const sq4 = await req('POST', '/api/crm/sequences', { name: 'CP1 Foreign Ref', pipeline_key: foreignPipe.json?.key, trigger_stage: 'new' });
  check("E10: tenant A cannot reference tenant B's company-scoped key (400)", sq4.status === 400, JSON.stringify(sq4));
  const htmlSrc = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  check('E10: esc() render defense still present on the trigger display',
    htmlSrc.includes('esc(nice(s.trigger_stage))') && htmlSrc.includes('esc(nice(s.pipeline_key))'), 'pattern missing');
  // B2 carry-through: humanly advancing a webinar_sales deal into the manual
  // trigger stage enrolls the sequence — proven via the API.
  await req('POST', `/api/crm/sequences/${sq1.json?.id}/steps`, { step_order: 1, channel: 'email', template_ref: 'noshow_fu1' });
  const cQ = await createContact('CP1 Enrollee');
  await req('POST', '/api/crm/deals', { title: 'CP1 Enroll Deal', contact_id: cQ, pipeline_key: 'webinar_sales' });
  await req('POST', `/api/crm/contacts/${cQ}/advance`, { pipeline_key: 'webinar_sales', stage: 'scheduled_call' });
  const enrollAdvance = await req('POST', `/api/crm/contacts/${cQ}/advance`, { pipeline_key: 'webinar_sales', stage: 'no_show_followup_1' });
  check('E10: human advance into no_show_followup_1 succeeds', enrollAdvance.status === 200 && enrollAdvance.json?.changed === true, JSON.stringify(enrollAdvance.json));
  const enrollments = await req('GET', `/api/crm/sequences/${sq1.json?.id}/enrollments`);
  check('E10: B2 carry-through — enrollment row exists for the contact (via API)',
    (enrollments.json?.enrollments || []).some(e => e.contact_id === cQ && e.status === 'active'), JSON.stringify(enrollments.json));

  // ── E11: GET /pipelines listing + override-once + DELETE 404 ───────────────
  // DELETE first (no override exists yet for this tenant) — global rows are
  // untouchable, so this must 404.
  const e11Del = await req('DELETE', '/api/crm/pipelines/webinar_delivery', undefined, CO_E11);
  check('E11: DELETE of a global funnel key 404s', e11Del.status === 404, JSON.stringify(e11Del.json));
  const e11List = await req('GET', '/api/crm/pipelines', undefined, CO_E11);
  const e11Keys = (e11List.json?.pipelines || []).map(p => p.key);
  check('E11: GET /pipelines returns all three global funnel configs',
    ['webinar_marketing', 'webinar_sales', 'webinar_delivery'].every(k => e11Keys.includes(k)), e11Keys.join(','));
  const e11Mkt = (e11List.json?.pipelines || []).find(p => p.key === 'webinar_marketing');
  check('E11: funnel entries carry funnel_type + per-stage mode',
    e11Mkt?.funnel_type === 'webinar' && e11Mkt?.applies_to === 'contact'
    && e11Mkt?.stages?.find(s => s.key === 'prospects')?.mode === 'manual', JSON.stringify(e11Mkt));
  await req('PATCH', '/api/crm/pipelines/webinar_delivery', { name: 'Delivery (ours)' }, CO_E11);
  const e11List2 = await req('GET', '/api/crm/pipelines', undefined, CO_E11);
  const deliveryEntries = (e11List2.json?.pipelines || []).filter(p => p.key === 'webinar_delivery');
  check('E11: tenant override appears ONCE with override precedence',
    deliveryEntries.length === 1 && deliveryEntries[0].name === 'Delivery (ours)' && deliveryEntries[0].overridden === true,
    JSON.stringify(deliveryEntries));

  // ── E12: PATCH /contacts/:id deal_stage side door ──────────────────────────
  const e12 = await req('PATCH', `/api/crm/contacts/${cA}`, { deal_stage: 'lead' });
  check('E12: deal_stage write while at a webinar marketing stage 400 pointing to /advance',
    e12.status === 400 && /advance/.test(e12.json?.error || ''), JSON.stringify(e12));
  const e12b = await req('PATCH', `/api/crm/contacts/${cA}`, { name: 'CP1 Walk A (renamed)' });
  check('E12: non-stage PATCH fields still work for the same contact', e12b.status === 200, JSON.stringify(e12b.json));

  // ── Critic-round fixes (Fable-5 fallback critic, see receipt) ──────────────
  // F1: PATCH /deals pipeline_key rekey is gated — rekeying was an ungated
  // stage authority that could walk a deal into/out of the funnel state
  // machine with no membership/mode check ever firing.
  const cRk = await createContact('CP1 Rekey');
  const rkLegacy = await req('POST', '/api/crm/deals', { title: 'CP1 Rekey Legacy', contact_id: cRk, stage: 'accepted' });
  const rk1 = await req('PATCH', `/api/crm/deals/${rkLegacy.json?.id}`, { pipeline_key: 'webinar_sales' });
  check('F1: legacy deal cannot be re-keyed INTO a funnel pipeline (400)', rk1.status === 400, JSON.stringify(rk1.json));
  const rkFunnel = await req('POST', '/api/crm/deals', { title: 'CP1 Rekey Funnel', contact_id: cRk, pipeline_key: 'webinar_sales' });
  const rk2 = await req('PATCH', `/api/crm/deals/${rkFunnel.json?.id}`, { pipeline_key: customKey });
  check('F1: funnel deal cannot be re-keyed OUT to an untyped custom (400)', rk2.status === 400, JSON.stringify(rk2.json));
  const rk3 = await req('PATCH', `/api/crm/deals/${rkFunnel.json?.id}`, { pipeline_key: 'sales' });
  check('F1: funnel deal cannot be re-keyed to legacy sales (400)', rk3.status === 400, JSON.stringify(rk3.json));
  const rk4 = await req('PATCH', `/api/crm/deals/${ud.json?.id}`, { pipeline_key: 'sales' });
  check('F1: untyped→legacy rekey keeps its pre-CP1 behavior (200)', rk4.status === 200, JSON.stringify(rk4.json));

  // F2: deal CREATION is mode-gated for automated callers — otherwise a fresh
  // deal minted directly in a manual stage sidesteps /advance's 403 (and wins
  // the active-deal lookup).
  const f2a = await req('POST', '/api/crm/deals', { title: 'F2 Auto Manual', contact_id: cRk, pipeline_key: 'webinar_sales', stage: 'deals', automated: true });
  check('F2: automated creation INTO a manual stage 403 manual_stage', f2a.status === 403 && f2a.json?.error_code === 'manual_stage', JSON.stringify(f2a.json));
  const f2b = await req('POST', '/api/crm/deals', { title: 'F2 Auto Delivery', contact_id: cRk, pipeline_key: 'webinar_delivery', automated: true });
  check('F2: automated creation defaulting to a manual stages[0] 403', f2b.status === 403 && f2b.json?.error_code === 'manual_stage', JSON.stringify(f2b.json));
  const f2c = await req('POST', '/api/crm/deals', { title: 'F2 Human Delivery', contact_id: cRk, pipeline_key: 'webinar_delivery' });
  check('F2: same creation by a human 201 at stages[0]', f2c.status === 201 && f2c.json?.stage === 'onboarding', JSON.stringify(f2c.json));

  // F3: a pipeline override takes effect on the gates IMMEDIATELY — the
  // config caches are invalidated on write, not left to the 60s TTL. Prime
  // the cache first (the ordering the E9 test deliberately avoids).
  const cCache = await createContact('CP1 Cache', CO_CACHE);
  const prime = await req('POST', `/api/crm/contacts/${cCache}/advance`, { pipeline_key: 'marketing', stage: 'enriched' }, CO_CACHE);
  check('F3 setup: advance primes the config cache', prime.status === 200, JSON.stringify(prime.json));
  const cacheOvrStages = LEGACY_MARKETING.map(s => ({ key: s.key, name: s.label, ...(s.key === 'segmented' ? { mode: 'manual' } : {}) }));
  await req('PATCH', '/api/crm/pipelines/marketing', { stages: cacheOvrStages }, CO_CACHE);
  const f3 = await req('POST', `/api/crm/contacts/${cCache}/advance`, { pipeline_key: 'marketing', stage: 'segmented', automated: true }, CO_CACHE);
  check('F3: override enforced immediately after PATCH (automated → newly-manual stage 403, not a 60s-stale 200)',
    f3.status === 403 && f3.json?.error_code === 'manual_stage', JSON.stringify(f3.json));

  // F4: the deal_stage side door infers pipeline from a bare stage NAME — a
  // funnel stage that shares its name with a legacy marketing stage must NOT
  // lock legacy contacts out of deal_stage writes (ambiguous ⇒ legacy wins).
  await req('PATCH', '/api/crm/pipelines/webinar_marketing', {
    stages: [...EXPECT_WEBINAR.webinar_marketing.stages.map(([k]) => ({ key: k, name: k })), { key: 'nurture', name: 'Nurture' }],
  }, CO_CACHE);
  const cAmb = await createContact('CP1 Ambiguous', CO_CACHE);
  for (const st of ['enriched', 'segmented', 'nurture']) {
    await req('POST', `/api/crm/contacts/${cAmb}/advance`, { pipeline_key: 'marketing', stage: st }, CO_CACHE);
  }
  const f4 = await req('PATCH', `/api/crm/contacts/${cAmb}`, { deal_stage: 'contacted' }, CO_CACHE);
  check('F4: legacy contact at a name-colliding stage keeps legacy deal_stage PATCH behavior (200, not locked)',
    f4.status === 200, JSON.stringify(f4.json));

  // F7: terminal:false explicitly CLEARS an inherited terminal flag
  // (incoming-wins, symmetric with mode).
  const f7Stages = EXPECT_WEBINAR.webinar_sales.stages.map(([k]) => ({ key: k, name: k, ...(k === 'disqualified' ? { terminal: false } : {}) }));
  const f7 = await req('PATCH', '/api/crm/pipelines/webinar_sales', { stages: f7Stages }, CO_CACHE);
  check('F7: terminal:false clears the inherited flag (mode still inherited)',
    f7.status === 200
    && f7.json?.stages?.find(s => s.key === 'disqualified')?.terminal === undefined
    && f7.json?.stages?.find(s => s.key === 'disqualified')?.mode === 'auto', JSON.stringify(f7.json?.stages));

  // Positive control for the E5 conversations gate (critic: the negative
  // alone could pass with the auto-advance entirely broken): a mode-less
  // tenant's inbound reply DOES advance engaged → responded.
  const cPos = await createContact('CP1 Reply Positive');
  for (const st of ['enriched', 'segmented', 'queued', 'engaged']) {
    await req('POST', `/api/crm/contacts/${cPos}/advance`, { pipeline_key: 'marketing', stage: st });
  }
  const posConv = await req('POST', '/api/crm/conversations', { contact_id: cPos, channel: 'email' });
  await req('POST', `/api/crm/conversations/${posConv.json?.id}/messages`, { direction: 'inbound', channel: 'email', body: 'interested!' });
  const cPosAfter = await req('GET', `/api/crm/contacts/${cPos}`);
  check('E5 positive control: mode-less tenant inbound reply still auto-advances to responded',
    cPosAfter.json?.marketing_stage === 'responded', cPosAfter.json?.marketing_stage);

  await db.shutdownDatabase();

  console.log(`\nDenchClaw CRM CP1 (funnel pipelines) verification — RUN=${RUN}\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
