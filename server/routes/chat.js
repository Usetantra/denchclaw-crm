'use strict';
// ─── DenchClaw chat ──────────────────────────────────────────────────────────
// A natural-language assistant over the CRM. READ + WRITE.
//
// Design note: we deliberately do NOT use Cloudflare's native function-calling
// (`tools`) mode. With a tools array attached, Llama flips into a mode where it
// compulsively invents arguments to call a tool (e.g. fabricating "John Doe")
// and refuses anything without a matching function ("your function definitions
// are not comprehensive enough"). Instead we run ordinary chat: the model either
// answers in plain text, or — only when a change/lookup is genuinely needed —
// emits a small JSON action block that we parse and execute against the CRM's
// own HTTP routes. Ordinary chat follows the system prompt reliably, so it
// answers counts from the snapshot and asks for missing details instead of
// making them up. All writes reuse existing routes (validation, stage-transition
// rules, activity logging). It cannot delete anything.
const express = require('express');
const router = express.Router();
const contactDb = require('../db/models/contacts');
const { requireAuth, getUserCompanyId, INTERNAL_API_KEY } = require('../middleware/auth');
const { getPipelineConfig } = require('../db/pipeline');

router.use(requireAuth);

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_TOKEN = process.env.CLOUDFLARE_AI_TOKEN;
const CF_MODEL = process.env.CLOUDFLARE_CHAT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_CONTEXT_CONTACTS = 80;

// Loopback base for internal self-calls — 127.0.0.1 satisfies the auth CIDR gate.
const SELF_BASE = `http://127.0.0.1:${process.env.PORT || 3100}/api/crm`;

// Fallback only — the live list is derived from crm_pipeline_configs per
// request (via the shared 60s-TTL loader) so the prompt tracks the seeded
// configs instead of a hardcoded list. 'lead'/'proposal_accepted' are legacy
// stages contacts can still sit in.
const FALLBACK_DEAL_STAGES = ['lead', 'accepted', 'contacted', 'booked', 'qualified', 'no_show', 'unqualified', 'proposal', 'proposal_accepted', 'negotiation', 'onboarding', 'won', 'lost', 'nurture'];
const LEAD_SCORES = ['hot', 'warm', 'neutral', 'cold'];

// Build the deal-stage vocabulary from the sales pipeline JSONB config (same
// authority as POST /advance and PATCH {deal_stage}). 'lead' is kept as the
// legacy default stage new contacts start in. Falls back to the static list
// when configs are absent/unreadable.
async function getDealStages(companyId) {
  try {
    const pipeline = await getPipelineConfig(companyId, 'sales');
    if (pipeline && Array.isArray(pipeline.stages) && pipeline.stages.length) {
      const keys = pipeline.stages.map(s => s.key).filter(Boolean);
      if (keys.length) return keys.includes('lead') ? keys : ['lead', ...keys];
    }
  } catch (_e) { /* fall through */ }
  return FALLBACK_DEAL_STAGES;
}
const WRITE_TOOLS = new Set(['create_contact', 'update_contact', 'add_note', 'delete_contact']);

