#!/usr/bin/env node
// DenchClaw CRM — CP-C2 LinkedIn executor + the ported safety spine.
//
// NO REAL PROVIDER IS EVER CONTACTED. A local stub is started and UNIPILE_API_BASE
// points at it. Unlike Twilio, that seam did not have to be invented — upstream
// already builds its base URL from UNIPILE_DSN — but the DSN form forces https,
// so the explicit base is what lets a plain http stub stand in.
//
// The assertions below are about the SPINE, not about "did status flip". A rate
// mistake on LinkedIn restricts the account, so every limit is checked by proving
// the provider was NOT called, and by proving the job was never even handed out.
import http from 'node:http';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import templatesDb from '../server/db/models/templates.js';

const KEY = process.env.INTERNAL_API_KEY;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpc2_co_' + RUN;
const ACCT = 'unipile_acct_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0; const results = [];
const check = (n, ok, d) => { if (ok) { pass++; results.push(`  PASS  ${n}`); } else { fail++; results.push(`  FAIL  ${n} — ${d}`); } };

const stub = { mode: 'ok', requests: [] };
const stubServer = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* non-json */ }
  stub.requests.push({ path: req.url, body, headers: req.headers });
  if (stub.mode === 'hang') return;
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (stub.mode === 'reject401') return send(401, { message: 'invalid api key' });
  if (stub.mode === 'ratelimit') return send(429, { message: 'too many requests' });
  if (stub.mode === 'ineligible') return send(422, { type: 'errors/already_invited', title: 'already invited' });
  if (stub.mode === 'error5xx') return send(503, { message: 'unavailable' });
  send(201, { object: 'InviteSent', invitation_id: `inv_${stub.requests.length}`, chat_id: `chat_${stub.requests.length}` });
});

