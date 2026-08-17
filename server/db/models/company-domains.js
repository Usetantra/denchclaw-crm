'use strict';
// ─── DAL: company_domains (migration 038) ──────────────────────────────────
const { query } = require('../index');

async function list(companyId) {
  if (!companyId) throw new Error('companyDomains.list requires companyId');
  const r = await query(`SELECT * FROM company_domains WHERE company_id=$1 ORDER BY created_at DESC`, [companyId]);
  return r.rows;
}

async function get(companyId, id) {
  const r = await query(`SELECT * FROM company_domains WHERE company_id=$1 AND id=$2`, [companyId, id]);
  return r.rows[0] || null;
}

// Server-side only — used to resolve which tenant owns a domain (inbound
// routing, sender validation), never exposed by domain name to the client.
async function getByDomain(domain) {
  const r = await query(`SELECT * FROM company_domains WHERE lower(domain)=lower($1)`, [domain]);
  return r.rows[0] || null;
}

async function create(companyId, { domain, resendDomainId, region, status, records }) {
  const r = await query(
    `INSERT INTO company_domains (company_id, domain, resend_domain_id, region, status, records)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [companyId, domain, resendDomainId, region || 'us-east-1', status || 'pending', JSON.stringify(records || [])]
  );
  return r.rows[0];
}

async function updateFromResend(companyId, id, { status, records, receivingEnabled }) {
  const sets = ['last_checked_at = now()', 'updated_at = now()'];
  const params = [];
  let i = 1;
  if (status !== undefined) { sets.push(`status=$${i++}`); params.push(status); }
  if (records !== undefined) { sets.push(`records=$${i++}`); params.push(JSON.stringify(records)); }
  if (receivingEnabled !== undefined) { sets.push(`receiving_enabled=$${i++}`); params.push(!!receivingEnabled); }
  params.push(companyId, id);
  const r = await query(
    `UPDATE company_domains SET ${sets.join(', ')} WHERE company_id=$${i++} AND id=$${i} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function remove(companyId, id) {
  const r = await query(`DELETE FROM company_domains WHERE company_id=$1 AND id=$2 RETURNING *`, [companyId, id]);
  return r.rows[0] || null;
}

module.exports = { list, get, getByDomain, create, updateFromResend, remove };
