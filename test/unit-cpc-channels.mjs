#!/usr/bin/env node
// DenchClaw CRM — CP-C per-channel executors (SMS + WhatsApp via Twilio).
//
// REWRITTEN 2026-08-15 (CP-M2 resolution, "replace it"): the automated
// dispatcher's sms/whatsapp providers now go through the SAME compliance-gated
// path the composer uses (server/lib/twilio.js + compliance-gate.js), resolved
// per-tenant from `channel_connections`/`channel_senders` — not
// TWILIO_ACCOUNT_SID/TWILIO_PHONE env vars, which no longer wire into
// server/lib/executors.js at all. See server/lib/twilio-compliant-provider.js
// and .loop/DECISIONS_PENDING.md (CP-M2) for the rationale.
//
// NO REAL PROVIDER IS EVER CONTACTED. A local stub is started and
// TWILIO_API_BASE points at it — the seam added to server/lib/twilio.js
// specifically so this suite could exist without hitting real Twilio. The stub
// records every request, which is how "exactly once" is proven rather than
// assumed.
import http from 'node:http';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import templatesDb from '../server/db/models/templates.js';
import channelsDb from '../server/db/models/channels.js';
import suppressionDb from '../server/db/models/suppression.js';

const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpc_co_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0; const results = [];
const check = (n, ok, d) => { if (ok) { pass++; results.push(`  PASS  ${n}`); } else { fail++; results.push(`  FAIL  ${n} — ${d}`); } };

const SMS_NUMBER = '+15550001111';
const WA_NUMBER = 'whatsapp:+15550001111';

const stub = { mode: 'ok', requests: [] };
const stubServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
  stub.requests.push({ form, headers: req.headers });
  if (stub.mode === 'hang') return;
  if (stub.mode === 'reject4xx') { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'is not a valid phone number', code: 21211 })); }
  if (stub.mode === 'reject401') { res.writeHead(401, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'authenticate' })); }
  if (stub.mode === 'ratelimit') { res.writeHead(429, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'too many', code: 20429 })); }
  if (stub.mode === 'error5xx') { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({ message: 'unavailable' })); }
  res.writeHead(201, {'content-type':'application/json'});
  res.end(JSON.stringify({ sid: `SM${stub.requests.length}`, status: 'queued' }));
});

