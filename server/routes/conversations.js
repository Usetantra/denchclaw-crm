'use strict';
// Part 4 — Unified AI Inbox: conversations + messages model
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/index');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');
const contactDb = require('../db/models/contacts');
const { getPipelineConfig, getPipelineTransitions } = require('../db/pipeline');
const { recordEngagement } = require('../lib/scoring');
const resendEmail = require('../lib/email-resend');

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
    const { contact_id, channel, metadata = {} } = req.body;
    if (!contact_id || !channel) return res.status(400).json({ error: 'contact_id and channel required' });

    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const r = await query(
      `INSERT INTO conversations (company_id, contact_id, channel, status, assignee, metadata)
       VALUES ($1,$2,$3,'open','ai',$4)
       ON CONFLICT (contact_id, channel) WHERE status != 'closed'
       DO UPDATE SET updated_at = now(), metadata = conversations.metadata || EXCLUDED.metadata
       RETURNING *`,
      [companyId, contact_id, channel, JSON.stringify(metadata)]
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

        // Stage advance: responded is only reachable from engaged per the marketing pipeline.
        try {
          const pipeline = await getPipelineConfig(companyId, 'marketing');
          if (pipeline) {
            const currentStage = contact.marketing_stage || 'sourced';
            const allowed = getPipelineTransitions(pipeline, currentStage);
            if (allowed.includes('responded')) {
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
