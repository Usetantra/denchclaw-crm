'use strict';
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const contactDb = require('../db/models/contacts');
const { query } = require('../db/index');
const { getPipelineConfig, getPipelineTransitions } = require('../db/pipeline');

const { requireAuth, getUserCompanyId } = require('../middleware/auth');

// All CRM routes require X-Internal-Key
router.use(requireAuth);

// No-op validator — engines send well-formed data; validation at API boundary
const validate = () => (req, res, next) => next();

const LEAD_SCORES = { hot: 90, warm: 60, neutral: 30, cold: 10, negative: 0 };

const DEFAULT_DEAL_STAGES = ['lead', 'accepted', 'contacted', 'booked', 'qualified', 'no_show', 'unqualified', 'proposal', 'proposal_accepted', 'negotiation', 'onboarding', 'won', 'lost', 'nurture'];
const DEAL_STAGES = DEFAULT_DEAL_STAGES;
const SOURCES = ['expandi', 'instantly', 'linkedin', 'website', 'referral', 'manual', 'webinar', 'whatsapp', 'sms', 'content',
  'cold_email_prospect', 'cold_calendar_prospect', 'linkedin_prospect', 'linkedin_engagement',
  'facebook_engagement', 'twitter_engagement', 'instagram_engagement', 'paid_ads', 'social_engagement'];

const ENGAGEMENT_WEIGHTS = {
  email_opened: 2,
  email_clicked: 5,
  email_replied: 10,
  whatsapp_read: 3,
  whatsapp_replied: 10,
  sms_replied: 8,
  linkedin_connection_accepted: 5,
  linkedin_message_replied: 10,
  video_watched: 15,
  video_completed: 20,
  call_booked: 25,
  call_completed: 30,
  form_submitted: 15,
  registered: 15,
  cta_clicked: 10,
  proposal_viewed: 15,
  payment: 50,
};

const DEFAULT_STAGE_TRANSITIONS = {
  lead:              ['accepted', 'contacted', 'lost'],
  accepted:          ['contacted', 'lost'],
  contacted:         ['booked', 'unqualified', 'nurture', 'lost'],
  booked:            ['qualified', 'no_show', 'contacted'],
  qualified:         ['proposal', 'unqualified', 'nurture', 'lost'],
  no_show:           ['contacted', 'booked', 'lost'],
  unqualified:       ['nurture', 'lost'],
  proposal:          ['negotiation', 'nurture', 'lost'],
  proposal_accepted: ['negotiation', 'onboarding', 'lost'],
  negotiation:       ['onboarding', 'lost'],
  onboarding:        ['won', 'lost'],
  won:               [],
  lost:              ['accepted'],
  nurture:           ['contacted', 'lost'],
};

// ONE transition authority (E3.3): the legacy PATCH {deal_stage} path delegates
// to the same JSONB-config checker POST /advance uses (getPipelineConfig +
// getPipelineTransitions on the 'sales' pipeline). DEFAULT_STAGE_TRANSITIONS
// remains only as (a) the fallback when configs are absent/unreadable and
// (b) the source for legacy-only stages ('lead', 'proposal_accepted') that
// predate the two-pipeline model and don't exist in the seeded sales config.
// Returns undefined for stages unknown to both sources — the PATCH path then
// skips enforcement, matching the historical behavior (e.g. mirrored
// marketing-stage values in deal_stage are not gated here; /advance gates them).
async function resolveDealStageTransitions(companyId, fromStage) {
  try {
    const salesPipeline = await getPipelineConfig(companyId, 'sales');
    if (salesPipeline && salesPipeline.stages.some(s => s.key === fromStage)) {
      return getPipelineTransitions(salesPipeline, fromStage);
    }
  } catch (_e) { /* fall through to defaults */ }
  return DEFAULT_STAGE_TRANSITIONS[fromStage];
}

const _pipelineCache = new Map();
const PIPELINE_TTL_MS = 60 * 1000;

async function getPipelineStages(companyId) {
  const cached = _pipelineCache.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < PIPELINE_TTL_MS) return cached;

  let stages = DEFAULT_DEAL_STAGES.slice();
  let transitions = { ...DEFAULT_STAGE_TRANSITIONS };
  try {
    // Scope to the tenant's SALES config only. This keeps GET /pipeline/transitions
    // (the automation_core drift contract) canonical: a fresh tenant has no
    // company 'sales' row → falls back to DEFAULT_* below; custom deal pipelines
    // (other keys) can never leak into this endpoint.
    const r = await query(
      `SELECT stages FROM crm_pipeline_configs
        WHERE company_id = $1 AND key = 'sales'
        ORDER BY is_default DESC, created_at ASC LIMIT 1`,
      [companyId]
    );
    const rawStages = Array.isArray(r.rows[0]?.stages) ? r.rows[0].stages : null;
    if (rawStages && rawStages.length) {
      const keys = rawStages.map(s => s.key || s.id).filter(Boolean);
      if (keys.length) {
        stages = keys;
        const customTx = {};
        let any = false;
        for (const s of rawStages) {
          const k = s.key || s.id;
          if (k && Array.isArray(s.transitions)) { customTx[k] = s.transitions; any = true; }
        }
        if (any) transitions = { ...DEFAULT_STAGE_TRANSITIONS, ...customTx };
      }
    }
  } catch (_e) { /* fall back to defaults */ }

  const entry = { stages, transitions, fetchedAt: Date.now() };
  _pipelineCache.set(companyId, entry);
  return entry;
}

// getPipelineConfig and getPipelineTransitions live in server/db/pipeline.js
// (imported above) so conversations.js can share the same cached loader.

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadDeals(companyId, { limit = 500 } = {}) {
  if (!companyId) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 500);
  const { rows } = await query(
    `SELECT d.*, c.name AS contact_display_name FROM deals d
     LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.company_id = $1 ORDER BY d.created_at DESC LIMIT $2`,
    [companyId, cap]
  );
  return rows.map(r => {
    const meta = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) || {};
    return {
      id: r.id,
      title: r.title,
      contact_id: r.contact_id,
      contact_name: meta.contact_name || r.contact_display_name || '',
      value: parseFloat(r.value) || 0,
      stage: r.stage,
      pipeline_key: r.pipeline_key || null,
      notes: meta.notes || '',
      activity: meta.activity || [],
      companyId: r.company_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      closed_at: meta.closed_at || null,
    };
  });
}

function broadcast(req, message) {
  // no-op — no WebSocket in standalone CRM
}

async function triggerStageAutomation(contact, oldStage, newStage) {
  console.log(`[CRM] Stage automation: ${contact.name || contact.email} ${oldStage} → ${newStage}`);
  // Automation hooks (Telegram, task queue, etc.) can be added here later
}

