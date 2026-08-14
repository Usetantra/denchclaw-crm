'use strict';
// ─── DAL: message templates (+ version history) ───────────────────────────────
// The CRM's authoritative template record. Local authoring/edit/archive/categorize
// works without a provider; provider_template_id + status are synced from Twilio /
// Meta. Every edit snapshots the prior definition into channel_message_template_versions.
const { query } = require('../index');

const FIELDS = 'id, company_id, channel, provider, provider_template_id, name, language, category, submitted_category, current_category, status, quality, header, body, footer, buttons, variables, rejection_reason, appeal_deadline, version, metadata, created_at, updated_at';

async function list(companyId, { channel, status, includeArchived = false } = {}) {
  const params = [companyId]; let where = 'company_id=$1';
  if (channel) { params.push(channel); where += ` AND channel=$${params.length}`; }
  if (status) { params.push(status); where += ` AND status=$${params.length}`; }
  if (!includeArchived) where += ` AND status <> 'ARCHIVED'`;
  const r = await query(`SELECT ${FIELDS} FROM channel_message_templates WHERE ${where} ORDER BY updated_at DESC`, params);
  return r.rows;
}

async function get(companyId, id) {
  const r = await query(`SELECT ${FIELDS} FROM channel_message_templates WHERE company_id=$1 AND id=$2 LIMIT 1`, [companyId, id]);
  return r.rows[0] || null;
}

async function create(companyId, t) {
  const r = await query(
    `INSERT INTO channel_message_templates
       (company_id, channel, provider, name, language, category, submitted_category, status,
        header, body, footer, buttons, variables, version, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,'DRAFT',$7,$8,$9,$10,$11,1, now())
     RETURNING ${FIELDS}`,
    [companyId, t.channel || 'whatsapp', t.provider || 'twilio', t.name, t.language || 'en',
     (t.category || 'UTILITY').toUpperCase(),
     t.header ? JSON.stringify(t.header) : null, t.body || '', t.footer || null,
     JSON.stringify(t.buttons || []), JSON.stringify(t.variables || [])]
  );
  return r.rows[0];
}

// Edit: snapshot current definition, then apply changes and bump version.
async function update(companyId, id, patch) {
  const cur = await get(companyId, id);
  if (!cur) return null;
  await query(
    `INSERT INTO channel_message_template_versions (template_id, company_id, version, snapshot, status)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, companyId, cur.version, JSON.stringify(cur), cur.status]
  );
  const next = {
    name: patch.name ?? cur.name,
    language: patch.language ?? cur.language,
    category: (patch.category ?? cur.category ?? 'UTILITY').toUpperCase(),
    header: patch.header !== undefined ? patch.header : cur.header,
    body: patch.body ?? cur.body,
    footer: patch.footer !== undefined ? patch.footer : cur.footer,
    buttons: patch.buttons !== undefined ? patch.buttons : cur.buttons,
    variables: patch.variables !== undefined ? patch.variables : cur.variables,
  };
  const r = await query(
    `UPDATE channel_message_templates SET name=$1, language=$2, category=$3, header=$4, body=$5, footer=$6,
       buttons=$7, variables=$8, status='DRAFT', provider_template_id=NULL, version=version+1, updated_at=now()
     WHERE company_id=$9 AND id=$10 RETURNING ${FIELDS}`,
    [next.name, next.language, next.category, next.header ? JSON.stringify(next.header) : null, next.body,
     next.footer, JSON.stringify(next.buttons || []), JSON.stringify(next.variables || []), companyId, id]
  );
  return r.rows[0];
}

async function setProvider(companyId, id, { providerTemplateId, status, submittedCategory }) {
  const r = await query(
    `UPDATE channel_message_templates SET provider_template_id=COALESCE($1, provider_template_id),
       status=COALESCE($2, status), submitted_category=COALESCE($3, submitted_category), updated_at=now()
     WHERE company_id=$4 AND id=$5 RETURNING ${FIELDS}`,
    [providerTemplateId || null, status || null, submittedCategory || null, companyId, id]
  );
  return r.rows[0] || null;
}

async function syncStatus(companyId, id, { status, currentCategory, rejectionReason }) {
  const r = await query(
    `UPDATE channel_message_templates SET status=COALESCE($1,status), current_category=COALESCE($2,current_category),
       rejection_reason=$3, updated_at=now() WHERE company_id=$4 AND id=$5 RETURNING ${FIELDS}`,
    [status || null, currentCategory || null, rejectionReason || null, companyId, id]
  );
  return r.rows[0] || null;
}

async function archive(companyId, id) {
  const r = await query(`UPDATE channel_message_templates SET status='ARCHIVED', updated_at=now() WHERE company_id=$1 AND id=$2 RETURNING ${FIELDS}`, [companyId, id]);
  return r.rows[0] || null;
}

async function remove(companyId, id) {
  await query(`DELETE FROM channel_message_templates WHERE company_id=$1 AND id=$2`, [companyId, id]);
  return true;
}

async function versions(companyId, id) {
  const r = await query(`SELECT version, status, snapshot, created_at FROM channel_message_template_versions WHERE company_id=$1 AND template_id=$2 ORDER BY version DESC`, [companyId, id]);
  return r.rows;
}

module.exports = { list, get, create, update, setProvider, syncStatus, archive, remove, versions };
