'use strict';
// ─── Companies ───────────────────────────────────────────────────────────────
// A real employer/account entity. company_id is the TENANT id (as everywhere);
// `name` is the company/account name, matched case-insensitively to
// contacts.company_name to compute contact_count + pipeline_value.
const express = require('express');
const router = express.Router();
const { query } = require('../db/index');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const EDITABLE = ['name', 'domain', 'industry', 'website', 'size', 'location', 'notes'];

// Exact rollups via the normalized company_ref_id FK (migration 011): linked
// contacts, their aggregate lead value, and the deal pipeline for the account.
const ROLLUP = `
  (SELECT COUNT(*)::int FROM contacts ct
     WHERE ct.company_ref_id = c.id AND ct.deleted_at IS NULL) AS contact_count,
  (SELECT COALESCE(SUM(ct.deal_value),0)::numeric FROM contacts ct
     WHERE ct.company_ref_id = c.id AND ct.deleted_at IS NULL) AS pipeline_value,
  (SELECT COUNT(*)::int FROM deals d WHERE d.company_ref_id = c.id) AS deal_count,
  (SELECT COALESCE(SUM(d.value),0)::numeric FROM deals d
     WHERE d.company_ref_id = c.id AND d.stage <> 'lost') AS deal_value`;

function mapRow(r) {
  return {
    id: r.id, name: r.name, domain: r.domain, industry: r.industry,
    website: r.website, size: r.size, location: r.location, notes: r.notes,
    contact_count: r.contact_count ?? 0,
    pipeline_value: parseFloat(r.pipeline_value) || 0,
    deal_count: r.deal_count ?? 0,
    deal_value: parseFloat(r.deal_value) || 0,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

// GET /api/crm/companies?search=&limit=&offset=
router.get('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { search } = req.query;
    const params = [companyId];
    let where = 'c.company_id = $1';
    if (search) { params.push(`%${search}%`); where += ` AND (c.name ILIKE $${params.length} OR c.industry ILIKE $${params.length} OR c.domain ILIKE $${params.length})`; }

    const paginated = req.query.limit !== undefined || req.query.offset !== undefined;
    let tail = ' ORDER BY c.name ASC';
    if (paginated) {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      params.push(limit, offset);
      tail += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
    }
    const { rows } = await query(`SELECT c.*, ${ROLLUP} FROM companies c WHERE ${where}${tail}`, params);
    const totalRes = await query('SELECT COUNT(*)::int AS n FROM companies WHERE company_id = $1', [companyId]);
    res.json({ total: totalRes.rows[0].n, companies: rows.map(mapRow) });
  } catch (err) {
    console.error('[CRM] GET /companies error:', err.message);
    res.status(500).json({ error: 'failed to load companies' });
  }
});

// POST /api/crm/companies
router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: 'name required' });
    const { rows } = await query(
      `INSERT INTO companies (company_id, name, domain, industry, website, size, location, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [companyId, String(body.name).trim(), body.domain || null, body.industry || null,
       body.website || null, body.size || null, body.location || null, body.notes || null]
    );
    res.status(201).json(mapRow({ ...rows[0], contact_count: 0, pipeline_value: 0 }));
  } catch (err) {
    console.error('[CRM] POST /companies error:', err.message);
    res.status(500).json({ error: 'failed to create company' });
  }
});

// POST /api/crm/companies/bulk — { action:'delete', ids:[] }  (before /:id)
router.post('/bulk', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { action, ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
    if (action === 'delete') {
      const r = await query('DELETE FROM companies WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, ids]);
      return res.json({ ok: true, deleted: r.rowCount });
    }
    res.status(400).json({ error: `unknown action: ${action}` });
  } catch (err) {
    console.error('[CRM] POST /companies/bulk error:', err.message);
    res.status(500).json({ error: 'bulk action failed' });
  }
});

// GET /api/crm/companies/:id
router.get('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT c.*, ${ROLLUP} FROM companies c WHERE c.id = $1 AND c.company_id = $2`, [req.params.id, companyId]);
    if (!rows.length) return res.status(404).json({ error: 'company not found' });
    res.json(mapRow(rows[0]));
  } catch (err) {
    console.error('[CRM] GET /companies/:id error:', err.message);
    res.status(500).json({ error: 'failed to load company' });
  }
});

// PATCH /api/crm/companies/:id
router.patch('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows: found } = await query('SELECT id FROM companies WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!found.length) return res.status(404).json({ error: 'company not found' });
    const body = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;
    for (const f of EDITABLE) {
      if (body[f] !== undefined) { sets.push(`${f} = $${i++}`); params.push(f === 'name' ? String(body[f]).trim() : body[f]); }
    }
    if (!sets.length) return res.status(400).json({ error: 'no editable fields provided' });
    sets.push('updated_at = now()');
    params.push(req.params.id, companyId);
    const { rows } = await query(
      `UPDATE companies c SET ${sets.join(', ')} WHERE c.id = $${i++} AND c.company_id = $${i++}
       RETURNING c.*, ${ROLLUP}`, params
    );
    res.json(mapRow(rows[0]));
  } catch (err) {
    console.error('[CRM] PATCH /companies/:id error:', err.message);
    res.status(500).json({ error: 'failed to update company' });
  }
});

// DELETE /api/crm/companies/:id
router.delete('/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query('DELETE FROM companies WHERE id = $1 AND company_id = $2 RETURNING *', [req.params.id, companyId]);
    if (!rows.length) return res.status(404).json({ error: 'company not found' });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    console.error('[CRM] DELETE /companies/:id error:', err.message);
    res.status(500).json({ error: 'failed to delete company' });
  }
});

// GET /api/crm/companies/:id/contacts — people linked to this account
router.get('/:id/contacts', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const own = await query('SELECT id FROM companies WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!own.rows.length) return res.status(404).json({ error: 'company not found' });
    const { rows } = await query(
      `SELECT id, name, email, title, phone, linkedin_url, source, lead_score,
              marketing_stage, deal_stage, deal_value, created_at
         FROM contacts
        WHERE company_ref_id = $1 AND deleted_at IS NULL
        ORDER BY deal_value DESC NULLS LAST, name ASC
        LIMIT 500`,
      [req.params.id]
    );
    res.json({ total: rows.length, contacts: rows });
  } catch (err) {
    console.error('[CRM] GET /companies/:id/contacts error:', err.message);
    res.status(500).json({ error: 'failed to load company contacts' });
  }
});

// GET /api/crm/companies/:id/deals — deals in this account's pipeline
router.get('/:id/deals', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const own = await query('SELECT id FROM companies WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!own.rows.length) return res.status(404).json({ error: 'company not found' });
    const { rows } = await query(
      `SELECT d.id, d.title, d.value, d.currency, d.stage, d.pipeline_key,
              d.expected_close, d.created_at, c.name AS contact_name
         FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id
        WHERE d.company_ref_id = $1
        ORDER BY d.created_at DESC
        LIMIT 500`,
      [req.params.id]
    );
    res.json({ total: rows.length, deals: rows });
  } catch (err) {
    console.error('[CRM] GET /companies/:id/deals error:', err.message);
    res.status(500).json({ error: 'failed to load company deals' });
  }
});

module.exports = router;