// Sales `nurture` off-ramp returns the contact to MARKETING's nurture queue
// (per the pipeline spec: nurture from contacted/qualified/proposal → "Marketing's
// nurture queue"). Applied whenever a deal enters 'nurture' (via /advance or
// PATCH /deals/:id). Only fires when the marketing config allows the contact's
// current stage → nurture (e.g. mql→nurture, segmented→nurture); otherwise the
// contact's marketing stage is left untouched. Returns true when recycled.
async function recycleContactToMarketingNurture(contactId, companyId, { dealId = null, actor = 'system' } = {}) {
  if (!contactId) return false;
  try {
    const contact = await contactDb.getById(contactId, companyId);
    if (!contact) return false;
    const currentStage = contact.marketing_stage || 'sourced';
    if (currentStage === 'nurture') return false; // already there
    const pipeline = await getPipelineConfig(companyId, 'marketing');
    if (!pipeline) return false;
    const allowed = getPipelineTransitions(pipeline, currentStage);
    if (!allowed.includes('nurture')) return false;
    await query(
      `UPDATE contacts SET marketing_stage='nurture', deal_stage='nurture', updated_at=now()
       WHERE id=$1 AND company_id=$2`,
      [contactId, companyId]
    );
    await addContactActivity(contactId, companyId, {
      type: 'stage_change',
      message: `Marketing stage: ${currentStage} → nurture (recycled from sales nurture off-ramp)`,
      agent: actor,
      channel: null,
      data: { pipeline_key: 'marketing', from: currentStage, to: 'nurture', deal_id: dealId, reason: 'sales_nurture_offramp' },
    });
    return true;
  } catch (err) {
    console.error('[CRM] recycleContactToMarketingNurture error:', err.message);
    return false;
  }
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

// GET /api/crm/contacts
router.get('/contacts', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { score, source, search, stage, limit, offset, tags, phone } = req.query;
    const paginated = limit !== undefined || offset !== undefined;

    // tags overlap filter — accepts ?tags=a,b or repeated ?tags=a&tags=b.
    // Powers the send-side enrolled-contact query under CRM_BACKEND=api.
    const tagList = tags === undefined
      ? undefined
      : (Array.isArray(tags) ? tags : String(tags).split(',')).map(s => String(s).trim()).filter(Boolean);

    const contacts = await contactDb.list(companyId, {
      search,
      dealStage: stage,
      leadScore: score,
      source,
      ...(tagList && tagList.length ? { tags: tagList } : {}),
      ...(phone ? { phone } : {}),
      ...(paginated ? { limit, offset } : {}),
    });

    const stats = {
      total: contacts.length,
      hot: contacts.filter(c => (c.lead_score || c.leadScore) === 'hot').length,
      warm: contacts.filter(c => (c.lead_score || c.leadScore) === 'warm').length,
      neutral: contacts.filter(c => (c.lead_score || c.leadScore) === 'neutral').length,
      cold: contacts.filter(c => (c.lead_score || c.leadScore) === 'cold').length,
      by_source: {},
      by_stage: {}
    };
    contacts.forEach(c => {
      const src = c.source || 'unknown';
      const stg = c.deal_stage || c.dealStage || 'lead';
      stats.by_source[src] = (stats.by_source[src] || 0) + 1;
      stats.by_stage[stg] = (stats.by_stage[stg] || 0) + 1;
    });

    if (paginated) {
      const lim = Math.min(parseInt(limit, 10) || 50, 500);
      const off = Math.max(parseInt(offset, 10) || 0, 0);
      const aggregate = await contactDb.getStats(companyId).catch(() => null);
      return res.json({
        data: contacts,
        contacts,
        total: aggregate?.totalContacts ?? contacts.length,
        limit: lim,
        offset: off,
        stats,
      });
    }
    res.json({ total: contacts.length, contacts, stats });
  } catch (err) {
    console.error('[CRM] GET /contacts error:', err.message);
    res.status(500).json({ error: 'failed to load contacts' });
  }
});

// POST /api/crm/contacts
router.post('/contacts', validate(), async (req, res) => {
  try {
    const { name, email, phone, company, title, linkedin_url, source, lead_score, notes, metadata, tags,
      utmSource, utmMedium, utmCampaign, utmContent,
      whatsappOptIn, smsOptIn,
      website, location, position } = req.body;
    if (!name && !email) return res.status(400).json({ error: 'name or email required' });

    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    let existing = null;
    if (email) {
      existing = await contactDb.getByEmail(email, companyId);
    }
    // LinkedIn fallback only when the incoming record has NO email — email is
    // the authoritative dedupe key; distinct emails never merge (see
    // findOrCreateContact below for the same rule).
    if (!existing && !email && linkedin_url) {
      const allContacts = await contactDb.list(companyId, { search: linkedin_url });
      existing = allContacts.find(c => c.linkedin_url && c.linkedin_url.toLowerCase() === linkedin_url.toLowerCase()) || null;
    }

    if (existing) {
      const updateData = {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(company && { company_name: company }),
        ...(title && { title }),
        ...(linkedin_url && { linkedin_url }),
        ...(lead_score && { lead_score }),
      };
      const updated = await contactDb.update(existing.id, updateData);
      if (notes) {
        await contactDb.addActivity(existing.id, { type: 'note', message: notes });
      }
      broadcast(req, { type: 'contact_updated', contact: updated || existing });
      return res.json(updated || existing);
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid email format' });
    }

    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const contactData = {
      id: uuidv4(),
      name: name || '',
      firstName,
      lastName,
      email: email || '',
      phone: phone || '',
      company: company || '',
      company_id: companyId,
      title: title || position || '',
      position: position || title || '',
      linkedin_url: linkedin_url || '',
      website: website || '',
      location: location || '',
      source: SOURCES.includes(source) ? source : 'manual',
      lead_score: Object.keys(LEAD_SCORES).includes(lead_score) ? lead_score : 'neutral',
      lead_score_numeric: LEAD_SCORES[lead_score] || 30,
      deal_stage: 'lead',
      deal_value: 0,
      engagementScore: 0,
      engagement_score: 0,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      whatsappOptIn: whatsappOptIn === true,
      smsOptIn: smsOptIn === true,
      isUnsubscribed: false,
      tags: Array.isArray(tags) ? tags : [],
      metadata: metadata || {},
      activity: [
        { type: 'created', message: `Contact created from ${source || 'manual'}`, timestamp: new Date().toISOString() }
      ],
      last_contacted: null,
      next_follow_up: null
    };

    const contact = await contactDb.create(contactData);
    broadcast(req, { type: 'contact_created', contact });

    res.status(201).json(contact);
  } catch (err) {
    console.error('[CRM] POST /contacts error:', err.message);
    res.status(500).json({ error: 'failed to create contact' });
  }
});

// GET /api/crm/contacts/follow-ups — MUST be before :id route
router.get('/contacts/follow-ups', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contacts = await contactDb.list(companyId, {});
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const needsFollowUp = contacts.filter(c => {
      if (c.deal_stage === 'won' || c.deal_stage === 'lost') return false;
      if (c.next_follow_up && new Date(c.next_follow_up) <= now) return true;
      if ((c.lead_score === 'hot' || c.lead_score === 'warm') && c.last_contacted) {
        const daysSince = (now - new Date(c.last_contacted)) / 86400000;
        if (c.lead_score === 'hot' && daysSince >= 2) return true;
        if (c.lead_score === 'warm' && daysSince >= 5) return true;
      }
      if (!c.last_contacted || new Date(c.last_contacted) < sevenDaysAgo) return true;
      return false;
    }).sort((a, b) => {
      const scoreOrder = { hot: 0, warm: 1, neutral: 2, cold: 3 };
      return (scoreOrder[a.lead_score] || 3) - (scoreOrder[b.lead_score] || 3);
    });
    res.json({ total: needsFollowUp.length, contacts: needsFollowUp });
  } catch (err) {
    console.error('[CRM] GET /contacts/follow-ups error:', err.message);
    res.status(500).json({ error: 'failed to load follow-ups' });
  }
});

