'use strict';
// ─── DAL: Tenants (GOAL A2 — real tenant entity + resolution) ─────────────────
// The tenant registry itself (migration 012) — distinct from `companies`
// (migration 008), which is per-tenant CRM data (an employer/account row
// inside one tenant's contacts). One row here per customer of DenchClaw.
const { query } = require('../index');

async function getById(id) {
  if (!id) return null;
  const result = await query('SELECT * FROM tenants WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getBySlug(slug) {
  if (!slug) return null;
  const result = await query('SELECT * FROM tenants WHERE slug = $1', [slug]);
  return result.rows[0] || null;
}

// Canonicalize an incoming id: exact tenant id match wins, else any tenant
// whose `aliases` contains it (replaces the old env-parsed LEGACY_COMPANY_IDS
// fold — aliases are now data, not config). Returns the tenant row or null if
// the id is unrecognized by any known tenant. ORDER BY makes the exact-id-wins
// priority deterministic even if a data bug ever let an alias collide with
// another tenant's id (the migration 012 trigger is the primary guard against
// that; this is defense in depth, not a substitute for it).
async function resolve(id) {
  if (!id) return null;
  const result = await query(
    `SELECT * FROM tenants WHERE id = $1 OR $1 = ANY(aliases)
     ORDER BY (id = $1) DESC LIMIT 1`,
    [id]
  );
  return result.rows[0] || null;
}

async function list() {
  const result = await query('SELECT * FROM tenants ORDER BY created_at ASC');
  return result.rows;
}

async function create({ id, name, slug, status = 'active', plan = 'standard', aliases = [] }) {
  const result = await query(
    `INSERT INTO tenants (id, name, slug, status, plan, aliases)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, name, slug, status, plan, aliases]
  );
  return result.rows[0];
}

module.exports = { getById, getBySlug, resolve, list, create };
