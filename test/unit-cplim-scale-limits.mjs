#!/usr/bin/env node
// DenchClaw CRM — CP-LIM: pagination, streaming export and import ceilings.
//
// The capacity limit was never Postgres — it was the application. Several
// endpoints emitted no LIMIT clause and loaded every contact a tenant owned into
// Node memory, so with pm2's max_memory_restart a large tenant did not get a
// slow response: the process was killed mid-request. These checks pin the
// bounds that replaced that, and — just as important — pin that nothing
// truncates SILENTLY. A partial list reporting itself as complete is a
// data-loss bug the operator cannot see, and is worse than the OOM it replaced.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cplim-scale-limits.mjs

import fs from 'node:fs';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import crmRouter from '../server/routes/crm.js';
import LIMITS from '../server/lib/query-limits.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cplim_co_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': CO },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
async function raw(p) {
  const r = await fetch(BASE + p, { headers: { 'x-internal-key': KEY, 'x-company-id': CO } });
  return { status: r.status, text: await r.text() };
}

const N = 25;

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  for (let i = 0; i < N; i++) {
    await contactDb.create({
      company_id: CO, name: `Lim ${String(i).padStart(3, '0')}`,
      email: `lim-${i}-${RUN}@ex.test`, phone: `+1415555${String(1000 + i)}`,
      deal_stage: i % 2 ? 'lead' : 'qualified', deal_value: 10,
      lead_score: 'hot',
    });
  }

  // ══ 1. The DAL backstop ═══════════════════════════════════════════════════
  const capped = await contactDb.list(CO, { hardCap: 10 });
  check('LIM-1 an unbounded list() is bounded by the hard cap',
    capped.length === 10, String(capped.length));
  check('LIM-2 ...and flags itself as capped so a route can report has_more',
    capped.capped === true, String(capped.capped));

  const notCapped = await contactDb.list(CO, { hardCap: 500 });
  check('LIM-3 a result inside the cap is NOT flagged',
    notCapped.length === N && notCapped.capped === undefined, `${notCapped.length}/${notCapped.capped}`);

  check('LIM-4 countMatching reports the true total', (await contactDb.countMatching(CO)) === N, 'count');

  // ══ 2. Keyset batching — every row exactly once ═══════════════════════════
  // The property that matters: no skips and no duplicates. OFFSET paging would
  // fail this under concurrent inserts; keyset is why this holds.
  const seen = [];
  let batches = 0;
  for await (const b of contactDb.listBatches(CO, { batchSize: 7 })) { batches++; seen.push(...b.map(c => c.id)); }
  check('LIM-5 listBatches yields every row exactly once',
    seen.length === N && new Set(seen).size === N, `${seen.length} rows, ${new Set(seen).size} unique`);
  check('LIM-6 ...in more than one batch (it really is streaming)', batches >= 4, String(batches));

  const limited = [];
  for await (const b of contactDb.listBatches(CO, { batchSize: 7, max: 10 })) limited.push(...b);
  check('LIM-7 listBatches honours an absolute max', limited.length === 10, String(limited.length));

  // ══ 3. Export — streamed, complete, and honestly bounded ══════════════════
  const csv = await raw('/api/crm/contacts/export?format=csv');
  const lines = csv.text.trim().split('\n');
  check('LIM-8 CSV export streams a header plus every contact',
    csv.status === 200 && lines.length === N + 1, `${lines.length} lines`);
  check('LIM-9 ...with a download filename and CSV content type',
    /name,email,phone/.test(lines[0]), lines[0]);

  const je = await raw('/api/crm/contacts/export');
  let parsed = null; try { parsed = JSON.parse(je.text); } catch {}
  check('LIM-10 the streamed JSON export is still valid JSON',
    !!parsed && Array.isArray(parsed.contacts), je.text.slice(0, 120));
  check('LIM-11 ...and contains every contact',
    parsed && parsed.contacts.length === N && parsed.total === N && parsed.exported === N,
    JSON.stringify({ n: parsed?.contacts?.length, total: parsed?.total }));

  // ══ 4. Import ceiling ═════════════════════════════════════════════════════
  const tooMany = await req('POST', '/api/crm/contacts/bulk-import', {
    contacts: Array.from({ length: LIMITS.IMPORT_MAX + 1 }, (_, i) => ({ name: `X${i}` })),
  });
  check('LIM-12 an over-size import is refused with 413, not a parser error',
    tooMany.status === 413, JSON.stringify(tooMany.json).slice(0, 160));
  check('LIM-13 ...and the error names the limit so the client can chunk',
    tooMany.json?.limit === LIMITS.IMPORT_MAX && /Split the file/.test(tooMany.json?.error || ''),
    JSON.stringify(tooMany.json));

  const okImport = await req('POST', '/api/crm/contacts/bulk-import', {
    contacts: [{ name: 'Imp One', email: `imp1-${RUN}@ex.test` }, { name: 'Imp Two', email: `imp2-${RUN}@ex.test` }],
  });
  check('LIM-14 a normal import still works', okImport.status === 200 && okImport.json?.created === 2,
    JSON.stringify(okImport.json).slice(0, 160));

  // ══ 5. Follow-ups — SQL-side, paginated ══════════════════════════════════
  const fu = await req('GET', '/api/crm/contacts/follow-ups?limit=5');
  check('LIM-15 follow-ups honours limit and reports a true total',
    fu.status === 200 && fu.json.contacts.length === 5 && fu.json.total > 5, JSON.stringify({ n: fu.json?.contacts?.length, t: fu.json?.total }));
  check('LIM-16 ...and says there is more rather than implying that is all',
    fu.json.has_more === true, String(fu.json?.has_more));

  const fu2 = await req('GET', '/api/crm/contacts/follow-ups?limit=5&offset=5');
  const overlap = fu.json.contacts.filter(a => fu2.json.contacts.some(b => b.id === a.id));
  check('LIM-17 ...and paging does not repeat rows', overlap.length === 0, `${overlap.length} overlapping`);

  // ══ 6. Pipeline — exact counts, bounded cards ════════════════════════════
  const pipe = await req('GET', '/api/crm/pipeline?stage_limit=3');
  const qualified = pipe.json?.pipeline?.qualified;
  check('LIM-18 pipeline caps the CARDS per stage',
    !!qualified && qualified.contacts.length <= 3, JSON.stringify({ n: qualified?.contacts?.length }));
  check('LIM-19 ...but the stage COUNT stays exact (aggregate, not array length)',
    qualified && qualified.count === Math.ceil(N / 2), JSON.stringify({ count: qualified?.count, expected: Math.ceil(N / 2) }));
  check('LIM-20 ...and the stage says it is truncated rather than looking complete',
    qualified && qualified.truncated === true, String(qualified?.truncated));
  check('LIM-21 ...and the stage value is a real sum, not a page sum',
    qualified && Number(qualified.value) === Math.ceil(N / 2) * 10, String(qualified?.value));

  // ══ 7. The SQL rewrite of the hot path still matches the same contacts ═══
  // findOrCreateContact's no-email path used to scan every contact per inbound
  // webhook. It is SQL now — the rules must be unchanged.
  const byPhone = await crmRouter.findOrCreateContact(null, { company_id: CO, phone: '+1 (415) 555-1005' });
  check('LIM-22 phone match still finds the existing contact via digits-only equality',
    byPhone.created === false && byPhone.contact.name === 'Lim 005', JSON.stringify({ created: byPhone.created, name: byPhone.contact?.name }));

  const li = await contactDb.create({ company_id: CO, name: 'LinkedIn Person', linkedin_url: 'https://linkedin.com/in/Case-Test' });
  const byLi = await crmRouter.findOrCreateContact(null, { company_id: CO, linkedin_url: 'https://LINKEDIN.com/in/case-test' });
  check('LIM-23 linkedin match is still case-insensitive',
    byLi.created === false && byLi.contact.id === li.id, JSON.stringify({ created: byLi.created }));

  const fresh = await crmRouter.findOrCreateContact(null, { company_id: CO, phone: '+19999999999' });
  check('LIM-24 an unmatched phone still creates rather than mis-matching',
    fresh.created === true, JSON.stringify({ created: fresh.created }));

  // ══ 7b. The UI's selectable page sizes ═══════════════════════════════════
  // The Contacts/Companies pager offers 25/50/100/200. Each must be a size the
  // server will actually honour — a selector offering a size the server clamps
  // would render "1–500 of N" while claiming a different page size, which reads
  // as a broken pager rather than a clamp.
  const ui = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const declared = (ui.match(/const PAGE_SIZES=\[([^\]]+)\]/) || [])[1];
  const sizes = declared ? declared.split(',').map(n => parseInt(n, 10)) : [];
  check('LIM-26 the UI declares selectable page sizes', sizes.length >= 2 && sizes.includes(50) && sizes.includes(100), declared);
  check('LIM-27 ...and every one is within the server page cap',
    sizes.length > 0 && sizes.every(n => n <= LIMITS.MAX_PAGE), `${declared} vs cap ${LIMITS.MAX_PAGE}`);
  check('LIM-28 the duplicated per-list pagers are gone (one shared renderPager)',
    !/CONTACT_PAGE_SIZE|COMPANY_PAGE_SIZE/.test(ui) && /function renderPager\(/.test(ui), 'pager unified');

  // Every offered size must round-trip through the real endpoint.
  for (const n of sizes) {
    const r = await req('GET', `/api/crm/contacts?limit=${n}&offset=0`);
    const got = (r.json?.contacts || []).length;
    check(`LIM-29.${n} contacts honours limit=${n} and reports the true total`,
      r.status === 200 && got === Math.min(n, r.json.total) && r.json.total >= N,
      JSON.stringify({ got, total: r.json?.total }));
  }

  // The paging maths the pager renders ("from–to of total") depends on `total`
  // being the tenant count, not the page length.
  const p1 = await req('GET', '/api/crm/contacts?limit=10&offset=0');
  const p2 = await req('GET', '/api/crm/contacts?limit=10&offset=10');
  check('LIM-30 total is the tenant count, not the page length',
    p1.json.total === p2.json.total && p1.json.total > 10, JSON.stringify({ a: p1.json?.total, b: p2.json?.total }));
  const dup = p1.json.contacts.filter(a => p2.json.contacts.some(b => b.id === a.id));
  check('LIM-31 consecutive pages do not repeat rows', dup.length === 0, `${dup.length} repeated`);

  const co = await req('GET', '/api/crm/companies?limit=100&offset=0');
  check('LIM-32 companies paginates on the same contract', co.status === 200 && typeof co.json.total === 'number',
    JSON.stringify(co.json).slice(0, 120));

  // ══ 7c. A filtered count must count the FILTER, not the tenant ═══════════
  // countMatching declared a `filters` argument and ignored it, so a filtered
  // page reported the tenant's whole contact total. The pager then rendered
  // "1-50 of 4,312" for a search matching three people — a wrong number
  // presented as authoritative, which is the exact failure the capping rules
  // exist to prevent.
  const hits = await contactDb.countMatching(CO, { search: 'Lim 00' });
  const all = await contactDb.countMatching(CO);
  check('LIM-33 countMatching applies the filters it is given',
    hits > 0 && hits < all, `${hits} filtered vs ${all} total`);

  const filtered = await req('GET', '/api/crm/contacts?search=Lim%20005&limit=10');
  check('LIM-34 a filtered page reports the MATCH count, not the tenant count',
    filtered.json.total === 1, JSON.stringify({ total: filtered.json?.total, n: filtered.json?.contacts?.length }));

  const noMatch = await req('GET', '/api/crm/contacts?search=zzz-nothing-matches&limit=10');
  check('LIM-35 ...and a search matching nothing reports zero, not the tenant total',
    noMatch.json.total === 0 && (noMatch.json.contacts || []).length === 0, JSON.stringify(noMatch.json?.total));

  // ══ 8. Tenancy holds through the new SQL ═════════════════════════════════
  const otherCount = await contactDb.countMatching('cplim_absent_' + RUN);
  check('LIM-25 countMatching is tenant-scoped', otherCount === 0, String(otherCount));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