function compactContact(c) {
  return {
    id: c.id,
    name: c.name || null,
    company: c.company_name || null,
    title: c.title || null,
    email: c.email || null,
    phone: c.phone || null,
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
    'You are Tantra, the built-in AI assistant for the CRM.',
    'You help the operator understand AND manage their sales pipeline.',
    `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
    '',
    'The CRM SNAPSHOT at the end is live data about THIS user\'s pipeline.',
    'Questions about counts, totals, stages, lead scores, who is in the pipeline,',
    'or any summary are ALWAYS answerable directly from the SNAPSHOT and STATS —',
    'answer them in plain text. Never say a request is outside your scope.',
    '',
    'You can also CHANGE the CRM by performing actions. The available actions are:',
    '- create_contact  args: {name, email?, phone?, company?, title?, source?, lead_score?, tags?[], notes?}',
    '- update_contact  args: {contact_id? | email? | name?, set:{name?,email?,phone?,company?,title?,deal_stage?,lead_score?,deal_value?,next_follow_up?,tags?[]}, note?}',
    '- add_note        args: {contact_id? | email? | name?, message}',
    '- delete_contact  args: {email? | contact_id? | name?}   (PERMANENT — see DELETING below)',
    '- find_contacts   args: {query?, stage?, limit?}   (use only if the snapshot lacks a specific person)',
    `  deal_stage must be one of: ${(ctx._dealStages || FALLBACK_DEAL_STAGES).join(', ')}.`,
    `  lead_score must be one of: ${LEAD_SCORES.join(', ')}.`,
    '  next_follow_up must be an ISO date like 2026-07-15.',
    '',
    'HOW TO ACT: When (and only when) you need to perform one or more actions,',
    'respond with a SINGLE JSON object and NOTHING ELSE — no prose, no markdown:',
    '{"actions":[{"tool":"<name>","args":{...}}]}',
    'A follow-up turn will then let you confirm the result to the user in words.',
    '',
    'CRITICAL RULES:',
    '- NEVER invent data. Do not make up names, emails, phones, or companies.',
    '- If the user asks to create/update but has not given the needed details',
    '  (a real name or email to create; which contact + what to change to update),',
    '  do NOT emit actions. Instead ask a short, friendly question for the missing',
    '  info. Placeholders like "John Doe" or "john@example.com" are never allowed.',
    '- For questions, greetings, counts, and summaries, reply in plain text only —',
    '  never emit JSON.',
    '- DELETING is permanent and cannot be undone. Identify the contact by email.',
    '  When the user asks to delete someone, do NOT emit a delete action yet — first',
    '  reply in plain text with the contact\'s details and ask them to reply exactly',
    '  "DELETE" to confirm. ONLY when the user\'s latest message is exactly DELETE,',
    '  emit {"actions":[{"tool":"delete_contact","args":{"email":"..."}}]} for the',
    '  contact discussed just before. If a delete result says "needs_confirmation",',
    '  relay that confirmation request. You cannot delete deals.',
    '- Email is the unique identifier for a contact. If you try to create a contact',
    '  whose email already exists, the action returns a "duplicate" result — tell the',
    '  user it already exists (with its current details) and offer to update it',
    '  instead; do not create a second copy.',
    '',
    `CRM SNAPSHOT (company: ${ctx._companyId}, ${ctx.contactCount} contacts total):`,
    'STATS: ' + JSON.stringify(ctx.stats),
    'CONTACTS: ' + JSON.stringify(ctx.contacts),
  ].join('\n');
}

// ─── Internal self-call helper ────────────────────────────────────────────────
async function callSelf(method, pathAndQuery, companyId, body) {
  const r = await fetch(`${SELF_BASE}${pathAndQuery}`, {
    method,
    headers: {
      'X-Internal-Key': INTERNAL_API_KEY,
      'X-Company-Id': companyId,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

// Resolve a contact reference {contact_id|email|name} → { id } | { error } | { ambiguous }
async function resolveContact(args, companyId) {
  if (args.contact_id) {
    const r = await callSelf('GET', `/contacts/${encodeURIComponent(args.contact_id)}`, companyId);
    if (r.ok && r.json && r.json.id) return { id: r.json.id, contact: r.json };
    return { error: `No contact found with id ${args.contact_id}.` };
  }
  const term = args.email || args.name;
  if (!term) return { error: 'Provide contact_id, email, or name to identify the contact.' };
  const r = await callSelf('GET', `/contacts?search=${encodeURIComponent(term)}&limit=25`, companyId);
  const rows = (r.json && (r.json.contacts || r.json.data || r.json)) || [];
  const list = Array.isArray(rows) ? rows : [];
  let matches = list;
  if (args.email) {
    matches = list.filter(c => (c.email || '').toLowerCase() === args.email.toLowerCase());
  } else if (args.name) {
    const exact = list.filter(c => (c.name || '').toLowerCase() === args.name.toLowerCase());
    if (exact.length) matches = exact;
  }
  if (matches.length === 1) return { id: matches[0].id, contact: matches[0] };
  if (matches.length === 0) return { error: `No contact found matching "${term}".` };
  return { ambiguous: matches.slice(0, 8).map(compactContact) };
}

// ─── Action execution ─────────────────────────────────────────────────────────
// opts.confirmed — set true only when the user's current message is the literal
// DELETE confirmation. Guards the destructive delete_contact action.
async function executeAction(name, args, companyId, opts = {}) {
  args = args || {};
  try {
    if (name === 'find_contacts') {
      const qs = new URLSearchParams();
      if (args.query) qs.set('search', args.query);
      if (args.stage) qs.set('deal_stage', args.stage);
      qs.set('limit', String(Math.min(parseInt(args.limit, 10) || 20, 50)));
      const r = await callSelf('GET', `/contacts?${qs.toString()}`, companyId);
      const rows = (r.json && (r.json.contacts || r.json.data || r.json)) || [];
      const list = (Array.isArray(rows) ? rows : []).map(compactContact);
      return { count: list.length, contacts: list };
    }

    if (name === 'create_contact') {
      if (!args.name && !args.email) return { error: 'A name or email is required to create a contact.' };
      // Email is the unique key: refuse to create (or silently upsert) a duplicate.
      if (args.email) {
        const existing = await resolveContact({ email: args.email }, companyId);
        const dup = existing.id ? existing.contact : (existing.ambiguous ? existing.ambiguous[0] : null);
        if (dup) {
          return { duplicate: compactContact(dup), message: `A contact with email ${args.email} already exists — no duplicate was created.` };
        }
      }
      const r = await callSelf('POST', '/contacts', companyId, {
        name: args.name, email: args.email, phone: args.phone, company: args.company,
        title: args.title, source: args.source, lead_score: args.lead_score,
        tags: args.tags, notes: args.notes,
      });
      if (!r.ok) return { error: r.json.error || `create failed (HTTP ${r.status})` };
      return { created: compactContact(r.json) };
    }

    if (name === 'update_contact') {
      const set = args.set || {};
      if (!set || Object.keys(set).length === 0) return { error: 'No fields provided to update.' };
      const resolved = await resolveContact(args, companyId);
      if (resolved.error) return { error: resolved.error };
      if (resolved.ambiguous) return { needs_disambiguation: resolved.ambiguous, hint: 'Multiple contacts matched — ask the user which one, then use its contact_id.' };
      const body = { ...set };
      if (set.company !== undefined) { body.company_name = set.company; delete body.company; }
      if (args.note) { body.activity_message = args.note; body.activity_type = 'note'; }
      const r = await callSelf('PATCH', `/contacts/${encodeURIComponent(resolved.id)}`, companyId, body);
      if (!r.ok) {
        return { error: r.json.error || `update failed (HTTP ${r.status})`, allowed_transitions: r.json.allowed_transitions, current_stage: r.json.current_stage };
      }
      return { updated: compactContact(r.json) };
    }

    if (name === 'add_note') {
      if (!args.message) return { error: 'A message is required.' };
      const resolved = await resolveContact(args, companyId);
      if (resolved.error) return { error: resolved.error };
      if (resolved.ambiguous) return { needs_disambiguation: resolved.ambiguous };
      const r = await callSelf('PATCH', `/contacts/${encodeURIComponent(resolved.id)}`, companyId, {
        activity_message: args.message, activity_type: 'note',
      });
      if (!r.ok) return { error: r.json.error || `add_note failed (HTTP ${r.status})` };
      return { noted: true, contact_id: resolved.id };
    }

    if (name === 'delete_contact') {
      const resolved = await resolveContact(args, companyId);
      if (resolved.error) return { error: resolved.error };
      if (resolved.ambiguous) return { needs_disambiguation: resolved.ambiguous };
      // Server-side confirmation gate: never delete unless the user's current
      // message was the literal DELETE confirmation, regardless of what the model asked for.
      if (!opts.confirmed) {
        return {
          needs_confirmation: true,
          target: compactContact(resolved.contact),
          message: `Deleting is permanent. Ask the user to reply DELETE to confirm removing ${resolved.contact.email || resolved.contact.name}.`,
        };
      }
      const r = await callSelf('DELETE', `/contacts/${encodeURIComponent(resolved.id)}`, companyId);
      if (!r.ok) return { error: r.json.error || `delete failed (HTTP ${r.status})` };
      return { deleted: compactContact((r.json && r.json.deleted) || resolved.contact) };
    }

    return { error: `Unknown action: ${name}` };
  } catch (err) {
    return { error: err.message || 'action execution failed' };
  }
}

// A coarse, content-light key identifying a write's target, so the same change
// can't be applied to the same contact twice in one turn.
function writeGuardKey(name, a) {
  const who = a.contact_id || a.email || a.name || '?';
  if (name === 'create_contact') return `create:${(a.email || a.name || '').toLowerCase()}`;
  if (name === 'update_contact') return `update:${String(who).toLowerCase()}`;
  if (name === 'add_note') return `note:${String(who).toLowerCase()}:${(a.message || '').trim().toLowerCase()}`;
  if (name === 'delete_contact') return `delete:${String(who).toLowerCase()}`;
  return `x:${name}`;
}

// ─── Model call (plain chat, NO tools) ────────────────────────────────────────
async function cloudflareRun(messages) {
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
      body: JSON.stringify({ messages, max_tokens: 800, temperature: 0.2 }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) {
      const msg = (j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare AI HTTP ${r.status}`;
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    return String(
      j?.result?.choices?.[0]?.message?.content ??
      j?.result?.response ??
      j?.choices?.[0]?.message?.content ??
      ''
    ).trim();
  } finally {
    clearTimeout(t);
  }
}

