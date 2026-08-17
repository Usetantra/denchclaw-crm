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
async function create({ companyId, email, password, name, role = 'member' }) {
  if (!companyId) throw new Error('users.create requires companyId');
  if (!email || !String(email).trim()) throw new Error('email required');
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const r = await query(
    `INSERT INTO users (company_id, email, password_hash, name, role)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [companyId, String(email).trim().toLowerCase(), hashPassword(password), name || null, role]
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
  SESSION_TTL_MS,
};
