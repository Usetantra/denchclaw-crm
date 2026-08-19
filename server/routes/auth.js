'use strict';
// ─── User accounts: profile / invites / team management ──────────────────────
// Clerk owns identity (sign-in, sign-up, passwords, MFA, session lifetime).
// This router owns everything Clerk does not know about: which tenant a person
// belongs to, what role they hold, who may invite whom, and suspension.
// See migration 044's header for the split, and middleware/auth.js for the seam
// that turns a Clerk token into req.user.
//
// Register/login/logout used to live here and are gone — Clerk's hosted
// components replace them entirely.
const express = require('express');
const router = express.Router();
const usersDb = require('../db/models/users');
const tenantDb = require('../db/models/tenants');
const resendEmail = require('../lib/email-resend');
const clerk = require('../lib/clerk');
const { requireAuth, requireUser, requireRole, getUserCompanyId } = require('../middleware/auth');

// ── PUBLIC ROUTES — must stay ABOVE the gate below. Order is load-bearing. ───
//
// Before Clerk this whole router sat behind requireAuth, and GET /invite/:token
// "worked" as a public preview only because the proxy injected an internal key
// into every browser call. The proxy no longer does that, so an invitee — who
// by definition has no account yet — would get a 401 on the invite screen if
// these stayed below the gate.

// GET /api/crm/auth/config — what the browser needs to boot Clerk.
// The publishable key is not a secret (it ships in every Clerk frontend), and
// serving it from here rather than hardcoding it in index.html is what lets the
// same static file work unchanged across dev, staging and production.
router.get('/config', (_req, res) => {
  res.json({
    publishable_key: clerk.publishableKey(),
    sign_in_enabled: clerk.isConfigured(),
  });
});

// GET /api/crm/auth/invite/:token — public preview before accepting.
// Deliberately minimal: email + role + company name, never anything about the
// company's actual data.
router.get('/invite/:token', async (req, res) => {
  try {
    const invite = await usersDb.resolveInvite(req.params.token);
    if (!invite) return res.status(404).json({ error: 'invite not found or expired' });
    const company = await tenantDb.getById(invite.company_id);
    res.json({ email: invite.email, role: invite.role, company_name: company?.name || invite.company_id });
  } catch (e) { res.status(500).json({ error: 'failed to load invite' }); }
});

// POST /api/crm/auth/accept-invite { token, name? }
//
// Needs a VERIFIED Clerk identity but NOT a provisioned users row — which is
// exactly why it cannot use requireAuth: a person accepting an invite is by
// definition not yet a member of anything, so requireAuth's `no_workspace`
// rejection would fire before this handler ever ran. Hence its own thin gate.
async function requireClerkIdentity(req, res, next) {
  if (!clerk.isConfigured()) return res.status(503).json({ error: 'sign-in is not configured on this server' });
  const identity = await clerk.verifyRequest(req);
  if (!identity) return res.status(401).json({ error: 'sign in first, then open your invite link' });
  if (!identity.email) identity.email = await clerk.fetchIdentityEmail(identity.clerkUserId);
  req.clerkIdentity = identity;
  next();
}

router.post('/accept-invite', requireClerkIdentity, async (req, res) => {
  try {
    const { token, name } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const invite = await usersDb.resolveInvite(token);
    if (!invite) return res.status(404).json({ error: 'invite not found, already used, or expired' });

    const { clerkUserId, email } = req.clerkIdentity;
    if (!email) return res.status(400).json({ error: 'could not read the email on your account' });

    // The token is a single-use, 7-day, cryptographically-random capability —
    // the same trust model as the lead-webhook tokens elsewhere in this repo —
    // so by default possession is enough and a mismatched email is only logged.
    // Set INVITE_REQUIRE_EMAIL_MATCH=1 if invites will ever be sent to
    // addresses the recipient does not control.
    if (String(invite.email).toLowerCase() !== email.toLowerCase()) {
      if (process.env.INVITE_REQUIRE_EMAIL_MATCH === '1') {
        return res.status(403).json({ error: `this invite is for ${invite.email}` });
      }
      console.warn('[Auth] invite for %s accepted by Clerk identity %s', invite.email, email);
    }
    const user = await usersDb.acceptInviteForClerk(invite, { clerkUserId, email, name });
    res.status(201).json({ user });
  } catch (e) {
    console.error('[Auth] accept-invite', e.message);
    res.status(500).json({ error: e.message || 'failed to accept invite' });
  }
});

// ── Everything below requires a resolved identity ────────────────────────────
router.use(requireAuth);

// GET /api/crm/auth/me — who am I, and which workspace am I in.
router.get('/me', requireUser, async (req, res) => {
  let company = null;
  try { company = await tenantDb.getById(req.user.company_id); }
  catch (e) { /* the header just loses the workspace name; not worth failing on */ }
  res.json({ user: req.user, company });
});

// PATCH /api/crm/auth/me { name? }
// Passwords, email and MFA are Clerk's business now — the browser sends people
// to Clerk's own account UI for those. Rejecting a password here explicitly
// (rather than ignoring it) is what stops a stale client from believing it
// changed something it did not.
router.patch('/me', requireUser, async (req, res) => {
  try {
    const { name, password } = req.body || {};
    if (password !== undefined) {
      return res.status(400).json({ error: 'password is managed by your sign-in provider' });
    }
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to update' });
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
    const target = await usersDb.getById(req.params.id, companyId);
    const updated = await usersDb.update(companyId, req.params.id, { role, status });
    if (!updated) return res.status(404).json({ error: 'user not found or no fields given' });
    if (status === 'suspended') {
      // Both of these are COURTESIES, not the guarantee. requireAuthAsync
      // re-reads users.status on every request, so the suspension takes effect
      // on the target's very next call whether or not either call succeeds —
      // which matters, because revoking a Clerk session is a network round trip
      // that can fail. This just logs them out promptly rather than leaving a
      // dead tab that still looks alive.
      await usersDb.destroyAllSessions(req.params.id);
      if (target?.clerk_user_id) await clerk.revokeUserSessions(target.clerk_user_id);
    }
    res.json({ user: updated });
  } catch (e) { res.status(500).json({ error: 'update failed' }); }
});

// DELETE /api/crm/auth/users/:id — owner only, never yourself (use another
// owner's account to remove an owner, same reasoning airlines use for pilots).
router.delete('/users/:id', requireRole('owner'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'cannot delete your own account' });
    const companyId = getUserCompanyId(req);
    // Read the row BEFORE deleting it — the Clerk id is only knowable from here.
    const target = await usersDb.getById(req.params.id, companyId);
    await usersDb.destroyAllSessions(req.params.id);
    await usersDb.remove(companyId, req.params.id);
    // Off by default: deleting a Clerk identity is irreversible, and in a
    // multi-tenant future it would destroy their memberships of other tenants
    // too. Removing someone from THIS workspace should not, by default, delete
    // the human. Opt in with CLERK_DELETE_IDENTITY_ON_REMOVE=1.
    if (target?.clerk_user_id) await clerk.deleteIdentity(target.clerk_user_id);
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

module.exports = router;
