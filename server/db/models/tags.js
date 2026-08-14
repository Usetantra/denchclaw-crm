'use strict';
// ─── DAL: tags (global view over contacts.tags) ────────────────────────────
// There is no separate tags table — tags live where they always have, on
// contacts.tags (TEXT[]). This module is a management layer over that column:
// list every distinct tag in use with its count, rename one across every
// contact that has it, or remove it everywhere. Renaming to a tag that
// already exists on some contact MERGES rather than duplicating (a contact
// can't hold the same tag twice — tags is a set, not a bag).
const { query } = require('../index');

async function list(companyId) {
  if (!companyId) throw new Error('tags.list requires companyId');
  const r = await query(
    `SELECT tag, COUNT(*)::int AS contact_count
       FROM contacts, unnest(tags) AS tag
      WHERE company_id=$1 AND deleted_at IS NULL
      GROUP BY tag
      ORDER BY contact_count DESC, tag ASC`,
    [companyId]
  );
  return r.rows;
}

async function rename(companyId, oldTag, newTag) {
  if (!companyId) throw new Error('tags.rename requires companyId');
  if (!newTag || !newTag.trim()) throw new Error('newTag is required');
  const trimmed = newTag.trim();
  // array_remove(tags, old) || CASE keeps the set deduplicated: a contact that
  // already has both old and new tags collapses to one 'new', not two.
  const r = await query(
    `UPDATE contacts
        SET tags = (
              SELECT array_agg(DISTINCT t)
                FROM unnest(array_replace(tags, $2, $3)) AS t
            ),
            updated_at = now()
      WHERE company_id=$1 AND $2 = ANY(tags) AND deleted_at IS NULL
      RETURNING id`,
    [companyId, oldTag, trimmed]
  );
  return r.rowCount;
}

async function remove(companyId, tag) {
  if (!companyId) throw new Error('tags.remove requires companyId');
  const r = await query(
    `UPDATE contacts SET tags = array_remove(tags, $2), updated_at = now()
      WHERE company_id=$1 AND $2 = ANY(tags) AND deleted_at IS NULL
      RETURNING id`,
    [companyId, tag]
  );
  return r.rowCount;
}

module.exports = { list, rename, remove };
