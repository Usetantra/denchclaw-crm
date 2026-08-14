#!/usr/bin/env node
// DenchClaw CRM — CP-M3: Business Profile, Custom Field definitions, and Tags
// management (Settings). All tenant-scoped under requireAuth (not the
// admin-only tenants.js provisioning router).
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpm3-settings.mjs

import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpm3_co_' + RUN;
const CO2 = 'cpm3_other_' + RUN;
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

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  // ── M3-1 — business profile: empty by default, upsert round-trips ─────────
  const empty = await req('GET', '/api/crm/settings/business-profile');
  check('M3-1 a fresh tenant has no business profile row (just company_id echoed)',
    empty.status === 200 && empty.json?.profile?.company_id === CO && !empty.json?.profile?.name, JSON.stringify(empty.json));
  const saved = await req('PATCH', '/api/crm/settings/business-profile', {
    name: 'Acme Growth', industry: 'SaaS', website: 'https://acme.test', timezone: 'Asia/Kolkata',
    currency: 'USD', address: { city: 'Bengaluru', country: 'IN' },
  });
  check('M3-1 PATCH upserts and returns the saved profile', saved.status === 200 && saved.json?.profile?.name === 'Acme Growth', JSON.stringify(saved.json));
  const reread = await req('GET', '/api/crm/settings/business-profile');
  check('M3-1 a second GET reflects the saved profile', reread.json?.profile?.industry === 'SaaS' && reread.json?.profile?.address?.city === 'Bengaluru', JSON.stringify(reread.json));
  const partial = await req('PATCH', '/api/crm/settings/business-profile', { phone: '+15551234567' });
  const afterPartial = await req('GET', '/api/crm/settings/business-profile');
  check('M3-1 a partial PATCH does not clobber fields it did not mention',
    afterPartial.json?.profile?.name === 'Acme Growth' && afterPartial.json?.profile?.phone === '+15551234567', JSON.stringify(afterPartial.json));
  const otherProfile = await req('GET', '/api/crm/settings/business-profile', undefined, CO2);
  check('M3-1 business profile is tenant-scoped', !otherProfile.json?.profile?.name, JSON.stringify(otherProfile.json));

  // ── M3-2 — custom field definitions: validation, CRUD, key normalization ──
  const badType = await req('POST', '/api/crm/settings/custom-fields', { label: 'X', type: 'wat' });
  check('M3-2 an unrecognised type is refused with 400', badType.status === 400, JSON.stringify(badType.json));
  const noLabel = await req('POST', '/api/crm/settings/custom-fields', { label: '', type: 'text' });
  check('M3-2 an empty label is refused with 400', noLabel.status === 400, JSON.stringify(noLabel.json));
  const created = await req('POST', '/api/crm/settings/custom-fields', { label: 'Favorite Color!', type: 'select', options: ['Red', 'Blue'] });
  check('M3-2 create succeeds (201) and normalizes the label into a safe key',
    created.status === 201 && created.json?.field?.key === 'favorite_color', JSON.stringify(created.json));
  const fid = created.json.field.id;
  const dupe = await req('POST', '/api/crm/settings/custom-fields', { label: 'Favorite Color!', type: 'text' });
  check('M3-2 a duplicate label (same normalized key) is refused with 409', dupe.status === 409, JSON.stringify(dupe.json));
  const list1 = await req('GET', '/api/crm/settings/custom-fields');
  check('M3-2 it shows up in the list with its options intact',
    (list1.json?.fields || []).some(f => f.id === fid && JSON.stringify(f.options) === JSON.stringify(['Red', 'Blue'])), JSON.stringify(list1.json));
  const updated = await req('PATCH', `/api/crm/settings/custom-fields/${fid}`, { label: 'Favourite Colour', options: ['Red', 'Blue', 'Green'] });
  check('M3-2 update changes label/options but the key stays stable (values keyed on it must not break)',
    updated.status === 200 && updated.json?.field?.label === 'Favourite Colour' && updated.json?.field?.key === 'favorite_color', JSON.stringify(updated.json));
  const badUpdateType = await req('PATCH', `/api/crm/settings/custom-fields/${fid}`, { type: 'nonsense' });
  check('M3-2 update also rejects an unrecognised type', badUpdateType.status === 400, JSON.stringify(badUpdateType.json));

  // ── M3-3 — deleting a definition does NOT erase a contact's existing value ─
  const contact = await contactDb.create({ name: 'M3 Contact', email: `m3-${RUN}@ex.test`, company_id: CO });
  await req('PATCH', `/api/crm/contacts/${contact.id}`, { metadata: { custom_fields: { favorite_color: 'Blue' } } });
  const del = await req('DELETE', `/api/crm/settings/custom-fields/${fid}`);
  check('M3-3 delete succeeds and reports the freed key', del.status === 200 && del.json?.key === 'favorite_color', JSON.stringify(del.json));
  const contactAfter = await req('GET', `/api/crm/contacts/${contact.id}`);
  check('M3-3 the contact\'s value survives the definition being deleted',
    contactAfter.json?.metadata?.custom_fields?.favorite_color === 'Blue', JSON.stringify(contactAfter.json?.metadata));
  const listAfterDel = await req('GET', '/api/crm/settings/custom-fields');
  check('M3-3 the definition itself is gone from the list', !(listAfterDel.json?.fields || []).some(f => f.id === fid), JSON.stringify(listAfterDel.json));

  // ── M3-4 — custom field definitions are tenant-scoped ──────────────────────
  const other = await req('POST', '/api/crm/settings/custom-fields', { label: 'Secret Field', type: 'text' }, CO2);
  const listMine = await req('GET', '/api/crm/settings/custom-fields');
  check('M3-4 another tenant\'s field definition never appears in this tenant\'s list',
    !(listMine.json?.fields || []).some(f => f.id === other.json?.field?.id), JSON.stringify(listMine.json));
  const crossDelete = await req('DELETE', `/api/crm/settings/custom-fields/${other.json.field.id}`, undefined, CO);
  check('M3-4 deleting another tenant\'s field id is a 404, not a leak', crossDelete.status === 404, JSON.stringify(crossDelete.json));

  // ── M3-5 — tags: list with counts, rename (incl. merge), delete ────────────
  const t1 = await contactDb.create({ name: 'Tag One', email: `m3tag1-${RUN}@ex.test`, company_id: CO });
  const t2 = await contactDb.create({ name: 'Tag Two', email: `m3tag2-${RUN}@ex.test`, company_id: CO });
  await req('PATCH', `/api/crm/contacts/${t1.id}`, { tags: ['alpha', 'shared'] });
  await req('PATCH', `/api/crm/contacts/${t2.id}`, { tags: ['beta', 'shared'] });
  const tagList = await req('GET', '/api/crm/settings/tags');
  const sharedRow = (tagList.json?.tags || []).find(t => t.tag === 'shared');
  check('M3-5 tag list aggregates counts across contacts', sharedRow?.contact_count === 2, JSON.stringify(tagList.json?.tags));

  const ren = await req('PATCH', '/api/crm/settings/tags', { old_tag: 'alpha', new_tag: 'renamed' });
  check('M3-5 rename succeeds and reports rows touched', ren.status === 200 && ren.json?.contacts_updated === 1, JSON.stringify(ren.json));
  const t1After = await req('GET', `/api/crm/contacts/${t1.id}`);
  check('M3-5 the contact now carries the renamed tag', (t1After.json?.tags || []).includes('renamed'), JSON.stringify(t1After.json?.tags));

  // Merge case: t1 gets 'shared' too (already has 'renamed'), then rename
  // 'renamed' -> 'shared' where t1 ALREADY has 'shared' — must merge, not duplicate.
  await req('PATCH', `/api/crm/contacts/${t1.id}`, { tags: ['renamed', 'shared'] });
  const merge = await req('PATCH', '/api/crm/settings/tags', { old_tag: 'renamed', new_tag: 'shared' });
  check('M3-5 renaming into an already-present tag succeeds', merge.status === 200, JSON.stringify(merge.json));
  const t1Merged = await req('GET', `/api/crm/contacts/${t1.id}`);
  const shareCount = (t1Merged.json?.tags || []).filter(t => t === 'shared').length;
  check('M3-5 the merge does not duplicate the tag on the contact', shareCount === 1, JSON.stringify(t1Merged.json?.tags));

  const delTag = await req('DELETE', '/api/crm/settings/tags', { tag: 'beta' });
  check('M3-5 delete removes the tag and reports rows touched', delTag.status === 200 && delTag.json?.contacts_updated === 1, JSON.stringify(delTag.json));
  const t2After = await req('GET', `/api/crm/contacts/${t2.id}`);
  check('M3-5 the contact no longer carries the deleted tag', !(t2After.json?.tags || []).includes('beta'), JSON.stringify(t2After.json?.tags));

  // ── M3-6 — tags are tenant-scoped ──────────────────────────────────────────
  const otherTagList = await req('GET', '/api/crm/settings/tags', undefined, CO2);
  check('M3-6 another tenant\'s tag list never shows this tenant\'s tags',
    !(otherTagList.json?.tags || []).some(t => t.tag === 'shared'), JSON.stringify(otherTagList.json));
  const crossRename = await req('PATCH', '/api/crm/settings/tags', { old_tag: 'shared', new_tag: 'stolen' }, CO2);
  const t1Unaffected = await req('GET', `/api/crm/contacts/${t1.id}`);
  check('M3-6 another tenant "renaming" a tag it does not have touches nothing (0 rows, not an error, not a leak)',
    crossRename.status === 200 && crossRename.json?.contacts_updated === 0 && (t1Unaffected.json?.tags || []).includes('shared'),
    JSON.stringify([crossRename.json, t1Unaffected.json?.tags]));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