async function main() {
  await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
  const port = stubServer.address().port;
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${port}`;
  process.env.TWILIO_TIMEOUT_MS = '600';
  process.env.SMS_EXECUTOR_ENABLED = '1';
  process.env.WHATSAPP_EXECUTOR_ENABLED = '1';

  const { sms, whatsapp } = await import('../server/lib/executors.js').then(m => m.default || m);
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  // A connected Twilio tenant with a default sender per channel — what an
  // operator sets up in Settings → Channels, not an env var.
  async function connectTenant(companyId) {
    await channelsDb.upsertConnection(companyId, 'twilio', {
      accountRef: 'ACstub', credentials: { account_sid: 'ACstub', auth_token: 'stub-token-not-real' }, status: 'connected',
    });
    await channelsDb.addSender(companyId, { channel: 'sms', identifier: SMS_NUMBER, is_default: true });
    await channelsDb.addSender(companyId, { channel: 'whatsapp', identifier: WA_NUMBER, is_default: true });
  }
  await connectTenant(CO);

  const jobsFor = async (e) => (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at', [e])).rows;
  const jobRow = async (id) => (await db.query('SELECT * FROM scheduled_actions WHERE id=$1', [id])).rows[0];
  // WhatsApp free-text requires an open 24h customer-service window, per
  // compliance-gate.js — set it open so the happy-path tests exercise the
  // send, not the gate's (separately tested) refusal.
  const openWaWindow = (contactId) =>
    db.query(`UPDATE contacts SET cs_window_expires_at = now() + interval '24 hours' WHERE id=$1`, [contactId]);
  let n = 0;
  async function mkJob(channel, { phone = '+15557654321', body = 'Hi {first_name}, real copy.', companyId = CO } = {}) {
    n++;
    const ref = `cpc_${RUN}_${n}`;
    await templatesDb.upsertTemplate(companyId, { ref, channel, body });
    const c = await contactDb.create({ name: `CPC P${n}`, email: `cpc${n}-${RUN}@ex.test`, phone, company_id: companyId });
    if (channel === 'whatsapp') await openWaWindow(c.id);
    const s = await seqDb.createSequence({ companyId, name: `cpc ${RUN} ${n}`, pipelineKey: 'webinar_sales' });
    await seqDb.addStep(s.id, companyId, { stepOrder: 1, channel, templateRef: ref });
    const e = await seqDb.enroll(companyId, { sequenceId: s.id, contactId: c.id });
    const j = (await jobsFor(e.id))[0];
    await db.query(`UPDATE scheduled_actions SET scheduled_for=now()-interval '1 minute' WHERE id=$1`, [j.id]);
    return { job: j, contact: c };
  }

  // ── C-1 — the boot gate is now PERMISSIVE (per-tenant checks moved to preflight) ─
  process.env.SMS_EXECUTOR_ENABLED = '0';
  check('C-1 SMS is off unless explicitly enabled', /not 1/.test(sms.bootGate() || ''));
  process.env.SMS_EXECUTOR_ENABLED = '1';
  check('C-1 the sync boot gate no longer depends on env-var Twilio config', sms.bootGate() === null, String(sms.bootGate()));
  check('C-1 …same for WhatsApp', whatsapp.bootGate() === null, String(whatsapp.bootGate()));

  // ── C-1b — the REAL per-tenant gate is the async preflight ────────────────
  const UNCONNECTED = 'cpc_unco_' + RUN;
  await tenantDb.create({ id: UNCONNECTED, name: UNCONNECTED, slug: UNCONNECTED });
  const uJob = await mkJob('sms', { companyId: UNCONNECTED });
  const rUnco = await sms.tick(UNCONNECTED);
  check('C-1b an unconnected tenant is blocked at preflight, not booted as configured',
    rUnco.ok === false && /not connected/.test(rUnco.blocked || ''), JSON.stringify(rUnco));
  check('C-1b …no job of theirs was touched', (await jobRow(uJob.job.id)).status === 'pending');

  const NO_SENDER = 'cpc_nosend_' + RUN;
  await tenantDb.create({ id: NO_SENDER, name: NO_SENDER, slug: NO_SENDER });
  await channelsDb.upsertConnection(NO_SENDER, 'twilio', { accountRef: 'ACstub2', credentials: { account_sid: 'ACstub2', auth_token: 'x' }, status: 'connected' });
  const nsJob = await mkJob('sms', { companyId: NO_SENDER });
  const rNoSender = await sms.tick(NO_SENDER);
  check('C-1b connected but no sender registered ⇒ still blocked',
    rNoSender.ok === false && /sending number/.test(rNoSender.blocked || ''), JSON.stringify(rNoSender));
  check('C-1b …no job of theirs was touched either', (await jobRow(nsJob.job.id)).status === 'pending');

  // ── C-2 — SMS actually sends, asserting CONTENT ───────────────────────────
  stub.mode = 'ok'; stub.requests.length = 0;
  const s1 = await mkJob('sms');
  const r1 = await sms.tick(CO);
  check('C-2 the SMS tick reports one send', r1.sent === 1, JSON.stringify(r1));
  check('C-2 THE PROVIDER WAS CALLED EXACTLY ONCE', stub.requests.length === 1, String(stub.requests.length));
  const f = stub.requests[0]?.form;
  check('C-2 with a NON-EMPTY body', !!f?.Body && f.Body.trim().length > 0, JSON.stringify(f?.Body));
  check('C-2 …token RESOLVED against the real contact', /^Hi CPC/.test(f?.Body || '') && !/\{first_name\}/.test(f?.Body || ''), f?.Body);
  check('C-2 …to the contact\'s phone', f?.To === s1.contact.phone, JSON.stringify(f?.To));
  check('C-2 …from the tenant\'s connected sender', f?.From === SMS_NUMBER, JSON.stringify(f?.From));
  check('C-2 …authenticated', !!stub.requests[0]?.headers.authorization);
  const after = await jobRow(s1.job.id);
  check('C-2 the job is sent with the provider sid recorded',
    after.status === 'sent' && /^SM/.test(after.provider_message_id || ''), JSON.stringify([after.status, after.provider_message_id]));

  // ── C-3 — WhatsApp prefixes BOTH ends ─────────────────────────────────────
  stub.requests.length = 0;
  const w1 = await mkJob('whatsapp');
  const rw = await whatsapp.tick(CO);
  check('C-3 WhatsApp sends', rw.sent === 1, JSON.stringify(rw));
  const wf = stub.requests[0]?.form;
  check('C-3 To carries the whatsapp: prefix', String(wf?.To).startsWith('whatsapp:'), JSON.stringify(wf?.To));
  check('C-3 From carries it too', String(wf?.From).startsWith('whatsapp:'), JSON.stringify(wf?.From));

  // ── C-3b — the compliance gate runs BEFORE every send ─────────────────────
  stub.requests.length = 0;
  const wClosed = await mkJob('whatsapp');
  await db.query(`UPDATE contacts SET cs_window_expires_at = now() - interval '1 hour' WHERE id=$1`, [wClosed.contact.id]);
  const rwClosed = await whatsapp.tick(CO);
  check('C-3b a WhatsApp send outside the 24h window with no template is refused by the gate, not sent',
    stub.requests.length === 0 && rwClosed.skipped >= 1, JSON.stringify([stub.requests.length, rwClosed]));
  check('C-3b …the job is released (pending again), not failed or quarantined',
    (await jobRow(wClosed.job.id)).status === 'pending', JSON.stringify(await jobRow(wClosed.job.id)));

  stub.requests.length = 0;
  const wSupp = await mkJob('whatsapp');
  await suppressionDb.add(CO, 'whatsapp', wSupp.contact.phone, { reason: 'stop_keyword' });
  const rwSupp = await whatsapp.tick(CO);
  check('C-3b a suppressed recipient is refused by the gate, not sent',
    stub.requests.length === 0 && rwSupp.skipped >= 1, JSON.stringify([stub.requests.length, rwSupp]));

  // ── C-4 — an SMS job never leaks into the WhatsApp executor ───────────────
  stub.requests.length = 0;
  await mkJob('sms');
  const wOnly = await whatsapp.tick(CO);
  check('C-4 the WhatsApp executor does not claim SMS work', wOnly.sent === 0, JSON.stringify(wOnly));

  // ── C-5 — the CP4a properties are INHERITED, not reimplemented ────────────
  stub.mode = 'hang'; stub.requests.length = 0;
  const unk = await mkJob('sms');
  const r5 = await sms.tick(CO);
  // A tick claims a BATCH, so an earlier leftover job is legitimately in this
  // one too — assert on THIS job rather than on the batch size.
  check('C-5 a timeout is quarantined, not failed',
    r5.failed === 0 && r5.jobs.some(j => j.id === unk.job.id && j.outcome === 'quarantined_unknown'),
    JSON.stringify(r5));
  const uRow = await jobRow(unk.job.id);
  check('C-5 …send_started_at retained (the in-flight proof)', !!uRow.send_started_at);
  check('C-5 …no retry consumed', uRow.attempt === 1, String(uRow.attempt));
  await db.query(`UPDATE scheduled_actions SET claimed_at=now()-interval '2 hours' WHERE id=$1`, [unk.job.id]);
  stub.requests.length = 0; stub.mode = 'ok';
  const r5b = await sms.tick(CO);
  check('C-5 THE DUPLICATE-SEND PROOF: a stale in-flight row is never re-served',
    !stub.requests.some(x => x.form.To === unk.contact.phone), JSON.stringify(r5b.sent));

  stub.mode = 'reject4xx'; stub.requests.length = 0;
  const rej = await mkJob('sms');
  const r6 = await sms.tick(CO);
  check('C-5 a definitive 4xx is acked failed and requeued', r6.failed === 1, JSON.stringify(r6));
  check('C-5 …with send_started_at cleared', (await jobRow(rej.job.id)).send_started_at === null);

  stub.mode = 'ratelimit'; stub.requests.length = 0;
  const rl = await mkJob('sms');
  const r7 = await sms.tick(CO);
  check('C-5 a 429 is deferred, not failed and not quarantined',
    r7.failed === 0 && r7.quarantined === 0, JSON.stringify(r7));
  check('C-5 …and burns no retry', (await jobRow(rl.job.id)).attempt === 1);

  stub.mode = 'reject401'; stub.requests.length = 0;
  const bad = await mkJob('sms');
  const r8 = await sms.tick(CO);
  check('C-5 a 401 aborts the tick as CONFIG, never dead-lettering a ladder',
    r8.ok === false && /configuration/.test(r8.blocked || ''), JSON.stringify(r8.blocked));
  check('C-5 …consuming no attempt', (await jobRow(bad.job.id)).attempt === 1);
  stub.mode = 'ok';

  // ── C-6 — content guard: chat channels need no subject, but need a body ───
  check('C-6 an SMS payload with no subject is fine (subject is meaningless here)',
    sms.contentProblem({ content_resolved: true, body: 'hi' }) === null);
  check('C-6 an empty body is still refused', /no body/.test(sms.contentProblem({ content_resolved: true, body: '  ' }) || ''));
  check('C-6 an unresolved token is still refused',
    /unresolved/.test(sms.contentProblem({ content_resolved: true, body: 'Hi {first_name}' }) || ''));

  await db.shutdownDatabase();
  await new Promise(r => stubServer.close(r));
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
