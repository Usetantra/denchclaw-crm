'use strict';
// ─── Sequence dispatcher (Goal B3) ────────────────────────────────────────────
// The always-on tick that turns scheduled steps into real sends. It CLAIMS due
// actions (FOR UPDATE SKIP LOCKED, so multiple workers never double-send), then
// delivers each through the CRM's OWN internal API — find-or-create a conversation
// and POST an outbound message with deliver:true. That means every send passes the
// same compliance gate, 24h-window/template logic and provider adapters already
// built; the dispatcher adds no second send path. Timing, quiet-hours, retry and
// exit-on-suppression are applied here, centrally, exactly once.
const seq = require('../db/models/sequences');

const PORT = process.env.PORT || 3100;
const SELF = `http://127.0.0.1:${PORT}`;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const TICK_MS = Math.max(5000, parseInt(process.env.SEQUENCE_TICK_MS, 10) || 30000);
const BATCH = Math.max(1, parseInt(process.env.SEQUENCE_BATCH, 10) || 20);
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SEQUENCE_MAX_ATTEMPTS, 10) || 5);

let timer = null;
let running = false;

async function api(method, path, payload, company) {
  const r = await fetch(SELF + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY, 'x-company-id': company },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let json = null; try { json = await r.json(); } catch (_e) {}
  return { status: r.status, json };
}

// Current wall-clock time-of-day in a tz, as minutes past midnight.
function minutesOfDayInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = (parseInt(parts.find(p => p.type === 'hour').value, 10) || 0) % 24;
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10) || 0;
  return h * 60 + m;
}

// If now is inside the sequence's quiet window, minutes until it ends; else 0.
function quietDeferMinutes(quiet) {
  if (!quiet || !quiet.start || !quiet.end) return 0;
  const cur = minutesOfDayInTz(quiet.tz);
  const [sh, sm] = String(quiet.start).split(':').map(Number);
  const [eh, em] = String(quiet.end).split(':').map(Number);
  const start = sh * 60 + (sm || 0), end = eh * 60 + (em || 0);
  const inQuiet = start < end ? (cur >= start && cur < end) : (cur >= start || cur < end); // handles overnight
  if (!inQuiet) return 0;
  const mins = ((end - cur) + 1440) % 1440;
  return mins === 0 ? 1 : mins;
}

// Cache the merged sender map per company for one tick.
async function sendersFor(company, cache) {
  if (cache.has(company)) return cache.get(company);
  const r = await api('GET', '/api/crm/channel-senders', null, company);
  const map = (r.json && r.json.senders) || {};
  cache.set(company, map);
  return map;
}

function pickSender(map, channel) {
  const list = (map && map[channel]) || [];
  const def = list.find(s => s.default) || list[0];
  return def ? def.identity : null;
}

function backoff(attempts) { return Math.min(60, 15 * (attempts + 1)); }