// GET /api/crm/contacts/export — MUST be before :id route (else ':id' captures 'export')
router.get('/contacts/export', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contacts = await contactDb.list(companyId, {});
    const { format } = req.query;
    if (format === 'csv') {
      const csvSafe = (val) => {
        const s = String(val || '').replace(/"/g, '""');
        if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
        return s;
      };
      const headers = 'name,email,phone,company,source,lead_score,deal_stage,engagementScore,utmSource,tags,created_at';
      const rows = contacts.map(c =>
        `"${csvSafe(c.name)}","${csvSafe(c.email)}","${csvSafe(c.phone)}","${csvSafe(c.company_name)}","${csvSafe(c.source)}","${csvSafe(c.lead_score)}","${csvSafe(c.deal_stage)}",${c.lead_score_numeric || 0},"${csvSafe(c.utm_source)}","${csvSafe((c.tags || []).join(';'))}","${csvSafe(c.created_at)}"`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.send([headers, ...rows].join('\n'));
    } else {
      res.json({ total: contacts.length, contacts });
    }
  } catch (err) {
    console.error('[CRM] GET /contacts/export error:', err.message);
    res.status(500).json({ error: 'failed to export contacts' });
  }
});

// GET /api/crm/contacts/:id
router.get('/contacts/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    res.json(contact);
  } catch (err) {
    console.error('[CRM] GET /contacts/:id error:', err.message);
    res.status(500).json({ error: 'failed to load contact' });
  }
});

// POST /api/crm/contacts/bulk — { action:'delete'|'tag', ids:[], value? }
// Stage changes are intentionally NOT bulk-editable here: a contact's pipeline
// position is governed by the marketing/sales advance state machines
// (POST /contacts/:id/advance, PATCH /deals/:id), not a free-set on the list.
router.post('/contacts/bulk', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { action, ids, value } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });

    let affected = 0;
    if (action === 'delete') {
      const r = await query('DELETE FROM contacts WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, ids]);
      affected = r.rowCount;
    } else if (action === 'tag') {
      if (!value) return res.status(400).json({ error: 'value (tag) required' });
      const r = await query(
        `UPDATE contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $1::text[]))),
                updated_at = NOW() WHERE company_id = $2 AND id = ANY($3::uuid[])`,
        [[value], companyId, ids]
      );
      affected = r.rowCount;
    } else {
      return res.status(400).json({ error: `unknown action: ${action}` });
    }
    res.json({ ok: true, affected });
  } catch (err) {
    console.error('[CRM] POST /contacts/bulk error:', err.message);
    res.status(500).json({ error: 'bulk action failed' });
  }
});

// PATCH /api/crm/contacts/:id
router.patch('/contacts/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const existing = await contactDb.getById(req.params.id, companyId);
    if (!existing) return res.status(404).json({ error: 'contact not found' });

    const updates = req.body;

    const allowed = ['name', 'email', 'phone', 'company', 'title', 'linkedin_url', 'source',
                      'lead_score', 'deal_stage', 'deal_value', 'tags', 'next_follow_up', 'last_contacted',
                      'company_name'];
    const updateData = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) updateData[key] = updates[key];
    }
    // Map 'company' → 'company_name' (automation_core sends 'company', DB column is 'company_name')
    if (updateData.company !== undefined && updateData.company_name === undefined) {
      updateData.company_name = updateData.company;
    }
    delete updateData.company;

    if (updates.lead_score) {
      updateData.lead_score_numeric = LEAD_SCORES[updates.lead_score] || 30;
    }

    if (updates.activity_message) {
      await contactDb.addActivity(req.params.id, {
        type: updates.activity_type || 'update',
        message: updates.activity_message,
        agent: updates.agent || 'system',
        data: updates.activity_data || null
      }, companyId);
    }

    if (updates.deal_stage && updates.deal_stage !== existing.deal_stage) {
      const oldStage = existing.deal_stage || 'lead';
      const newStage = updates.deal_stage;

      // Config-driven check — same authority as POST /advance (E3.3).
      const allowedTransitions = await resolveDealStageTransitions(companyId, oldStage);
      if (allowedTransitions && !allowedTransitions.includes(newStage)) {
        return res.status(400).json({
          error: `Invalid stage transition: ${oldStage} → ${newStage}`,
          allowed_transitions: allowedTransitions,
          current_stage: oldStage,
        });
      }

      await contactDb.addActivity(req.params.id, {
        type: 'stage_change',
        message: `Stage: ${oldStage} → ${newStage}`,
      }, companyId);

      triggerStageAutomation({ ...existing, ...updateData }, oldStage, newStage).catch(() => {});
    }

    const contact = await contactDb.update(req.params.id, updateData, companyId);
    broadcast(req, { type: 'contact_updated', contact: contact || existing });

    res.json(contact || existing);
  } catch (err) {
    console.error('[CRM] PATCH /contacts/:id error:', err.message);
    res.status(500).json({ error: 'failed to update contact' });
  }
});

// GET /api/crm/contacts/:id/activity
router.get('/contacts/:id/activity', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const limit = parseInt(req.query.limit) || 50;
    const activity = await contactDb.getActivity(req.params.id, limit, companyId);
    res.json({ activity });
  } catch (err) {
    console.error('[CRM] GET /contacts/:id/activity error:', err.message);
    res.status(500).json({ error: 'failed to load activity' });
  }
});

// POST /api/crm/contacts/:id/activity
router.post('/contacts/:id/activity', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const { type, message, agent, data, channel } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const entry = {
      type: type || 'note',
      message,
      agent: agent || 'system',
      channel: channel || null,
      timestamp: new Date().toISOString(),
      data: data || null
    };

    await contactDb.addActivity(req.params.id, entry, companyId);

    const SCORE_WEIGHTS = { email_opened: 2, email_clicked: 5, email_replied: 10, call_booked: 25, call_completed: 30, form_submitted: 15, payment: 50 };
    const weight = SCORE_WEIGHTS[entry.type] || 1;
    await query(`UPDATE contacts SET lead_score_numeric = LEAST(COALESCE(lead_score_numeric, 0) + $1, 100) WHERE id = $2 AND company_id = $3`, [weight, req.params.id, companyId]);

    broadcast(req, { type: 'contact_activity', contact_id: req.params.id, entry });
    res.json(entry);
  } catch (err) {
    console.error('[CRM] POST /contacts/:id/activity error:', err.message);
    res.status(500).json({ error: 'failed to add activity' });
  }
});

// ─── STAGE ADVANCE (pipeline-aware, transition-enforcing) ────────────────────

