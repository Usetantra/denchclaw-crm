#!/usr/bin/env node
// DenchClaw CRM — contract test harness.
// Spec: ../.specs/001-api-contract.md   Brief: ../docs/PRODUCT_BRIEF.md
//
// Re-runnable: uses a run tag (RUN env, default = epoch) to make emails/linkedin/phone unique,
// since the CRM dedups on all three. Drives the running server on CRM_API_BASE.
//
//   DATABASE-free: this script only speaks HTTP to a server you started separately.
//
// Usage:
//   CRM_API_BASE=http://127.0.0.1:3100 INTERNAL_API_KEY=... node test/contract.mjs
//
// Each case carries a `cp` tag = the checkpoint at which its TARGET behavior lands. At CP0 we assert
// the BASELINE (current) behavior — including the known-bad cases — so later checkpoints flip the
// expectation and the diff is visible. Set PHASE=CP0 (default) to assert baseline.

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
// Optional key bound (via server INTERNAL_API_KEYS) to ONLY the company 'co_bound_only',
// used to prove the 403 key→company binding at CP1+.
const LIMITED_KEY = process.env.LIMITED_API_KEY || null;
const RUN = process.env.RUN || String(Date.now());
const PHASE = process.env.PHASE || 'CP0';
const CO_A = 'co_a_' + RUN;
const CO_B = 'co_b_' + RUN;
const DEFAULT_CO = 'growthclub'; // auth.js default when X-Company-Id absent

if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];