// Pull a {"actions":[...]} object out of the model's reply. Returns the actions
// array, or null if the reply is ordinary prose (the common case for reads and
// clarifying questions).
function parseActions(text) {
  if (!text || text.indexOf('"actions"') === -1) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  // Balanced-brace scan for the first complete JSON object.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(candidate);
          if (obj && Array.isArray(obj.actions) && obj.actions.length) return obj.actions;
        } catch { /* not valid JSON — treat as prose */ }
        return null;
      }
    }
  }
  return null;
}

// ─── Orchestration ────────────────────────────────────────────────────────────
async function runChat(convo, companyId, ctx) {
  const messages = [{ role: 'system', content: systemPrompt(ctx) }, ...convo];
  const first = await cloudflareRun(messages);
  const actionSpecs = parseActions(first);

  // No actions → ordinary reply (answer, greeting, or clarifying question).
  if (!actionSpecs) return { reply: first, actions: [] };

  // Was the user's current message the literal DELETE confirmation? This — not
  // anything the model claims — is what authorizes a destructive delete.
  const lastUserMsg = [...convo].reverse().find(m => m.role === 'user');
  const userConfirmedDelete = !!lastUserMsg && lastUserMsg.content.trim().toUpperCase() === 'DELETE';

  // Execute requested actions, each write applied at most once per target.
  const results = [];
  const writesDone = new Set();
  for (const spec of actionSpecs.slice(0, 8)) {
    const name = spec.tool || spec.name;
    const args = spec.args || spec.arguments || {};
    if (!name) continue;
    if (WRITE_TOOLS.has(name)) {
      const key = writeGuardKey(name, args);
      if (writesDone.has(key)) {
        results.push({ tool: name, arguments: args, result: { skipped: true, reason: 'already applied this turn' } });
        continue;
      }
      writesDone.add(key);
    }
    const result = await executeAction(name, args, companyId, { confirmed: userConfirmedDelete });
    results.push({ tool: name, arguments: args, result });
  }

  // Second pass (no snapshot needed, no JSON) → plain-language confirmation.
  const lastUser = lastUserMsg;
  const summarySystem = [
    'You are Tantra, the CRM assistant. You just performed actions on the user\'s',
    'CRM. Given the results, reply to the user in plain, friendly language, confirming',
    'exactly what changed using the real names and values from the results.',
    'If a result has "error", explain it plainly. If it has "needs_disambiguation",',
    'list the matches and ask which one they mean. If it has "allowed_transitions",',
    'tell the user which stage changes are allowed. If it has "duplicate", tell the',
    'user a contact with that email already exists, show its current details, make',
    'clear NO duplicate was created, and offer to update it instead.',
    'If it has "needs_confirmation", show the contact\'s details and ask the user to',
    'reply DELETE to permanently delete it (nothing has been deleted yet).',
    'If it has "deleted", confirm the contact was permanently deleted, by name/email.',
    'Do NOT output JSON.',
  ].join('\n');
  const summaryMessages = [
    { role: 'system', content: summarySystem },
    { role: 'user', content: `My request: "${lastUser ? lastUser.content : ''}"\n\nAction results:\n${JSON.stringify(results, null, 2)}` },
  ];
  const reply = await cloudflareRun(summaryMessages);
  return { reply: reply || 'Done.', actions: results };
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
    ctx._dealStages = await getDealStages(companyId);
    const { reply, actions } = await runChat(convo, companyId, ctx);
    res.json({ reply, model: CF_MODEL, actions, context: { contactCount: ctx.contactCount } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'chat failed' });
  }
});

module.exports = router;
