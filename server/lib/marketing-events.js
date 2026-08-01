'use strict';
// ─── Marketing-stage ingestion: ONE canonical path ───────────────────────────
//
// Migration 018 declared five "automated" marketing stages — `invitees`,
// `visits`, `registrants`, `auto_registrants`, `attendees` — and then nothing
// in the server ever mentioned them again. This file is what makes them move.
//
// BORROWED, per the operator's instruction ("the automation workflows have to be
// designed OR BORROWED FROM THE EXISTING AUTOMATION WORKFLOWS that we've created
// within the outreach engine or the nurturing engine"). The shape here is
// ~/nurturing-engine/backend/app/events.py's `ingest_event`, carried over
// deliberately rather than reinvented:
//
//   normalize → resolve contact → dedupe → log → side-effects
//
// and its two load-bearing rules:
//   · ONE ingest for every signal, so segmentation/staging/suppression live in
//     exactly one place and a new channel is an adapter, not a new policy;
//   · a dedupe conflict skips EVERY side-effect, not merely the insert. The
//     engine learned this the hard way; a re-delivered provider webhook that
//     re-advances a stage also re-fires the sequence enrolment behind it.
//
// WHAT IS DELIBERATELY NOT BORROWED: the engine's `advance_stage` walks a
// contact through intermediate stages to reach a target. Ours must never do
// that, because in this CRM every hop fires `enrollForTriggerStage` — a walk
// from `visits` to `attendees` would send the "thanks for registering" mail to
// somebody who has already attended. One hop, or a recorded refusal.
//
// AND THE RULE THAT OUTRANKS EVERYTHING: this file has NO stage-writing code of
// its own. Every advance goes through server/lib/stage-authority.js with
// `automated: true`, which is the same authority POST /contacts/:id/advance
// uses. So the manual-stage invariant, the transition table, the pipeline entry
// rule and the suppression-escape refusal all apply to ingestion for free, and
// cannot drift away from the human path.

const crypto = require('crypto');
const { query } = require('../db/index');
const { getPipelineConfig } = require('../db/pipeline');
const { advanceContactStage } = require('./stage-authority');
const { classifyInterest, normalizeRsvp } = require('./reply-classify');
const contactDb = require('../db/models/contacts');
const limitDb = require('../db/models/limits');

// Which pipeline the marketing stages live on. Overridable per call and per
// deployment, defaulting to the pipeline migration 018 seeds.
const DEFAULT_MARKETING_PIPELINE = process.env.MARKETING_PIPELINE_KEY || 'webinar_marketing';

// Event → the stage it drives. `no_show` maps to nothing on purpose: the
// operator's marketing pipeline has no no-show stage, and the nurturing engine
// already established that a no-show is a branch LABEL, not a forward stage.
// Inventing a stage for it here would put a contact somewhere the spec has no
// name for.
const EVENT_STAGE = Object.freeze({
  invite_sent:        'invitees',
  landing_page_visit: 'visits',
  registration:       'registrants',
  calendar_rsvp:      'auto_registrants',
  email_reply:        'auto_registrants',
  content_comment:    'auto_registrants',
  attendance:         'attendees',
  no_show:            null,
});

const EVENT_TYPES = Object.freeze(Object.keys(EVENT_STAGE));

// Timeline entry type per event. Where an existing scoring type describes the
// signal exactly, we reuse it rather than minting a parallel vocabulary — a
// landing-page visit from an invite IS a CTA click, a form fill IS a
// registration, an interested reply IS an email reply.
const EVENT_ACTIVITY_TYPE = Object.freeze({
  invite_sent:        'marketing_invite_sent',
  landing_page_visit: 'cta_clicked',
  registration:       'registered',
  calendar_rsvp:      'registered',
  email_reply:        'email_replied',
  content_comment:    'content_comment',
  attendance:         'webinar_attended',
  no_show:            'marketing_no_show',
});

