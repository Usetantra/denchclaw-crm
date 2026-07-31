'use strict';
// ─── CP4a-0: the message content store ───────────────────────────────────────
// The prerequisite the roadmap never scoped. Before this, a queued job carried
// `payload = '{}'::jsonb` and a `template_ref` pointing at nothing, so any
// executor built on top of it would have called the provider with an empty
// subject and an empty body and mailed real prospects blank email — while a
// suite asserting only `pending → sent` went green.
//
// THE CONTRACT THIS FILE ESTABLISHES, which the executor may rely on:
//
//   A queued job either carries RESOLVED content, or it is explicitly flagged as
//   carrying none. There is no third state, and no path on which an empty string
//   is mistaken for a message.
//
// That is why `resolveStepContent` never returns `{subject:'', body:''}` and
// calls it success: an unresolvable step comes back `resolved:false` with a
// human-readable `reason`, the reason is frozen into the payload, and the
// executor refuses to send it. Failing loudly at schedule time is recoverable;
// a blank email is not.
//
// PRECEDENCE lives here and nowhere else:
//   1. the step's own inline `body` (a one-off step), else
//   2. the `message_templates` row `template_ref` resolves to, per tenant.
// A subject follows its body's source — mixing a step's body with a template's
// subject would be a third, invisible source of truth.
const { query } = require('../index');
const { resolveTokens } = require('../../lib/ai-draft');

// Channels where a subject is a real field. On the chat-shaped channels a
// subject is meaningless, so its absence must never count as "unresolved".
const SUBJECT_CHANNELS = ['email'];

// A template's `channel` is a PIN, not a filter: NULL means "usable on any
// channel", and a non-NULL value means the copy was written for that channel
// specifically. Resolution deliberately does NOT re-check the pin — by then the
// job is already queued and refusing would strand a contact mid-ladder for a
// config mistake. The pin is enforced at configuration time instead
// (server/routes/sequences.js), which is CP2's stage_writeback lesson: a
// mismatch is an authoring error, and the moment to say so is while the human
// is authoring.
function templateChannelMismatch(template, stepChannel) {
  if (!template || !template.channel || !stepChannel) return null;
  if (template.channel === stepChannel) return null;
  return `template '${template.ref}' is written for '${template.channel}' but this step sends on '${stepChannel}'`;
}

// ─── template CRUD (tenant-scoped) ───────────────────────────────────────────

async function upsertTemplate(companyId, { ref, channel = null, subject = null, body }) {
  if (!companyId) throw new Error('templates.upsertTemplate requires companyId');
  if (!ref || !String(ref).trim()) throw new Error('templates.upsertTemplate requires ref');
  if (!body || !String(body).trim()) throw new Error('templates.upsertTemplate requires a non-empty body');
  const result = await query(
    `INSERT INTO message_templates (company_id, ref, channel, subject, body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, ref) DO UPDATE
       SET channel = EXCLUDED.channel,
           subject = EXCLUDED.subject,
           body    = EXCLUDED.body,
           updated_at = now()
     RETURNING *`,
    [companyId, String(ref).trim(), channel, subject, String(body)]
  );
  return result.rows[0];
}

async function getTemplate(companyId, ref) {
  if (!companyId) throw new Error('templates.getTemplate requires companyId');
  if (!ref) return null;
  const result = await query(
    'SELECT * FROM message_templates WHERE company_id = $1 AND ref = $2',
    [companyId, String(ref).trim()]
  );
  return result.rows[0] || null;
}

async function listTemplates(companyId, { channel = null } = {}) {
  if (!companyId) throw new Error('templates.listTemplates requires companyId');
  const params = [companyId];
  let where = 'company_id = $1';
  if (channel) { params.push(channel); where += ` AND channel = $${params.length}`; }
  const result = await query(
    `SELECT * FROM message_templates WHERE ${where} ORDER BY ref ASC`, params
  );
  return result.rows;
}

async function deleteTemplate(companyId, ref) {
  if (!companyId) throw new Error('templates.deleteTemplate requires companyId');
  const result = await query(
    'DELETE FROM message_templates WHERE company_id = $1 AND ref = $2 RETURNING id',
    [companyId, String(ref || '').trim()]
  );
  return result.rows.length > 0;
}

