'use strict';
// ─── DAL: webhook_captures (migration 035) ────────────────────────────────────
// See that migration's header for what this is for. Not company-scoped —
// captured before any tenant is known.
const { query } = require('../index');

const MAX_PER_TOOL = 20; // a debugging aid, not a log — keep it small.

async function record(tool, { method, headers, body, rawBody }) {
  const r = await query(
    `INSERT INTO webhook_captures (tool, method, headers, body, raw_body)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tool, method, JSON.stringify(headers || {}), body != null ? JSON.stringify(body) : null, rawBody || null]
  );
  // Prune in the same call — this table exists to show "what did the last
  // real event look like", not to accumulate every test click forever.
  await query(
    `DELETE FROM webhook_captures WHERE tool = $1 AND id NOT IN (
       SELECT id FROM webhook_captures WHERE tool = $1 ORDER BY received_at DESC LIMIT $2
     )`,
    [tool, MAX_PER_TOOL]
  );
  return r.rows[0];
}

async function list(tool, limit = 10) {
  const r = await query(
    `SELECT * FROM webhook_captures WHERE tool = $1 ORDER BY received_at DESC LIMIT $2`,
    [tool, Math.min(parseInt(limit, 10) || 10, MAX_PER_TOOL)]
  );
  return r.rows;
}

async function listTools() {
  const r = await query(
    `SELECT tool, COUNT(*)::int AS count, MAX(received_at) AS last_received_at FROM webhook_captures GROUP BY tool ORDER BY last_received_at DESC`
  );
  return r.rows;
}

module.exports = { record, list, listTools };
