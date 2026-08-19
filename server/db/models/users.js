'use strict';
// ─── DAL: users / user_invites / user_sessions (migration 033) ───────────────
// Real per-person accounts layered ON TOP of the existing X-Internal-Key gate,
// not a replacement for it — see server/middleware/auth.js for how a session
// composes with that. One company per user (an agency + its team members
// working the same company, per the operator's own framing), not cross-tenant
// identities.
const crypto = require('crypto');
const { query } = require('../index');

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS, 10) || 30 * 24 * 60 * 60 * 1000; // 30 days
const INVITE_TTL_MS = parseInt(process.env.INVITE_TTL_MS, 10) || 7 * 24 * 60 * 60 * 1000; // 7 days

// ── passwords ──────────────────────────────────────────────────────────────
// scrypt, not a fast hash — a user-CHOSEN password is low-entropy/guessable,
// unlike the system-generated tokens tenant_api_keys hashes with sha256 (see
// that file's own header comment for the reasoning this mirrors).
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `v1:${salt.toString('base64')}:${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}
// Deliberately loose — real strength enforcement belongs in a dedicated
// zxcvbn-style check; this only blocks the "123456" class of accident.
function passwordProblem(password) {
  if (!password || String(password).length < 8) return 'password must be at least 8 characters';
  return null;
}

function sanitize(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

// ── users ─────────────────────────────────────────────────────────────────
// A user is identified by a Clerk identity OR a local password, never neither.
// The password branch is kept (rather than deleted outright) so the pre-Clerk
// login path stays revertible through burn-in — see migration 044's header.
async function create({ companyId, email, password, clerkUserId, name, role = 'member' }) {
  if (!companyId) throw new Error('users.create requires companyId');
  if (!email || !String(email).trim()) throw new Error('email required');
  if (!clerkUserId) {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
  }
  const r = await query(
    `INSERT INTO users (company_id, email, password_hash, name, role, clerk_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [companyId, String(email).trim().toLowerCase(), clerkUserId ? null : hashPassword(password),
     name || null, role, clerkUserId || null]
  );
  return sanitize(r.rows[0]);
}

async function findByEmail(email) {
  const r = await query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [String(email || '').trim()]);
  return r.rows[0] || null; // includes password_hash — internal use only (verifyLogin)
}

async function getById(id, companyId) {
  const params = companyId ? [id, companyId] : [id];
  const r = await query(
    `SELECT * FROM users WHERE id = $1${companyId ? ' AND company_id = $2' : ''}`,
    params
  );
  return sanitize(r.rows[0]);
}

async function list(companyId) {
  if (!companyId) throw new Error('users.list requires companyId');
  const r = await query(`SELECT * FROM users WHERE company_id = $1 ORDER BY created_at ASC`, [companyId]);
  return r.rows.map(sanitize);
}

const EDITABLE = ['name', 'role', 'status'];
async function update(companyId, id, fields) {
  if (!companyId) throw new Error('users.update requires companyId');
  const sets = [], params = []; let i = 1;
  for (const k of EDITABLE) {
    if (fields[k] === undefined) continue;
    sets.push(`${k}=$${i++}`); params.push(fields[k]);
  }
  if (fields.password !== undefined) {
    const problem = passwordProblem(fields.password);
    if (problem) throw new Error(problem);
    sets.push(`password_hash=$${i++}`); params.push(hashPassword(fields.password));
  }
  if (!sets.length) return null;
  params.push(id, companyId);
  const r = await query(
    `UPDATE users SET ${sets.join(', ')}, updated_at=now() WHERE id=$${i++} AND company_id=$${i} RETURNING *`,
    params
  );
  return sanitize(r.rows[0]);
}

async function remove(companyId, id) {
  if (!companyId) throw new Error('users.remove requires companyId');
  await query(`DELETE FROM users WHERE id=$1 AND company_id=$2`, [id, companyId]);
  return true;
}

async function verifyLogin(email, password) {
  const user = await findByEmail(email);
  if (!user || user.status !== 'active') return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return sanitize(user);
}