// POST /api/crm/contacts/:id/advance
// Advances a contact through a named pipeline. Validates against the pipeline's
// allowed_transitions; rejects illegal jumps with 409. Idempotent if already at stage.
// pipeline_key='marketing' → updates contacts.marketing_stage (mirrors to deal_stage)
// pipeline_key='sales'     → updates the contact's active deals row
router.post('/contacts/:id/advance', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    const { pipeline_key, stage, reason, actor } = req.body;
    if (!pipeline_key || !stage) return res.status(400).json({ error: 'pipeline_key and stage required' });

    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const pipeline = await getPipelineConfig(companyId, pipeline_key);
    if (!pipeline) return res.status(404).json({ error: `Pipeline '${pipeline_key}' not configured` });

    if (pipeline_key === 'marketing') {
      const currentStage = contact.marketing_stage || 'sourced';
      if (currentStage === stage) {
        return res.json({ contact_id: contact.id, pipeline_key, stage, previous: currentStage, changed: false });
      }

      const allowed = getPipelineTransitions(pipeline, currentStage);
      if (!allowed.includes(stage)) {
        return res.status(409).json({ error: 'Illegal stage transition', current: currentStage, requested: stage, allowed });
      }

      // Update both marketing_stage and the legacy deal_stage mirror
      await query(
        `UPDATE contacts SET marketing_stage=$1, deal_stage=$1, updated_at=now() WHERE id=$2 AND company_id=$3`,
        [stage, contact.id, companyId]
      );

      await addContactActivity(contact.id, companyId, {
        type: 'stage_change',
        message: `Marketing stage: ${currentStage} → ${stage}${reason ? ' (' + reason + ')' : ''}`,
        agent: actor || 'system',
        channel: null,
        data: { pipeline_key, from: currentStage, to: stage, reason: reason || null },
      });

      return res.json({ contact_id: contact.id, pipeline_key, stage, previous: currentStage, changed: true });
    }

    if (pipeline_key === 'sales') {
      const dealRes = await query(
        `SELECT * FROM deals WHERE contact_id=$1 AND company_id=$2 AND stage NOT IN ('won','lost')
         ORDER BY created_at DESC LIMIT 1`,
        [contact.id, companyId]
      );
      const deal = dealRes.rows[0];
      if (!deal) return res.status(404).json({ error: 'No active sales deal found for this contact' });

      const currentStage = deal.stage;
      if (currentStage === stage) {
        return res.json({ contact_id: contact.id, deal_id: deal.id, pipeline_key, stage, previous: currentStage, changed: false });
      }

      const allowed = getPipelineTransitions(pipeline, currentStage);
      if (!allowed.includes(stage)) {
        return res.status(409).json({ error: 'Illegal stage transition', current: currentStage, requested: stage, allowed });
      }

      const meta = (typeof deal.metadata === 'string' ? JSON.parse(deal.metadata) : deal.metadata) || {};
      const activity = meta.activity || [];
      activity.push({ type: 'stage_change', message: `Stage: ${currentStage} → ${stage}`, timestamp: new Date().toISOString(), actor: actor || 'system' });
      if (['won', 'lost'].includes(stage)) meta.closed_at = new Date().toISOString();

      await query(
        `UPDATE deals SET stage=$1, metadata=$2, updated_at=now() WHERE id=$3 AND company_id=$4`,
        [stage, JSON.stringify({ ...meta, activity }), deal.id, companyId]
      );

      await addContactActivity(contact.id, companyId, {
        type: 'stage_change',
        message: `Sales stage: ${currentStage} → ${stage}${reason ? ' (' + reason + ')' : ''}`,
        agent: actor || 'system',
        channel: null,
        data: { pipeline_key, deal_id: deal.id, from: currentStage, to: stage, reason: reason || null },
      });

      // Sales nurture off-ramp → recycle the contact to marketing's nurture queue.
      let marketing_recycled;
      if (stage === 'nurture') {
        marketing_recycled = await recycleContactToMarketingNurture(contact.id, companyId, { dealId: deal.id, actor: actor || 'system' });
      }

      return res.json({
        contact_id: contact.id, deal_id: deal.id, pipeline_key, stage, previous: currentStage, changed: true,
        ...(marketing_recycled !== undefined ? { marketing_recycled } : {}),
      });
    }

    return res.status(400).json({ error: `Unknown pipeline_key '${pipeline_key}' — use 'marketing' or 'sales'` });
  } catch (err) {
    console.error('[CRM] POST /contacts/:id/advance error:', err.message);
    res.status(500).json({ error: 'advance failed' });
  }
});

// ─── DEALS / PIPELINE ────────────────────────────────────────────────────────

// GET /api/crm/deals
router.get('/deals', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req) || null;
    const deals = await loadDeals(companyId);
    const { stage, search } = req.query;

    let filtered = deals;
    if (stage) filtered = filtered.filter(d => d.stage === stage);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(d =>
        (d.title || '').toLowerCase().includes(q) ||
        (d.contact_name || '').toLowerCase().includes(q)
      );
    }

    const pipeline = {};
    DEAL_STAGES.forEach(s => { pipeline[s] = deals.filter(d => d.stage === s); });

    const totalValue = deals.filter(d => d.stage !== 'lost').reduce((s, d) => s + (d.value || 0), 0);
    const wonValue = deals.filter(d => d.stage === 'won').reduce((s, d) => s + (d.value || 0), 0);

    res.json({ total: filtered.length, deals: filtered, pipeline, stats: { totalValue, wonValue } });
  } catch (err) {
    console.error('[CRM] GET /deals error:', err.message);
    res.status(500).json({ error: 'failed to load deals' });
  }
});

// POST /api/crm/deals
router.post('/deals', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { title, contact_id, contact_name, value, stage, notes } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    // Which pipeline does this deal live in? Default (null) = built-in sales.
    const pipelineKey = req.body.pipeline_key && req.body.pipeline_key !== 'sales' ? req.body.pipeline_key : null;
    let initialStage;
    if (pipelineKey) {
      const cfg = await getPipelineConfig(companyId, pipelineKey);
      const keys = cfg ? cfg.stages.map(s => s.key) : [];
      initialStage = (stage && keys.includes(stage)) ? stage : (keys[0] || 'lead');
    } else {
      initialStage = DEAL_STAGES.includes(stage) ? stage : 'lead';
    }

    // Link (or create) a real contact so the opportunity also shows up in
    // Contacts, Companies, and the dashboard — not just on the deals board.
    let dealContactId = contact_id || null;
    let dealContactName = contact_name || '';
    const cEmail = (req.body.contact_email || '').trim() || null;
    const cCompany = (req.body.company || '').trim() || null;
    if (!dealContactId && (cEmail || dealContactName)) {
      try {
        const { contact } = await findOrCreateContact(cEmail, {
          company_id: companyId,
          name: dealContactName || undefined,
          company: cCompany,
          source: 'manual',
        });
        if (contact) { dealContactId = contact.id; dealContactName = contact.name || dealContactName; }
      } catch (e) { console.error('[CRM] deal→contact link failed:', e.message); }
    }
    // Ensure a company record exists so it appears on the Companies tab too.
    if (cCompany) {
      try {
        await query(
          `INSERT INTO companies (company_id, name)
           SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM companies WHERE company_id = $1 AND lower(name) = lower($2))`,
          [companyId, cCompany]
        );
      } catch (e) { /* companies table optional */ }
    }

    const deal = {
      id: uuidv4(),
      title,
      contact_id: dealContactId,
      contact_name: dealContactName,
      value: value || 0,
      stage: initialStage,
      pipeline_key: pipelineKey,
      notes: notes || '',
      activity: [
        { type: 'created', message: 'Deal created', timestamp: new Date().toISOString() }
      ],
      companyId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: null
    };

    await query(
      `INSERT INTO deals (id, company_id, contact_id, title, value, stage, pipeline_key, source, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
      [deal.id, deal.companyId, deal.contact_id, deal.title, deal.value, deal.stage, deal.pipeline_key, 'crm',
       JSON.stringify({ contact_name: deal.contact_name, notes: deal.notes, activity: deal.activity })]
    );

    broadcast(req, { type: 'deal_created', deal });
    res.status(201).json(deal);
  } catch (err) {
    console.error('[CRM] POST /deals error:', err.message);
    res.status(500).json({ error: 'failed to create deal' });
  }
});

// GET /api/crm/deals/:id
router.get('/deals/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });
    const row = rows[0];
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
    res.json({
      id: row.id, title: row.title, contact_id: row.contact_id,
      contact_name: meta.contact_name || '', value: parseFloat(row.value) || 0,
      stage: row.stage, notes: meta.notes || '', activity: meta.activity || [],
      companyId: row.company_id, created_at: row.created_at, updated_at: row.updated_at,
      closed_at: meta.closed_at || null,
    });
  } catch (err) {
    console.error('[CRM] GET /deals/:id error:', err.message);
    res.status(500).json({ error: 'failed to load deal' });
  }
});

// PATCH /api/crm/deals/:id
router.patch('/deals/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });

    const row = rows[0];
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
    const deal = {
      id: row.id, title: row.title, contact_id: row.contact_id,
      contact_name: meta.contact_name || '', value: parseFloat(row.value) || 0,
      stage: row.stage, pipeline_key: row.pipeline_key || null,
      notes: meta.notes || '', activity: meta.activity || [],
      companyId: row.company_id, created_at: row.created_at, updated_at: row.updated_at,
      closed_at: meta.closed_at || null,
    };

    const updates = req.body;

    if (updates.title) deal.title = updates.title;
    if (updates.value !== undefined) deal.value = updates.value;
    if (updates.notes) deal.notes = updates.notes;
    if (updates.contact_id) deal.contact_id = updates.contact_id;
    if (updates.contact_name) deal.contact_name = updates.contact_name;
    // Move a deal to a different pipeline (null / 'sales' => built-in sales).
    if (updates.pipeline_key !== undefined) {
      deal.pipeline_key = updates.pipeline_key && updates.pipeline_key !== 'sales' ? updates.pipeline_key : null;
    }

    if (updates.stage && updates.stage !== deal.stage) {
      const oldStage = deal.stage;
      const newStage = updates.stage;

      // Only the built-in sales pipeline gates transitions (same source as
      // /advance, preserving the automation contract). Custom pipelines move
      // freely — the operator designed them.
      if (!deal.pipeline_key) {
        const salesPipeline = await getPipelineConfig(companyId, 'sales');
        if (salesPipeline) {
          const allowed = getPipelineTransitions(salesPipeline, oldStage);
          if (!allowed.includes(newStage)) {
            return res.status(409).json({
              error: `Invalid stage transition: ${oldStage} → ${newStage}`,
              allowed_transitions: allowed,
              current_stage: oldStage,
            });
          }
        }
      }

      deal.activity.push({
        type: 'stage_change',
        message: `Stage: ${oldStage} → ${newStage}`,
        timestamp: new Date().toISOString()
      });
      deal.stage = newStage;
      if (newStage === 'won' || newStage === 'lost') {
        deal.closed_at = new Date().toISOString();
      }
      if (deal.contact_id) {
        // Cross-write is company-scoped: addActivity only writes if the contact
        // belongs to this deal's company (no-op otherwise), so a deal cannot
        // annotate a contact in another tenant.
        await contactDb.addActivity(deal.contact_id, {
          type: 'deal_stage_change',
          message: `Deal "${deal.title}" moved from ${oldStage} to ${newStage}`,
          channel: 'crm',
          data: { deal_id: deal.id, old_stage: oldStage, new_stage: newStage, value: deal.value }
        }, companyId);
        // Sales nurture off-ramp → recycle the contact to marketing's nurture queue.
        if (newStage === 'nurture') {
          await recycleContactToMarketingNurture(deal.contact_id, companyId, { dealId: deal.id });
        }
      }
    }

    deal.updated_at = new Date().toISOString();

    await query(
      `UPDATE deals SET title=$1, value=$2, stage=$3, contact_id=$4, pipeline_key=$5, metadata=$6, updated_at=NOW() WHERE id=$7 AND company_id=$8`,
      [deal.title, deal.value, deal.stage, deal.contact_id, deal.pipeline_key,
       JSON.stringify({ contact_name: deal.contact_name, notes: deal.notes, activity: deal.activity, closed_at: deal.closed_at }),
       deal.id, companyId]
    );

    broadcast(req, { type: 'deal_updated', deal });
    res.json(deal);
  } catch (err) {
    console.error('[CRM] PATCH /deals/:id error:', err.message);
    res.status(500).json({ error: 'failed to update deal' });
  }
});

// GET /api/crm/stats
// Reads from targeted COUNT queries + rollup table — no full-table scans.
router.get('/stats', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    const [contactSummary, contactBySource, contactByStage,
           dealSummary, dealByStage, campaignSummary] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int                                                        AS total,
           COUNT(*) FILTER (WHERE lead_score = 'hot')::int                     AS hot,
           COUNT(*) FILTER (WHERE lead_score = 'warm')::int                    AS warm,
           COUNT(*) FILTER (WHERE created_at > now() - interval '1 day')::int  AS new_today,
           COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_this_week
         FROM contacts WHERE company_id = $1 AND deleted_at IS NULL`,
        [companyId]
      ),
      query(
        `SELECT source, COUNT(*)::int AS count FROM contacts
         WHERE company_id = $1 AND deleted_at IS NULL GROUP BY source`,
        [companyId]
      ),
      query(
        `SELECT marketing_stage AS stage, COUNT(*)::int AS count FROM contacts
         WHERE company_id = $1 AND deleted_at IS NULL GROUP BY marketing_stage`,
        [companyId]
      ),
      query(
        `SELECT
           COUNT(*)::int                                                             AS total,
           COUNT(*) FILTER (WHERE stage NOT IN ('won','lost'))::int                 AS open,
           COUNT(*) FILTER (WHERE stage = 'won')::int                               AS won,
           COUNT(*) FILTER (WHERE stage = 'lost')::int                              AS lost,
           COALESCE(SUM(value) FILTER (WHERE stage NOT IN ('won','lost')), 0)::numeric AS pipeline_value,
           COALESCE(SUM(value) FILTER (WHERE stage = 'won'), 0)::numeric            AS won_value
         FROM deals WHERE company_id = $1`,
        [companyId]
      ),
      query(
        `SELECT stage, COUNT(*)::int AS count FROM deals
         WHERE company_id = $1 GROUP BY stage`,
        [companyId]
      ),
      query(
        `SELECT
           COALESCE(SUM(sends), 0)::int   AS total_sends,
           COALESCE(SUM(opens), 0)::int   AS total_opens,
           COALESCE(SUM(replies), 0)::int AS total_replies,
           COALESCE(SUM(bounces), 0)::int AS total_bounces,
           COALESCE(SUM(mql_count), 0)::int AS total_mqls
         FROM campaign_event_rollups
         WHERE company_id = $1 AND day >= CURRENT_DATE - interval '30 days'`,
        [companyId]
      ),
    ]);

    const cs = contactSummary.rows[0] || {};
    const ds = dealSummary.rows[0] || {};

    res.json({
      contacts: {
        total: cs.total || 0,
        hot: cs.hot || 0,
        warm: cs.warm || 0,
        new_today: cs.new_today || 0,
        new_this_week: cs.new_this_week || 0,
        by_source: contactBySource.rows.reduce((a, r) => { a[r.source || 'unknown'] = r.count; return a; }, {}),
        by_stage: contactByStage.rows.reduce((a, r) => { a[r.stage || 'unknown'] = r.count; return a; }, {}),
      },
      deals: {
        total: ds.total || 0,
        open: ds.open || 0,
        won: ds.won || 0,
        lost: ds.lost || 0,
        pipeline_value: parseFloat(ds.pipeline_value) || 0,
        won_value: parseFloat(ds.won_value) || 0,
        by_stage: dealByStage.rows.reduce((a, r) => { a[r.stage] = r.count; return a; }, {}),
      },
      campaign_last_30d: campaignSummary.rows[0] || {},
    });
  } catch (err) {
    console.error('[CRM] GET /stats error:', err.message);
    res.status(500).json({ error: 'failed to load stats' });
  }
});

