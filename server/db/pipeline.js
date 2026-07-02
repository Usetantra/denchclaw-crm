'use strict';
// Shared pipeline config loader — used by crm.js and conversations.js.
// Caches per (companyId, pipelineKey) with a 60-second TTL so repeated
// requests within one minute pay zero DB cost.
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
    const entry = { stages, fetchedAt: Date.now() };
    _cache.set(cacheKey, entry);
    return entry;
  } catch (_e) { return null; }
}

function getPipelineTransitions(pipeline, currentStage) {
  const s = pipeline.stages.find(st => st.key === currentStage);
  return s ? (s.transitions || []) : [];
}

module.exports = { getPipelineConfig, getPipelineTransitions };
