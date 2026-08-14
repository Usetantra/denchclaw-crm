'use strict';
// ─── DAL: business profile ─────────────────────────────────────────────────
// One row per company_id, upserted — the operator's own business info
// (Settings → Business Profile), not to be confused with `tenants` (DenchClaw's
// own customer registry, admin-only) or `companies` (an account inside a
// tenant's contacts).
const { query } = require('../index');

async function get(companyId) {
  if (!companyId) throw new Error('businessProfile.get requires companyId');
  const r = await query(`SELECT * FROM business_profile WHERE company_id=$1`, [companyId]);
  return r.rows[0] || null;
}

const FIELDS = ['name', 'industry', 'website', 'phone', 'timezone', 'currency', 'address', 'logo_url'];

async function upsert(companyId, fields = {}) {
  if (!companyId) throw new Error('businessProfile.upsert requires companyId');
  const cols = ['company_id'], vals = [companyId], placeholders = ['$1'];
  let i = 2;
  for (const f of FIELDS) {
    if (fields[f] === undefined) continue;
    cols.push(f);
    vals.push(f === 'address' ? JSON.stringify(fields[f] || {}) : fields[f]);
    placeholders.push(`$${i++}`);
  }
  const updateCols = cols.slice(1).map(c => `${c}=EXCLUDED.${c}`);
  updateCols.push('updated_at=now()');
  const r = await query(
    `INSERT INTO business_profile (${cols.join(', ')}, updated_at)
     VALUES (${placeholders.join(', ')}, now())
     ON CONFLICT (company_id) DO UPDATE SET ${updateCols.join(', ')}
     RETURNING *`,
    vals
  );
  return r.rows[0];
}

module.exports = { get, upsert };