// PATCH /api/crm/contacts/:id/follow-up
router.patch('/contacts/:id/follow-up', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const existing = await contactDb.getById(req.params.id, companyId);
    if (!existing) return res.status(404).json({ error: 'contact not found' });

    const { next_follow_up, action_taken, notes } = req.body;

    const updateData = { last_contacted: new Date().toISOString() };
    if (next_follow_up) updateData.next_follow_up = next_follow_up;

    await contactDb.addActivity(req.params.id, {
      type: 'follow_up',
      message: action_taken || 'Follow-up completed',
      agent: req.body.agent || 'human',
      data: { notes, next_follow_up }
    }, companyId);

    const contact = await contactDb.update(req.params.id, updateData, companyId);
    broadcast(req, { type: 'contact_updated', contact: contact || existing });
    res.json(contact || existing);
  } catch (err) {
    console.error('[CRM] PATCH /contacts/:id/follow-up error:', err.message);
    res.status(500).json({ error: 'failed to update follow-up' });
  }
});

// GET /api/crm/activity/recent
router.get('/activity/recent', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const limit = parseInt(req.query.limit) || 20;

    const { rows } = await query(
      `SELECT ca.*, c.name AS contact_name, c.company_name AS contact_company, c.lead_score
       FROM contact_activity ca
       JOIN contacts c ON c.id = ca.contact_id
       WHERE ca.company_id = $1
       ORDER BY ca.created_at DESC LIMIT $2`,
      [companyId, limit]
    );
    res.json({ activities: rows });
  } catch (err) {
    console.error('[CRM] GET /activity/recent error:', err.message);
    res.status(500).json({ error: 'failed to load recent activity' });
  }
});

// GET /api/crm/pipeline — pipeline-aware via ?pipeline_key=marketing|sales
// Omitting pipeline_key returns the legacy flat view (backward-compat).
router.get('/pipeline', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const pipelineKey = req.query.pipeline_key;

    if (pipelineKey === 'marketing') {
      const pipelineConfig = await getPipelineConfig(companyId, 'marketing');
      const stages = pipelineConfig
        ? pipelineConfig.stages.map(s => s.key)
        : ['sourced','enriched','segmented','queued','engaged','responded','mql','nurture','suppressed'];
      const contacts = await contactDb.list(companyId, {});
      const pipeline = {};
      stages.forEach(stage => {
        const sc = contacts.filter(c => (c.marketing_stage || c.deal_stage) === stage);
        pipeline[stage] = {
          count: sc.length,
          contacts: sc.map(c => ({
            id: c.id, name: c.name, company: c.company_name, lead_score: c.lead_score,
            tags: c.tags, last_contacted: c.last_contacted, linkedin_url: c.linkedin_url,
            source: c.source, created_at: c.created_at,
          }))
        };
      });
      return res.json({ pipeline_key: 'marketing', pipeline });
    }

    if (pipelineKey === 'sales') {
      const pipelineConfig = await getPipelineConfig(companyId, 'sales');
      const stages = pipelineConfig
        ? pipelineConfig.stages.map(s => s.key)
        : ['accepted','contacted','booked','qualified','proposal','negotiation','onboarding','won','lost','no_show','unqualified','nurture'];
      // Sales owns deals not assigned to a custom pipeline (pipeline_key null or 'sales').
      const deals = (await loadDeals(companyId)).filter(d => !d.pipeline_key || d.pipeline_key === 'sales');
      const pipeline = {};
      stages.forEach(stage => {
        const sd = deals.filter(d => d.stage === stage);
        pipeline[stage] = {
          count: sd.length,
          value: sd.reduce((s, d) => s + (d.value || 0), 0),
          deals: sd,
        };
      });
      return res.json({ pipeline_key: 'sales', pipeline });
    }

    // Custom deal pipeline (any company-defined key other than marketing/sales).
    if (pipelineKey) {
      const cfg = await getPipelineConfig(companyId, pipelineKey);
      if (!cfg) return res.status(404).json({ error: 'pipeline not found' });
      const stages = cfg.stages.map(s => s.key);
      const deals = (await loadDeals(companyId)).filter(d => d.pipeline_key === pipelineKey);
      const pipeline = {};
      stages.forEach(stage => {
        const sd = deals.filter(d => d.stage === stage);
        pipeline[stage] = { count: sd.length, value: sd.reduce((s, d) => s + (d.value || 0), 0), deals: sd };
      });
      return res.json({ pipeline_key: pipelineKey, pipeline });
    }

    // Legacy flat view — no pipeline_key (backward-compat for existing consumers)
    const contacts = await contactDb.list(companyId, {});
    const pipeline = {};
    DEAL_STAGES.forEach(stage => {
      const stageContacts = contacts.filter(c => (c.deal_stage || c.dealStage) === stage);
      pipeline[stage] = {
        count: stageContacts.length,
        value: stageContacts.reduce((s, c) => s + (c.deal_value || c.dealValue || 0), 0),
        contacts: stageContacts.map(c => ({
          id: c.id, name: c.name, company: c.company_name, lead_score: c.lead_score || c.leadScore,
          deal_value: c.deal_value || c.dealValue, last_contacted: c.last_contacted,
          linkedin_url: c.linkedin_url, source: c.source
        }))
      };
    });
    res.json({ pipeline });
  } catch (err) {
    console.error('[CRM] GET /pipeline error:', err.message);
    res.status(500).json({ error: 'failed to load pipeline' });
  }
});

// GET /api/crm/pipeline/transitions — the authoritative stage state machine.
// automation_core mirrors this map for its postgres backend and asserts equality
// against this endpoint in CI (drift detector). CRM is the single source of truth.
router.get('/pipeline/transitions', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { stages, transitions } = await getPipelineStages(companyId);
    res.json({ stages, transitions });
  } catch (err) {
    console.error('[CRM] GET /pipeline/transitions error:', err.message);
    res.status(500).json({ error: 'failed to load transitions' });
  }
});