async function req(method, path, { company, key = KEY, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (key !== null) h['x-internal-key'] = key;
  if (company !== undefined && company !== null) h['x-company-id'] = company;
  const r = await fetch(BASE + path, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

function check(name, cp, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  [${cp}] ${name}`); }
  else { fail++; results.push(`  FAIL  [${cp}] ${name} — ${detail}`); }
}

const email = (who) => `ct-${who}-${RUN}@example.com`;

async function main() {
  console.log(`\nDenchClaw CRM contract test — PHASE=${PHASE} RUN=${RUN}\nBASE=${BASE}\n`);

  // 1 — health
  {
    const r = await req('GET', '/health', { company: CO_A });
    check('health ok', '—', r.status === 200 && r.json?.ok === true, `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 2 — create contact (co_a) → 201 + company_name echoed
  let aId = null;
  {
    const r = await req('POST', '/api/crm/contacts', {
      company: CO_A,
      body: { name: 'Alice A', email: email('a'), company: 'Acme A', source: 'manual', lead_score: 'warm' },
    });
    aId = r.json?.id || null;
    check('create co_a contact', '—',
      r.status === 201 && !!aId && (r.json?.company_name === 'Acme A'),
      `status=${r.status} id=${aId} company_name=${r.json?.company_name}`);
  }

  // 3 — find by email (co_a)
  {
    const r = await req('GET', `/api/crm/contacts?search=${encodeURIComponent(email('a'))}`, { company: CO_A });
    const found = (r.json?.contacts || []).some(c => (c.email || '').toLowerCase() === email('a'));
    check('find co_a by email', '—', r.status === 200 && found, `status=${r.status} n=${r.json?.contacts?.length}`);
  }

  // 4 — read co_a contact AS co_b  (BASELINE: leaks 200; TARGET CP1: 404)
  {
    const r = await req('GET', `/api/crm/contacts/${aId}`, { company: CO_B });
    const leaks = r.status === 200 && r.json?.id === aId;
    if (PHASE === 'CP0') check('cross-company read leaks (baseline)', 'CP1→404', leaks, `status=${r.status}`);
    else check('cross-company read blocked', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 5 — patch co_a contact AS co_b  (BASELINE: mutates 200; TARGET CP1: 404)
  {
    const r = await req('PATCH', `/api/crm/contacts/${aId}`, { company: CO_B, body: { title: 'pwned-by-b' } });
    if (PHASE === 'CP0') check('cross-company patch mutates (baseline)', 'CP1→404', r.status === 200, `status=${r.status}`);
    else check('cross-company patch blocked', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 6 — read co_a contact activity AS co_b  (BASELINE: leaks feed; TARGET CP1: 404)
  {
    const r = await req('GET', `/api/crm/contacts/${aId}/activity`, { company: CO_B });
    if (PHASE === 'CP0') check('cross-company activity leaks (baseline)', 'CP1→404', r.status === 200, `status=${r.status}`);
    else check('cross-company activity blocked', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 7 — key→company binding (BASELINE: any company accepted; TARGET CP1: 403 for out-of-set)
  {
    if (PHASE === 'CP0') {
      const r = await req('GET', '/api/crm/contacts', { company: 'totally-unbound-company-' + RUN });
      check('foreign company-id accepted (baseline)', 'CP1→403', r.status === 200, `status=${r.status}`);
    } else if (LIMITED_KEY) {
      const denied = await req('GET', '/api/crm/contacts', { key: LIMITED_KEY, company: 'co_other_' + RUN });
      check('out-of-set company rejected (403)', 'CP1', denied.status === 403, `status=${denied.status} (should be 403)`);
      const ok = await req('GET', '/api/crm/contacts', { key: LIMITED_KEY, company: 'co_bound_only' });
      check('in-set company allowed (200)', 'CP1', ok.status === 200, `status=${ok.status} (should be 200)`);
    } else {
      check('binding test', 'CP1', false, 'LIMITED_API_KEY not provided — cannot test 403 binding');
    }
  }

  // 8 — api-backend default-company path: read co_a contact with the DEFAULT company header
  //     (mirrors _ApiBackend.find_by_id sending X-Company-Id=growthclub). BASELINE: 200 (unscoped).
  //     After CP1 + client company-threading, the backend will send the right company; this raw-default
  //     probe should then 404 (proving the scope is real). Kept as a regression sentinel.
  {
    const r = await req('GET', `/api/crm/contacts/${aId}`, { company: DEFAULT_CO });
    if (PHASE === 'CP0') check('default-company read works unscoped (baseline)', 'CP1', r.status === 200, `status=${r.status}`);
    else check('default-company cannot read co_a row', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 9 — illegal stage transition lead→won → 400 with allowed_transitions
  {
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Stage X', email: email('stage'), source: 'manual' } });
    const sid = c.json?.id;
    const r = await req('PATCH', `/api/crm/contacts/${sid}`, { company: CO_A, body: { deal_stage: 'won' } });
    check('illegal transition lead→won → 400', '—',
      r.status === 400 && Array.isArray(r.json?.allowed_transitions),
      `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 10 — legal transition lead→contacted → 200, and 11 — reactivation lead→lost→lead → 200
  {
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Stage Y', email: email('stageY'), source: 'manual' } });
    const sid = c.json?.id;
    const r1 = await req('PATCH', `/api/crm/contacts/${sid}`, { company: CO_A, body: { deal_stage: 'contacted' } });
    check('legal transition lead→contacted → 200', '—', r1.status === 200, `status=${r1.status}`);

    const c2 = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'React Z', email: email('react'), source: 'manual' } });
    const rid = c2.json?.id;
    const toLost = await req('PATCH', `/api/crm/contacts/${rid}`, { company: CO_A, body: { deal_stage: 'lost' } });
    // Since f82738c the authority maps lost → ['accepted'] (was ['lead']).
    const back = await req('PATCH', `/api/crm/contacts/${rid}`, { company: CO_A, body: { deal_stage: 'accepted' } });
    check('reactivation lost→accepted → 200 (state machine)', '—',
      toLost.status === 200 && back.status === 200, `lost=${toLost.status} back=${back.status}`);
  }

  // 12 — add activity bumps lead_score_numeric
  {
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Score', email: email('score'), source: 'manual' } });
    const sid = c.json?.id;
    const before = (await req('GET', `/api/crm/contacts/${sid}`, { company: CO_A })).json?.lead_score_numeric ?? 0;
    await req('POST', `/api/crm/contacts/${sid}/activity`, { company: CO_A, body: { type: 'email_replied', message: 'replied' } });
    const after = (await req('GET', `/api/crm/contacts/${sid}`, { company: CO_A })).json?.lead_score_numeric ?? 0;
    check('activity bumps lead_score_numeric', '—', after > before, `before=${before} after=${after}`);
  }

  // 13 — prospect_inbox enqueue (BASELINE: 404 no route; TARGET CP3: 201/200)
  {
    const r = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: aId, target_engine: 'nurturing' } });
    if (PHASE === 'CP0') check('prospect-inbox enqueue absent (baseline)', 'CP3→200', r.status === 404, `status=${r.status}`);
    else check('prospect-inbox enqueue works', 'CP3', r.status === 200 || r.status === 201, `status=${r.status}`);
  }

  // ── CP3 deep cases (handoff). Only meaningful once the endpoints + migration exist. ──
  if (PHASE === 'CP3' || PHASE === 'CP4' || PHASE === 'CP5') {
    // 14 — idempotent on (contact_id, target_engine)
    {
      const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'HO', email: email('ho'), source: 'manual' } });
      const cid = c.json?.id;
      const e1 = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: cid, target_engine: 'nurturing', metadata: { a: 1 } } });
      const e2 = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: cid, target_engine: 'nurturing', metadata: { b: 2 } } });
      check('enqueue idempotent (one row, merged meta)', 'CP3',
        e1.json?.id && e2.json?.id === e1.json.id && e2.json?.metadata?.a === 1 && e2.json?.metadata?.b === 2,
        `e1=${e1.json?.id} e2=${e2.json?.id} meta=${JSON.stringify(e2.json?.metadata)}`);

      // 15 — re-handoff after done resets to pending
      await req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: 'nurturing', limit: 50, claimed_by: 'nurturing' } });
      await req('PATCH', `/api/crm/prospect-inbox/${e1.json.id}`, { company: CO_A, body: { status: 'done' } });
      const reEnq = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: cid, target_engine: 'nurturing' } });
      check('re-handoff resets done→pending', 'CP3',
        reEnq.json?.status === 'pending' && reEnq.json?.claimed_by === null,
        `status=${reEnq.json?.status} claimed_by=${reEnq.json?.claimed_by}`);
    }

    // 16 — cross-company enqueue → 404 (contact belongs to CO_A, caller is CO_B)
    {
      const r = await req('POST', '/api/crm/prospect-inbox', { company: CO_B, body: { contact_id: aId, target_engine: 'nurturing' } });
      check('cross-company enqueue blocked (404)', 'CP3', r.status === 404, `status=${r.status}`);
    }

    // 17 — N-way atomic claim: K pending rows, N concurrent claimers (limit 1) → no dup, total==K
    {
      const TE = 'race_' + RUN;
      const K = 6;
      const ids = [];
      for (let i = 0; i < K; i++) {
        const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: `R${i}`, email: email('race' + i), source: 'manual' } });
        await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: c.json.id, target_engine: TE } });
      }
      const N = 10;
      const claims = await Promise.all(
        Array.from({ length: N }, () => req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: TE, limit: 1, claimed_by: 'w' } }))
      );
      const claimedIds = claims.flatMap(c => (c.json?.claimed || []).map(r => r.id));
      const uniq = new Set(claimedIds);
      check('atomic claim: no double-claim', 'CP3',
        claimedIds.length === uniq.size && uniq.size === K,
        `claimed=${claimedIds.length} unique=${uniq.size} expected=${K}`);
    }

    // 18 — broadcast (NULL target) claimable by a specific engine
    {
      const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'BC', email: email('bc'), source: 'manual' } });
      const enq = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: c.json.id } }); // no target = broadcast
      const claim = await req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: 'some_engine_' + RUN, limit: 10, claimed_by: 'x' } });
      const got = (claim.json?.claimed || []).some(r => r.id === enq.json?.id);
      check('broadcast handoff claimable by any engine', 'CP3', enq.json?.target_engine === null && got, `target=${enq.json?.target_engine} claimed=${got}`);
    }
  }

  // 19 — tags overlap filter on GET /contacts (send-side enrolled-contact query)
  {
    const tag = 'enrolltest_' + RUN;
    const a = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Tagged', email: email('tagged'), source: 'manual', tags: [tag] } });
    await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Untagged', email: email('untagged'), source: 'manual' } });
    const r = await req('GET', `/api/crm/contacts?tags=${encodeURIComponent(tag)}`, { company: CO_A });
    const rows = r.json?.contacts || [];
    const hasTagged = rows.some(c => c.id === a.json?.id);
    const onlyTagged = rows.every(c => (c.tags || []).includes(tag));
    check('GET /contacts?tags= filters by tag overlap', 'CP4', r.status === 200 && hasTagged && onlyTagged && rows.length >= 1,
      `status=${r.status} n=${rows.length} hasTagged=${hasTagged} onlyTagged=${onlyTagged}`);
  }

  // 20 — phone overlap filter (inbound webhook contact resolution)
  {
    const last4 = String(RUN).slice(-4);
    const ph = `(415) 555-${last4}`;                       // stored digits: 415555<last4>
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Phoned', email: email('phoned'), phone: ph, source: 'manual' } });
    // query a differently-formatted but digit-equal value to prove normalization
    const r = await req('GET', `/api/crm/contacts?phone=${encodeURIComponent(`415-555-${last4}`)}`, { company: CO_A });
    const rows = r.json?.contacts || [];
    check('GET /contacts?phone= normalized digit match', 'CP4',
      r.status === 200 && rows.some(x => x.id === c.json?.id),
      `status=${r.status} n=${rows.length}`);
  }

  // ══ CP5 — two-pipeline surface: /advance, prospect-inbox sales claim,
  //          conversations + inbound auto-advance, campaign-events analytics,
  //          bulk-import tenant scoping (E3.1 regression). ══
  if (PHASE === 'CP5') {
    const advance = (cid, body, company = CO_A) =>
      req('POST', `/api/crm/contacts/${cid}/advance`, { company, body });

    // 21 — marketing /advance legal: sourced→segmented (per migration 006)
    let mktId = null;
    {
      const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Mkt A', email: email('mkt'), source: 'manual', tags: ['campaign:cp5camp_' + RUN] } });
      mktId = c.json?.id;
      const r = await advance(mktId, { pipeline_key: 'marketing', stage: 'segmented' });
      check('marketing advance sourced→segmented → 200 changed', 'CP5',
        r.status === 200 && r.json?.changed === true && r.json?.previous === 'sourced',
        `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 22 — marketing /advance idempotent same-stage → 200 changed:false
    {
      const r = await advance(mktId, { pipeline_key: 'marketing', stage: 'segmented' });
      check('marketing advance idempotent same-stage → changed:false', 'CP5',
        r.status === 200 && r.json?.changed === false, `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 23 — marketing /advance illegal: segmented→mql → 409 + allowed list
    {
      const r = await advance(mktId, { pipeline_key: 'marketing', stage: 'mql' });
      check('marketing advance illegal segmented→mql → 409 + allowed', 'CP5',
        r.status === 409 && Array.isArray(r.json?.allowed) && r.json.allowed.includes('queued'),
        `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 24 — sales claim auto-creates a deal at 'accepted'
    let salesContactId = null, dealId = null;
    {
      const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Sales A', email: email('sales'), source: 'manual' } });
      salesContactId = c.json?.id;
      await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: salesContactId, target_engine: 'sales', source_engine: 'outreach', metadata: { reason: 'mql' } } });
      const claim = await req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: 'sales', limit: 10, claimed_by: 'sales-engine' } });
      const claimedRow = (claim.json?.claimed || []).find(r => r.contact_id === salesContactId);
      const deals = await req('GET', `/api/crm/deals?stage=accepted`, { company: CO_A });
      const deal = (deals.json?.deals || []).find(d => d.contact_id === salesContactId);
      dealId = deal?.id || null;
      check('sales claim auto-creates deal at accepted', 'CP5',
        claim.status === 200 && !!claimedRow && !!deal && deal.stage === 'accepted',
        `claimStatus=${claim.status} claimed=${!!claimedRow} deal=${JSON.stringify(deal)}`);
    }

    // 25 — sales /advance illegal: accepted→won → 409 + allowed list
    {
      const r = await advance(salesContactId, { pipeline_key: 'sales', stage: 'won' });
      check('sales advance illegal accepted→won → 409 + allowed', 'CP5',
        r.status === 409 && Array.isArray(r.json?.allowed) && r.json.allowed.includes('contacted'),
        `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 26 — sales /advance legal: accepted→contacted → 200 changed (targets the deal row)
    {
      const r = await advance(salesContactId, { pipeline_key: 'sales', stage: 'contacted' });
      check('sales advance accepted→contacted → 200 changed + deal_id', 'CP5',
        r.status === 200 && r.json?.changed === true && r.json?.deal_id === dealId,
        `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 27 — sales /advance idempotent same-stage → changed:false
    {
      const r = await advance(salesContactId, { pipeline_key: 'sales', stage: 'contacted' });
      check('sales advance idempotent same-stage → changed:false', 'CP5',
        r.status === 200 && r.json?.changed === false, `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 28 — unknown pipeline_key → 404 (no such pipeline config)
    {
      const r = await advance(salesContactId, { pipeline_key: 'bogus', stage: 'contacted' });
      check('advance unknown pipeline_key → 404 not configured', 'CP5',
        r.status === 404 && /not configured/i.test(r.json?.error || ''), `status=${r.status} body=${JSON.stringify(r.json)}`);
    }

    // 29 — conversations find-or-create is idempotent per (contact, channel)
    let convId = null;
    {
      // Walk the marketing contact to 'engaged' so the inbound reply can advance it.
      await advance(mktId, { pipeline_key: 'marketing', stage: 'queued' });
      await advance(mktId, { pipeline_key: 'marketing', stage: 'engaged' });
      const c1 = await req('POST', '/api/crm/conversations', { company: CO_A, body: { contact_id: mktId, channel: 'email' } });
      const c2 = await req('POST', '/api/crm/conversations', { company: CO_A, body: { contact_id: mktId, channel: 'email' } });
      convId = c1.json?.id || null;
      check('conversation find-or-create idempotent (same id)', 'CP5',
        c1.status === 201 && c2.status === 201 && !!convId && c2.json?.id === convId,
        `c1=${c1.json?.id} c2=${c2.json?.id}`);
    }

    // 30 — inbound message auto-advances marketing engaged→responded + returns active_campaigns
    {
      const r = await req('POST', `/api/crm/conversations/${convId}/messages`, {
        company: CO_A,
        body: { direction: 'inbound', channel: 'email', body: 'interested!', provider_message_id: 'pm_' + RUN },
      });
      const contact = (await req('GET', `/api/crm/contacts/${mktId}`, { company: CO_A })).json;
      check('inbound message → marketing responded + active_campaigns', 'CP5',
        r.status === 201 && Array.isArray(r.json?.active_campaigns) &&
        r.json.active_campaigns.includes('cp5camp_' + RUN) &&
        contact?.marketing_stage === 'responded',
        `status=${r.status} campaigns=${JSON.stringify(r.json?.active_campaigns)} stage=${contact?.marketing_stage}`);

      // 31 — provider_message_id dedup: same webhook twice → same message row
      const dup = await req('POST', `/api/crm/conversations/${convId}/messages`, {
        company: CO_A,
        body: { direction: 'inbound', channel: 'email', body: 'interested!', provider_message_id: 'pm_' + RUN },
      });
      check('inbound message idempotent on provider_message_id', 'CP5',
        dup.status === 201 && dup.json?.message?.id === r.json?.message?.id,
        `first=${r.json?.message?.id} second=${dup.json?.message?.id}`);
    }

    // 32 — campaign-events: single + array ingested, reflected in /analytics/by-campaign
    {
      const camp = 'cp5camp_' + RUN;
      const single = await req('POST', '/api/crm/campaign-events', {
        company: CO_A, body: { campaign_id: camp, contact_id: mktId, channel: 'email', type: 'send' },
      });
      const batch = await req('POST', '/api/crm/campaign-events', {
        company: CO_A, body: [
          { campaign_id: camp, contact_id: mktId, channel: 'email', type: 'open' },
          { campaign_id: camp, contact_id: mktId, channel: 'email', type: 'reply' },
        ],
      });
      const rep = await req('GET', '/api/crm/analytics/by-campaign?days=7', { company: CO_A });
      const row = (rep.json?.campaigns || []).find(c => c.campaign_id === camp);
      check('campaign-events single+array → by-campaign rollup', 'CP5',
        single.status === 202 && single.json?.accepted === 1 &&
        batch.status === 202 && batch.json?.accepted === 2 &&
        !!row && row.sends === 1 && row.opens === 1 && row.replies === 1,
        `single=${single.status}/${single.json?.accepted} batch=${batch.status}/${batch.json?.accepted} row=${JSON.stringify(row)}`);
    }

    // 33 — /analytics/funnel?pipeline_key=marketing reflects stage counts
    {
      const r = await req('GET', '/api/crm/analytics/funnel?pipeline_key=marketing', { company: CO_A });
      const responded = (r.json?.stages || []).find(s => s.stage === 'responded');
      check('funnel marketing shows responded ≥ 1', 'CP5',
        r.status === 200 && r.json?.pipeline_key === 'marketing' && (responded?.count || 0) >= 1,
        `status=${r.status} stages=${JSON.stringify(r.json?.stages)}`);
    }

    // 34 — /analytics/funnel?pipeline_key=sales reflects deal stages
    {
      const r = await req('GET', '/api/crm/analytics/funnel?pipeline_key=sales', { company: CO_A });
      const contacted = (r.json?.stages || []).find(s => s.stage === 'contacted');
      check('funnel sales shows contacted ≥ 1', 'CP5',
        r.status === 200 && (contacted?.count || 0) >= 1,
        `status=${r.status} stages=${JSON.stringify(r.json?.stages)}`);
    }

    // 35 — bulk-import tenant scoping (E3.1 regression): rows land in caller's company
    {
      const bulkEmail = email('bulk');
      const imp = await req('POST', '/api/crm/contacts/bulk-import', {
        company: CO_A, body: { contacts: [{ name: 'Bulk B', email: bulkEmail, source: 'listX' }] },
      });
      const inA = await req('GET', `/api/crm/contacts?search=${encodeURIComponent(bulkEmail)}`, { company: CO_A });
      const rowA = (inA.json?.contacts || []).find(c => (c.email || '').toLowerCase() === bulkEmail);
      const inB = await req('GET', `/api/crm/contacts?search=${encodeURIComponent(bulkEmail)}`, { company: CO_B });
      const rowB = (inB.json?.contacts || []).find(c => (c.email || '').toLowerCase() === bulkEmail);
      check('bulk-import contact lands in caller company (not null)', 'CP5',
        imp.status === 200 && imp.json?.created === 1 && !!rowA && rowA.company_id === CO_A && !rowB,
        `imp=${imp.status}/${JSON.stringify(imp.json)} inA=${!!rowA} company_id=${rowA?.company_id} inB=${!!rowB}`);

      // 36 — its activity is tenant-scoped too (visible to CO_A, 404 for CO_B)
      const actA = await req('GET', `/api/crm/contacts/${rowA?.id}/activity`, { company: CO_A });
      const hasLoad = (actA.json?.activity || []).some(a => a.type === 'prospect_loaded');
      const actB = await req('GET', `/api/crm/contacts/${rowA?.id}/activity`, { company: CO_B });
      check('bulk-import activity written under caller company', 'CP5',
        actA.status === 200 && hasLoad && actB.status === 404,
        `actA=${actA.status} hasLoad=${hasLoad} actB=${actB.status}`);

      // 37 — re-import same email in-tenant dedups (updated, not duplicated)
      const imp2 = await req('POST', '/api/crm/contacts/bulk-import', {
        company: CO_A, body: { contacts: [{ name: 'Bulk B2', email: bulkEmail }] },
      });
      check('bulk-import re-import dedups in-tenant (updated=1)', 'CP5',
        imp2.status === 200 && imp2.json?.updated === 1 && imp2.json?.created === 0,
        `body=${JSON.stringify(imp2.json)}`);
    }
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed  (PHASE=${PHASE})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });
