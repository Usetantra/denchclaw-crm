'use strict';
// ─── User accounts: register / login / invites / team management ─────────────
// Layered on top of the existing X-Internal-Key gate (server/middleware/auth.js)
// — every route here still goes through requireAuth for the key check, exactly
// like every other router; what's new is req.user (a resolved session) and
// req.auth.companyId being overridden by it. See migration 033's header for the
// full reasoning.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const usersDb = require('../db/models/users');
const tenantDb = require('../db/models/tenants');
const resendEmail = require('../lib/email-resend');
const { requireAuth, requireUser, requireRole, getUserCompanyId } = require('../middleware/auth');
const { setSessionCookie, clearSessionCookie } = require('../lib/session-cookie');

router.use(requireAuth);

function slugify(name) {
  return String(name || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'company';
}

// POST /api/crm/auth/register { company_name, name, email, password }
//   OR  { company_id, name, email, password }
//
// Two shapes: company_name creates a brand NEW tenant with this user as its
// first owner (normal self-serve signup). company_id instead CLAIMS an
// existing, user-less tenant — this is how a tenant that existed before this
// migration (created the old way, via requireAdmin's /tenants route or by
// hand) gets its first real login. Claiming is refused the moment the tenant
// already has one user, which is what makes it safe: a stranger who merely
// knows a company's id cannot attach themselves to data that already has an
// owner — the window where claiming works is exactly "nobody owns this yet".
router.post('/register', async (req, res) => {
  try {
    const { company_name, company_id, name, email, password } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ error: 'email required' });
    if (await usersDb.findByEmail(email)) return res.status(409).json({ error: 'an account with this email already exists' });

    let tenant;
    if (company_id) {
      tenant = await tenantDb.getById(company_id);
      if (!tenant) return res.status(404).json({ error: 'no company with that id exists' });
      const existing = await usersDb.list(company_id);
      if (existing.length) return res.status(409).json({ error: 'this company already has an owner — ask them to invite you instead' });
    } else {
      if (!company_name || !String(company_name).trim()) return res.status(400).json({ error: 'company_name (or company_id, to claim an existing company) required' });
      const base = slugify(company_name);
      const id = `${base}_${crypto.randomBytes(3).toString('hex')}`;
      tenant = await tenantDb.create({ id, name: String(company_name).trim(), slug: id });
    }
    const user = await usersDb.create({ companyId: tenant.id, email, password, name: name || null, role: 'owner' });

    const token = await usersDb.createSession(user.id);
    setSessionCookie(res, token, usersDb.SESSION_TTL_MS);
    res.status(201).json({ user, company: tenant });
  } catch (e) {
    console.error('[Auth] register', e.message);
    res.status(e.message && /password|email/i.test(e.message) ? 400 : 500).json({ error: e.message || 'registration failed' });
  }
});

// POST /api/crm/auth/login { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await usersDb.verifyLogin(email, password);
    if (!user) return res.status(401).json({ error: 'invalid email or password' });
    const token = await usersDb.createSession(user.id);
    setSessionCookie(res, token, usersDb.SESSION_TTL_MS);
    res.json({ user });
  } catch (e) { console.error('[Auth] login', e.message); res.status(500).json({ error: 'login failed' }); }
});

// POST /api/crm/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const { readSessionCookie } = require('../lib/session-cookie');
    const token = readSessionCookie(req);
    if (token) await usersDb.destroySession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) { console.error('[Auth] logout', e.message); res.status(500).json({ error: 'logout failed' }); }
});

// GET /api/crm/auth/me
router.get('/me', requireUser, (req, res) => res.json({ user: req.user }));

// PATCH /api/crm/auth/me { name?, password?, current_password? }
// Changing your own password requires current_password — the account owner
// proving they're still the one in control of the session, not just anyone
// who found an unlocked browser tab.
router.patch('/me', requireUser, async (req, res) => {
  try {
    const { name, password, current_password } = req.body || {};
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (password !== undefined) {
      const ok = await usersDb.verifyLogin(req.user.email, current_password || '');
      if (!ok) return res.status(403).json({ error: 'current_password is incorrect' });
      fields.password = password;
    }
    const updated = await usersDb.update(req.user.company_id, req.user.id, fields);
    res.json({ user: updated });
  } catch (e) { res.status(400).json({ error: e.message || 'update failed' }); }
});

// ── Team management (admin/owner) ────────────────────────────────────────────

// GET /api/crm/auth/users
router.get('/users', requireRole('admin'), async (req, res) => {
  try { res.json({ users: await usersDb.list(getUserCompanyId(req)) }); }
  catch (e) { res.status(500).json({ error: 'failed to load users' }); }
});