// ─── resolution ──────────────────────────────────────────────────────────────
// Returns a content descriptor for ONE step and ONE contact. Never throws for
// missing content — "there is nothing to send" is a legitimate, reportable
// state, not an exception, because it must be visible on a dashboard and frozen
// into the job rather than crashing an enrolment.
//
// `client` threads an open transaction through so this can run inside the same
// transaction that materialises the job (CP2's enroll() is transactional).
async function resolveStepContent(companyId, step, contact, { stageLabel = null, client = null } = {}) {
  if (!companyId) throw new Error('templates.resolveStepContent requires companyId');
  const run = (text, params) => (client ? client.query(text, params) : query(text, params));
  const channel = step && step.channel;
  const wantsSubject = SUBJECT_CHANNELS.includes(channel);

  let rawSubject = null, rawBody = null, source = null, templateRef = step ? step.template_ref : null;

  if (step && step.body && String(step.body).trim()) {
    rawBody = step.body;
    rawSubject = step.subject || null;
    source = 'step';
  } else if (templateRef) {
    const t = await run(
      'SELECT subject, body FROM message_templates WHERE company_id = $1 AND ref = $2',
      [companyId, String(templateRef).trim()]
    );
    if (t.rows[0]) {
      rawBody = t.rows[0].body;
      rawSubject = t.rows[0].subject || null;
      source = 'template';
    }
  }

  if (!rawBody || !String(rawBody).trim()) {
    return {
      resolved: false,
      source: null,
      template_ref: templateRef || null,
      subject: null,
      body: null,
      reason: templateRef
        ? `no message content: step has no inline body and no template matches ref '${templateRef}' for this tenant`
        : 'no message content: step has neither an inline body nor a template_ref',
    };
  }

  // Tokens are resolved against THIS contact, at the moment the job is
  // materialised — which for step 5 of a ladder is 16 days after enrolment, so
  // the copy reflects who the contact is when the message actually goes out.
  const tokenCtx = { contact: contact || {}, stageLabel };
  const subject = rawSubject ? resolveTokens(rawSubject, tokenCtx) : null;
  const body = resolveTokens(rawBody, tokenCtx);

  // These two are BLOCKING, not advisory, and that was a deliberate change of
  // mind: as warnings they were recorded and then sent anyway, because nothing
  // downstream was required to read them.
  //
  //  * An unresolved token means the prospect receives a literal "Hi
  //    {first_name},". That is worse than not sending — it is visibly broken
  //    outreach with our name on it.
  //  * An email with no subject reaches the provider, which substitutes
  //    '(no subject)' (server/lib/email-resend.js) — the exact blank-mail
  //    outcome this checkpoint exists to prevent. A whitespace-only subject is
  //    the same thing wearing a disguise, so it is trimmed before the check.
  //
  // Blocking here means the ladder pauses on that rung and the reason is
  // visible on the readiness surface, rather than the CRM emailing something
  // embarrassing to a real person. The operator fixes the copy or the contact
  // data and it flows again.
  const cleanSubject = subject && subject.trim() ? subject.trim() : null;
  const leftover = [...new Set(
    [...String(body + ' ' + (cleanSubject || '')).matchAll(/\{(\w+)\}/g)].map(m => m[1])
  )];
  if (leftover.length) {
    return {
      resolved: false, source, template_ref: templateRef || null, subject: null, body: null,
      reason: `content would ship unresolved tokens (${leftover.join(', ')}) — the contact is missing those fields, or the copy references a token that does not exist`,
    };
  }
  if (wantsSubject && !cleanSubject) {
    return {
      resolved: false, source, template_ref: templateRef || null, subject: null, body: null,
      reason: 'email content has no subject — the provider would substitute "(no subject)"',
    };
  }

  return { resolved: true, source, template_ref: templateRef || null, subject: cleanSubject, body, reason: null, warnings: [] };
}

// The payload frozen into `scheduled_actions.payload`. Shape is deliberately
// flat and self-describing: an executor reads `content_resolved` first and
// refuses anything false, then sends `subject`/`body` verbatim. It never has to
// look up a template, a contact or a step — i.e. it never reaches around the
// claim/ack contract to find out what to send.
function contentPayload(resolved, extra = {}) {
  // Caller metadata is spread FIRST and every content_* key is then written
  // unconditionally — including the null cases. Writing them conditionally let
  // a caller-supplied `content_error` survive into a resolved payload and
  // misclassify a perfectly good job for anything keying off that field.
  const caller = { ...(extra && typeof extra === 'object' ? extra : {}) };
  delete caller.content_resolved; delete caller.content_error;
  delete caller.content_source; delete caller.subject; delete caller.body;
  return {
    ...caller,
    content_resolved: resolved.resolved,
    content_source: resolved.source,
    template_ref: resolved.template_ref,
    subject: resolved.subject,
    body: resolved.body,
    content_error: resolved.resolved ? null : resolved.reason,
  };
}

// Operator-facing readiness: which steps of a sequence would go out blank?
// Answers the question BEFORE the ladder fires at anyone, which is the only
// time the answer is cheap.
async function sequenceContentReadiness(companyId, sequenceId, { sampleContact = null } = {}) {
  if (!companyId) throw new Error('templates.sequenceContentReadiness requires companyId');
  const steps = await query(
    `SELECT ss.id, ss.step_order, ss.channel, ss.template_ref, ss.subject, ss.body
       FROM sequence_steps ss
      WHERE ss.sequence_id = $1 AND ss.company_id = $2
      ORDER BY ss.step_order ASC`,
    [sequenceId, companyId]
  );
  const out = [];
  for (const step of steps.rows) {
    const r = await resolveStepContent(companyId, step, sampleContact);
    out.push({
      step_id: step.id, step_order: step.step_order, channel: step.channel,
      template_ref: step.template_ref,
      resolved: r.resolved, source: r.source, reason: r.reason,
      warnings: r.warnings || [],
      subject_preview: r.subject, body_preview: r.body ? String(r.body).slice(0, 200) : null,
    });
  }
  return {
    sequence_id: sequenceId,
    total_steps: out.length,
    unresolved_steps: out.filter(s => !s.resolved).length,
    // The one line an operator needs: is this sequence safe to switch on?
    sendable: out.length > 0 && out.every(s => s.resolved),
    steps: out,
  };
}

module.exports = {
  upsertTemplate, getTemplate, listTemplates, deleteTemplate, templateChannelMismatch,
  resolveStepContent, contentPayload, sequenceContentReadiness,
  SUBJECT_CHANNELS,
};