const CHANNELS = new Set(['email', 'sms', 'whatsapp', 'linkedin', 'ai_call', 'calendar', 'content', 'web']);

function sha16(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
}

// ─── Webinars ────────────────────────────────────────────────────────────────

async function getWebinarByKey(companyId, key) {
  const r = await query('SELECT * FROM crm_webinars WHERE company_id=$1 AND key=$2', [companyId, key]);
  return r.rows[0] || null;
}

async function getWebinarById(companyId, id) {
  const r = await query('SELECT * FROM crm_webinars WHERE company_id=$1 AND id=$2', [companyId, id]);
  return r.rows[0] || null;
}

async function upsertWebinar(companyId, { key, name, scheduled_at, landing_page_url, status, metadata }) {
  const r = await query(
    `INSERT INTO crm_webinars (company_id, key, name, scheduled_at, landing_page_url, status, metadata)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'scheduled'),COALESCE($7,'{}'::jsonb))
     ON CONFLICT (company_id, key) DO UPDATE SET
       name             = EXCLUDED.name,
       scheduled_at     = COALESCE(EXCLUDED.scheduled_at, crm_webinars.scheduled_at),
       landing_page_url = COALESCE(EXCLUDED.landing_page_url, crm_webinars.landing_page_url),
       status           = EXCLUDED.status,
       metadata         = crm_webinars.metadata || EXCLUDED.metadata,
       updated_at       = now()
     RETURNING *`,
    [companyId, key, name, scheduled_at || null, landing_page_url || null, status || null,
      metadata ? JSON.stringify(metadata) : null]
  );
  return r.rows[0];
}

async function listWebinars(companyId) {
  const r = await query(
    `SELECT w.*,
            (SELECT COUNT(*)::int FROM crm_invite_links l WHERE l.webinar_id = w.id) AS invite_link_count,
            (SELECT COUNT(*)::int FROM crm_marketing_events e WHERE e.webinar_id = w.id) AS event_count
       FROM crm_webinars w WHERE w.company_id=$1 ORDER BY COALESCE(w.scheduled_at, w.created_at) DESC`,
    [companyId]
  );
  return r.rows;
}

// ─── Invite links — the attribution primitive ────────────────────────────────
//
// "Visits — invitees that have visited the landing pages FROM THE INVITES or
// invite emails." A raw page-view cannot satisfy that sentence. The token is
// what carries the invitee's identity from the invite into the click.