// PATCH /api/crm/auth/users/:id { role?, status? } — not for your own account;
// use PATCH /me for that, so nobody can lock themselves out via a typo here.
router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'use PATCH /auth/me to change your own account' });
    const { role, status } = req.body || {};
    if (role !== undefined && !['owner', 'admin', 'member'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (status !== undefined && !['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'invalid status' });

    const companyId = getUserCompanyId(req);
    // Only an owner may grant/revoke the owner role or touch another admin —
    // a plain admin promoting themselves (or a peer) to owner, or demoting a
    // rival admin, would be a privilege escalation this gate exists to close.
    // A plain admin may only ever act on a 'member'.
    if (req.user.role !== 'owner') {
      const target = await usersDb.getById(req.params.id, companyId);
      if (!target) return res.status(404).json({ error: 'user not found' });
      if (target.role !== 'member') return res.status(403).json({ error: 'only an owner can manage another admin or owner' });
      if (role !== undefined && role !== 'member') return res.status(403).json({ error: 'only an owner can grant admin/owner role' });
    }
    const updated = await usersDb.update(companyId, req.params.id, { role, status });
    if (!updated) return res.status(404).json({ error: 'user not found or no fields given' });
    if (status === 'suspended') await usersDb.destroyAllSessions(req.params.id);
    res.json({ user: updated });
  } catch (e) { res.status(500).json({ error: 'update failed' }); }
});

// DELETE /api/crm/auth/users/:id — owner only, never yourself (use another
// owner's account to remove an owner, same reasoning airlines use for pilots).
router.delete('/users/:id', requireRole('owner'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot delete your own account' });
    await usersDb.destroyAllSessions(req.params.id);
    await usersDb.remove(getUserCompanyId(req), req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'delete failed' }); }
});

// ── Invites ───────────────────────────────────────────────────────────────────

// POST /api/crm/auth/invite { email, role? }
router.post('/invite', requireRole('admin'), async (req, res) => {
  try {
    const { email, role = 'member' } = req.body || {};
    if (!email || !String(email).trim()) return res.status(400).json({ error: 'email required' });
    if (!['owner', 'admin', 'member'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'only an owner can invite another owner' });
    if (await usersDb.findByEmail(email)) return res.status(409).json({ error: 'an account with this email already exists' });

    const companyId = getUserCompanyId(req);
    const { invite, rawToken } = await usersDb.createInvite({ companyId, email, role, invitedBy: req.user.id });
    // A query param on the app's own root, not a distinct path — the app is
    // served behind a proxy (dev-proxy.mjs locally, presumably nginx in prod)
    // that only routes the bare /crm path to index.html; a second path would
    // need its own server-side route just to serve the same file.
    const acceptUrl = `${process.env.APP_URL || ''}/crm?invite=${rawToken}`;
    const company = await tenantDb.getById(companyId);

    let emailed = false;
    if (resendEmail.isConfigured()) {
      try {
        await resendEmail.sendEmail({
          from: process.env.INVITE_FROM_EMAIL || undefined,
          to: email, subject: `You're invited to join ${company?.name || companyId} on DenchClaw CRM`,
          text: `${req.user.name || req.user.email} invited you to join their team. Accept here: ${acceptUrl}\n\nThis link expires in 7 days.`,
        });
        emailed = true;
      } catch (e) { console.error('[Auth] invite email failed:', e.message); }
    }
    // The raw token/link is always returned — email delivery is a courtesy,
    // never the only way to get it (mirrors the lead-webhook token pattern:
    // an operator can always copy/share it by hand). token_hash never leaves
    // the server — it's the same secret the raw token in accept_url already
    // proves possession of, just irreversibly hashed; returning both would be
    // pointless exposure, not a convenience.
    const { token_hash, ...safeInvite } = invite;
    res.status(201).json({ invite: safeInvite, accept_url: acceptUrl, emailed });
  } catch (e) { console.error('[Auth] invite', e.message); res.status(500).json({ error: 'failed to create invite' }); }
});

// GET /api/crm/auth/invites
router.get('/invites', requireRole('admin'), async (req, res) => {
  try { res.json({ invites: await usersDb.listInvites(getUserCompanyId(req)) }); }
  catch (e) { res.status(500).json({ error: 'failed to load invites' }); }
});

// DELETE /api/crm/auth/invites/:id
router.delete('/invites/:id', requireRole('admin'), async (req, res) => {
  try { await usersDb.revokeInvite(getUserCompanyId(req), req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'failed to revoke invite' }); }
});

// GET /api/crm/auth/invite/:token — public preview (no session required)
// before the accept form is submitted. Deliberately minimal: email + role,
// never anything about the company's actual data.
router.get('/invite/:token', async (req, res) => {
  try {
    const invite = await usersDb.resolveInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'invite not found or expired' });
    const company = await tenantDb.getById(invite.company_id);
    res.json({ email: invite.email, role: invite.role, company_name: company?.name || invite.company_id });
  } catch (e) { res.status(500).json({ error: 'failed to load invite' }); }
});

// POST /api/crm/auth/accept-invite { token, name, password }
router.post('/accept-invite', async (req, res) => {
  try {
    const { token, name, password } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const user = await usersDb.acceptInvite(token, { name, password });
    if (!user) return res.status(404).json({ error: 'invite not found, already used, or expired' });
    const sessionToken = await usersDb.createSession(user.id);
    setSessionCookie(res, sessionToken, usersDb.SESSION_TTL_MS);
    res.status(201).json({ user });
  } catch (e) {
    console.error('[Auth] accept-invite', e.message);
    res.status(e.message && /password|email|exists/i.test(e.message) ? 400 : 500).json({ error: e.message || 'failed to accept invite' });
  }
});

module.exports = router;
