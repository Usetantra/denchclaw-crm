'use strict';
// ─── DAL: Companies (account entity + auto-identification) ────────────────────
// Keeps the Companies tab in sync with reality: whenever a contact or deal comes
// in, the employer name is resolved to a real `companies` row and the contact/
// deal is linked via the company_ref_id FK (migration 011). The read side then
// rolls up exact counts/pipeline value per account.
const { query } = require('../index');

// Obvious scrape-noise employer names that must never become an account row.
// Mirrors the blocklist in migrations/011_company_normalization.sql. Match is
// exact on the lowercased/trimmed name, so real names that merely CONTAIN these
// words ("Growth Labs", "Ocean Bottle") are unaffected.
const NAME_BLOCKLIST = new Set([
  'home', 'home page', 'homepage', 'page', 'blog', 'growth', 'growthclub', 'tantra',
  'ai', 'full', 'merge', 'about', 'contact', 'contact us', 'login', 'log in', 'sign up',
  'signup', 'product', 'products', 'pricing', 'features', 'n/a', 'na', 'none', 'null',
  'unknown', 'test', 'demo', 'index', 'dashboard', 'portal', 'careers', 'support',
]);

function cleanName(raw) {
  const n = (raw == null ? '' : String(raw)).trim();
  if (!n) return null;
  if (NAME_BLOCKLIST.has(n.toLowerCase())) return null;
  return n;
}

// Resolve an employer name to a company row id.
//   • Returns the existing row's id if the account already exists.
//   • Otherwise materializes it the moment a 2nd contact shares the name — the
//     same >=2 rule used by the backfill, so singletons/noise don't clutter the
//     tab. Pass { force:true } (deals) to always upsert: an explicit deal is
//     proof of a real account regardless of contact count.
//   • Returns null for noise names / still-singletons (caller leaves it unlinked;
//     the raw company_name text is preserved on the contact either way).
async function resolveCompanyId(companyId, rawName, { force = false } = {}) {
  const name = cleanName(rawName);
  if (!companyId || !name) return null;

  const existing = await query(
    'SELECT id FROM companies WHERE company_id=$1 AND lower(name)=lower($2) LIMIT 1',
    [companyId, name]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  if (!force) {
    const cnt = await query(
      `SELECT count(*)::int AS c FROM contacts
        WHERE company_id=$1 AND deleted_at IS NULL
          AND lower(btrim(company_name))=lower($2)`,
      [companyId, name]
    );
    if ((cnt.rows[0]?.c || 0) < 2) return null;
  }

  const ins = await query(
    `INSERT INTO companies (company_id, name) VALUES ($1,$2)
       ON CONFLICT (company_id, lower(name)) DO UPDATE SET updated_at=now()
     RETURNING id`,
    [companyId, name]
  );
  return ins.rows[0].id;
}

// Link every contact in the tenant whose employer name matches `name` to the
// company row (backlinks the earlier singleton once its sibling arrives).
async function linkContactsByName(companyId, companyRefId, name) {
  const clean = cleanName(name);
  if (!companyRefId || !clean) return;
  await query(
    `UPDATE contacts SET company_ref_id=$1
      WHERE company_id=$2 AND deleted_at IS NULL
        AND lower(btrim(company_name))=lower($3)
        AND company_ref_id IS DISTINCT FROM $1`,
    [companyRefId, companyId, clean]
  );
}

// One-shot for ingestion: resolve the account and link all matching contacts.
// Returns the company_ref_id (or null). Never throws into the request path —
// company identification is best-effort enrichment, not a hard dependency.
async function identifyAndLink(companyId, rawName, opts = {}) {
  try {
    const refId = await resolveCompanyId(companyId, rawName, opts);
    if (refId) await linkContactsByName(companyId, refId, rawName);
    return refId;
  } catch (e) {
    console.error('[CRM] company identify failed:', e.message);
    return null;
  }
}

module.exports = { resolveCompanyId, linkContactsByName, identifyAndLink, cleanName, NAME_BLOCKLIST };