// Config-time validation (C9): reject a bad destination while the human/engine
// is authoring the invite, not at redirect time when a real prospect is waiting.
const HOST_ALLOWLIST = (process.env.MARKETING_LINK_HOST_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function validateDestination(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'destination_url must be an absolute URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'destination_url must be http(s)';
  // Credentials in a redirect target are a phishing primitive and never
  // legitimate for a landing page.
  if (u.username || u.password) return 'destination_url must not embed credentials';
  if (HOST_ALLOWLIST.length && !HOST_ALLOWLIST.includes(u.hostname.toLowerCase())) {
    return `destination_url host '${u.hostname}' is not in MARKETING_LINK_HOST_ALLOWLIST`;
  }
  return null;
}

async function mintInviteLink(companyId, { webinarId, contactId, channel, destinationUrl }) {
  // 22 bytes of base64url ≈ 176 bits — unguessable, and comfortably over the
  // schema's length(token) >= 16 floor.
  const token = crypto.randomBytes(22).toString('base64url');
  const r = await query(
    `INSERT INTO crm_invite_links (company_id, webinar_id, contact_id, channel, token, destination_url)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id, webinar_id, contact_id, channel) DO UPDATE SET
       destination_url = EXCLUDED.destination_url
     RETURNING *`,
    [companyId, webinarId, contactId, channel, token, destinationUrl]
  );
  // On conflict the EXISTING token is returned, never a fresh one: a resend must
  // not orphan the link already sitting in an inbox.
  return r.rows[0];
}

async function getInviteLinkByToken(token) {
  const r = await query('SELECT * FROM crm_invite_links WHERE token=$1', [String(token || '')]);
  return r.rows[0] || null;
}

function inviteUrlFor(token) {
  const base = (process.env.MARKETING_PUBLIC_BASE || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${base}/m/i/${token}`;
}

// ─── Contact resolution ──────────────────────────────────────────────────────
// Same precedence as the engines' resolve_contact: explicit id, then email,
// then phone. A registration additionally find-or-creates, because a
// registration is a NEW-LEAD signal — the person filling the form may never
// have been in the CRM, and dropping them is how a funnel leaks at its widest
// point.

async function resolveContact(companyId, payload) {
  // An invite token is the STRONGEST identifier we have — it was minted for one
  // named contact and delivered to them personally, so it beats an email match
  // (which can collide with a forwarded form) and it is what makes a landing
  // page hit an *invitee's* visit rather than a stranger's.
  if (payload.token) {
    const link = await getInviteLinkByToken(payload.token);
    if (link && link.company_id === companyId) {
      const c = await contactDb.getById(link.contact_id, companyId);
      if (c) return c;
    }
  }
  if (payload.contact_id) {
    const c = await contactDb.getById(payload.contact_id, companyId);
    if (c) return c;
  }
  if (payload.email) {
    const c = await contactDb.getByEmail(String(payload.email).trim().toLowerCase(), companyId);
    if (c) return c;
  }
  if (payload.phone) {
    const digits = String(payload.phone).replace(/\D/g, '');
    if (digits) {
      const r = await query(
        `SELECT * FROM contacts
          WHERE company_id=$1 AND deleted_at IS NULL
            AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $2
          ORDER BY created_at ASC LIMIT 1`,
        [companyId, digits]
      );
      if (r.rows[0]) return r.rows[0];
    }
  }
  return null;
}

// ─── Dedupe keys ─────────────────────────────────────────────────────────────
// Namespaced `mk:` so marketing observations can never collide with the
// outbound `campaign:contact:channel:step` space or the inbound `wh:` space the
// engines use. Every key is NATURAL where a natural key exists (same person,
// same webinar, same signal ⇒ same key), because that is what makes a replay a
// no-op without needing the provider to supply an event id.

function deriveDedupeKey(payload, { contact, webinar }) {
  if (payload.dedupe_key) return String(payload.dedupe_key);
  if (payload.provider && payload.provider_event_id) {
    return `mk:${payload.provider}:${payload.provider_event_id}:${payload.event_type}`;
  }
  const w = webinar ? webinar.id : 'no_webinar';
  const c = contact ? contact.id : `anon:${sha16(payload.email || payload.phone || payload.token || '')}`;
  switch (payload.event_type) {
    case 'invite_sent':
      return `mk:invite:${w}:${c}:${payload.channel || 'unknown'}`;
    case 'landing_page_visit':
      // Keyed on the LINK, not the hit: the second click of the same invite is
      // the same observation ("this invitee visited"), so it dedupes and the
      // stage does not move twice.
      return `mk:visit:${payload.token ? `tok:${payload.token}` : `${w}:${c}`}`;
    case 'registration':
      return `mk:reg:${w}:${c}`;
    case 'calendar_rsvp':
      return `mk:rsvp:${w}:${c}:${normalizeRsvp(payload.rsvp) || 'unknown'}`;
    case 'email_reply':
      return `mk:reply:${w}:${c}:${sha16(payload.body || '')}`;
    case 'content_comment':
      return `mk:comment:${payload.post_ref || w}:${c}:${sha16(payload.body || '')}`;
    case 'attendance':
      return `mk:attend:${w}:${c}`;
    case 'no_show':
      return `mk:noshow:${w}:${c}`;
    default:
      return `mk:${payload.event_type}:${w}:${c}`;
  }
}

// ─── The ingest ──────────────────────────────────────────────────────────────

/**
 * @param {string} companyId
 * @param {object} payload  { event_type, channel?, contact_id?/email?/phone?,
 *                            webinar_key?/webinar_id?, token?, rsvp?, body?,
 *                            interested?, post_ref?, provider?, provider_event_id?,
 *                            dedupe_key?, pipeline_key?, name?, source?, metadata? }
 * @param {object} deps     { recordActivity } — injected for the same
 *                          require-cycle reason stage-authority.js documents.
 */
async function ingestMarketingEvent(companyId, payload, deps = {}) {
  const recordActivity = deps.recordActivity || null;
  const eventType = payload && payload.event_type;

  if (!companyId) throw new Error('ingestMarketingEvent requires companyId');
  if (!EVENT_TYPES.includes(eventType)) {
    return { ok: false, status: 400, error: `event_type must be one of: ${EVENT_TYPES.join(', ')}` };
  }
  const channel = payload.channel && CHANNELS.has(payload.channel) ? payload.channel : null;
  if (payload.channel && !channel) {
    return { ok: false, status: 400, error: `unknown channel '${payload.channel}'` };
  }

  // ── Webinar. Required for anything that is ABOUT a specific event. An invite,
  // a registration or an attendance with no webinar is not a partial record, it
  // is a meaningless one — so this is a 400 at the door, not a NULL in a row.
  let webinar = null;
  if (payload.webinar_id) webinar = await getWebinarById(companyId, payload.webinar_id);
  else if (payload.webinar_key) webinar = await getWebinarByKey(companyId, payload.webinar_key);
  if (!webinar && payload.token) {
    // A landing page that echoes the invite token back need not also know the
    // webinar key — the link already encodes which webinar it was minted for.
    const link = await getInviteLinkByToken(payload.token);
    if (link && link.company_id === companyId) webinar = await getWebinarById(companyId, link.webinar_id);
  }
  const needsWebinar = ['invite_sent', 'registration', 'attendance', 'no_show'].includes(eventType);
  if (needsWebinar && !webinar) {
    return {
      ok: false, status: 400,
      error: `event_type '${eventType}' requires a known webinar (webinar_key or webinar_id)`,
      detail: payload.webinar_key || payload.webinar_id
        ? 'no webinar with that key/id exists for this tenant'
        : 'no webinar_key or webinar_id supplied',
    };
  }

  // ── Contact.
  let contact = await resolveContact(companyId, payload);
  let contactCreated = false;
  if (!contact && eventType === 'registration' && payload.email) {
    // NEW-LEAD signal (borrowed from the engines' D1 rule): someone filled the
    // form who is not in the CRM. Creating them is the whole point of a landing
    // page. Routed through the CRM's own findOrCreateContact when the caller
    // injects it, so the registrant gets the same company auto-identification
    // and email-authoritative dedupe every other intake path gets.
    if (deps.findOrCreateContact) {
      const r = await deps.findOrCreateContact(String(payload.email).trim().toLowerCase(), {
        company_id: companyId, name: payload.name || null,
        phone: payload.phone || null, source: payload.source || 'webinar',
      });
      contact = r.contact; contactCreated = !!r.created;
    } else {
      contact = await contactDb.create({
        company_id: companyId,
        email: String(payload.email).trim().toLowerCase(),
        name: payload.name || String(payload.email).split('@')[0],
        phone: payload.phone || null,
        source: payload.source || 'webinar',
      });
      contactCreated = true;
    }
  }

  const dedupeKey = deriveDedupeKey({ ...payload, event_type: eventType, channel }, { contact, webinar });

  // ── Log FIRST, and let the unique index be the idempotency gate (C3: at the
  // door, in the query — not a read-then-write race in JS).
  const ins = await query(
    `INSERT INTO crm_marketing_events
       (company_id, webinar_id, contact_id, event_type, channel, dedupe_key, outcome, payload)
     VALUES ($1,$2,$3,$4,$5,$6,'no_change',$7)
     ON CONFLICT (company_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [companyId, webinar ? webinar.id : null, contact ? contact.id : null, eventType, channel, dedupeKey,
      JSON.stringify(sanitizePayload(payload))]
  );

  if (!ins.rows[0]) {
    // Already seen. Skip EVERY side-effect — this is the rule the nurturing
    // engine spells out, and the reason a re-delivered webhook cannot re-fire a
    // sequence enrolment.
    const prev = await query(
      'SELECT id, outcome, from_stage, to_stage, detail FROM crm_marketing_events WHERE company_id=$1 AND dedupe_key=$2',
      [companyId, dedupeKey]
    );
    const row = prev.rows[0] || null;
    // ONE exception, borrowed from the engine's "fail loud + self-heal" note:
    // the log is written BEFORE the side-effects, so a transient failure on the
    // first delivery would otherwise strand this event behind `duplicate: true`
    // forever. An `error` outcome is therefore retried — safe, because the
    // advance is idempotent (already-at-stage ⇒ no_change ⇒ no enrolment).
    if (!row || row.outcome !== 'error') {
      return {
        ok: true, duplicate: true, event_id: row ? row.id : null, dedupe_key: dedupeKey,
        contact_id: contact ? contact.id : null, event_type: eventType,
        outcome: row ? row.outcome : 'no_change',
        from_stage: row ? row.from_stage : null, to_stage: row ? row.to_stage : null,
        detail: row ? row.detail : null,
      };
    }
  }

  const eventId = ins.rows[0]
    ? ins.rows[0].id
    : (await query('SELECT id FROM crm_marketing_events WHERE company_id=$1 AND dedupe_key=$2', [companyId, dedupeKey])).rows[0].id;

  try {
    const result = await applyEvent(companyId, {
      eventId, eventType, channel, contact, webinar, payload, recordActivity,
    });
    await query(
      `UPDATE crm_marketing_events SET outcome=$1, from_stage=$2, to_stage=$3, detail=$4 WHERE id=$5`,
      [result.outcome, result.from_stage || null, result.to_stage || null, result.detail || null, eventId]
    );
    return {
      ok: true, duplicate: false, event_id: eventId, dedupe_key: dedupeKey,
      contact_id: contact ? contact.id : null, contact_created: contactCreated,
      event_type: eventType, webinar_id: webinar ? webinar.id : null,
      outcome: result.outcome, from_stage: result.from_stage || null, to_stage: result.to_stage || null,
      detail: result.detail || null,
      ...(result.sequence_enrollments && result.sequence_enrollments.length
        ? { sequence_enrollments: result.sequence_enrollments } : {}),
    };
  } catch (err) {
    console.error('[marketing] ingest side-effect failed:', err.message);
    await query(
      `UPDATE crm_marketing_events SET outcome='error', detail=$1 WHERE id=$2`,
      [String(err.message).slice(0, 500), eventId]
    );
    return {
      ok: false, status: 500, event_id: eventId, dedupe_key: dedupeKey,
      contact_id: contact ? contact.id : null, event_type: eventType,
      outcome: 'error', error: 'marketing event side-effects failed',
    };
  }
}

// Never persist a raw provider blob wholesale. Keep the fields that explain the
// decision; drop anything unbounded.
function sanitizePayload(p) {
  const out = {};
  for (const k of ['channel', 'rsvp', 'interested', 'post_ref', 'post_url', 'provider',
    'provider_event_id', 'source', 'name', 'utm', 'webinar_key', 'registration_source']) {
    if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  }
  if (p.email) out.email = String(p.email).slice(0, 320);
  if (p.body) out.body = String(p.body).slice(0, 1000);
  if (p.metadata && typeof p.metadata === 'object') out.metadata = p.metadata;
  return out;
}

// ─── Side-effects: decide, then hand the decision to the stage authority ─────

async function applyEvent(companyId, { eventId, eventType, channel, contact, webinar, payload, recordActivity }) {
  // No identifiable person ⇒ a real observation that moves nobody. This is the
  // anonymous landing-page hit, and it is exactly the case that must NOT become
  // a Visit: "invitees that have visited the landing pages from the invites".
  if (!contact) {
    return {
      outcome: 'not_attributed',
      detail: 'no contact could be resolved from this event (no contact_id, email, phone or invite token)',
    };
  }

  // ── Per-event admission rules, BEFORE any stage authority is consulted. ────
  let interestNote = null;

  if (eventType === 'calendar_rsvp') {
    // Path 1: "invitees that respond YES / MAYBE to cold calendar invite outreach."
    const rsvp = normalizeRsvp(payload.rsvp);
    if (rsvp !== 'yes' && rsvp !== 'maybe') {
      return {
        outcome: 'not_interested',
        detail: rsvp === 'no'
          ? 'calendar invite was declined'
          : `unrecognised RSVP value ${JSON.stringify(payload.rsvp ?? null)} — not treated as acceptance`,
      };
    }
    interestNote = `calendar RSVP: ${rsvp}`;
  }

  if (eventType === 'email_reply' || eventType === 'content_comment') {
    // Paths 2 and 3: "invitees that reply and express interest" / "prospects
    // that comment below content posts expressing interest".
    //
    // An explicit `interested` from the caller wins — an upstream classifier or
    // a human who has read the message knows more than a regex. Absent, we
    // classify, conservatively, and absence of a signal is a NO (C4).
    let interested, reason, kind;
    if (typeof payload.interested === 'boolean') {
      interested = payload.interested;
      reason = 'caller-supplied interested flag';
      kind = classifyInterest(payload.body).kind;
    } else {
      ({ interested, reason, kind } = classifyInterest(payload.body));
    }

    // An opt-out is acted on even when the caller claimed interest: the person
    // asked to be left alone, and that outranks any upstream classification.
    if (kind === 'stop') {
      try {
        await limitDb.suppress(
          companyId, contact.id, null,
          `inbound opt-out on ${channel || 'unknown channel'} (marketing ${eventType})`
        );
      } catch (e) {
        console.error('[marketing] suppression on opt-out failed:', e.message);
      }
      return { outcome: 'suppressed', detail: 'inbound message is an opt-out — suppressed, not registered' };
    }
    if (!interested) {
      return { outcome: 'not_interested', detail: reason };
    }
    interestNote = reason;
  }

  const targetStage = EVENT_STAGE[eventType];

  // `no_show` has no stage. Record it against the contact so the sales side can
  // see it, and move nothing.
  if (!targetStage) {
    await writeActivity(recordActivity, contact, companyId, {
      eventType, channel, webinar, payload, detail: 'recorded; no marketing stage change',
    });
    return { outcome: 'no_change', detail: 'no_show is a label, not a marketing stage — nothing advanced' };
  }

  const pipelineKey = payload.pipeline_key || DEFAULT_MARKETING_PIPELINE;
  const pipeline = await getPipelineConfig(companyId, pipelineKey);
  if (!pipeline) {
    return { outcome: 'refused', detail: `marketing pipeline '${pipelineKey}' is not configured for this tenant` };
  }
  if (pipeline.entity_type !== 'contact') {
    return { outcome: 'refused', detail: `pipeline '${pipelineKey}' is a ${pipeline.entity_type} pipeline — marketing stages live on the contact` };
  }
  if (!pipeline.stages.some(s => s.key === targetStage)) {
    return { outcome: 'refused', detail: `pipeline '${pipelineKey}' has no stage '${targetStage}'` };
  }

  // Re-read the contact: it may have been created seconds ago, or moved by a
  // concurrent ingest, and the authority decides against CURRENT state.
  const fresh = await contactDb.getById(contact.id, companyId) || contact;

  const advance = await advanceContactStage({
    companyId, contact: fresh, pipelineKey, pipeline, stage: targetStage,
    // ALWAYS true. This is ingestion — there is no human here — so a manual
    // stage must refuse it. If someone ever re-marks one of these stages
    // manual, this line is what makes the CRM stop rather than quietly obey.
    automated: true,
    reason: interestNote || `marketing ${eventType}${webinar ? ` (${webinar.key})` : ''}`,
    actor: 'marketing-ingest',
    recordActivity,
  });

  await writeActivity(recordActivity, contact, companyId, {
    eventType, channel, webinar, payload,
    detail: advance.changed
      ? `${advance.previous} → ${targetStage}`
      : `no stage change (${advance.code})`,
  });

  if (advance.ok && advance.changed) {
    return {
      outcome: 'advanced', from_stage: advance.previous, to_stage: targetStage,
      detail: interestNote, sequence_enrollments: advance.sequence_enrollments,
    };
  }
  if (advance.ok) {
    return { outcome: 'no_change', from_stage: advance.previous, to_stage: targetStage,
      detail: `already at '${targetStage}'` };
  }
  // Refused by the authority. `detail` carries WHICH gate said no, because
  // "the stage didn't move" with no reason is the thing this column exists to
  // prevent. The commonest one by far is the entry rule: `prospects` is a
  // MANUAL stage, so the CRM may not put a stranger into the webinar funnel —
  // a human has to place them in Prospects first. That is the invariant working,
  // not a bug, and the message says so.
  return {
    outcome: 'refused', from_stage: advance.previous, to_stage: targetStage,
    detail: advance.body && advance.body.error
      ? `${advance.body.error}${advance.code === 'not_in_pipeline'
        ? " — a human must place this contact in the pipeline's first stage (Prospects is manual)" : ''}`
      : `refused (${advance.code})`,
  };
}

async function writeActivity(recordActivity, contact, companyId, { eventType, channel, webinar, payload, detail }) {
  if (!recordActivity) return;
  try {
    await recordActivity(contact.id, companyId, {
      type: EVENT_ACTIVITY_TYPE[eventType] || `marketing_${eventType}`,
      message: `Marketing: ${eventType.replace(/_/g, ' ')}${webinar ? ` — ${webinar.name}` : ''}${detail ? ` (${detail})` : ''}`,
      agent: 'marketing-ingest',
      channel: channel === 'web' ? null : channel,
      data: {
        marketing_event: eventType,
        webinar_key: webinar ? webinar.key : null,
        rsvp: payload.rsvp || null,
        post_ref: payload.post_ref || null,
      },
    });
  } catch (e) {
    // The activity feed must never be able to fail an ingest — the stage move
    // is the contract, the timeline entry is decoration.
    console.error('[marketing] activity write failed:', e.message);
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function listEvents(companyId, { contactId, webinarId, eventType, outcome, limit = 100 } = {}) {
  const conds = ['e.company_id = $1'];
  const params = [companyId];
  if (contactId) { params.push(contactId); conds.push(`e.contact_id = $${params.length}`); }
  if (webinarId) { params.push(webinarId); conds.push(`e.webinar_id = $${params.length}`); }
  if (eventType) { params.push(eventType); conds.push(`e.event_type = $${params.length}`); }
  if (outcome) { params.push(outcome); conds.push(`e.outcome = $${params.length}`); }
  params.push(Math.min(Number(limit) || 100, 500));
  const r = await query(
    `SELECT e.*, c.email AS contact_email, c.name AS contact_name, w.key AS webinar_key
       FROM crm_marketing_events e
       LEFT JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN crm_webinars w ON w.id = e.webinar_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.created_at DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

module.exports = {
  ingestMarketingEvent, listEvents,
  getWebinarByKey, getWebinarById, upsertWebinar, listWebinars,
  mintInviteLink, getInviteLinkByToken, inviteUrlFor, validateDestination,
  EVENT_TYPES, EVENT_STAGE, DEFAULT_MARKETING_PIPELINE,
};