// ───────── PROSPECT INBOX (cross-engine handoff) ──────────────────────────────
const HANDOFF_STATUSES = ['pending', 'claimed', 'enrolled', 'done'];

// POST /api/crm/prospect-inbox — enqueue a handoff (idempotent on contact+target;
// re-enqueue of a 'done' row resets it to pending so a contact can be re-handed-off).
router.post('/prospect-inbox', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, target_engine = null, source_engine = null, suggested_campaign = null, metadata = {} } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

    // Tenant guard: the contact must belong to the caller's company.
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const resetBody = `
      source_engine      = COALESCE(EXCLUDED.source_engine, prospect_inbox.source_engine),
      suggested_campaign = COALESCE(EXCLUDED.suggested_campaign, prospect_inbox.suggested_campaign),
      metadata           = prospect_inbox.metadata || EXCLUDED.metadata,
      status     = CASE WHEN prospect_inbox.status = 'done' THEN 'pending' ELSE prospect_inbox.status END,
      claimed_by = CASE WHEN prospect_inbox.status = 'done' THEN NULL      ELSE prospect_inbox.claimed_by END,
      claimed_at = CASE WHEN prospect_inbox.status = 'done' THEN NULL      ELSE prospect_inbox.claimed_at END,
      created_at = CASE WHEN prospect_inbox.status = 'done' THEN now()     ELSE prospect_inbox.created_at END`;

    let row;
    if (target_engine === null) {
      // Broadcast: arbiter is the partial unique index on (contact_id) WHERE target_engine IS NULL.
      const r = await query(
        `INSERT INTO prospect_inbox (company_id, contact_id, source_engine, target_engine, suggested_campaign, metadata)
         VALUES ($1,$2,$3,NULL,$4,$5)
         ON CONFLICT (contact_id) WHERE target_engine IS NULL
         DO UPDATE SET ${resetBody} RETURNING *`,
        [companyId, contact_id, source_engine, suggested_campaign, JSON.stringify(metadata || {})]
      );
      row = r.rows[0];
    } else {
      const r = await query(
        `INSERT INTO prospect_inbox (company_id, contact_id, source_engine, target_engine, suggested_campaign, metadata)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (contact_id, target_engine) WHERE target_engine IS NOT NULL
         DO UPDATE SET ${resetBody} RETURNING *`,
        [companyId, contact_id, source_engine, target_engine, suggested_campaign, JSON.stringify(metadata || {})]
      );
      row = r.rows[0];
    }
    broadcast(req, { type: 'prospect_enqueued', row });
    res.status(201).json(row);
  } catch (err) {
    console.error('[CRM] POST /prospect-inbox error:', err.message);
    res.status(500).json({ error: 'failed to enqueue prospect' });
  }
});

// POST /api/crm/prospect-inbox/claim — atomically claim pending rows for an engine
// (+ broadcast rows). FOR UPDATE SKIP LOCKED prevents double-claim under concurrency.
// T3: when target_engine='sales', auto-creates a deals row at 'accepted' if none exists.
router.post('/prospect-inbox/claim', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { target_engine = null, limit = 1, claimed_by = null } = req.body;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 1, 1), 100);
    const r = await query(
      `UPDATE prospect_inbox SET status='claimed', claimed_by=$3, claimed_at=now()
       WHERE id IN (
         SELECT id FROM prospect_inbox
         WHERE company_id=$1 AND status='pending'
           AND ($2::text IS NULL OR target_engine=$2 OR target_engine IS NULL)
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       RETURNING *`,
      [companyId, target_engine, claimed_by, lim]
    );

    // T3: MQL → Sales handoff. Auto-create a deals row at 'accepted' for each claimed
    // sales prospect. Idempotent: skips if an open deal already exists for the contact.
    if (target_engine === 'sales' && r.rows.length > 0) {
      for (const row of r.rows) {
        if (!row.contact_id) continue;
        try {
          const existing = await query(
            `SELECT id FROM deals WHERE contact_id=$1 AND company_id=$2
             AND stage NOT IN ('won','lost') LIMIT 1`,
            [row.contact_id, companyId]
          );
          if (existing.rows.length === 0) {
            const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
            await query(
              `INSERT INTO deals
                 (id, company_id, contact_id, title, value, stage, source, metadata, created_at, updated_at)
               VALUES ($1,$2,$3,$4,0,'accepted','prospect_inbox',$5,now(),now())`,
              [
                uuidv4(), companyId, row.contact_id,
                `MQL Handoff${meta.reason ? ' — ' + meta.reason : ''}`,
                JSON.stringify({
                  source_engine: row.source_engine,
                  suggested_campaign: row.suggested_campaign,
                  ...meta,
                  activity: [{ type: 'created', message: 'Deal created from MQL handoff', timestamp: new Date().toISOString() }],
                }),
              ]
            );
          }
        } catch (dealErr) {
          console.error('[CRM] claim: failed to create sales deal for contact', row.contact_id, dealErr.message);
        }
      }
    }

    res.json({ claimed: r.rows });
  } catch (err) {
    console.error('[CRM] POST /prospect-inbox/claim error:', err.message);
    res.status(500).json({ error: 'failed to claim prospects' });
  }
});

// GET /api/crm/prospect-inbox?target_engine=&status=&limit=
router.get('/prospect-inbox', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { target_engine, status } = req.query;
    const lim = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const conditions = ['company_id = $1'];
    const params = [companyId];
    let idx = 2;
    if (target_engine !== undefined) { conditions.push(`(target_engine = $${idx++} OR target_engine IS NULL)`); params.push(target_engine); }
    if (status !== undefined) {
      if (!HANDOFF_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
      conditions.push(`status = $${idx++}`); params.push(status);
    }
    params.push(lim);
    const r = await query(
      `SELECT * FROM prospect_inbox WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT $${idx}`,
      params
    );
    res.json({ total: r.rows.length, rows: r.rows });
  } catch (err) {
    console.error('[CRM] GET /prospect-inbox error:', err.message);
    res.status(500).json({ error: 'failed to list prospects' });
  }
});

// PATCH /api/crm/prospect-inbox/:id — transition a handoff (e.g. → enrolled | done)
router.patch('/prospect-inbox/:id', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { status, claimed_by } = req.body;
    if (status && !HANDOFF_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    const sets = [];
    const params = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); params.push(status); }
    if (status === 'pending') {
      // Release back to the queue (sweep / no-campaign path): clear claim ownership
      // so a released row isn't left lying as still-claimed (stale claimed_by/at).
      sets.push(`claimed_by = NULL`);
      sets.push(`claimed_at = NULL`);
    } else if (claimed_by !== undefined) {
      sets.push(`claimed_by = $${idx++}`); params.push(claimed_by);
    }
    if (status === 'claimed' || status === 'enrolled') { sets.push(`claimed_at = now()`); }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.id, companyId);
    const r = await query(
      `UPDATE prospect_inbox SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'prospect not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[CRM] PATCH /prospect-inbox/:id error:', err.message);
    res.status(500).json({ error: 'failed to update prospect' });
  }
});

// DELETE /api/crm/contacts/:id
router.delete('/contacts/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    await query('DELETE FROM contacts WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    broadcast(req, { type: 'contact_deleted', id: req.params.id });
    res.json({ ok: true, deleted: contact });
  } catch (err) {
    console.error('[CRM] DELETE /contacts/:id error:', err.message);
    res.status(500).json({ error: 'failed to delete contact' });
  }
});

// DELETE /api/crm/deals/:id
router.delete('/deals/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });
    await query('DELETE FROM deals WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    broadcast(req, { type: 'deal_deleted', id: req.params.id });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    console.error('[CRM] DELETE /deals/:id error:', err.message);
    res.status(500).json({ error: 'failed to delete deal' });
  }
});

// POST /api/crm/deals/:id/activity
router.post('/deals/:id/activity', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { type, message, agent, data } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const entry = { type: type || 'note', message, agent: agent || 'system', timestamp: new Date().toISOString(), data: data || null };

    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });

    const row = rows[0];
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
    const activity = meta.activity || [];
    activity.push(entry);

    await query(
      `UPDATE deals SET metadata = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [JSON.stringify({ ...meta, activity }), row.id, companyId]
    );

    broadcast(req, { type: 'deal_activity', deal_id: row.id, entry });
    res.json(entry);
  } catch (err) {
    console.error('[CRM] POST /deals/:id/activity error:', err.message);
    res.status(500).json({ error: 'failed to add deal activity' });
  }
});

