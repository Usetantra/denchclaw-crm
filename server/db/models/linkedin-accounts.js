'use strict';
// ─── DAL: linkedin_accounts (migration 024) ───────────────────────────────────
// The table itself, and the reads that matter for SENDING (getActiveAccount,
// counters, gates), already existed in server/lib/linkedin-gate.js. What was
// missing was CRUD for an operator to manage the row at all — before this, an
// account was inserted by hand directly into the database. This is that
// missing layer: connect / list / update / disconnect, company-scoped.
const { query } = require('../index');

async function list(companyId) {
  if (!companyId) throw new Error('linkedinAccounts.list requires companyId');
  const r = await query(
    `SELECT * FROM linkedin_accounts WHERE company_id = $1 ORDER BY connected_at ASC`,
    [companyId]
  );
  return r.rows;
}

async function get(companyId, id) {
  if (!companyId) throw new Error('linkedinAccounts.get requires companyId');
  const r = await query(`SELECT * FROM linkedin_accounts WHERE id = $1 AND company_id = $2`, [id, companyId]);
  return r.rows[0] || null;
}

// account_id is the Unipile account id — obtained by completing Unipile's own
// hosted LinkedIn login flow (outside this app) and copying the id it returns.
// engineDispatchDisabled is THE OPERATOR'S ASSERTION the gate refuses to send
// without (server/lib/linkedin-gate.js admits()) — a second system dispatching
// on the same connected LinkedIn account would blow through every cap here
// without either side knowing, so it fails closed until confirmed true.
async function connect(companyId, { accountId, displayName, timezone, engineDispatchDisabled }) {
  if (!companyId) throw new Error('linkedinAccounts.connect requires companyId');
  if (!accountId) throw new Error('linkedinAccounts.connect requires accountId');
  const r = await query(
    `INSERT INTO linkedin_accounts (company_id, account_id, display_name, timezone, engine_dispatch_disabled, status)
     VALUES ($1,$2,$3,COALESCE($4,'Asia/Kolkata'),$5,'connected')
     ON CONFLICT (account_id) DO UPDATE SET
       company_id=EXCLUDED.company_id, display_name=COALESCE(EXCLUDED.display_name, linkedin_accounts.display_name),
       timezone=COALESCE(EXCLUDED.timezone, linkedin_accounts.timezone),
       engine_dispatch_disabled=EXCLUDED.engine_dispatch_disabled, status='connected', updated_at=now()
     RETURNING *`,
    [companyId, accountId, displayName || null, timezone || null, !!engineDispatchDisabled]
  );
  return r.rows[0];
}

const EDITABLE = [
  'status', 'display_name', 'timezone', 'daily_invite_limit', 'daily_message_limit',
  'daily_inmail_limit', 'daily_total_limit', 'weekly_invite_limit', 'max_pending_invites',
  'active_start', 'active_end', 'active_days', 'allow_unverified_message', 'engine_dispatch_disabled',
];
async function update(companyId, id, fields) {
  if (!companyId) throw new Error('linkedinAccounts.update requires companyId');
  const sets = [], params = []; let i = 1;
  for (const k of EDITABLE) {
    if (fields[toCamel(k)] === undefined) continue;
    sets.push(`${k}=$${i++}`); params.push(fields[toCamel(k)]);
  }
  if (!sets.length) return null;
  params.push(id, companyId);
  const r = await query(
    `UPDATE linkedin_accounts SET ${sets.join(', ')}, updated_at=now()
      WHERE id=$${i++} AND company_id=$${i} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}
function toCamel(snake) { return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

async function disconnect(companyId, id) {
  if (!companyId) throw new Error('linkedinAccounts.disconnect requires companyId');
  const r = await query(
    `UPDATE linkedin_accounts SET status='disconnected', updated_at=now()
      WHERE id=$1 AND company_id=$2 RETURNING *`,
    [id, companyId]
  );
  return r.rows[0] || null;
}

async function remove(companyId, id) {
  if (!companyId) throw new Error('linkedinAccounts.remove requires companyId');
  await query(`DELETE FROM linkedin_accounts WHERE id=$1 AND company_id=$2`, [id, companyId]);
  return true;
}

module.exports = { list, get, connect, update, disconnect, remove };
