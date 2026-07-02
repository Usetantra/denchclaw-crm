'use strict';
// Shared pipeline config loader — used by crm.js, conversations.js and chat.js.
// Caches per (companyId, pipelineKey) with a 60-second TTL so repeated
// requests within one minute pay zero DB cost.
//
// Failure policy: on a DB error we serve the last-known (even expired) cache
// entry rather than returning null — a transition-authority checker must not
// fail open to defaults just because Postgres blipped. Only a company that has
// never been loaded resolves to null on error.
const { query } = require('./index');

const _cache = new Map();
const TTL_MS = 60 * 1000;

async function getPipelineConfig(companyId, pipelineKey) {
  const cacheKey = `${companyId}:${pipelineKey}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
  try {
    const r = await query(
      `SELECT stages FROM crm_pipeline_configs
       WHERE key = $1 AND (company_id = $2 OR company_id IS NULL)
       ORDER BY CASE WHEN company_id = $2 THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
      [pipelineKey, companyId]
    );
    if (!r.rows[0]) return null;
    const stages = Array.isArray(r.rows[0].stages) ? r.rows[0].stages : [];
    // Freeze so no caller can mutate the shared cached entry.
    for (const s of stages) {
      if (s && Array.isArray(s.transitions)) Object.freeze(s.transitions);
      Object.freeze(s);
    }
    const entry = Object.freeze({ stages: Object.freeze(stages), fetchedAt: Date.now() });
    _cache.set(cacheKey, entry);
    return entry;
  } catch (_e) {
    // DB error: fall back to the stale cache entry if we ever had one.
    return cached || null;
  }
}

function getPipelineTransitions(pipeline, currentStage) {
  const s = pipeline.stages.find(st => st.key === currentStage);
  // Guard malformed configs: a non-array `transitions` (e.g. a string) must not
  // reach `.includes()` substring semantics — treat it as "no legal transitions".
  return s && Array.isArray(s.transitions) ? s.transitions : [];
}

module.exports = { getPipelineConfig, getPipelineTransitions };