// POST /api/crm/contacts/bulk-import
// Tenant-scoped: every imported contact is created under (and every dedup
// lookup runs against) the request's company — company_id is never null.
router.post('/contacts/bulk-import', async (req, res) => {
  const companyId = getUserCompanyId(req);
  if (!companyId) return res.status(401).json({ error: 'Authentication required' });

  const { contacts: inputContacts } = req.body;
  if (!Array.isArray(inputContacts) || inputContacts.length === 0) {
    return res.status(400).json({ error: 'contacts array required' });
  }

  let created = 0, updated = 0, errors = 0;
  for (const input of inputContacts) {
    try {
      if (!input.email && !input.name) { errors++; continue; }
      const { contact, created: isNew } = await findOrCreateContact(input.email, {
        company_id: companyId,
        name: input.name,
        phone: input.phone,
        company: input.company,
        title: input.title || input.position,
        linkedin_url: input.linkedin_url || input.linkedin,
        source: input.source || 'bulk_import',
        lead_score: input.lead_score || 'cold',
        tags: input.tags || ['bulk_import'],
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
        metadata: input.metadata,
      });
      if (isNew) {
        await addContactActivity(contact.id, companyId, { type: 'prospect_loaded', message: `Loaded from bulk import (${input.source || 'list'})` });
        created++;
      } else {
        updated++;
      }
    } catch { errors++; }
  }

  res.json({ ok: true, created, updated, errors, total: inputContacts.length });
});

// (GET /contacts/export moved above the /contacts/:id route — ':id' was capturing 'export')

// ─── Exported helpers ─────────────────────────────────────────────────────────

async function findContactByEmail(email, companyId) {
  if (!email) return null;
  return await contactDb.getByEmail(email, companyId || null);
}

async function findOrCreateContact(email, defaults = {}) {
  const companyId = defaults.company_id || defaults.companyId || null;

  let contact = email ? await contactDb.getByEmail(email, companyId) : null;

  // Email is the AUTHORITATIVE dedupe key. The phone/linkedin fallback only
  // fires when the incoming record has NO email — two records with distinct
  // non-empty emails must never merge, even if they share a phone or LinkedIn
  // profile (real case: two prospects on one device / one profile scraped for
  // several dot-alias emails). Mirrors the automation_core BUG-1 fix.
  if (!contact && !email && (defaults.phone || defaults.linkedin_url)) {
    const allContacts = await contactDb.list(companyId, {});
    if (!contact && defaults.phone) {
      const normalized = defaults.phone.replace(/\D/g, '');
      contact = allContacts.find(c => c.phone && c.phone.replace(/\D/g, '') === normalized) || null;
    }
    if (!contact && defaults.linkedin_url) {
      contact = allContacts.find(c => c.linkedin_url && c.linkedin_url.toLowerCase() === defaults.linkedin_url.toLowerCase()) || null;
    }
  }

  if (contact) return { contact, created: false };

  const name = defaults.name || (email ? email.split('@')[0] : 'Unknown');
  const nameParts = name.trim().split(/\s+/);

  const contactData = {
    id: uuidv4(),
    name,
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '',
    email: email ? email.toLowerCase() : '',
    phone: defaults.phone || null,
    company: defaults.company || null,
    company_id: companyId,
    title: defaults.title || defaults.position || null,
    position: defaults.position || defaults.title || null,
    linkedin_url: defaults.linkedin_url || null,
    website: defaults.website || null,
    location: defaults.location || null,
    source: defaults.source || 'webhook',
    lead_score: defaults.lead_score || 'neutral',
    lead_score_numeric: LEAD_SCORES[defaults.lead_score || 'neutral'] || 30,
    deal_stage: defaults.deal_stage || 'lead',
    deal_value: defaults.deal_value || 0,
    engagementScore: 0,
    engagement_score: 0,
    utmSource: defaults.utmSource || null,
    utmMedium: defaults.utmMedium || null,
    utmCampaign: defaults.utmCampaign || null,
    utmContent: defaults.utmContent || null,
    whatsappOptIn: defaults.whatsappOptIn === true,
    smsOptIn: defaults.smsOptIn === true,
    isUnsubscribed: false,
    tags: defaults.tags || [],
    metadata: defaults.metadata || {},
    activity: [],
    last_contacted: null,
    next_follow_up: null,
  };

  contact = await contactDb.create(contactData);
  return { contact, created: true };
}

async function findContactByPhone(phone) {
  if (!phone) return null;
  const normalized = phone.replace(/\D/g, '');
  const allContacts = await contactDb.list(null, {});
  return allContacts.find(c => c.phone && c.phone.replace(/\D/g, '') === normalized) || null;
}

function calculateEngagementScore(contact) {
  if (!contact.activity || contact.activity.length === 0) return 0;
  let score = 0;
  for (const act of contact.activity) {
    score += ENGAGEMENT_WEIGHTS[act.type] || 0;
  }
  return Math.min(score, 100);
}

async function addContactActivity(contactId, companyId, entry) {
  const contact = await contactDb.getById(contactId, companyId);
  if (!contact) return false;

  const timestampedEntry = { ...entry, timestamp: new Date().toISOString() };
  await contactDb.addActivity(contactId, timestampedEntry, companyId);

  const updated = await contactDb.getById(contactId, companyId);
  const es = calculateEngagementScore(updated || contact);

  const updateData = { lead_score_numeric: es };

  if (es >= 80 && (contact.lead_score || contact.leadScore) !== 'hot') {
    updateData.lead_score = 'hot';
    updateData.lead_score_numeric = 90;
  } else if (es >= 50 && (contact.lead_score || contact.leadScore) === 'cold') {
    updateData.lead_score = 'warm';
    updateData.lead_score_numeric = 60;
  }

  await contactDb.update(contactId, updateData, companyId);
  return true;
}

router.findContactByEmail = findContactByEmail;
router.findContactByPhone = findContactByPhone;
router.findOrCreateContact = findOrCreateContact;
router.addContactActivity = addContactActivity;
router.calculateEngagementScore = calculateEngagementScore;

module.exports = router;
