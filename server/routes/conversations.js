'use strict';
// Part 4 — Unified AI Inbox: conversations + messages model
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/index');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const workflowTriggers = require('../lib/workflow-triggers');
const contactDb = require('../db/models/contacts');
// CP-M union (D4): both sides added imports here. The branch needs sequenceDb +
// isManualStage for the inbound-reply auto-advance (the CP1 mode gate and B2's
// enrollment hook); main needs scoring + Resend for the inbox composer and the
// inbox-fed lead score. All of it survives.
const sequenceDb = require('../db/models/sequences');
const { getPipelineConfig, getPipelineTransitions, isManualStage } = require('../db/pipeline');
const { recordEngagement } = require('../lib/scoring');
const resendEmail = require('../lib/email-resend');
// CP-M D11: A5's suppression list, needed by the composer's deliver path below.
const limitsDb = require('../db/models/limits');
// CP-M2 (WhatsApp/SMS compliance layer, ported from origin/aquila-working-branch).
// Separate from limitsDb's suppression above — that's A5's general channel
// suppression; these are the WhatsApp/SMS-specific consent ladder, 24h window
// and India DLT template rules, checked in addition, not instead.
const twilioCompliant = require('../lib/twilio');
const channelsModel = require('../db/models/channels');
const channelTemplatesModel = require('../db/models/channel-templates');
const complianceGate = require('../lib/compliance-gate');
const segments = require('../lib/segments');

// Inbound reply → engagement event (per channel), so the Unified AI Inbox feeds
// the same lead score the activity feed does. Channels with no scoring reply
// event fall back to a generic 'message_replied' (weight 0 — logged, not scored).
const REPLY_EVENT_BY_CHANNEL = {
  email: 'email_replied',
  whatsapp: 'whatsapp_replied',
  sms: 'sms_replied',
  linkedin: 'linkedin_message_replied',
};

router.use(requireAuth);

// ── Conversations ──────────────────────────────────────────────────────────────

// POST /api/crm/conversations
// Find-or-create the active (non-closed) conversation for (contact_id, channel).
// Idempotent: returns the existing open conversation if one exists.
router.post('/conversations', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { contact_id, channel, channel_account, metadata = {} } = req.body;
    if (!contact_id || !channel) return res.status(400).json({ error: 'contact_id and channel required' });

    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    // `channel_account` (migration 040) is the B3 grain: a contact can hold two
    // open conversations on ONE channel when two accounts serve different
    // purposes (Tantra's outreach WhatsApp vs the CRM's own). Omitting it means
    // '' — the CRM's own account — which is exactly what every caller predating
    // 040 meant, so this stays backward-compatible. The ON CONFLICT inference
    // list must match `uq_conversations_contact_channel_account` exactly.
    const r = await query(
      `INSERT INTO conversations (company_id, contact_id, channel, channel_account, status, assignee, metadata)
       VALUES ($1,$2,$3,$4,'open','ai',$5)
       ON CONFLICT (contact_id, channel, channel_account) WHERE status != 'closed'
       DO UPDATE SET updated_at = now(), metadata = conversations.metadata || EXCLUDED.metadata
       RETURNING *`,
      [companyId, contact_id, channel, channel_account || '', JSON.stringify(metadata)]
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[Conversations] POST /conversations error:', err.message);
    res.status(500).json({ error: 'failed to create conversation' });
  }
});

