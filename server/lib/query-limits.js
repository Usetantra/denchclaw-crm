'use strict';
// ─── Row-count ceilings ──────────────────────────────────────────────────────
// Every bound the CRM applies to a list, an export or an import lives here, so
// "how big can this get?" has one answer instead of nine.
//
// WHY THIS FILE EXISTS
//
// The database was never the capacity limit — Postgres holds millions of
// contacts without complaint, and `contacts` is indexed on company_id. The limit
// was the APPLICATION: `contactDb.list(companyId, {})` emitted no LIMIT clause
// at all, so several endpoints loaded every contact a tenant owned into Node
// memory at once. With pm2's `max_memory_restart`, a large tenant hitting
// /contacts/export or /pipeline did not return a slow response or a clean error
// — the process was killed and restarted mid-request, taking every other
// in-flight request with it. That is the failure mode these ceilings remove.
//
// THE RULE THESE CONSTANTS FOLLOW: never silently truncate. Every cap either
// paginates (with `has_more` and a cursor/offset so the caller can continue),
// streams (so the whole set is delivered without ever being held in memory), or
// refuses with a 413 that names the limit. Quietly returning the first N rows of
// an unbounded query is worse than the OOM it replaces — an export that looks
// complete and silently isn't is a data-loss bug the operator cannot see.

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = {
  // Default page size when a caller asks for a list without saying how many.
  DEFAULT_PAGE: envInt('CRM_DEFAULT_PAGE_SIZE', 50),

  // The largest page a caller may explicitly request. Bounds one response.
  MAX_PAGE: envInt('CRM_MAX_PAGE_SIZE', 500),

  // Backstop inside contacts.list() for the legacy unbounded call form. Callers
  // that pass no limit still get a bounded result, and the array is flagged
  // (`rows.capped`) so a route can report `has_more` rather than lie. Chosen to
  // sit far above any realistic in-app list and far below what would exhaust the
  // heap.
  HARD_CAP: envInt('CRM_HARD_ROW_CAP', 5000),

  // Export streams in batches of this size — the peak memory of an export is one
  // batch, not the whole table, so a 500k-contact export costs the same as a
  // 500-contact one.
  EXPORT_BATCH: envInt('CRM_EXPORT_BATCH', 1000),

  // Absolute ceiling on a single export. Past this, a 413 naming the limit and
  // suggesting a filter beats a response that takes ten minutes and times out
  // behind a proxy anyway.
  EXPORT_MAX: envInt('CRM_EXPORT_MAX_ROWS', 250000),

  // Rows accepted in one bulk-import request. Import is a serial per-row loop
  // (find-or-create, activity, scoring), so a huge array is a long-held request
  // rather than a memory problem — this keeps one request inside a normal proxy
  // timeout and makes the client chunk instead.
  IMPORT_MAX: envInt('CRM_IMPORT_MAX_ROWS', 1000),
};
