'use strict';
// ─── DenchClaw chat ──────────────────────────────────────────────────────────
// A natural-language assistant over the CRM. Pulls a compact snapshot of the
// caller's contacts + stats, hands it to Cloudflare Workers AI (same provider the
// rest of the Tantra stack uses), and returns the reply. Read-only: it answers
// questions about the pipeline, it does not mutate data.
const express = require('express');
const router = express.Router();
const contactDb = require('../db/models/contacts');
const { requireAuth, getUserCompanyId } = require('../middleware/auth');

router.use(requireAuth);

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_AI_TOKEN;
const CF_MODEL = process.env.CLOUDFLARE_CHAT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_CONTEXT_CONTACTS = 80;

function compactContact(c) {
  return {
    name: c.name || null,
    company: c.company_name || null,
    title: c.title || null,
    email: c.email || null,
    stage: c.deal_stage || null,
    score: c.lead_score || null,
    source: c.source || null,
    next_follow_up: c.next_follow_up || null,
    created: c.created_at || null,
  };
}

async function buildContext(companyId) {
  const [stats, contacts] = await Promise.all([
    contactDb.getStats(companyId).catch(() => null),
    contactDb.list(companyId, {}).catch(() => []),
  ]);
  const trimmed = (contacts || []).slice(0, MAX_CONTEXT_CONTACTS).map(compactContact);
  return { stats, contactCount: (contacts || []).length, contacts: trimmed };
}

function systemPrompt(ctx) {
  return [
    'You are DenchClaw, the built-in AI assistant for the DenchClaw CRM.',
    'You help the operator understand and reason about their sales pipeline.',
    'Answer ONLY from the CRM snapshot below. If the snapshot does not contain the',
    'answer, say so plainly. Be concise, friendly, and specific. Use names and numbers',
    'from the data. You are read-only — if asked to change data, explain that edits',
    'must be made through the engines or API, and offer to summarize instead.',
    '',
    `CRM SNAPSHOT (company: ${ctx._companyId}, ${ctx.contactCount} contacts total):`,
    'STATS: ' + JSON.stringify(ctx.stats),
    'CONTACTS: ' + JSON.stringify(ctx.contacts),
  ].join('\n');
}

async function callCloudflare(messages) {
  if (!CF_ACCOUNT || !CF_TOKEN) {
    const err = new Error('Chat is not configured (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_AI_TOKEN missing).');
    err.status = 503;
    throw err;
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${CF_MODEL}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, max_tokens: 800, temperature: 0.3 }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) {
      const msg = (j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare AI HTTP ${r.status}`;
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    // Workers AI (OpenAI-compat) shape OR legacy {result:{response}}
    const reply =
      j?.result?.choices?.[0]?.message?.content ??
      j?.result?.response ??
      j?.choices?.[0]?.message?.content ??
      '';
    return String(reply).trim();
  } finally {
    clearTimeout(t);
  }
}

// POST /api/crm/chat   { message: string, history?: [{role,content}] }
//                  or  { messages: [{role,content}] }
router.post('/', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const body = req.body || {};
    let convo = Array.isArray(body.messages) ? body.messages : [];
    if (!convo.length && body.message) {
      convo = [...(Array.isArray(body.history) ? body.history : []), { role: 'user', content: String(body.message) }];
    }
    convo = convo
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12);
    if (!convo.length) return res.status(400).json({ error: 'No message provided' });

    const ctx = await buildContext(companyId);
    ctx._companyId = companyId;
    const messages = [{ role: 'system', content: systemPrompt(ctx) }, ...convo];
    const reply = await callCloudflare(messages);
    res.json({ reply, model: CF_MODEL, context: { contactCount: ctx.contactCount } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'chat failed' });
  }
});

module.exports = router;
