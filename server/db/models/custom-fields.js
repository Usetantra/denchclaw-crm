'use strict';
// ─── DAL: custom field definitions ─────────────────────────────────────────
// Named, typed fields an operator pre-declares in Settings so the Contacts
// drawer can render a proper input (select/date/number/checkbox) instead of
// every custom field being a free-text key/value pair. The VALUES still live
// in contacts.metadata.custom_fields (CP-M2's per-contact free-form store) —
// this table only defines the shape, it never stores contact data itself.
const { query } = require('../index');

const TYPES = ['text', 'number', 'date', 'select', 'checkbox'];

async function list(companyId, entityType = 'contact') {
  if (!companyId) throw new Error('customFields.list requires companyId');
  const r = await query(
    `SELECT * FROM custom_field_definitions WHERE company_id=$1 AND entity_type=$2 ORDER BY position, created_at`,
    [companyId, entityType]
  );
  return r.rows;
}

function normalizeKey(label) {
  return String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function create(companyId, { label, type = 'text', options = [], entityType = 'contact' }) {
  if (!companyId) throw new Error('customFields.create requires companyId');
  if (!label || !label.trim()) throw new Error('label is required');
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  const key = normalizeKey(label);
  if (!key) throw new Error('label must contain at least one letter or number');
  const { rows: [{ n }] } = await query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS n FROM custom_field_definitions WHERE company_id=$1 AND entity_type=$2`,
    [companyId, entityType]
  );
  const r = await query(
    `INSERT INTO custom_field_definitions (company_id, entity_type, key, label, type, options, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [companyId, entityType, key, label.trim(), type, JSON.stringify(type === 'select' ? options : []), n]
  );
  return r.rows[0];
}

async function update(companyId, id, { label, type, options, position }) {
  if (!companyId) throw new Error('customFields.update requires companyId');
  const sets = [], params = []; let i = 1;
  if (label !== undefined) { sets.push(`label=$${i++}`); params.push(label); }
  if (type !== undefined) {
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
    sets.push(`type=$${i++}`); params.push(type);
  }
  if (options !== undefined) { sets.push(`options=$${i++}`); params.push(JSON.stringify(options)); }
  if (position !== undefined) { sets.push(`position=$${i++}`); params.push(position); }
  if (!sets.length) return get(companyId, id);
  params.push(companyId, id);
  const r = await query(
    `UPDATE custom_field_definitions SET ${sets.join(', ')}, updated_at=now()
      WHERE company_id=$${i++} AND id=$${i} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

async function get(companyId, id) {
  const r = await query(`SELECT * FROM custom_field_definitions WHERE company_id=$1 AND id=$2`, [companyId, id]);
  return r.rows[0] || null;
}

async function remove(companyId, id) {
  const r = await query(`DELETE FROM custom_field_definitions WHERE company_id=$1 AND id=$2 RETURNING key`, [companyId, id]);
  return r.rows[0] || null;
}

module.exports = { TYPES, list, create, update, get, remove, normalizeKey };