// GET /api/crm/conversations
// Human escalation queue + dashboard: filter by status, assignee, channel, contact.
router.get('/conversations', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { status, assignee, channel, contact_id } = req.query;
    const lim = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const off = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const conditions = ['cv.company_id = $1'];
    const params = [companyId];
    let idx = 2;
    if (status)     { conditions.push(`cv.status = $${idx++}`);     params.push(status); }
    if (assignee)   { conditions.push(`cv.assignee = $${idx++}`);   params.push(assignee); }
    if (channel)    { conditions.push(`cv.channel = $${idx++}`);    params.push(channel); }
    if (contact_id) { conditions.push(`cv.contact_id = $${idx++}`); params.push(contact_id); }

    const { rows } = await query(
      `SELECT cv.*, c.name AS contact_name, c.email AS contact_email
       FROM conversations cv
       JOIN contacts c ON c.id = cv.contact_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY cv.last_message_at DESC NULLS LAST, cv.created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, lim, off]
    );
    return res.json({ total: rows.length, conversations: rows });
  } catch (err) {
    console.error('[Conversations] GET /conversations error:', err.message);
    res.status(500).json({ error: 'failed to load conversations' });
  }
});

// GET /api/crm/conversations/:id
router.get('/conversations/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(
      `SELECT cv.*, c.name AS contact_name, c.email AS contact_email
       FROM conversations cv
       JOIN contacts c ON c.id = cv.contact_id
       WHERE cv.id = $1 AND cv.company_id = $2`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'conversation not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[Conversations] GET /conversations/:id error:', err.message);
    res.status(500).json({ error: 'failed to load conversation' });
  }
});

// PATCH /api/crm/conversations/:id
// Assign/close/escalate/snooze a conversation.
router.patch('/conversations/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { status, assignee, intent, metadata } = req.body;

    const sets = ['updated_at = now()'];
    const params = [];
    let idx = 1;
    if (status)   { sets.push(`status = $${idx++}`);   params.push(status); }
    if (assignee) { sets.push(`assignee = $${idx++}`); params.push(assignee); }
    if (intent)   { sets.push(`intent = $${idx++}`);   params.push(intent); }
    if (metadata) {
      sets.push(`metadata = conversations.metadata || $${idx++}`);
      params.push(JSON.stringify(metadata));
    }

    params.push(req.params.id, companyId);
    const { rows } = await query(
      `UPDATE conversations SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'conversation not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[Conversations] PATCH /conversations/:id error:', err.message);
    res.status(500).json({ error: 'failed to update conversation' });
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────

// POST /api/crm/conversations/:id/messages
// Add a message. Idempotent on provider_message_id (dedup inbound webhooks).
// For inbound messages: returns active_campaigns so the engine can halt competing outbound.
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    const { direction, channel, body, ai_generated = false, intent,
            provider_message_id, metadata = {}, deliver = false } = req.body;
    if (!direction || !channel) return res.status(400).json({ error: 'direction and channel required' });
    if (!['inbound', 'outbound'].includes(direction)) return res.status(400).json({ error: 'direction must be inbound or outbound' });

    const convRes = await query(
      `SELECT * FROM conversations WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    const conv = convRes.rows[0];
    if (!conv) return res.status(404).json({ error: 'conversation not found' });

    // Real delivery via the channel's provider adapter (currently email → Resend).
    // Only fires for an outbound email when the composer asks to deliver AND a
    // provider is configured; otherwise the message is just recorded (demo mode).
    // CP-M D11 — the merge itself opened this hole, so the merge closes it.
    // Main's composer delivers mail directly and consulted `suppressions` not at
    // all; the branch enforced A5 only in the dispatcher's claim path and at
    // pipeline entry. Unioned, a human could hit "send" and mail a contact who
    // has withdrawn consent — a compliance hole, not a style issue, and one no
    // existing test would catch (A5's tests only exercise branch paths).
    //
    // Same function and semantics the dispatcher uses (dispatch.js's claim
    // scan): it matches a GLOBAL suppression (channel IS NULL) or one for THIS
    // channel. Gated on the request's intent to deliver rather than on whether a
    // provider happens to be configured, so the answer can't silently change
    // with deployment config. A `deliver:false` call still records normally —
    // only actually sending is refused.
    //
    // The check is ADDRESS-keyed, not just conversation-keyed. Suppression lives
    // on a contact, but the address this route delivers to is caller-supplied
    // (`metadata.to`, and cc/bcc) and defaults to the conversation's contact only
    // when omitted. Checking `conv.contact_id` alone left the hole open: post a
    // message on an UNSUPPRESSED contact's conversation with a SUPPRESSED
    // contact's address in `metadata.to`, and the mail goes out. So every
    // address this request would actually deliver to is mapped back to a contact
    // in this tenant and checked too. An address belonging to no contact cannot
    // be suppressed (suppressions are contact-keyed), so it passes.
    if (deliver && direction === 'outbound') {
      const suspects = new Map([[conv.contact_id, 'conversation contact']]);
      if (channel === 'email') {
        const addrs = [metadata.to, metadata.cc, metadata.bcc]
          .flatMap(v => (Array.isArray(v) ? v : (v ? [v] : [])));
        for (const raw of addrs) {
          const m = String(raw || '').match(/<([^>]+)>/);
          const addr = (m ? m[1] : String(raw || '')).trim().toLowerCase();
          if (!addr) continue;
          const target = await contactDb.getByEmail(addr, companyId);
          if (target && !suspects.has(target.id)) suspects.set(target.id, `recipient ${addr}`);
        }
      }
      for (const [suspectId, why] of suspects) {
        if (await limitsDb.isSuppressed(companyId, suspectId, channel)) {
          console.warn(`[Conversations] composer delivery refused — ${why} (${suspectId}) is suppressed on '${channel}'`);
          return res.status(403).json({
            error: 'contact is suppressed on this channel — delivery refused',
            contact_id: suspectId,
            channel,
          });
        }
      }
    }

    let deliveredId = null;
    if (deliver && direction === 'outbound' && channel === 'email' && resendEmail.isConfigured()) {
      let toAddr = metadata.to;
      if (!toAddr) { const ct = await contactDb.getById(conv.contact_id, companyId); toAddr = ct && ct.email; }
      try {
        const sent = await resendEmail.sendEmail({
          from: metadata.from, to: toAddr, cc: metadata.cc, bcc: metadata.bcc,
          subject: metadata.subject, text: body,
          replyTo: metadata.reply_to || process.env.INBOUND_REPLY_TO || undefined,
        });
        deliveredId = sent.id;
        // Persist the email Message-ID so an inbound reply's In-Reply-To can be
        // matched back to this message ("in reply to …" in the thread).
        if (sent.messageId) metadata.message_id = sent.messageId;
      } catch (e) {
        console.error('[Conversations] email delivery failed:', e.message);
        return res.status(502).json({ error: `Email delivery failed — ${e.message}` });
      }
    }
    // WhatsApp / SMS delivery via Twilio — CP-M2. Every send passes the
    // compliance gate first (suppression → consent → WhatsApp 24h window /
    // India DLT template). This is a NEW capability, not a replacement: before
    // this, a reply on a WhatsApp/SMS thread recorded a row and delivered
    // nothing (only email/LinkedIn had a delivery path here). The automated
    // channel-jobs executor's own Twilio sender (twilio-send.js, CP-C) is
    // untouched — see .loop/DECISIONS_PENDING.md (CP-M2) for that decision.
    if (deliver && direction === 'outbound' && (channel === 'whatsapp' || channel === 'sms')) {
      const conn = await channelsModel.getConnection(companyId, 'twilio');
      if (!conn || conn.status !== 'connected' || !conn.credentials) {
        return res.status(409).json({ error: 'Twilio is not connected — connect it in Settings' });
      }
      const ct = await contactDb.getById(conv.contact_id, companyId);
      const phone = ct && ct.phone ? String(ct.phone).replace(/^whatsapp:/i, '') : '';
      if (!phone) return res.status(422).json({ error: 'contact has no phone number' });
      const from = metadata.from;
      if (!from) return res.status(400).json({ error: 'no sender selected for this channel' });
      const to = channel === 'whatsapp' ? `whatsapp:${phone}` : phone;

      const windowOpen = channel === 'whatsapp'
        ? !!(ct.cs_window_expires_at && new Date(ct.cs_window_expires_at) > new Date())
        : true;

      // Resolve the template server-side from its id — never trust a client-sent
      // status. Only an APPROVED template with a provider content id can be sent.
      let tplRecord = null;
      if (metadata.template_id) {
        tplRecord = await channelTemplatesModel.get(companyId, metadata.template_id);
        if (!tplRecord) return res.status(422).json({ error: 'selected template not found' });
      }

      const g = await complianceGate.check({
        companyId, channel, contact: ct, identifier: phone,
        category: metadata.category || 'conversational', windowOpen,
        template: tplRecord ? { status: tplRecord.status, provider_template_id: tplRecord.provider_template_id } : undefined,
        destinationCountry: ct.destination_country,
      });
      if (!g.allowed) {
        const httpCode = ['window_closed', 'template_not_approved', 'dlt_template_required'].includes(g.code) ? 409 : 403;
        return res.status(httpCode).json({ error: g.reason, code: g.code, meta: g.meta });
      }

      try {
        const sendArgs = {
          creds: conn.credentials, from, to,
          statusCallback: process.env.TWILIO_STATUS_CALLBACK || undefined,
        };
        // Template send → ContentSid + ContentVariables (Twilio uses the approved
        // content, not free-text Body). Otherwise send the free-form body.
        if (tplRecord && tplRecord.provider_template_id) {
          sendArgs.contentSid = tplRecord.provider_template_id;
          if (metadata.template_variables && Object.keys(metadata.template_variables).length) {
            sendArgs.contentVariables = metadata.template_variables;
          }
          metadata.template_name = tplRecord.name;
          metadata.billing_category = (tplRecord.current_category || tplRecord.category || '').toLowerCase() || undefined;
        } else {
          sendArgs.body = body;
        }
        const sent = await twilioCompliant.sendMessage(sendArgs);
        deliveredId = sent.sid;
        if (channel === 'sms') { const seg = segments.analyze(body || ''); metadata.encoding = seg.encoding; metadata.segments = seg.segments; }
        if (!metadata.billing_category) metadata.billing_category = metadata.category || (channel === 'whatsapp' ? 'service' : undefined);
        if (channel === 'whatsapp') metadata.window_state = windowOpen ? 'in_window' : 'out_of_window';
      } catch (e) {
        console.error('[Conversations]', channel, 'delivery failed:', e.message);
        return res.status(502).json({ error: `${channel} delivery failed — ${e.message}` });
      }
    }
    const effectiveProviderId = deliveredId || provider_message_id;

    let message;
    let isNewMessage;
    if (effectiveProviderId) {
      // Idempotent upsert: a webhook delivered twice yields one message row.
      // DO UPDATE SET provider_message_id = EXCLUDED.provider_message_id is a no-op write
      // that makes RETURNING * return the existing row. (xmax = 0) distinguishes a
      // fresh insert from a conflict-hit so retries don't re-advance / re-score.
      const msgRes = await query(
        `INSERT INTO messages
           (conversation_id, company_id, direction, channel, body, ai_generated, intent,
            provider_message_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (company_id, provider_message_id) WHERE provider_message_id IS NOT NULL
         DO UPDATE SET provider_message_id = EXCLUDED.provider_message_id
         RETURNING *, (xmax::text = '0') AS _inserted`,
        [req.params.id, companyId, direction, channel, body || null,
         ai_generated, intent || null, effectiveProviderId, JSON.stringify(metadata)]
      );
      message = msgRes.rows[0];
      isNewMessage = message._inserted === true;
      delete message._inserted;
    } else {
      const msgRes = await query(
        `INSERT INTO messages
           (conversation_id, company_id, direction, channel, body, ai_generated, intent, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.params.id, companyId, direction, channel, body || null,
         ai_generated, intent || null, JSON.stringify(metadata)]
      );
      message = msgRes.rows[0];
      isNewMessage = true;
    }

    // Update conversation's last_message_at and intent when provided
    const convSets = ['last_message_at = now()', 'updated_at = now()'];
    const convParams = [];
    let cvIdx = 1;
    if (intent) {
      convSets.push(`intent = $${cvIdx++}`);
      convParams.push(intent);
    }
    convParams.push(req.params.id, companyId);
    await query(
      `UPDATE conversations SET ${convSets.join(', ')} WHERE id = $${cvIdx++} AND company_id = $${cvIdx}`,
      convParams
    );

    // For inbound messages: advance marketing stage to 'responded' if valid, then
    // return active campaign tags so the engine can suppress competing outbound.
    // Gated on isNewMessage so a duplicate webhook delivery re-scores/re-advances
    // nothing ("exactly one row" extends to "scores exactly once").
    let active_campaigns = [];
    if (direction === 'inbound' && isNewMessage) {
      const contact = await contactDb.getById(conv.contact_id, companyId);
      if (contact) {
        // The reply is an engagement event: log it to the activity feed AND bump
        // the lead score (channel-mapped weight), so the inbox feeds the score.
        try {
          const replyType = REPLY_EVENT_BY_CHANNEL[channel] || 'message_replied';
          await recordEngagement(conv.contact_id, companyId, {
            type: replyType,
            message: `Inbound ${channel} reply${body ? ': ' + String(body).slice(0, 140) : ''}`,
            agent: 'contact',
            channel,
            data: { conversation_id: req.params.id, provider_message_id: provider_message_id || null, intent: intent || null },
          });
        } catch (_e) { /* non-blocking — message already persisted */ }

        // Workflow trigger: `reply_received`. Guarded by `isNewMessage`, so a
        // provider redelivering the same message id re-enrols nobody — the
        // dedupe that protects the messages table protects the workflow too.
        // A workflow may narrow to one channel via trigger_config.
        workflowTriggers.fire(companyId, conv.contact_id, 'reply_received', { channel });

        // Stage advance: responded is only reachable from engaged per the marketing pipeline.
        try {
          const pipeline = await getPipelineConfig(companyId, 'marketing');
          if (pipeline) {
            const currentStage = contact.marketing_stage || 'sourced';
            const allowed = getPipelineTransitions(pipeline, currentStage);
            // CP1 mode gate: this auto-advance is programmatic by definition
            // (it doesn't go through /advance, so the `automated` body flag
            // never applies here) — a mode:'manual' target stage must never
            // be set by it. Legacy marketing configs carry no mode, so this
            // is a no-op today; it exists so a funnel-typed/overridden config
            // that marks 'responded' manual is respected.
            if (allowed.includes('responded') && !isManualStage(pipeline, 'responded')) {
              await query(
                `UPDATE contacts SET marketing_stage = 'responded', deal_stage = 'responded',
                  updated_at = now() WHERE id = $1 AND company_id = $2`,
                [conv.contact_id, companyId]
              );
              await contactDb.addActivity(conv.contact_id, {
                type: 'stage_change',
                message: `Stage: ${currentStage} → responded (inbound reply)`,
                channel: channel || null,
                data: { pipeline_key: 'marketing', from: currentStage, to: 'responded' },
              }, companyId);
              // GOAL B2: this is a real marketing-pipeline transition outside
              // crm.js's /advance authority — the roadmap names "the existing
              // stage authority" broadly, and this inbound-reply auto-advance
              // is one of its paths too. Called after the UPDATE above persists.
              await sequenceDb.enrollForTriggerStage(companyId, conv.contact_id, 'marketing', 'responded');
            }
          }
        } catch (_e) { /* non-blocking — message already persisted */ }

        const tags = contact.tags || [];
        active_campaigns = tags
          .filter(t => String(t).startsWith('campaign:'))
          .map(t => t.replace('campaign:', ''));
      }
    }

    // Audit: log an outbound send on the contact's activity feed (channel recorded),
    // so "sent a message to contact" shows up alongside replies and stage changes.
    if (direction === 'outbound' && isNewMessage) {
      const subj = metadata && metadata.subject ? ` — "${metadata.subject}"` : '';
      await contactDb.addActivity(conv.contact_id, {
        type: 'message_sent',
        message: `Sent ${channel} message${subj}${body ? ': ' + String(body).slice(0, 140) : ''}${ai_generated ? ' (AI)' : ''}`,
        channel,
        data: { conversation_id: req.params.id, ai_generated: !!ai_generated, provider_message_id: provider_message_id || null, subject: (metadata && metadata.subject) || null },
      }, companyId);
    }

    return res.status(201).json({ message, active_campaigns });
  } catch (err) {
    console.error('[Conversations] POST /conversations/:id/messages error:', err.message);
    res.status(500).json({ error: 'failed to add message' });
  }
});

// GET /api/crm/conversations/:id/messages
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const lim = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows } = await query(
      `SELECT m.* FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
       WHERE m.conversation_id = $1 AND m.company_id = $2
       ORDER BY m.created_at ASC LIMIT $3`,
      [req.params.id, companyId, lim]
    );
    return res.json({ total: rows.length, messages: rows });
  } catch (err) {
    console.error('[Conversations] GET /conversations/:id/messages error:', err.message);
    res.status(500).json({ error: 'failed to load messages' });
  }
});

module.exports = router;