// ── Clerk identity resolution (migration 044) ──────────────────────────────
// Maps a verified Clerk identity onto a CRM user row. This is the ONLY place
// that decides which tenant a human belongs to, so the rules live here in one
// readable block rather than spread across the middleware.
//
// Evaluated top to bottom, first match wins:
//
//   1. Already linked (clerk_user_id matches)  -> use that row
//   2. Email matches an UNLINKED row           -> link it, keep its company/role
//   3. Email matches a DIFFERENTLY-linked row  -> refuse (two identities, one account)
//   4. A pending invite matches the email      -> create from the invite
//   5. Target tenant has zero users            -> bootstrap as owner
//   6. otherwise                               -> refuse
//
// Returns a sanitized user row, or null meaning "this identity has no
// workspace" — which the caller turns into a 403, never a 401. The distinction
// matters: the token was perfectly valid, the person just is not a member here,
// and telling them to sign in again would send them round a loop.
async function findByClerkId(clerkUserId) {
  const r = await query(
    `SELECT * FROM users WHERE clerk_user_id = $1 ORDER BY created_at ASC`, [clerkUserId]);
  return r.rows;
}

async function findPendingInvite(email) {
  const r = await query(
    `SELECT * FROM user_invites
      WHERE lower(email) = lower($1) AND accepted_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [String(email || '').trim()]
  );
  return r.rows[0] || null;
}

// Picks one membership when a person belongs to several tenants. UNREACHABLE
// today (uq_users_email makes email globally unique), and written anyway so the
// eventual multi-tenant migration is DB-only — see migration 044's closing note.
//
// The load-bearing rule: requestedCompanyId may only SELECT AMONG rows that
// already exist. It can never widen access to a tenant the person is not
// already a member of. That is the cross-tenant-hop property.
function selectMembership(rows, requestedCompanyId) {
  if (requestedCompanyId) {
    const match = rows.find(r => r.company_id === requestedCompanyId);
    if (match) return sanitize(match);
    return null; // asked for a tenant they are not a member of
  }
  return sanitize(rows[0]); // oldest membership as the default workspace
}

async function bootstrapOwner({ clerkUserId, email, name }) {
  if (process.env.CLERK_ALLOW_BOOTSTRAP === '0') return null;
  const target = process.env.CLERK_BOOTSTRAP_COMPANY_ID
    || process.env.DEFAULT_COMPANY_ID
    || 'tantra';
  const t = await query(`SELECT id FROM tenants WHERE id = $1`, [target]);
  if (!t.rows[0]) return null;
  // THE safety window, lifted from the /register claim logic in routes/auth.js:
  // bootstrapping works only while nobody owns this tenant yet. The moment one
  // user exists, this path is dead forever and the only ways in are an invite
  // or a hand-inserted row. A stranger who signs up on the Clerk instance after
  // that gets rule 6.
  const existing = await query(`SELECT 1 FROM users WHERE company_id = $1 LIMIT 1`, [target]);
  if (existing.rows[0]) return null;
  console.warn('[Auth] bootstrapping %s as the first owner of tenant %s', email, target);
  return create({ companyId: target, email, clerkUserId, name: name || null, role: 'owner' });
}

async function resolveClerkIdentity({ clerkUserId, email, name }, { requestedCompanyId } = {}) {
  if (!clerkUserId) return null;

  // 1. Already linked.
  const linked = await findByClerkId(clerkUserId);
  if (linked.length === 1) return sanitize(linked[0]);
  if (linked.length > 1) return selectMembership(linked, requestedCompanyId);

  if (!email) {
    console.warn('[Auth] Clerk identity %s has no resolvable email — cannot provision', clerkUserId);
    return null;
  }
  const lower = String(email).trim().toLowerCase();

  // 2. Link a pre-Clerk row for this email. Guarded on `clerk_user_id IS NULL`
  //    so two concurrent first-requests cannot both claim it, and so a row
  //    already bound to a different identity is never silently re-bound.
  const linkable = await query(
    `UPDATE users SET clerk_user_id = $1, updated_at = now()
      WHERE lower(email) = $2 AND clerk_user_id IS NULL RETURNING *`,
    [clerkUserId, lower]
  );
  if (linkable.rows[0]) {
    console.warn('[Auth] linked Clerk identity %s to existing user %s', clerkUserId, lower);
    return sanitize(linkable.rows[0]);
  }

  // 3. Same email, different Clerk identity. Refuse rather than guess.
  const collision = await query(`SELECT id FROM users WHERE lower(email) = $1`, [lower]);
  if (collision.rows[0]) {
    console.error('[Auth] SECURITY: %s is already bound to a different Clerk identity — refusing', lower);
    return null;
  }

  // 4/5. Provision, retrying once on a unique-violation race. The unique
  //      indexes are the correct serialization point here — a transaction
  //      spanning the whole function would serialize every login instead.
  try {
    const invite = await findPendingInvite(lower);
    if (invite) return acceptInviteForClerk(invite, { clerkUserId, email: lower, name });
    return await bootstrapOwner({ clerkUserId, email: lower, name });
  } catch (err) {
    if (err && err.code === '23505') {
      const again = await findByClerkId(clerkUserId);
      if (again.length) return selectMembership(again, requestedCompanyId);
    }
    throw err;
  }
}

// Creates the row an invite promised, and stamps the invite used. Idempotent on
// double-submit: a second call with the same identity returns the existing row
// rather than colliding.
async function acceptInviteForClerk(invite, { clerkUserId, email, name }) {
  const already = await findByClerkId(clerkUserId);
  if (already.length) return sanitize(already[0]);
  const user = await create({
    companyId: invite.company_id,
    email: email || invite.email,
    clerkUserId,
    name: name || null,
    role: invite.role,
  });
  await query(`UPDATE user_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
  return user;
}

// ── sessions ──────────────────────────────────────────────────────────────
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function createSession(userId) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' milliseconds')::interval)`,
    [userId, hashToken(rawToken), SESSION_TTL_MS]
  );
  return rawToken;
}

// Returns { user } (sanitized) or null. Sliding expiry: a valid session's
// last_seen_at (and window) refreshes on use, so an active user is never
// logged out mid-session, but an abandoned one still expires.
async function resolveSession(rawToken) {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const r = await query(
    `UPDATE user_sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' milliseconds')::interval
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING user_id`,
    [tokenHash, SESSION_TTL_MS]
  );
  if (!r.rows[0]) return null;
  const u = await query(`SELECT * FROM users WHERE id = $1`, [r.rows[0].user_id]);
  if (!u.rows[0] || u.rows[0].status !== 'active') return null;
  return sanitize(u.rows[0]);
}

async function destroySession(rawToken) {
  if (!rawToken) return;
  await query(`DELETE FROM user_sessions WHERE token_hash = $1`, [hashToken(rawToken)]);
}

async function destroyAllSessions(userId) {
  await query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
}

// ── invites ───────────────────────────────────────────────────────────────
async function createInvite({ companyId, email, role = 'member', invitedBy }) {
  if (!companyId) throw new Error('users.createInvite requires companyId');
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const r = await query(
    `INSERT INTO user_invites (company_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' milliseconds')::interval)
     ON CONFLICT (company_id, lower(email)) WHERE accepted_at IS NULL DO UPDATE SET
       role=EXCLUDED.role, token_hash=EXCLUDED.token_hash, invited_by=EXCLUDED.invited_by,
       expires_at=EXCLUDED.expires_at, created_at=now()
     RETURNING *`,
    [companyId, String(email).trim().toLowerCase(), role, hashToken(rawToken), invitedBy || null, INVITE_TTL_MS]
  );
  return { invite: r.rows[0], rawToken };
}

async function resolveInvite(rawToken) {
  if (!rawToken) return null;
  const r = await query(
    `SELECT * FROM user_invites WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [hashToken(rawToken)]
  );
  return r.rows[0] || null;
}