async function main() {
  await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
  const port = stubServer.address().port;
  process.env.UNIPILE_API_BASE = `http://127.0.0.1:${port}`;
  process.env.UNIPILE_API_KEY = 'stub-key-not-real';
  process.env.UNIPILE_TIMEOUT_MS = '600';
  process.env.LINKEDIN_EXECUTOR_ENABLED = '1';
  delete process.env.LIVE_SENDS_DISABLED;
  delete process.env.LIVE_SEND_ALLOWLIST;

  const ex = await import('../server/lib/executors.js').then(m => m.default || m);
  const gate = await import('../server/lib/linkedin-gate.js').then(m => m.default || m);
  const { linkedin, email } = ex;
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  const jobRow = async (id) => (await db.query('SELECT * FROM scheduled_actions WHERE id=$1', [id])).rows[0];
  const stateFor = async (cid) => (await db.query(
    'SELECT * FROM linkedin_prospect_state WHERE account_id=$1 AND contact_id=$2', [ACCT, cid])).rows[0];

  // The account's window is pinned to RIGHT NOW in UTC, so the suite is not a
  // clock-dependent flake. (CP-C found a real one of those: a fixture that only
  // broke between 23:00 and 00:00 UTC had been crashing the suite for an hour
  // every day.) Everything about the window is then varied deliberately.
  const nowUtc = gate.accountClock('UTC');
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hm = (mins) => `${String(Math.floor(((mins % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((mins % 60) + 60) % 60).padStart(2, '0')}`;
  // Start at midnight so the pacer's "fraction of the window elapsed" is large
  // by now — pacing is asserted separately, not left to accidentally gate this.
  const OPEN = 0, CLOSE = Math.min(1439, nowUtc.minutes + 30);
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date());

  async function setAccount(patch = {}) {
    await db.query('DELETE FROM linkedin_accounts WHERE company_id=$1', [CO]);
    const cols = {
      company_id: CO, account_id: ACCT, display_name: 'CPC2 Sender', status: 'connected',
      timezone: 'UTC', active_start: hm(OPEN), active_end: hm(CLOSE), active_days: [today],
      daily_invite_limit: 30, daily_message_limit: 40, daily_inmail_limit: 20, daily_total_limit: 100,
      weekly_invite_limit: 100, max_pending_invites: 400, allow_unverified_message: false,
      engine_dispatch_disabled: true, ...patch,
    };
    const keys = Object.keys(cols);
    await db.query(
      `INSERT INTO linkedin_accounts (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
      keys.map(k => cols[k]));
  }

  let n = 0;
  async function mkJob({ action = 'invite', channel = 'linkedin', body = 'Hi {first_name}, connecting.', subject = null,
    linkedinUrl = null } = {}) {
    n++;
    const ref = `cpc2_${RUN}_${n}`;
    await templatesDb.upsertTemplate(CO, { ref, channel, subject, body });
    const c = await contactDb.create({
      name: `CPC2 P${n}`, email: `cpc2-${n}-${RUN}@ex.test`, company_id: CO,
      linkedin_url: linkedinUrl === null ? `https://www.linkedin.com/in/cpc2-${n}-${RUN}` : linkedinUrl,
    });
    const s = await seqDb.createSequence({ companyId: CO, name: `cpc2 ${RUN} ${n}`, pipelineKey: 'webinar_sales' });
    const st = await seqDb.addStep(s.id, CO, { stepOrder: 1, channel, templateRef: ref });
    if (channel === 'linkedin') {
      await db.query('UPDATE sequence_steps SET linkedin_action=$2 WHERE id=$1', [st.id, action]);
    }
    const e = await seqDb.enroll(CO, { sequenceId: s.id, contactId: c.id });
    const j = (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1 ORDER BY created_at', [e.id])).rows[0];
    await db.query(`UPDATE scheduled_actions SET scheduled_for=now()-interval '1 minute' WHERE id=$1`, [j.id]);
    return { job: j, contact: c };
  }

  // ── L-1 — the boot gate, and the kill switch it now carries ───────────────
  await setAccount();
  process.env.LINKEDIN_EXECUTOR_ENABLED = '0';
  check('L-1 LinkedIn is off unless explicitly enabled', /not 1/.test(linkedin.bootGate() || ''), String(linkedin.bootGate()));
  process.env.LINKEDIN_EXECUTOR_ENABLED = '1';
  check('L-1 fully configured ⇒ the gate opens', linkedin.bootGate() === null, String(linkedin.bootGate()));

  process.env.LIVE_SENDS_DISABLED = '1';
  check('L-1 THE KILL SWITCH STOPS LINKEDIN', /LIVE_SENDS_DISABLED/.test(linkedin.bootGate() || ''), String(linkedin.bootGate()));
  check('L-1 …and it is GLOBAL, not per channel — email stops too',
    /LIVE_SENDS_DISABLED/.test(email.bootGate() || ''), String(email.bootGate()));
  check('L-1 …ahead of the per-channel enable flag, so one lever stops everything',
    !/EXECUTOR_ENABLED/.test(linkedin.bootGate() || ''), String(linkedin.bootGate()));
  delete process.env.LIVE_SENDS_DISABLED;
  check('L-1 clearing it re-opens WITHOUT a restart (checked per tick, not per boot)',
    linkedin.bootGate() === null, String(linkedin.bootGate()));

  // ── L-2 — no connected account is a refusal, not a send ───────────────────
  await db.query('DELETE FROM linkedin_accounts WHERE company_id=$1', [CO]);
  stub.requests.length = 0;
  const noAcct = await linkedin.tick(CO);
  check('L-2 no connected account ⇒ the tick refuses', noAcct.ok === false, JSON.stringify(noAcct));
  check('L-2 …naming WHY', /no_linkedin_account/.test(noAcct.blocked || ''), String(noAcct.blocked));
  check('L-2 …and the provider was never called', stub.requests.length === 0, String(stub.requests.length));

  // ── L-3 — a paused account stops sending within ONE TICK ─────────────────
  await setAccount({ status: 'paused' });
  const paused = await linkedin.tick(CO);
  check('L-3 a paused account stops sending on the very next tick (no restart)',
    paused.ok === false && /account_paused/.test(paused.blocked || ''), JSON.stringify(paused));

  // ── L-4 — THE WINDOW IS ENFORCED AT THE CLAIM DOOR ───────────────────────
  // The point of the whole design: a job claimed at 17:59 and sent at 18:05 has
  // left the window, so the job must never be handed out at all.
  await setAccount({ active_days: [DAYS[(DAYS.indexOf(today) + 1) % 7]] });
  const w1 = await mkJob({ action: 'invite' });
  stub.requests.length = 0;
  const outDay = await linkedin.tick(CO);
  check('L-4 outside the active DAYS the tick refuses', /out_of_window/.test(outDay.blocked || ''), JSON.stringify(outDay));
  let r = await jobRow(w1.job.id);
  check('L-4 …and the job was NEVER CLAIMED — refused at the door, not after',
    r.status === 'pending' && r.claimed_by === null, `${r.status}/${r.claimed_by}`);
  check('L-4 …no provider call', stub.requests.length === 0, String(stub.requests.length));

  // Same job, outside the HOURS.
  await setAccount({ active_start: hm(nowUtc.minutes + 60), active_end: hm(nowUtc.minutes + 120) });
  const outHours = await linkedin.tick(CO);
  check('L-4 outside the active HOURS the tick refuses', /out_of_window/.test(outHours.blocked || ''), JSON.stringify(outHours));
  r = await jobRow(w1.job.id);
  check('L-4 …job still unclaimed', r.status === 'pending', r.status);

  // A window whose end precedes its start is a MISCONFIGURATION, and it fails
  // CLOSED here — upstream's pacer treats that case as "always allow".
  await setAccount({ active_start: '18:00', active_end: '07:00' });
  const inverted = await linkedin.tick(CO);
  check('L-4 an inverted window fails CLOSED, not open',
    /out_of_window/.test(inverted.blocked || ''), JSON.stringify(inverted));

  // ── L-4b — TWO SYSTEMS, ONE ACCOUNT: fails CLOSED until a human says so ──
  // The one risk the CRM cannot see from inside itself. If the outreach engine
  // is still dispatching LinkedIn on this identity, it counts its sends in a
  // ledger this one cannot read — two systems each allowing 100/day is 200/day
  // on one human's account, with both believing they are compliant.
  await setAccount({ engine_dispatch_disabled: false });
  stub.requests.length = 0;
  const unfenced = await linkedin.tick(CO);
  check('L-4b an account not confirmed fenced off from the engine cannot send',
    /engine_dispatch_not_confirmed_disabled/.test(unfenced.blocked || ''), JSON.stringify(unfenced.blocked));
  check('L-4b …and the default for a NEW account is exactly that refusal',
    stub.requests.length === 0, String(stub.requests.length));

  // ── L-5 — an invite actually sends, asserting CONTENT ────────────────────
  await setAccount();
  stub.mode = 'ok'; stub.requests.length = 0;
  const inv = await linkedin.tick(CO);
  check('L-5 the tick reports one send', inv.sent === 1, JSON.stringify(inv));
  check('L-5 THE PROVIDER WAS CALLED EXACTLY ONCE', stub.requests.length === 1, String(stub.requests.length));
  const req0 = stub.requests[0];
  check('L-5 …on the INVITE endpoint borrowed from upstream', req0?.path === '/users/invite', String(req0?.path));
  check('L-5 …authenticated with X-API-KEY (not Bearer — Unipile is unusual here)',
    req0?.headers['x-api-key'] === 'stub-key-not-real', JSON.stringify(req0?.headers['x-api-key']));
  check('L-5 …as the CONNECTED ACCOUNT from the DB, not an env var',
    req0?.body.account_id === ACCT, JSON.stringify(req0?.body.account_id));
  check('L-5 …to the public identifier parsed off the profile URL',
    req0?.body.public_identifier === `cpc2-1-${RUN}`, JSON.stringify(req0?.body.public_identifier));
  check('L-5 …with a NON-EMPTY note whose token RESOLVED',
    /^Hi CPC2,/.test(req0?.body.message || '') && !/\{first_name\}/.test(req0?.body.message || ''),
    JSON.stringify(req0?.body.message));

  // ── L-6 — the invite is REMEMBERED, which is what the accept gate reads ──
  const st1 = await stateFor(w1.contact.id);
  check('L-6 the invite is recorded as pending', st1 && st1.status === 'invited', JSON.stringify(st1?.status));
  check('L-6 …with the send time the abandon rule needs', !!st1?.invite_sent_at, String(st1?.invite_sent_at));
  check('L-6 …and the provider id cached for webhook reverse-lookup',
    st1?.provider_id === 'inv_1', String(st1?.provider_id));

  // ── L-7 — DEFAULT DENY: a message to someone we have no evidence of ──────
  // This is stricter than upstream, deliberately: upstream only gates a message
  // when an invite precedes it in the same sequence, which leaves a message-only
  // ladder aimed at strangers wide open.
  const m1 = await mkJob({ action: 'message', body: 'Hey {first_name}, following up.' });
  stub.requests.length = 0;
  const noEv = await linkedin.tick(CO);
  check('L-7 a message with NO connection evidence is refused', noEv.sent === 0, JSON.stringify(noEv));
  check('L-7 …the provider was never called', stub.requests.length === 0, String(stub.requests.length));
  r = await jobRow(m1.job.id);
  check('L-7 …the job is LEFT PENDING, not skipped (skipping would advance the ladder)',
    r.status === 'pending' && r.attempt === m1.job.attempt, `${r.status}/attempt=${r.attempt}`);

  // ── L-8 — evidence of acceptance un-sticks it ────────────────────────────
  await db.query(
    `INSERT INTO linkedin_prospect_state (company_id, account_id, contact_id, status, accepted_at)
     VALUES ($1,$2,$3,'accepted',now())
     ON CONFLICT (account_id, contact_id) DO UPDATE SET status='accepted', accepted_at=now()`,
    [CO, ACCT, m1.contact.id]);
  stub.requests.length = 0;
  const withEv = await linkedin.tick(CO);
  check('L-8 once the invite is ACCEPTED the message sends', withEv.sent === 1, JSON.stringify(withEv));
  const reqM = stub.requests[0];
  check('L-8 …on the chats endpoint', reqM?.path === '/chats', String(reqM?.path));
  check('L-8 …with the classic api flag upstream uses', reqM?.body.api === 'classic', JSON.stringify(reqM?.body.api));
  check('L-8 …addressed to one attendee', Array.isArray(reqM?.body.attendees_ids) && reqM.body.attendees_ids.length === 1,
    JSON.stringify(reqM?.body.attendees_ids));
  check('L-8 …carrying real resolved copy',
    /^Hey CPC2,/.test(reqM?.body.text || '') && !/\{first_name\}/.test(reqM?.body.text || ''), JSON.stringify(reqM?.body.text));
  check('L-8 …and NOT flagged as InMail', reqM?.body.inmail !== true, JSON.stringify(reqM?.body.inmail));

  // ── L-9 — an inbound LinkedIn message is evidence too ────────────────────
  const m2 = await mkJob({ action: 'message', body: 'Hi {first_name}.' });
  const conv = await db.query(
    `INSERT INTO conversations (company_id, contact_id, channel) VALUES ($1,$2,'linkedin') RETURNING id`,
    [CO, m2.contact.id]);
  await db.query(
    `INSERT INTO messages (conversation_id, company_id, direction, channel, body)
     VALUES ($1,$2,'inbound','linkedin','they wrote first')`, [conv.rows[0].id, CO]);
  stub.requests.length = 0;
  const inboundEv = await linkedin.tick(CO);
  check('L-9 a prospect who messaged US counts as connected', inboundEv.sent === 1, JSON.stringify(inboundEv));

  // ── L-10 — the daily per-type cap, counted off scheduled_actions ─────────
  const sofar = await gate.countsToday(ACCT, 'UTC');
  await setAccount({ daily_invite_limit: (sofar.byType.invite || 0) + 1 });
  const cap1 = await mkJob({ action: 'invite' });
  const cap2 = await mkJob({ action: 'invite' });
  stub.requests.length = 0;
  const capped = await linkedin.tick(CO);
  check('L-10 with room for exactly ONE more invite, exactly one goes out',
    stub.requests.length === 1, `${stub.requests.length} requests, report=${JSON.stringify(capped)}`);
  const capRows = await db.query('SELECT id, status FROM scheduled_actions WHERE id = ANY($1)', [[cap1.job.id, cap2.job.id]]);
  check('L-10 …one of the two was never claimed at all',
    capRows.rows.filter(x => x.status === 'pending').length === 1, JSON.stringify(capRows.rows));
  stub.requests.length = 0;
  await linkedin.tick(CO);
  check('L-10 …and a SECOND tick sends nothing more the same day', stub.requests.length === 0, String(stub.requests.length));

  // ── L-11 — the pending-invite ceiling ────────────────────────────────────
  await setAccount({ daily_invite_limit: 30, max_pending_invites: 1 });
  stub.requests.length = 0;
  await linkedin.tick(CO);
  check('L-11 with 1 pending invite already outstanding, no further invite is sent',
    stub.requests.length === 0, String(stub.requests.length));

  // ── L-12 — the weekly invite ceiling ─────────────────────────────────────
  await setAccount({ max_pending_invites: 400, weekly_invite_limit: 1 });
  stub.requests.length = 0;
  await linkedin.tick(CO);
  check('L-12 the weekly invite ceiling holds independently of the daily one',
    stub.requests.length === 0, String(stub.requests.length));

  // ── L-13 — the live allowlist, checked per RECIPIENT ─────────────────────
  await setAccount();
  const al = await mkJob({ action: 'invite' });
  process.env.LIVE_SEND_ALLOWLIST = 'https://www.linkedin.com/in/somebody-else';
  stub.requests.length = 0;
  const blocked = await linkedin.tick(CO);
  check('L-13 a recipient outside the allowlist is not contacted', stub.requests.length === 0, String(stub.requests.length));
  check('L-13 …and it is reported as a skip, not a failure',
    blocked.jobs.some(j => j.outcome === 'skipped_not_in_live_allowlist'), JSON.stringify(blocked.jobs));
  r = await jobRow(al.job.id);
  check('L-13 …the claim is RELEASED, consuming nothing: no retry burned…',
    r.attempt === al.job.attempt, `${r.attempt} vs baseline ${al.job.attempt}`);
  check('L-13 …no reservation left behind…', r.send_started_at === null, String(r.send_started_at));
  // "No cap slot leaked" is a statement about the LEDGER, not about a column
  // being blanked: a released row is 'pending' with no reservation, and that is
  // precisely what countsToday declines to count. Asserting the count directly
  // is the honest test — the earlier version asserted an implementation detail
  // that a later fix (leaving the stamp alone, so the generic release path names
  // no LinkedIn column) correctly changed.
  const afterRelease = await gate.countsToday(ACCT, 'UTC');
  check('L-13 …and no cap slot leaked — the released job counts for nothing',
    r.status === 'pending' && r.send_started_at === null &&
    afterRelease.total === (await gate.countsToday(ACCT, 'UTC')).total,
    `${r.status}, counted total ${afterRelease.total}`);

  process.env.LIVE_SEND_ALLOWLIST = al.contact.linkedin_url;
  stub.requests.length = 0;
  await linkedin.tick(CO);
  check('L-13 …a released job is DEFERRED, so it does not head-of-line block the queue',
    stub.requests.length === 0, `${stub.requests.length} — a release should push the job out, not re-serve it`);
  await db.query(`UPDATE scheduled_actions SET scheduled_for=now()-interval '1 minute' WHERE id=$1`, [al.job.id]);
  await linkedin.tick(CO);
  check('L-13 …and once due again, an allowlisted recipient goes through',
    stub.requests.length === 1, String(stub.requests.length));
  delete process.env.LIVE_SEND_ALLOWLIST;

  // ── L-14 — an ILLEGAL action is TERMINAL, never retried ──────────────────
  const bad = await mkJob({ action: 'invite' });
  stub.mode = 'ineligible'; stub.requests.length = 0;
  const inelig = await linkedin.tick(CO);
  check('L-14 a 422 from Unipile is reported as ineligible',
    inelig.jobs.some(j => j.outcome === 'ineligible'), JSON.stringify(inelig.jobs));
  r = await jobRow(bad.job.id);
  check('L-14 …and it is TERMINAL — the ladder ends rather than looping',
    r.status === 'failed', `${r.status}/attempt=${r.attempt}`);
  const badState = await stateFor(bad.contact.id);
  check('L-14 …the prospect is recorded ineligible with a reason',
    badState?.status === 'ineligible' && !!badState?.ineligible_reason, JSON.stringify(badState?.ineligible_reason));
  stub.requests.length = 0;
  await linkedin.tick(CO);
  check('L-14 …A SECOND TICK NEVER RETRIES THE ILLEGAL ACTION', stub.requests.length === 0, String(stub.requests.length));

  // ── L-15 — an UNKNOWN outcome is quarantined, never retried ──────────────
  const unk = await mkJob({ action: 'invite' });
  stub.mode = 'hang'; stub.requests.length = 0;
  const hung = await linkedin.tick(CO);
  check('L-15 a timed-out invite is quarantined', hung.quarantined === 1, JSON.stringify(hung));
  r = await jobRow(unk.job.id);
  check('L-15 …the reservation is RETAINED (it may have landed)', !!r.send_started_at, String(r.send_started_at));
  check('L-15 …no delivery retry was consumed', r.attempt === unk.job.attempt,
    `${r.attempt} vs baseline ${unk.job.attempt}`);
  const before = stub.requests.length;
  await db.query(`UPDATE scheduled_actions SET claimed_at = now() - interval '2 hours' WHERE id=$1`, [unk.job.id]);
  stub.mode = 'ok';
  await linkedin.tick(CO);
  check('L-15 …AND AN AGED-OUT CLAIM IS STILL NOT RE-SENT', stub.requests.length === before, String(stub.requests.length - before));

  // ── L-16 — 401 is OUR problem: abort, burn nothing ───────────────────────
  const cfg = await mkJob({ action: 'invite' });
  stub.mode = 'reject401';
  const aborted = await linkedin.tick(CO);
  check('L-16 a 401 aborts the tick as a configuration error',
    aborted.ok === false && /configuration error/.test(aborted.blocked || ''), JSON.stringify(aborted.blocked));
  r = await jobRow(cfg.job.id);
  check('L-16 …without consuming an attempt (3 of those dead-letter the ladder)',
    r.attempt === cfg.job.attempt, `${r.attempt} vs baseline ${cfg.job.attempt}`);
  check('L-16 …and without leaving a reservation behind', r.send_started_at === null, String(r.send_started_at));

  // ── L-17 — 429 defers, it does not fail ──────────────────────────────────
  // Its own job on purpose: L-16's row is still 'claimed' by the aborted tick's
  // instance and is legitimately not reclaimable until CLAIM_TIMEOUT_MS.
  const rlj = await mkJob({ action: 'invite' });
  stub.mode = 'ratelimit';
  const rl = await linkedin.tick(CO);
  check('L-17 a 429 is deferred, not failed',
    rl.failed === 0 && rl.quarantined === 0 && rl.jobs.some(j => j.outcome === 'deferred_rate_limited'),
    JSON.stringify(rl.jobs));
  r = await jobRow(rlj.job.id);
  check('L-17 …costing the message none of its three lives', r.attempt === rlj.job.attempt,
    `${r.attempt} vs baseline ${rlj.job.attempt}`);

  // ── L-18 — InMail carries its subject and its flag ───────────────────────
  stub.mode = 'ok';
  await db.query('DELETE FROM scheduled_actions WHERE company_id=$1 AND status=$2', [CO, 'pending']);
  const im = await mkJob({ action: 'inmail', subject: 'Worth 60 minutes, {first_name}?', body: 'Hi {first_name}, sharing something.' });
  stub.requests.length = 0;
  const imr = await linkedin.tick(CO);
  check('L-18 an InMail step sends', imr.sent === 1, JSON.stringify(imr));
  check('L-18 …flagged as InMail', stub.requests[0]?.body.inmail === true, JSON.stringify(stub.requests[0]?.body));
  check('L-18 …with its subject resolved', /Worth 60 minutes, CPC2\?/.test(stub.requests[0]?.body.subject || ''),
    JSON.stringify(stub.requests[0]?.body.subject));
  check('L-18 …and InMail needs NO connection evidence, which is its whole point',
    !(await stateFor(im.contact.id))?.accepted_at, 'inmail should not require acceptance');

  // ── L-19 — no cross-channel claiming ─────────────────────────────────────
  process.env.EMAIL_EXECUTOR_ENABLED = '1';
  const mail = await mkJob({ channel: 'email', body: 'Hello {first_name}', subject: 'Hi' });
  stub.requests.length = 0;
  const noCross = await linkedin.tick(CO);
  check('L-19 the LinkedIn tick does not claim an email job', noCross.sent === 0 && stub.requests.length === 0,
    JSON.stringify(noCross));
  check('L-19 …and that email job is untouched',
    (await jobRow(mail.job.id)).status === 'pending', (await jobRow(mail.job.id)).status);

  // ── L-20 — a contact with no LinkedIn identifier is refused, not guessed ─
  const noId = await mkJob({ action: 'invite', linkedinUrl: '' });
  stub.requests.length = 0;
  const idr = await linkedin.tick(CO);
  check('L-20 a contact with no LinkedIn URL is quarantined, never guessed at',
    idr.jobs.some(j => j.outcome === 'quarantined_no_recipient'), JSON.stringify(idr.jobs));
  check('L-20 …with no provider call', stub.requests.length === 0, String(stub.requests.length));
  check('L-20 …and it stays quarantined', !!(await jobRow(noId.job.id)).outcome_unknown_at, 'expected quarantine');

  // ── L-21 — the pacer spreads the day rather than bursting at window open ─
  const pacer = { timezone: 'UTC', active_start: '08:00', active_end: '18:00', daily_total_limit: 100 };
  const at = (h, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));
  check('L-21 at window OPEN the allowance is ~1, not the whole day',
    gate.pacedAllowance(pacer, at(8)) <= 2, String(gate.pacedAllowance(pacer, at(8))));
  check('L-21 …halfway through the window it is ~half the cap',
    gate.pacedAllowance(pacer, at(13)) > 45 && gate.pacedAllowance(pacer, at(13)) < 56,
    String(gate.pacedAllowance(pacer, at(13))));
  check('L-21 …and at window close it is the whole cap, never more',
    gate.pacedAllowance(pacer, at(18)) === 101, String(gate.pacedAllowance(pacer, at(18))));

  // ── L-25 — an empty active_days list fails CLOSED, not open ─────────────
  check('L-25 active_days = [] refuses, rather than meaning "every day"',
    gate.windowVerdict({ timezone: 'UTC', active_days: [], active_start: '00:00', active_end: '23:59' })
      === gate.V.OUT_OF_WINDOW, 'an emptied day list must not mean weekend sending');
  check('L-25 …while an ABSENT list is the only "unset" that opens',
    gate.windowVerdict({ timezone: 'UTC', active_days: null, active_start: '00:00', active_end: '23:59' })
      === gate.OK, 'null active_days should not block');

  // ── L-26 — we never re-invite someone we are already connected to ───────
  // The CRM's dedupe is UNIQUE (enrollment_id, step_id), so a SECOND sequence
  // aimed at the same contact is a fresh row — and without a state check it
  // would fire a real, illegal connection request at someone already connected.
  await setAccount();
  const known = await mkJob({ action: 'invite' });
  await db.query(
    `INSERT INTO linkedin_prospect_state (company_id, account_id, contact_id, status, accepted_at)
     VALUES ($1,$2,$3,'accepted',now())`, [CO, ACCT, known.contact.id]);
  stub.mode = 'ok'; stub.requests.length = 0;
  await linkedin.tick(CO);
  const knownRow = await jobRow(known.job.id);
  check('L-26 an invite to an ALREADY-CONNECTED contact is refused at the door',
    knownRow.status === 'pending' && !stub.requests.some(q => q.path === '/users/invite' &&
      q.body.public_identifier === `cpc2-${known.contact.name.split(' ')[1].slice(1)}-${RUN}`),
    `${knownRow.status}, ${stub.requests.length} requests`);

  // And an invite already out and not yet stale is upstream's ALREADY verdict.
  const pend = await mkJob({ action: 'invite' });
  await db.query(
    `INSERT INTO linkedin_prospect_state (company_id, account_id, contact_id, status, invite_sent_at)
     VALUES ($1,$2,$3,'invited',now())`, [CO, ACCT, pend.contact.id]);
  await linkedin.tick(CO);
  check('L-26 …and an invite already pending is not sent a second time',
    (await jobRow(pend.job.id)).status === 'pending', (await jobRow(pend.job.id)).status);

  // ── L-27 — a released claim goes to the BACK of the queue ───────────────
  // Without this a full batch of allowlist-refused jobs is re-claimed and
  // re-released every tick forever, and a job to an ALLOWLISTED recipient
  // scheduled later never surfaces — the allowlist starving the very sends it
  // exists to permit.
  const rel = await mkJob({ action: 'invite' });
  const wasDue = (await jobRow(rel.job.id)).scheduled_for;
  process.env.LIVE_SEND_ALLOWLIST = 'https://www.linkedin.com/in/nobody-at-all';
  await linkedin.tick(CO);
  delete process.env.LIVE_SEND_ALLOWLIST;
  const relRow = await jobRow(rel.job.id);
  check('L-27 a released job is pushed out, not re-served immediately',
    new Date(relRow.scheduled_for) > new Date(wasDue), `${relRow.scheduled_for} vs ${wasDue}`);

  // ── L-28 — LinkedIn is NOT claimable over HTTP ──────────────────────────
  // The claim door gates it correctly for any claimant, but the reserve lives in
  // the CRM's own executor: an external claimant that sends and dies before
  // acking leaves a row indistinguishable from "never sent", which is re-served
  // as a SECOND connection request to the same person.
  const claimRes = await fetch(`${process.env.CRM_API_BASE}/api/crm/channel-jobs/claim`, {
    method: 'POST',
    headers: { 'x-internal-key': KEY, 'x-company-id': CO, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'linkedin', limit: 5, claimed_by: 'an-external-engine' }),
  });
  check('L-28 an external claimant cannot claim LinkedIn jobs', claimRes.status === 400, String(claimRes.status));
  const emailClaim = await fetch(`${process.env.CRM_API_BASE}/api/crm/channel-jobs/claim`, {
    method: 'POST',
    headers: { 'x-internal-key': KEY, 'x-company-id': CO, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'email', limit: 5, claimed_by: 'an-external-engine' }),
  });
  check('L-28 …while every other channel is untouched', emailClaim.status === 200, String(emailClaim.status));

  // ── L-23 — TWO TICKS AT ONCE CANNOT OVERSHOOT THE CAP ───────────────────
  // The reason the gate lives at the claim door rather than in the executor: the
  // claim door already holds pg_advisory_xact_lock(company:channel), so counting
  // and reserving are one serialized step. Without that, two ticks each read
  // "0 sent today" and both send a full allowance.
  await db.query(`UPDATE scheduled_actions SET status='skipped' WHERE company_id=$1 AND status IN ('pending','claimed')`, [CO]);
  const base = await gate.countsToday(ACCT, 'UTC');
  await setAccount({ daily_total_limit: base.total + 2, daily_invite_limit: 99, allow_unverified_message: true });
  const racers = [];
  for (let i = 0; i < 6; i++) racers.push(await mkJob({ action: 'invite' }));
  stub.mode = 'ok'; stub.requests.length = 0;
  const [t1, t2] = await Promise.all([linkedin.tick(CO), linkedin.tick(CO)]);
  check('L-23 two concurrent ticks together send AT MOST the remaining allowance',
    stub.requests.length <= 2, `${stub.requests.length} sends for an allowance of 2 (${t1.sent}+${t2.sent})`);
  check('L-23 …and they did send, so this is not passing by sending nothing',
    stub.requests.length >= 1, String(stub.requests.length));
  const stillPending = await db.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_actions WHERE id = ANY($1) AND status = 'pending'`,
    [racers.map(x => x.job.id)]);
  check('L-23 …and the rest were never handed out at all',
    stillPending.rows[0].n >= 4, `${stillPending.rows[0].n} of 6 still pending`);

  // ── L-24 — one LinkedIn account cannot belong to two tenants ────────────
  // Without this the per-(company,channel) advisory lock would not serialize two
  // tenants sharing one connected identity, and the account cap would be counted
  // twice over. The schema is what makes the lock sufficient.
  let shared = null;
  try {
    await db.query(
      `INSERT INTO linkedin_accounts (company_id, account_id) VALUES ($1, $2)`, ['tantra', ACCT]);
    shared = 'inserted';
  } catch (e) { shared = e.code; }
  check('L-24 a second tenant CANNOT register the same connected account (unique account_id)',
    shared === '23505', String(shared));

  // ── L-22 — the channel is now real at the control surface ───────────────
  const res = await fetch(`${process.env.CRM_API_BASE}/api/crm/executors/linkedin/status`, {
    headers: { 'x-internal-key': KEY, 'x-company-id': CO } });
  const statusBody = await res.json();
  check('L-22 GET /executors/linkedin/status is no longer a 404', res.status === 200, String(res.status));
  check('L-22 …and reports the channel', statusBody.channel === 'linkedin', JSON.stringify(statusBody));

  console.log(results.join('\n'));
  console.log(`\nCP-C2 LinkedIn: ${pass} passed / ${fail} failed`);
  stubServer.close();
  await db.closeDatabase?.();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