// Process one claimed action end-to-end.
async function processAction(a, senderCache) {
  const company = a.company_id;
  const enrollment = await seq.getEnrollment(company, a.enrollment_id);
  if (!enrollment) return seq.completeAction(company, a, { status: 'canceled', result: { reason: 'enrollment_gone' } });
  if (enrollment.status === 'paused') return seq.deferAction(company, a.id, 30);
  if (enrollment.status !== 'active') return seq.completeAction(company, a, { status: 'canceled', result: { reason: `enrollment_${enrollment.status}` } });

  const sequence = await seq.get(company, a.sequence_id);
  if (!sequence) return seq.completeAction(company, a, { status: 'canceled', result: { reason: 'sequence_gone' } });
  if (sequence.status === 'paused') return seq.deferAction(company, a.id, 30);
  if (sequence.status !== 'active') return seq.completeAction(company, a, { status: 'canceled', result: { reason: `sequence_${sequence.status}` } });

  // Quiet hours — hold the step until the window closes (no attempt consumed).
  const defer = quietDeferMinutes(sequence.quiet_hours);
  if (defer > 0) return seq.deferAction(company, a.id, defer);

  const step = (sequence.steps || []).find(s => s.id === a.step_id) || { channel: a.channel };

  // A 'wait' step is a pure delay — mark done and advance.
  if (step.channel === 'wait') return seq.completeAction(company, a, { status: 'sent', result: { wait: true } });

  // Pick the connected sender for this channel.
  const senders = await sendersFor(company, senderCache);
  const from = pickSender(senders, step.channel);
  if (!from) {
    if (a.attempts + 1 >= MAX_ATTEMPTS) return seq.completeAction(company, a, { status: 'failed', error: `no ${step.channel} sender connected` });
    return seq.retryAction(company, a.id, backoff(a.attempts), `no ${step.channel} sender connected`);
  }

  // Find-or-create the channel conversation, then send through the internal API
  // (compliance gate + provider adapter live there).
  const conv = await api('POST', '/api/crm/conversations', { contact_id: a.contact_id, channel: step.channel }, company);
  const convId = conv.json && conv.json.id;
  if (!convId) return seq.retryAction(company, a.id, backoff(a.attempts), `conversation create failed (${conv.status})`);

  const metadata = { from, category: step.category || undefined };
  if (step.subject) metadata.subject = step.subject;
  if (step.template_id) metadata.template_id = step.template_id;
  if (step.metadata && step.metadata.template_variables) metadata.template_variables = step.metadata.template_variables;

  const send = await api('POST', `/api/crm/conversations/${convId}/messages`,
    { direction: 'outbound', channel: step.channel, body: step.body || '', ai_generated: false, metadata, deliver: true }, company);

  if (send.status >= 200 && send.status < 300) {
    return seq.completeAction(company, a, { status: 'sent', result: { conversation_id: convId, message: send.json && send.json.id } });
  }
  // Compliance / validation block (4xx): record and advance; a hard opt-out also
  // exits the whole enrollment so no further steps fire.
  if (send.status >= 400 && send.status < 500) {
    const code = (send.json && send.json.code) || null;
    if (code === 'suppressed') await seq.exitContact(company, a.contact_id, 'suppressed');
    return seq.completeAction(company, a, { status: 'skipped', result: { reason: code || 'blocked', http: send.status }, error: send.json && send.json.error });
  }
  // Transient (5xx / network): retry with backoff, then fail-advance.
  if (a.attempts + 1 >= MAX_ATTEMPTS) {
    return seq.completeAction(company, a, { status: 'failed', result: { http: send.status }, error: (send.json && send.json.error) || 'send failed' });
  }
  return seq.retryAction(company, a.id, backoff(a.attempts), (send.json && send.json.error) || `send failed (${send.status})`);
}

async function tick() {
  if (running) return { skipped: 'overlap' };
  running = true;
  const senderCache = new Map();
  let processed = 0, errors = 0;
  try {
    const due = await seq.claimDueActions(BATCH);
    for (const a of due) {
      try { await processAction(a, senderCache); processed++; }
      catch (e) { errors++; console.error('[Dispatcher] action', a.id, 'failed:', e.message); try { await seq.retryAction(a.company_id, a.id, 15, e.message); } catch (_e) {} }
    }
  } catch (e) {
    console.error('[Dispatcher] tick error:', e.message);
  } finally {
    running = false;
  }
  if (processed) console.log(`[Dispatcher] tick: ${processed} sent/advanced, ${errors} errored`);
  return { processed, errors };
}

function start() {
  if (process.env.SEQUENCE_DISPATCHER === 'off') { console.log('[Dispatcher] disabled (SEQUENCE_DISPATCHER=off)'); return; }
  if (!INTERNAL_KEY) { console.warn('[Dispatcher] no INTERNAL_API_KEY — dispatcher cannot self-call; not starting'); return; }
  if (timer) return;
  timer = setInterval(() => { tick().catch(e => console.error('[Dispatcher]', e.message)); }, TICK_MS);
  if (timer.unref) timer.unref(); // never keep the process alive on the tick alone
  console.log(`[Dispatcher] started — every ${TICK_MS}ms, batch ${BATCH}`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, processAction, quietDeferMinutes };
