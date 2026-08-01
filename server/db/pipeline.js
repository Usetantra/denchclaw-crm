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
      `SELECT stages, entity_type, funnel_type FROM crm_pipeline_configs
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
    const entry = Object.freeze({
      stages: Object.freeze(stages),
      // CP1: which object the stages live on ('contact' | 'deal') and whether
      // this config is funnel-typed (mode/transition gates apply). Legacy rows
      // predating migration 018 resolve to 'contact'/null via the defaults.
      entity_type: r.rows[0].entity_type || 'contact',
      funnel_type: r.rows[0].funnel_type || null,
      fetchedAt: Date.now(),
    });
    _cache.set(cacheKey, entry);
    return entry;
  } catch (_e) {
    // DB error: fall back to the stale cache entry if we ever had one.
    return cached || null;
  }
}

function getPipelineTransitions(pipeline, currentStage) {
  const s = findStage(pipeline, currentStage);
  // Guard malformed configs: a non-array `transitions` (e.g. a string) must not
  // reach `.includes()` substring semantics — treat it as "no legal transitions".
  return s && Array.isArray(s.transitions) ? s.transitions : [];
}

function findStage(pipeline, stageKey) {
  if (!pipeline || !Array.isArray(pipeline.stages)) return null;
  return pipeline.stages.find(st => st && st.key === stageKey) || null;
}

// mode:'manual' = only a human may set the stage. Absent mode ⇒ false ('auto'):
// legacy configs carry no mode field and their automated paths (e.g.
// conversations.js's auto-advance to 'responded') must keep working unchanged.
// Unknown stage ⇒ false (the transition checker rejects it separately).
function isManualStage(pipeline, stageKey) {
  const s = findStage(pipeline, stageKey);
  return !!s && s.mode === 'manual';
}

// ─── CP-Y: what AUTOMATION may set, which is not the negation of manual ─────
//
// `isManualStage` answers "does a person own this?" and returns false when no
// `mode` is declared. That reading is right for the UI glyph and wrong — badly
// wrong — as an automation gate, because the legacy `marketing`/`sales`
// pipelines declare no `mode` on any stage. So the gate opened, transition
// legality was the only remaining guard, and `onboarding → won` is legal: a
// sequence step marked a $50,000 deal **Won** with no human involved.
//
// This predicate is therefore NOT `!isManualStage`. It fails CLOSED and is
// opt-in: automation may set a stage only when someone explicitly declared it
// `auto`. Absent mode means a human owns it, because that is the safe reading
// when nobody has said otherwise — and on the one invariant that outranks
// everything in this system, the default has to be the safe one, not the
// convenient one.
//
// Both predicates exist on purpose and mean different things. `isManualStage`
// keeps its meaning for display; this one is the only thing an automated writer
// may ask.
function mayAutomationSetStage(pipeline, stageKey) {
  const s = findStage(pipeline, stageKey);
  return !!s && s.mode === 'auto';
}

// "terminal": true on a stage object = entering it closes the deal (sets
// closed_at) and the deal stops counting as the contact's active deal on that
// pipeline. Absent flag ⇒ false.
function isTerminalStage(pipeline, stageKey) {
  const s = findStage(pipeline, stageKey);
  return !!s && s.terminal === true;
}

function terminalStageKeys(pipeline) {
  if (!pipeline || !Array.isArray(pipeline.stages)) return [];
  return pipeline.stages.filter(s => s && s.terminal === true).map(s => s.key);
}

// CP1 decision 10 (the deal_stage side door): is this contact's current
// marketing_stage a member of a funnel-typed CONTACT pipeline? Returns the
// matching pipeline key, or null. Key list is cached per company (same 60s TTL
// as the config loader); on any DB error resolves to null — the legacy PATCH
// path then behaves exactly as before rather than failing the whole request.
const _funnelContactKeysCache = new Map();

async function findFunnelContactPipelineForStage(companyId, stageKey) {
  if (!companyId || !stageKey) return null;
  try {
    // A stage NAME alone can't say which pipeline a contact is in — this
    // helper infers it (marketing_stage stores no pipeline_key). If the name
    // is ALSO a legacy-marketing stage (e.g. a tenant adds a funnel stage
    // named 'nurture'), treat it as ambiguous and answer null: the caller
    // then keeps legacy PATCH behavior rather than locking every legacy
    // contact sitting at that marketing stage out of deal_stage writes.
    const legacyMarketing = await getPipelineConfig(companyId, 'marketing');
    if (legacyMarketing && findStage(legacyMarketing, stageKey)) return null;
    let cached = _funnelContactKeysCache.get(companyId);
    if (!cached || Date.now() - cached.fetchedAt >= TTL_MS) {
      const r = await query(
        `SELECT DISTINCT key FROM crm_pipeline_configs
         WHERE funnel_type IS NOT NULL AND entity_type = 'contact'
           AND (company_id = $1 OR company_id IS NULL)`,
        [companyId]
      );
      cached = { keys: r.rows.map(row => row.key), fetchedAt: Date.now() };
      _funnelContactKeysCache.set(companyId, cached);
    }
    for (const key of cached.keys) {
      const pipeline = await getPipelineConfig(companyId, key);
      if (pipeline && pipeline.funnel_type && findStage(pipeline, stageKey)) return key;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// CP1: pipeline override/create/delete must take effect on the gates
// immediately, not after the 60s TTL — a tenant that primes the cache with an
// /advance and then edits the pipeline would otherwise be gated by the stale
// config. pipelines.js calls invalidateCompany() after every config write;
// other modules with their own per-company caches (crm.js's
// getPipelineStages) register here so one call clears them all. The ticket's
// accepted 60s staleness applies only to a DELETED pipeline still validating
// on sequences.js (the loader can't tell "deleted" from "never existed"
// without a read; a delete invalidates too, so even that window closes in
// this process — the acceptance remains for OTHER server processes only).
const _invalidationHooks = [];
function onPipelineCacheInvalidate(fn) { _invalidationHooks.push(fn); }
function invalidateCompanyPipelines(companyId) {
  for (const k of [..._cache.keys()]) {
    if (k.startsWith(`${companyId}:`)) _cache.delete(k);
  }
  _funnelContactKeysCache.delete(companyId);
  for (const fn of _invalidationHooks) {
    try { fn(companyId); } catch (_e) { /* a listener must not break the write path */ }
  }
}

module.exports = {
  getPipelineConfig, getPipelineTransitions, findStage,
  isManualStage, mayAutomationSetStage, isTerminalStage, terminalStageKeys,
  findFunnelContactPipelineForStage,
  invalidateCompanyPipelines, onPipelineCacheInvalidate,
};
