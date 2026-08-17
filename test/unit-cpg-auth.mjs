#!/usr/bin/env node
// DenchClaw CRM — CP-G: user accounts (agency + team members), migration 033.
//
// Real per-person login layered ON TOP of the existing X-Internal-Key gate —
// every request here still carries the key (like every other suite), but auth
// itself is proven via a session cookie, hand-managed here since Node's fetch
// does not do cookie-jar handling across separate calls the way a browser does.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... node test/unit-cpg-auth.mjs
import db from '../server/db/index.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const m = /dc_session=([^;]*)/.exec(raw);
  return m ? m[1] : null;
}
async function req(method, path, body, { cookie, companyId } = {}) {
  const headers = { 'content-type': 'application/json', 'x-internal-key': KEY };
  if (companyId) headers['x-company-id'] = companyId;
  if (cookie) headers['cookie'] = `dc_session=${cookie}`;
  const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, cookie: extractCookie(r) };
}

async function main() {
  await db.initDatabase();
  const emailA = `owner-${RUN}@acme.test`;
  const emailB = `member-${RUN}@acme.test`;
  const emailOther = `owner2-${RUN}@rival.test`;

  // ── G-1 — register creates a tenant + owner, and logs them in ─────────────
  const reg = await req('POST', '/api/crm/auth/register', {
    company_name: `Auth Test Co ${RUN}`, name: 'Ada Owner', email: emailA, password: 'correcthorse123',
  });
  check('G-1 register returns 201', reg.status === 201, JSON.stringify(reg));
  check('G-1 …the new user is owner', reg.json?.user?.role === 'owner', JSON.stringify(reg.json));
  check('G-1 …a session cookie is set', !!reg.cookie, JSON.stringify(reg));
  const companyId = reg.json?.company?.id;
  const ownerCookie = reg.cookie;

  check('G-1 duplicate email registration is refused (409)',
    (await req('POST', '/api/crm/auth/register', { company_name: 'Dup', name: 'x', email: emailA, password: 'correcthorse123' })).status === 409);
  check('G-1 a short password is refused (400)',
    (await req('POST', '/api/crm/auth/register', { company_name: 'Short', name: 'x', email: `short-${RUN}@x.test`, password: '123' })).status === 400);

  // ── G-2 — login ─────────────────────────────────────────────────────────
  const badLogin = await req('POST', '/api/crm/auth/login', { email: emailA, password: 'wrong-password' });
  check('G-2 wrong password is refused (401)', badLogin.status === 401, JSON.stringify(badLogin));
  const login = await req('POST', '/api/crm/auth/login', { email: emailA, password: 'correcthorse123' });
  check('G-2 correct password logs in', login.status === 200 && !!login.cookie, JSON.stringify(login));

  // ── G-3 — session required for /me, session identifies the caller ─────────
  check('G-3 /auth/me with no session is 401', (await req('GET', '/api/crm/auth/me')).status === 401);
  const me = await req('GET', '/api/crm/auth/me', undefined, { cookie: ownerCookie });
  check('G-3 /auth/me with a session returns the right user', me.json?.user?.email === emailA, JSON.stringify(me.json));

  // ── G-4 — THE SECURITY PROPERTY: session company overrides X-Company-Id ───
  // Attempt to read a DIFFERENT tenant's contacts by sending its id in the
  // header while authenticated as a real user of THIS tenant.
  const hop = await req('GET', '/api/crm/contacts', undefined, { cookie: ownerCookie, companyId: 'tantra' });
  check('G-4 a logged-in session is NOT redirected to another tenant by X-Company-Id',
    hop.status === 200 && Array.isArray(hop.json?.contacts) && (hop.json.total ?? 0) === 0,
    JSON.stringify(hop.json));

  // ── G-5 — invites ───────────────────────────────────────────────────────
  const invite = await req('POST', '/api/crm/auth/invite', { email: emailB, role: 'member' }, { cookie: ownerCookie });
  check('G-5 invite succeeds', invite.status === 201, JSON.stringify(invite));
  check('G-5 …the response never leaks token_hash', invite.json?.invite?.token_hash === undefined, JSON.stringify(invite.json));
  const token = new URL(invite.json.accept_url, 'http://x').searchParams.get('invite');
  check('G-5 …the accept token is present', !!token);

  const preview = await req('GET', `/api/crm/auth/invite/${token}`);
  check('G-5 invite preview is public (no session) and minimal', preview.status === 200 && preview.json?.email === emailB, JSON.stringify(preview.json));

  const accept = await req('POST', '/api/crm/auth/accept-invite', { token, name: 'Bob Member', password: 'anotherlonggoodpw' });
  check('G-5 accept-invite creates the user in the INVITING company with the invited role',
    accept.json?.user?.company_id === companyId && accept.json.user.role === 'member', JSON.stringify(accept.json));
  const memberCookie = accept.cookie;

  check('G-5 the SAME token cannot be used twice',
    (await req('POST', '/api/crm/auth/accept-invite', { token, name: 'x', password: 'anotherlonggoodpw' })).status === 404);

  // ── G-6 — role gating ──────────────────────────────────────────────────
  check('G-6 a member cannot list the team (403)',
    (await req('GET', '/api/crm/auth/users', undefined, { cookie: memberCookie })).status === 403);
  check('G-6 a member cannot invite (403)',
    (await req('POST', '/api/crm/auth/invite', { email: `x-${RUN}@acme.test` }, { cookie: memberCookie })).status === 403);
  const usersList = await req('GET', '/api/crm/auth/users', undefined, { cookie: ownerCookie });
  check('G-6 an owner CAN list the team, and sees both members', usersList.json?.users?.length === 2, JSON.stringify(usersList.json));
  check('G-6 …never returns password_hash', usersList.json.users.every(u => u.password_hash === undefined), JSON.stringify(usersList.json));

  // Promote Bob to admin (owner-only power), then confirm a plain admin still
  // cannot touch another admin/owner or grant the owner role.
  const bobId = accept.json.user.id;
  const promote = await req('PATCH', `/api/crm/auth/users/${bobId}`, { role: 'admin' }, { cookie: ownerCookie });
  check('G-6 owner can promote a member to admin', promote.json?.user?.role === 'admin', JSON.stringify(promote.json));

  // Re-login as Bob (his role changed but the same session should reflect it live).
  const bobLogin = await req('POST', '/api/crm/auth/login', { email: emailB, password: 'anotherlonggoodpw' });
  const adminCookie = bobLogin.cookie;
  check('G-6 …a fresh login reflects the promoted role', bobLogin.json?.user?.role === 'admin', JSON.stringify(bobLogin.json));

  const cId = await req('POST', '/api/crm/auth/invite', { email: `carol-${RUN}@acme.test`, role: 'member' }, { cookie: adminCookie });
  const carolAccept = await req('POST', '/api/crm/auth/accept-invite',
    { token: new URL(cId.json.accept_url, 'http://x').searchParams.get('invite'), name: 'Carol', password: 'yetanotherlongpw' });
  const carolId = carolAccept.json.user.id;

  check('G-6 a plain admin CAN manage a member',
    (await req('PATCH', `/api/crm/auth/users/${carolId}`, { status: 'suspended' }, { cookie: adminCookie })).status === 200);
  await req('PATCH', `/api/crm/auth/users/${carolId}`, { status: 'active' }, { cookie: ownerCookie }); // reset
  check('G-6 a plain admin CANNOT grant the owner role',
    (await req('PATCH', `/api/crm/auth/users/${carolId}`, { role: 'owner' }, { cookie: adminCookie })).status === 403);

  // A second, distinct admin — so "admin acting on ANOTHER admin" is a real
  // cross-person case, not the self-guard (PATCH /me exists for a reason).
  const daveInvite = await req('POST', '/api/crm/auth/invite', { email: `dave-${RUN}@acme.test`, role: 'admin' }, { cookie: ownerCookie });
  const daveAccept = await req('POST', '/api/crm/auth/accept-invite',
    { token: new URL(daveInvite.json.accept_url, 'http://x').searchParams.get('invite'), name: 'Dave', password: 'davelongpassword1' });
  const daveId = daveAccept.json.user.id;
  const adminOnAdmin = await req('PATCH', `/api/crm/auth/users/${daveId}`, { status: 'suspended' }, { cookie: adminCookie });
  check('G-6b a plain admin cannot manage a DIFFERENT admin (only the owner can)',
    adminOnAdmin.status === 403, JSON.stringify(adminOnAdmin));
  check('G-6b …but the owner can',
    (await req('PATCH', `/api/crm/auth/users/${daveId}`, { status: 'suspended' }, { cookie: ownerCookie })).status === 200);
  check('G-6c acting on your OWN account via /users (not /me) is refused',
    (await req('PATCH', `/api/crm/auth/users/${bobId}`, { name: 'x' }, { cookie: adminCookie })).status === 400);

  // ── G-7 — suspending a user kills their live sessions ─────────────────────
  const suspend = await req('PATCH', `/api/crm/auth/users/${carolId}`, { status: 'suspended' }, { cookie: ownerCookie });
  check('G-7 owner can suspend', suspend.status === 200, JSON.stringify(suspend));
  const carolLoginAfter = await req('POST', '/api/crm/auth/login', { email: `carol-${RUN}@acme.test`, password: 'yetanotherlongpw' });
  check('G-7 a suspended user cannot log in', carolLoginAfter.status === 401, JSON.stringify(carolLoginAfter));

  // ── G-8 — self-service profile ────────────────────────────────────────────
  const badPwChange = await req('PATCH', '/api/crm/auth/me', { password: 'brandnewpassword1', current_password: 'wrong' }, { cookie: ownerCookie });
  check('G-8 changing your password requires the CORRECT current_password', badPwChange.status === 403, JSON.stringify(badPwChange));
  const pwChange = await req('PATCH', '/api/crm/auth/me', { password: 'brandnewpassword1', current_password: 'correcthorse123' }, { cookie: ownerCookie });
  check('G-8 …with the right one it succeeds', pwChange.status === 200, JSON.stringify(pwChange));
  const reLogin = await req('POST', '/api/crm/auth/login', { email: emailA, password: 'brandnewpassword1' });
  check('G-8 …the new password actually works', reLogin.status === 200, JSON.stringify(reLogin));

  // ── G-9 — deletion guards ──────────────────────────────────────────────────
  check('G-9 you cannot delete your own account',
    (await req('DELETE', `/api/crm/auth/users/${reg.json.user.id}`, undefined, { cookie: reLogin.cookie })).status === 400);
  check('G-9 an admin (not owner) cannot delete anyone',
    (await req('DELETE', `/api/crm/auth/users/${carolId}`, undefined, { cookie: adminCookie })).status === 403);
  const del = await req('DELETE', `/api/crm/auth/users/${carolId}`, undefined, { cookie: reLogin.cookie });
  check('G-9 an owner can delete another user', del.status === 200, JSON.stringify(del));

  // ── G-10 — tenant isolation between two completely different companies ────
  const regOther = await req('POST', '/api/crm/auth/register', {
    company_name: `Rival Co ${RUN}`, name: 'Rival Owner', email: emailOther, password: 'rivalpassword1',
  });
  const otherUsers = await req('GET', '/api/crm/auth/users', undefined, { cookie: regOther.cookie });
  check('G-10 a second company\'s owner sees only their own team (1, just themselves)',
    otherUsers.json?.users?.length === 1 && otherUsers.json.users[0].email === emailOther, JSON.stringify(otherUsers.json));

  // ── G-11 — logout invalidates the session ──────────────────────────────────
  const freshLogin = await req('POST', '/api/crm/auth/login', { email: emailOther, password: 'rivalpassword1' });
  const logout = await req('POST', '/api/crm/auth/logout', undefined, { cookie: freshLogin.cookie });
  check('G-11 logout succeeds', logout.status === 200);
  const afterLogout = await req('GET', '/api/crm/auth/me', undefined, { cookie: freshLogin.cookie });
  check('G-11 the session is dead after logout', afterLogout.status === 401, JSON.stringify(afterLogout));

  // ── G-12 — claiming an existing, pre-migration tenant (no company_name) ───
  const preexisting = 'cpg_preexisting_' + RUN;
  await db.query(
    `INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$1) ON CONFLICT (id) DO NOTHING`,
    [preexisting, preexisting]
  );
  const claim = await req('POST', '/api/crm/auth/register', {
    company_id: preexisting, name: 'Claimer', email: `claimer-${RUN}@x.test`, password: 'claimerpassword1',
  });
  check('G-12 claiming a user-less existing tenant succeeds', claim.status === 201 && claim.json?.user?.company_id === preexisting, JSON.stringify(claim));
  const reclaim = await req('POST', '/api/crm/auth/register', {
    company_id: preexisting, name: 'Squatter', email: `squatter-${RUN}@x.test`, password: 'squatterpassword1',
  });
  check('G-12 a SECOND claim on the same tenant is refused (409) once it has an owner', reclaim.status === 409, JSON.stringify(reclaim));
  check('G-12 claiming a nonexistent company id 404s',
    (await req('POST', '/api/crm/auth/register', { company_id: 'nope_' + RUN, name: 'x', email: `nope-${RUN}@x.test`, password: 'somepassword1' })).status === 404);

  await db.shutdownDatabase();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