async function acceptInvite(rawToken, { password, name }) {
  const invite = await resolveInvite(rawToken);
  if (!invite) return null;
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const existing = await findByEmail(invite.email);
  if (existing) throw new Error('an account with this email already exists');
  const user = await create({ companyId: invite.company_id, email: invite.email, password, name, role: invite.role });
  await query(`UPDATE user_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
  return user;
}

async function listInvites(companyId) {
  if (!companyId) throw new Error('users.listInvites requires companyId');
  const r = await query(
    `SELECT id, company_id, email, role, invited_by, expires_at, accepted_at, created_at
       FROM user_invites WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  return r.rows;
}

async function revokeInvite(companyId, id) {
  if (!companyId) throw new Error('users.revokeInvite requires companyId');
  await query(`DELETE FROM user_invites WHERE id=$1 AND company_id=$2 AND accepted_at IS NULL`, [id, companyId]);
  return true;
}

module.exports = {
  create, findByEmail, getById, list, update, remove, verifyLogin,
  createSession, resolveSession, destroySession, destroyAllSessions,
  createInvite, resolveInvite, acceptInvite, listInvites, revokeInvite,
  // Clerk (migration 044)
  resolveClerkIdentity, acceptInviteForClerk, findByClerkId, findPendingInvite,
  SESSION_TTL_MS,
};
