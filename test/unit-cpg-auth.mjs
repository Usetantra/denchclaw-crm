#!/usr/bin/env node
// DenchClaw CRM — CP-G: human sign-in via Clerk (migrations 033 + 044).
//
// Clerk owns identity; this service owns which tenant a person belongs to, what
// role they hold, and whether they are suspended. This suite proves the seam.
//
// HOW IT AUTHENTICATES WITHOUT A LIVE CLERK INSTANCE
//
// @clerk/backend's verifyToken() accepts a `jwtKey` (PEM public key) and then
// makes no network call. run-local.sh generates an RSA pair per run and boots
// the server with the public half as CLERK_JWT_KEY; this suite signs its own
// RS256 tokens with the private half. The REAL library does the verifying, so
// the signature/exp/nbf/azp assertions below exercise production code rather
// than a mock that agrees with whatever we wrote.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... CLERK_TEST_PRIVATE_KEY=... DATABASE_URL=... node test/unit-cpg-auth.mjs
import db from '../server/db/index.js';
import { mintToken } from './clerk-token.mjs';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const PRIV = (process.env.CLERK_TEST_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const AZP = process.env.CLERK_TEST_AZP || 'http://localhost';
const RUN = process.env.RUN || String(Date.now());
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }
if (!PRIV) { console.error('FATAL: CLERK_TEST_PRIVATE_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

const tok = (opts) => mintToken(PRIV, { azp: AZP, ...opts });

// `token: null` sends no Authorization header at all; `key: true` adds the
// machine key, which is how the machine-path regression guards are written.
async function req(method, path, body, { token, key, companyId } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (key) headers['x-internal-key'] = typeof key === 'string' ? key : KEY;
  if (companyId) headers['x-company-id'] = companyId;
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

async function main() {
  await db.initDatabase();
  const coA = `cpg_co_${RUN}`;
  const coB = `cpg_rival_${RUN}`;
  const emailOwner = `owner-${RUN}@acme.test`;
  const emailMember = `member-${RUN}@acme.test`;
  const emailDave = `dave-${RUN}@acme.test`;
  const emailRival = `owner2-${RUN}@rival.test`;

  // Two tenants seeded directly — tenant provisioning is not what this suite is
  // about, and going through /tenants would need a wildcard key per tenant.
  for (const [id, name] of [[coA, 'Acme'], [coB, 'Rival']]) {
    await db.query(`INSERT INTO tenants (id,name,slug,status,plan) VALUES ($1,$2,$1,'active','standard') ON CONFLICT (id) DO NOTHING`, [id, name]);
  }

  // ── G-0 — bootstrap: the first identity into an owner-less tenant ─────────
  // The server under test is booted with CLERK_BOOTSTRAP_COMPANY_ID=coA.
  const subOwner = `user_owner_${RUN}`;
  const r0 = await req('GET', '/api/crm/auth/me', undefined, { token: tok({ sub: subOwner, email: emailOwner }) });
  check('G-0 a fresh identity bootstraps as owner of the empty target tenant',
    r0.status === 200 && r0.json?.user?.role === 'owner' && r0.json?.user?.company_id === coA,
    JSON.stringify(r0.json));
  check('G-0b /me reports the workspace, not just the user',
    r0.json?.company?.id === coA, JSON.stringify(r0.json?.company));

  const r0b = await req('GET', '/api/crm/auth/me', undefined, { token: tok({ sub: `user_late_${RUN}`, email: `late-${RUN}@acme.test` }) });
  check('G-0c bootstrap is self-closing — a second stranger gets no workspace',
    r0b.status === 403 && r0b.json?.error === 'no_workspace', `${r0b.status} ${JSON.stringify(r0b.json)}`);

  // ── G-1 — token verification, delegated to the real library ───────────────
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['expired', tok({ sub: subOwner, email: emailOwner, iat: now - 9999, exp: now - 600 })],
    ['not yet valid (nbf)', tok({ sub: subOwner, email: emailOwner, nbf: now + 9999 })],
    ['wrong authorized party (azp)', mintToken(PRIV, { sub: subOwner, email: emailOwner, azp: 'https://evil.example' })],
    ['malformed', 'not.a.jwt'],
    ['empty', ' '],
  ];
  for (const [label, t] of cases) {
    const r = await req('GET', '/api/crm/auth/me', undefined, { token: t });
    check(`G-1 ${label} token is refused (401)`, r.status === 401, `${r.status} ${JSON.stringify(r.json)}`);
  }

  // A token signed by a DIFFERENT key must not verify — the signature check is
  // the whole foundation, so it gets its own case with a freshly generated key.
  const { generateKeyPair } = await import('./clerk-token.mjs');
  const other = generateKeyPair();
  const forged = mintToken(other.privatePem, { sub: subOwner, email: emailOwner, azp: AZP });
  const rForged = await req('GET', '/api/crm/auth/me', undefined, { token: forged });
  check('G-1f a token signed by the wrong key is refused', rForged.status === 401, `${rForged.status}`);

  // ── G-2 — no credential at all ───────────────────────────────────────────
  const rAnon = await req('GET', '/api/crm/contacts');
  check('G-2 no token and no key is refused', rAnon.status === 401, `${rAnon.status}`);

  // ── G-3 — invites ────────────────────────────────────────────────────────
  const ownerTok = tok({ sub: subOwner, email: emailOwner });
  const rInv = await req('POST', '/api/crm/auth/invite', { email: emailMember, role: 'member' }, { token: ownerTok });
  check('G-3 an owner can invite a teammate', rInv.status === 201, `${rInv.status} ${JSON.stringify(rInv.json)}`);
  const acceptUrl = rInv.json?.accept_url || '';
  const inviteToken = (/invite=([^&]+)/.exec(acceptUrl) || [])[1];
  check('G-3b the invite returns a usable token', Boolean(inviteToken), acceptUrl);
  check('G-3c the token hash never leaves the server',
    rInv.json?.invite && rInv.json.invite.token_hash === undefined, JSON.stringify(rInv.json?.invite));

  // The preview must work with NO credential of any kind — an invitee has no
  // account yet, and this route only appeared to work before because the proxy
  // injected a key into every browser call.
  const rPrev = await req('GET', `/api/crm/auth/invite/${inviteToken}`);
  check('G-3d the invite preview is genuinely public (no token, no key)',
    rPrev.status === 200 && rPrev.json?.email === emailMember, `${rPrev.status} ${JSON.stringify(rPrev.json)}`);

  const subMember = `user_member_${RUN}`;
  const rAcc = await req('POST', '/api/crm/auth/accept-invite', { token: inviteToken, name: 'Member' },
    { token: tok({ sub: subMember, email: emailMember }) });
  check('G-3e accepting binds the Clerk identity to the invited role',
    rAcc.status === 201 && rAcc.json?.user?.role === 'member' && rAcc.json?.user?.company_id === coA,
    `${rAcc.status} ${JSON.stringify(rAcc.json)}`);

  const rAcc2 = await req('POST', '/api/crm/auth/accept-invite', { token: inviteToken },
    { token: tok({ sub: `user_thief_${RUN}`, email: `thief-${RUN}@acme.test` }) });
  check('G-3f an accepted invite cannot be used again', rAcc2.status === 404, `${rAcc2.status}`);

  const rAccAnon = await req('POST', '/api/crm/auth/accept-invite', { token: inviteToken });
  check('G-3g accepting requires a verified identity', rAccAnon.status === 401, `${rAccAnon.status}`);

  // ── G-4 — CROSS-TENANT HOP. The highest-value assertion in this file. ─────
  const memberTok = tok({ sub: subMember, email: emailMember });
  const rHop = await req('GET', '/api/crm/auth/me', undefined, { token: memberTok, companyId: coB });
  check('G-4 a forged x-company-id cannot move a user to another tenant',
    rHop.status === 200 && rHop.json?.user?.company_id === coA,
    `${rHop.status} ${JSON.stringify(rHop.json?.user)}`);

  // The mirror: a Clerk session must not be widened by ALSO presenting a key.
  const rHop2 = await req('GET', '/api/crm/auth/me', undefined, { token: memberTok, key: true, companyId: coB });
  check('G-4b a valid Bearer wins over an accompanying internal key',
    rHop2.status === 200 && rHop2.json?.user?.company_id === coA,
    `${rHop2.status} ${JSON.stringify(rHop2.json?.user)}`);

  // And an INVALID Bearer must be terminal, never falling through to the key.
  const rStale = await req('GET', '/api/crm/contacts', undefined,
    { token: tok({ sub: subOwner, email: emailOwner, iat: now - 9999, exp: now - 600 }), key: true });
  check('G-4c an expired Bearer is refused even when a valid key is present',
    rStale.status === 401, `${rStale.status}`);

  // ── G-5 — role gating ────────────────────────────────────────────────────
  const rMemList = await req('GET', '/api/crm/auth/users', undefined, { token: memberTok });
  check('G-5 a member cannot list the team', rMemList.status === 403, `${rMemList.status}`);
  const rOwnList = await req('GET', '/api/crm/auth/users', undefined, { token: ownerTok });
  check('G-5b an owner can list the team', rOwnList.status === 200 && Array.isArray(rOwnList.json?.users), `${rOwnList.status}`);

  const memberId = rAcc.json?.user?.id;
  const rSelfPromote = await req('PATCH', `/api/crm/auth/users/${memberId}`, { role: 'owner' }, { token: memberTok });
  check('G-5c a member cannot promote anyone', rSelfPromote.status === 403, `${rSelfPromote.status}`);

  // ── G-6 — suspension. The rule Clerk does NOT replicate. ─────────────────
  // Clerk session revocation is asynchronous and best-effort, so a suspended
  // person's already-issued token stays cryptographically valid. What must hold
  // is that the SERVER refuses it on the very next request.
  const rInvD = await req('POST', '/api/crm/auth/invite', { email: emailDave, role: 'member' }, { token: ownerTok });
  const daveToken = (/invite=([^&]+)/.exec(rInvD.json?.accept_url || '') || [])[1];
  const subDave = `user_dave_${RUN}`;
  const rDave = await req('POST', '/api/crm/auth/accept-invite', { token: daveToken },
    { token: tok({ sub: subDave, email: emailDave }) });
  const daveId = rDave.json?.user?.id;
  const daveTok = tok({ sub: subDave, email: emailDave });
  check('G-6 the new teammate can reach the API before suspension',
    (await req('GET', '/api/crm/auth/me', undefined, { token: daveTok })).status === 200, 'pre-suspend');

  const rSusp = await req('PATCH', `/api/crm/auth/users/${daveId}`, { status: 'suspended' }, { token: ownerTok });
  check('G-6b an owner can suspend a teammate', rSusp.status === 200, `${rSusp.status} ${JSON.stringify(rSusp.json)}`);
  const rAfter = await req('GET', '/api/crm/auth/me', undefined, { token: daveTok });
  check('G-6c a suspended user\'s STILL-VALID token is refused on the next request',
    rAfter.status === 403 && rAfter.json?.error === 'account_suspended',
    `${rAfter.status} ${JSON.stringify(rAfter.json)}`);

  // ── G-7 — identity linking rules (migration 044) ─────────────────────────
  // Rule 2: a row created before Clerk links to the first identity presenting
  // that email, keeping its company and role — the operator's escape hatch.
  await db.query(`INSERT INTO users (company_id,email,name,role,status) VALUES ($1,$2,'Rival Owner','owner','active')`, [coB, emailRival]);
  const rLink = await req('GET', '/api/crm/auth/me', undefined,
    { token: tok({ sub: `user_rival_${RUN}`, email: emailRival }) });
  check('G-7 an unlinked pre-existing row links on first sign-in, keeping its tenant and role',
    rLink.status === 200 && rLink.json?.user?.company_id === coB && rLink.json?.user?.role === 'owner',
    `${rLink.status} ${JSON.stringify(rLink.json?.user)}`);

  // Rule 3: that row is now bound. A DIFFERENT identity claiming the same email
  // must be refused, not silently re-bound.
  const rSteal = await req('GET', '/api/crm/auth/me', undefined,
    { token: tok({ sub: `user_impostor_${RUN}`, email: emailRival }) });
  check('G-7b a second Clerk identity cannot claim an already-linked account',
    rSteal.status === 403 && rSteal.json?.error === 'no_workspace', `${rSteal.status} ${JSON.stringify(rSteal.json)}`);

  // Concurrency: parallel first-requests from one fresh identity must not
  // produce two rows. The unique indexes are the serialization point.
  const emailRace = `race-${RUN}@acme.test`;
  const subRace = `user_race_${RUN}`;
  await req('POST', '/api/crm/auth/invite', { email: emailRace, role: 'member' }, { token: ownerTok });
  await Promise.all(Array.from({ length: 5 }, () =>
    req('GET', '/api/crm/auth/me', undefined, { token: tok({ sub: subRace, email: emailRace }) })));
  const raceRows = await db.query(`SELECT id FROM users WHERE clerk_user_id = $1`, [subRace]);
  check('G-7c five concurrent first-requests create exactly one user row',
    raceRows.rows.length === 1, `${raceRows.rows.length} rows`);

  // ── G-8 — passwords are no longer this service's business ────────────────
  const rPw = await req('PATCH', '/api/crm/auth/me', { password: 'hunter2hunter2' }, { token: ownerTok });
  check('G-8 changing a password here is refused, not silently ignored',
    rPw.status === 400 && /sign-in provider/i.test(rPw.json?.error || ''), `${rPw.status} ${JSON.stringify(rPw.json)}`);

  // ── G-9 — the machine path is untouched ──────────────────────────────────
  const rKey = await req('GET', '/api/crm/contacts?limit=1', undefined, { key: true, companyId: coA });
  check('G-9 an internal key still authenticates with no Clerk involvement', rKey.status === 200, `${rKey.status}`);
  const rBadKey = await req('GET', '/api/crm/contacts?limit=1', undefined, { key: 'not-a-real-key' });
  check('G-9b an unknown internal key is still refused', rBadKey.status === 401, `${rBadKey.status}`);

  // ── G-10 — cross-tenant data isolation through the Clerk path ────────────
  await db.query(`INSERT INTO contacts (company_id,name,email) VALUES ($1,$2,$3)`, [coB, 'Rival Contact', `rival-c-${RUN}@x.test`]);
  const rList = await req('GET', '/api/crm/contacts?limit=200', undefined, { token: ownerTok });
  const leaked = (rList.json?.contacts || []).some(c => String(c.email || '').startsWith(`rival-c-${RUN}`));
  check('G-10 a Clerk-authenticated user never sees another tenant\'s contacts', !leaked, 'leaked a rival row');

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.closePool?.();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
