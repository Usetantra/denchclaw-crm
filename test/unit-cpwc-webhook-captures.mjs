#!/usr/bin/env node
// DenchClaw CRM — CP-WC: webhook capture (POST /webhooks/capture/:tool +
// GET /api/crm/settings/webhook-captures), the scratch surface for building
// real connectors (WebinarGeek, Zoom, Instantly, ...) from real payloads
// instead of guessed-at docs. See migrations/035_webhook_captures.sql.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpwc-webhook-captures.mjs

import crypto from 'crypto';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpwc_co_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': CO, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
// The capture endpoint is public — no internal key, same posture as other files in this router.
async function pub(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  const tool = 'cpwctest_' + RUN;

  // ── basic capture round-trip ───────────────────────────────────────────
  const cap1 = await pub('POST', `/webhooks/capture/${tool}`, { registrant: { email: 'a@ex.test', name: 'A' } });
  check('capture accepts an arbitrary JSON payload and returns 200', cap1.status === 200 && cap1.json?.captured === true, JSON.stringify(cap1.json));

  const listAfter1 = await req('GET', `/api/crm/settings/webhook-captures?tool=${tool}`);
  check('it shows up in the authenticated captures list for that tool', listAfter1.status === 200 && listAfter1.json?.captures?.length === 1, JSON.stringify(listAfter1.json));
  const row = listAfter1.json.captures[0];
  check('the captured body round-trips exactly', row.body?.registrant?.email === 'a@ex.test', JSON.stringify(row));
  check('method is recorded', row.method === 'POST', JSON.stringify(row));

  // ── tool key is sanitized ──────────────────────────────────────────────
  const dirty = await pub('POST', `/webhooks/capture/${tool}!!!UPPER`, { x: 1 });
  check('a tool key with unsafe characters is still accepted (sanitized, not rejected)', dirty.status === 200, JSON.stringify(dirty.json));

  // ── aggregated tools listing ───────────────────────────────────────────
  const tools = await req('GET', '/api/crm/settings/webhook-captures');
  check('the aggregated tools list includes our test tool with a count', tools.status === 200 && tools.json?.tools?.some(t => t.tool === tool && t.count >= 1), JSON.stringify(tools.json));

  // ── auth is required on the read side, not the write side ─────────────
  const noAuth = await fetch(`${BASE}/api/crm/settings/webhook-captures?tool=${tool}`);
  check('reading captures without auth is refused', noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));

  // ── pruning: only the most recent 20 per tool are kept ─────────────────
  for (let i = 0; i < 22; i++) {
    await pub('POST', `/webhooks/capture/${tool}`, { i });
  }
  const pruned = await req('GET', `/api/crm/settings/webhook-captures?tool=${tool}&limit=50`);
  check('captures are pruned to at most 20 per tool', pruned.json?.captures?.length === 20, JSON.stringify(pruned.json?.captures?.length));
  check('pruning keeps the most recent ones', pruned.json.captures[0].body?.i === 21, JSON.stringify(pruned.json.captures[0]));

  // ── Zoom endpoint.url_validation handshake ─────────────────────────────
  const plainToken = 'zoom_test_token_' + RUN;
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  const zoomRes = await pub('POST', '/webhooks/capture/zoom', { event: 'endpoint.url_validation', payload: { plainToken } });
  check('Zoom validation handshake responds 200', zoomRes.status === 200, JSON.stringify(zoomRes.json));
  if (secret) {
    const expected = crypto.createHmac('sha256', secret).update(plainToken).digest('hex');
    check('with ZOOM_WEBHOOK_SECRET_TOKEN set, the encryptedToken matches the expected HMAC', zoomRes.json?.encryptedToken === expected, JSON.stringify(zoomRes.json));
    check('plainToken is echoed back', zoomRes.json?.plainToken === plainToken, JSON.stringify(zoomRes.json));
  } else {
    check('without ZOOM_WEBHOOK_SECRET_TOKEN, capture still succeeds with a note instead of a token', zoomRes.json?.captured === true && !zoomRes.json?.encryptedToken, JSON.stringify(zoomRes.json));
  }

  // ── non-JSON content-type still captured (empty/undefined body, no crash) ──
  const rawTool = 'cpwcraw_' + RUN;
  const rawRes = await fetch(`${BASE}/webhooks/capture/${rawTool}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'not json at all' });
  check('a non-JSON content-type body is still accepted (200)', rawRes.status === 200, String(rawRes.status));

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
