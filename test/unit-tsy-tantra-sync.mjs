#!/usr/bin/env node
// DenchClaw CRM — TSY: the Tantra mirror (migrations 039 + 040).
//
// Covers the read seam (tantra-client), the translation boundary
// (tantra-normalize), mirror resolution/idempotency (tantra-sync-engine),
// the executor sweep, and the webhook's new nudge + event-id dedupe.
//
// A STUB Tantra API is stood up on TANTRA_STUB_PORT and the CRM server is
// booted with TANTRA_API_BASE pointing at it, so this suite can never make a
// real outbound call — same seam UNIPILE_API_BASE/RESEND_API_BASE established.
//
// Usage: CRM_API_BASE=... INTERNAL_API_KEY=... DATABASE_URL=... TANTRA_STUB_PORT=... node test/unit-tsy-tantra-sync.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import tantraSyncDb from '../server/db/models/tantra-sync.js';
import normalize from '../server/lib/tantra-normalize.js';

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const STUB_PORT = Number(process.env.TANTRA_STUB_PORT || 3197);
const RUN = process.env.RUN || String(Date.now());
const CO = 'tsy_co_' + RUN;
const CO2 = 'tsy_other_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

async function req(method, p, body, company = CO) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': company },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

// ─── the stub Tantra API ─────────────────────────────────────────────────────
// Responses use Tantra's REAL documented shape, including the trap that matters
// most: the DTO is EMAIL-SHAPED ON EVERY CHANNEL, so the WhatsApp thread below
// carries `gmailMessageId` and a phone number in `mailboxEmail`.
const stub = {
  threads: [],
  messagesByThread: {},
  calls: [],
  rejectKey: false,
  failMessagesFor: null,
};

function tantraStubServer() {
  return http.createServer((rq, rs) => {
    stub.calls.push(rq.url);
    const send = (code, obj) => {
      rs.writeHead(code, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(obj));
    };
    if (rq.url === '/health') return send(200, { ok: true });
    if (stub.rejectKey || rq.headers['x-api-key'] !== 'tk_live_good') {
      return send(401, { message: 'Unauthorized' });
    }
    const u = new URL(rq.url, 'http://x');
    if (u.pathname === '/api/v1/email/threads') {
      const page = Number(u.searchParams.get('page') || 1);
      return send(200, { threads: page === 1 ? stub.threads : [] });
    }
    if (/^\/api\/v1\/email\/threads\/[^/]+\/messages\/reply$/.test(u.pathname)) {
      // The social path returns the SAME envelope keys as the email path.
      return send(201, { gmailMessageId: 'sent_' + stub.calls.length, threadId: 'x', messageIdHeader: '<m@x>' });
    }
    const m = u.pathname.match(/^\/api\/v1\/email\/threads\/([^/]+)(\/messages)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2]) {
        if (stub.failMessagesFor === id) return send(500, { message: 'upstream boom' });
        return send(200, { messages: stub.messagesByThread[id] || [] });
      }
      const t = stub.threads.find(x => x.id === id);
      return t ? send(200, t) : send(404, { message: 'not found' });
    }
    send(404, { message: 'no stub route' });
  });
}

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });

  const server = tantraStubServer();
  await new Promise((r) => server.listen(STUB_PORT, '127.0.0.1', r));

  try {
    // ══ 1. The translation boundary ═══════════════════════════════════════
    // The single most valuable assertion here: a WhatsApp message arrives
    // carrying `gmailMessageId`, and the CRM must not inherit that name.
    const waThread = normalize.normalizeThread({
      id: 's_wa_1', channel: 'whatsapp',
      mailboxEmail: '+14155550142',            // a PHONE, in a field called ...Email
      participantName: 'Wanda Whatsapp',
      participantEmail: '+1 (415) 555-0199',
      lastMessageAt: '2026-08-10T10:00:00.000Z',
      contactId: 'tantra_c_1',
    });
    check('TSY-1 a WhatsApp thread normalises to channel=whatsapp', waThread.channel === 'whatsapp', JSON.stringify(waThread));
    check('TSY-2 mailboxEmail holding a phone becomes the channel ACCOUNT, not the person',
      waThread.accountRef === '+14155550142' && waThread.counterparty.value === '+14155550199',
      JSON.stringify(waThread));

    const waMsg = normalize.normalizeMessage(
      { gmailMessageId: 'g_abc', direction: 'inbound', bodyText: 'hi there', date: '2026-08-10T10:00:00.000Z' },
      { channel: 'whatsapp' });
    check('TSY-3 gmailMessageId on a WhatsApp message becomes a namespaced provider id',
      waMsg.providerMessageId === 'tantra:g_abc' && waMsg.channel === 'whatsapp', JSON.stringify(waMsg));
    check('TSY-4 an unreadable direction defaults to inbound, never outbound',
      normalize.normalizeMessage({ id: 'x' }, {}).direction === 'inbound', 'direction default');

    // The static scan. If this fails, the email-shaped DTO has leaked into the
    // CRM's domain model and the names never wash out.
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const srvDir = path.join(__dirname, '..', 'server');
    const offenders = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { walk(fp); continue; }
        if (!e.name.endsWith('.js')) continue;
        if (e.name === 'tantra-normalize.js') continue;   // the ONE permitted home
        const src = fs.readFileSync(fp, 'utf8');
        // tantra-client.js may NAME the reply route; it must not read the field.
        if (/gmailMessageId\s*[:.\]]/.test(src) || /\bmailboxEmail\b\s*[:.\]]/.test(src)) offenders.push(fp);
      }
    })(srvDir);
    check('TSY-5 gmailMessageId/mailboxEmail are READ in tantra-normalize.js and nowhere else',
      offenders.length === 0, offenders.join(', '));

    // ══ 2. Connection ═════════════════════════════════════════════════════
    const badConnect = await req('POST', '/api/crm/tantra/connect', { api_key: 'tk_live_bad' });
    check('TSY-6 a key Tantra rejects fails the connect instead of being stored',
      badConnect.status === 400, JSON.stringify(badConnect.json));

    const conn = await req('POST', '/api/crm/tantra/connect', { api_key: 'tk_live_good' });
    check('TSY-7 a valid key connects', conn.status === 200 && conn.json?.connection?.connected === true, JSON.stringify(conn.json));
    check('TSY-8 ...and the response says plainly that the key is effectively root',
      /root credential/i.test(conn.json?.warning || ''), JSON.stringify(conn.json));

    const shown = await req('GET', '/api/crm/tantra/connection');
    check('TSY-9 the API key is never echoed back to the client',
      !JSON.stringify(shown.json).includes('tk_live_good'), JSON.stringify(shown.json));

    // ══ 3. The mirror ═════════════════════════════════════════════════════
    stub.threads = [
      { id: 's_wa_1', channel: 'whatsapp', mailboxEmail: '+14155550142',
        participantName: 'Wanda Whatsapp', participantEmail: '+14155550199',
        lastMessageAt: '2026-08-10T10:00:00.000Z', contactId: 'tantra_c_1' },
      { id: 'e_1', channel: 'email', mailboxEmail: 'outreach@tantra.test',
        participantName: 'Eddie Email', participantEmail: `eddie-${RUN}@ex.test`,
        subject: 'Re: intro', lastMessageAt: '2026-08-11T10:00:00.000Z' },
    ];
    stub.messagesByThread['s_wa_1'] = [
      { gmailMessageId: 'wa_m1', direction: 'inbound', bodyText: 'Hi from WhatsApp', date: '2026-08-10T09:00:00.000Z' },
      { gmailMessageId: 'wa_m2', direction: 'outbound', bodyText: 'Reply from Tantra', date: '2026-08-10T10:00:00.000Z' },
    ];
    stub.messagesByThread['e_1'] = [
      { gmailMessageId: 'e_m1', direction: 'inbound', bodyText: 'Interested!', date: '2026-08-11T10:00:00.000Z' },
    ];

    const tick1 = await req('POST', '/api/crm/tantra/tick', {});
    check('TSY-10 a tick mirrors both threads',
      tick1.json?.ok === true && tick1.json?.threads === 2 && tick1.json?.messages === 3, JSON.stringify(tick1.json));

    const waContact = (await req('GET', '/api/crm/contacts?limit=200')).json;
    const list = Array.isArray(waContact) ? waContact : (waContact.contacts || waContact.data || []);
    const wanda = list.find(c => c.name === 'Wanda Whatsapp');
    check('TSY-11 a contact was created for the WhatsApp counterparty', !!wanda, JSON.stringify(list.map(c => c.name)));

    // Idempotency is structural (uq_messages_provider_id), not checked — so the
    // real proof is that running the SAME sweep again writes nothing.
    await db.query(`UPDATE tantra_sync_state SET threads_synced_through = NULL WHERE company_id=$1`, [CO]);
    const tick2 = await req('POST', '/api/crm/tantra/tick', {});
    check('TSY-12 re-sweeping the same threads writes ZERO duplicate messages',
      tick2.json?.messages === 0, JSON.stringify(tick2.json));

    const msgCount = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1 AND provider_message_id LIKE 'tantra:%'`, [CO]);
    check('TSY-13 ...and exactly 3 mirrored messages exist in total',
      msgCount.rows[0].n === 3, JSON.stringify(msgCount.rows[0]));

    // ══ 4. B3 — two accounts on ONE channel for ONE contact ═══════════════
    // This is what migration 040 exists for. Before it, the second open
    // WhatsApp conversation violated uq_conversations_contact_channel.
    const convA = await db.query(
      `SELECT id, channel, channel_account FROM conversations
        WHERE company_id=$1 AND contact_id=$2 AND channel='whatsapp'`, [CO, wanda.id]);
    check('TSY-14 the mirrored WhatsApp conversation carries Tantra\'s account',
      convA.rows.length === 1 && convA.rows[0].channel_account === '+14155550142', JSON.stringify(convA.rows));

    // Now the CRM's OWN WhatsApp number opens a second conversation with the
    // same person — reminders vs cold outreach, the B3 split.
    const own = await req('POST', '/api/crm/conversations', { contact_id: wanda.id, channel: 'whatsapp' });
    check('TSY-15 the CRM\'s own WhatsApp opens a SECOND open conversation, no collision',
      own.status === 201 && own.json.channel_account === '', JSON.stringify(own.json));

    const both = await db.query(
      `SELECT count(*)::int AS n FROM conversations
        WHERE company_id=$1 AND contact_id=$2 AND channel='whatsapp' AND status <> 'closed'`, [CO, wanda.id]);
    check('TSY-16 ...so one contact holds TWO open WhatsApp conversations',
      both.rows[0].n === 2, JSON.stringify(both.rows[0]));

    // And the payoff: the inbox groups by CONTACT, so it is still one thread.
    const thread = await req('GET', `/api/crm/inbox/${wanda.id}/thread`);
    const rows = (thread.json && thread.json.thread) || [];
    check('TSY-17 the inbox still shows ONE unified thread for that contact',
      thread.status === 200 && rows.length >= 2, JSON.stringify(thread.json).slice(0, 300));
    check('TSY-17b ...spanning BOTH of that contact\'s open WhatsApp conversations',
      (thread.json.conversations || []).filter(c => c.channel === 'whatsapp').length === 2,
      JSON.stringify(thread.json.conversations));
    check('TSY-17c ...and both directions of the mirrored history are present',
      rows.some(m => m.direction === 'inbound') && rows.some(m => m.direction === 'outbound'),
      JSON.stringify(rows.map(m => m.direction)));

    // ══ 4b. Channel ownership — "anything Tantra owns must send through Tantra"
    // Suppression, unsubscribe, warmup pacing and quota reservation all live on
    // the Tantra side. Sending on a Tantra-owned account from here bypasses all
    // of them, so it must be refused rather than quietly succeeding.
    check('TSY-18a telegram is in the CRM channel vocabulary (the mirror writes it)',
      (await req('GET', '/api/crm/inbox?channel=telegram')).status === 200, 'telegram filter');

    const ownReply = await req('POST', `/api/crm/inbox/${wanda.id}/reply`,
      { channel: 'whatsapp', body: 'reminder from the CRM number' });
    check('TSY-18b replying on the CRM\'s OWN account still works, unchanged',
      ownReply.status === 201, JSON.stringify(ownReply.json).slice(0, 200));

    // Disconnect Tantra, then try to reply on the Tantra-owned account.
    await req('DELETE', '/api/crm/tantra/connection');
    const orphanReply = await req('POST', `/api/crm/inbox/${wanda.id}/reply`,
      { channel: 'whatsapp', channel_account: '+14155550142', body: 'should be refused' });
    check('TSY-18c a Tantra-owned conversation with Tantra disconnected is REFUSED, not sent locally',
      orphanReply.status === 409 && /bypass/i.test(orphanReply.json?.error || ''),
      JSON.stringify(orphanReply.json));

    const noGhost = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1 AND body='should be refused'`, [CO]);
    check('TSY-18d ...and no message row was written for the refused send',
      noGhost.rows[0].n === 0, JSON.stringify(noGhost.rows[0]));

    // Reconnect and prove it routes THROUGH Tantra rather than the CRM provider.
    await req('POST', '/api/crm/tantra/connect', { api_key: 'tk_live_good' });
    const callsBefore = stub.calls.length;
    const routed = await req('POST', `/api/crm/inbox/${wanda.id}/reply`,
      { channel: 'whatsapp', channel_account: '+14155550142', body: 'sent via Tantra' });
    check('TSY-18e a Tantra-owned reply is routed to Tantra\'s reply endpoint',
      routed.status === 201 && stub.calls.slice(callsBefore).some(u => /\/messages\/reply$/.test(u)),
      JSON.stringify(stub.calls.slice(callsBefore)));

    // ══ 4c. The ownership check must not be side-steppable ════════════════
    // Replying with a channel_account that has no conversation used to CREATE
    // one — CRM-owned, but labelled with Tantra's number. external_system was
    // then NULL, so the guard read it as "not Tantra-owned" and sent through the
    // CRM's own provider on Tantra's identity: the exact bypass the guard
    // exists to stop, reachable whenever the mirror hasn't seen that thread yet.
    const stranger = await req('POST', '/api/crm/contacts',
      { name: 'No Tantra Thread', email: `nt-${RUN}@ex.test` });
    const sneak = await req('POST', `/api/crm/inbox/${stranger.json.id}/reply`,
      { channel: 'whatsapp', channel_account: '+14155550142', body: 'should not send' });
    check('TSY-18f replying on an account with no conversation is refused, not invented',
      sneak.status === 404, JSON.stringify(sneak.json));
    const invented = await db.query(
      `SELECT count(*)::int AS n FROM conversations
        WHERE company_id=$1 AND contact_id=$2 AND channel_account='+14155550142'`,
      [CO, stranger.json.id]);
    check('TSY-18g ...and no conversation was created carrying Tantra\'s account',
      invented.rows[0].n === 0, JSON.stringify(invented.rows[0]));
    const ghost = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1 AND body='should not send'`, [CO]);
    check('TSY-18h ...and nothing was sent', ghost.rows[0].n === 0, JSON.stringify(ghost.rows[0]));

    // ══ 5. Webhook: nudge, dedupe, and NO writes from an unsigned body ════
    const hookRow = await req('GET', '/api/crm/settings/tantra-webhook');
    const token = hookRow.json.webhook.token;

    async function hook(body, headers) {
      const r = await fetch(`${BASE}/webhooks/tantra/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, json };
    }

    const ev1 = await hook({ threadId: 's_wa_1' },
      { 'x-tantra-event': 'whatsapp.message.replied', 'x-tantra-event-id': `evt-${RUN}-1` });
    check('TSY-18 a webhook delivery is accepted', ev1.status === 200, JSON.stringify(ev1.json));

    const pending = await tantraSyncDb.countPendingNudges(CO);
    check('TSY-19 ...and enqueues a nudge to poll that thread', pending === 1, String(pending));

    const ev1again = await hook({ threadId: 's_wa_1' },
      { 'x-tantra-event': 'whatsapp.message.replied', 'x-tantra-event-id': `evt-${RUN}-1` });
    check('TSY-20 a REDELIVERED event id is a no-op, not a duplicate',
      ev1again.json?.duplicate === true, JSON.stringify(ev1again.json));
    check('TSY-21 ...and does not enqueue a second nudge',
      (await tantraSyncDb.countPendingNudges(CO)) === 1, 'nudge count');

    // The forgery test. An unsigned body claiming a message must write nothing:
    // every persisted byte comes from the authenticated API, never from here.
    const before = (await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1`, [CO])).rows[0].n;
    await hook(
      { threadId: 's_forged', text: 'FORGED — should never be stored', recipient_email: `forged-${RUN}@ex.test` },
      { 'x-tantra-event': 'whatsapp.message.replied', 'x-tantra-event-id': `evt-${RUN}-forge` });
    const forged = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1 AND body LIKE '%FORGED%'`, [CO]);
    check('TSY-22 an unsigned webhook body never becomes a message',
      forged.rows[0].n === 0, JSON.stringify(forged.rows[0]));
    check('TSY-23 ...and the forged thread ref is only ever a poll target',
      (await db.query(`SELECT count(*)::int AS n FROM tantra_nudges WHERE company_id=$1 AND thread_ref='s_forged'`, [CO])).rows[0].n === 1,
      'forged nudge parked');

    // ══ 5b. The watermark must not step over a failed thread ══════════════
    // The sweep's stopping rule IS the watermark, so advancing past a thread
    // that failed to sync means it is never read again and its messages are
    // lost silently. Re-reading is free (writes are idempotent), so the mark
    // may only move to the newest thread actually WRITTEN that is older than
    // the oldest still-unresolved one.
    await db.query(`UPDATE tantra_sync_state SET threads_synced_through=NULL WHERE company_id=$1`, [CO]);
    stub.threads = [
      { id: 'e_new', channel: 'email', mailboxEmail: 'outreach@tantra.test',
        participantName: 'Newer', participantEmail: `newer-${RUN}@ex.test`,
        lastMessageAt: '2026-08-20T10:00:00.000Z' },
      { id: 'e_broken', channel: 'email', mailboxEmail: 'outreach@tantra.test',
        participantName: 'Broken', participantEmail: `broken-${RUN}@ex.test`,
        lastMessageAt: '2026-08-19T10:00:00.000Z' },
      { id: 'e_old', channel: 'email', mailboxEmail: 'outreach@tantra.test',
        participantName: 'Older', participantEmail: `older-${RUN}@ex.test`,
        lastMessageAt: '2026-08-18T10:00:00.000Z' },
    ];
    stub.messagesByThread['e_new'] = [{ gmailMessageId: 'n1', direction: 'inbound', bodyText: 'new', date: '2026-08-20T10:00:00.000Z' }];
    stub.messagesByThread['e_old'] = [{ gmailMessageId: 'o1', direction: 'inbound', bodyText: 'old', date: '2026-08-18T10:00:00.000Z' }];
    stub.failMessagesFor = 'e_broken';        // its messages read 500s

    const partial = await req('POST', '/api/crm/tantra/tick', {});
    check('TSY-25a a thread whose messages cannot be read is reported as skipped',
      (partial.json?.skipped || []).some(x => /unreadable/.test(x)), JSON.stringify(partial.json?.skipped));
    check('TSY-25b the watermark stops BELOW the failed thread, not above it',
      partial.json?.watermarkAdvancedTo === '2026-08-18T10:00:00.000Z',
      JSON.stringify({ to: partial.json?.watermarkAdvancedTo, held: partial.json?.heldBack }));

    // Once the transient failure clears, the next sweep picks the thread up —
    // which is only possible because the watermark never passed it.
    stub.failMessagesFor = null;
    stub.messagesByThread['e_broken'] = [{ gmailMessageId: 'b1', direction: 'inbound', bodyText: 'recovered', date: '2026-08-19T10:00:00.000Z' }];
    const recovered = await req('POST', '/api/crm/tantra/tick', {});
    check('TSY-25c the next sweep recovers it instead of losing it forever',
      recovered.json?.messages >= 1, JSON.stringify(recovered.json));
    const got = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1 AND provider_message_id='tantra:b1'`, [CO]);
    check('TSY-25d ...and the previously-unreadable message is now stored',
      got.rows[0].n === 1, JSON.stringify(got.rows[0]));

    // ══ 5c. An unclassifiable thread must not be filed as email ═══════════
    // detectChannel returns null for a social thread with no explicit channel
    // field. The conversation upsert used to default to 'email', so a WhatsApp
    // chat would be mirrored into the wrong channel — invisible until a rep
    // replied on the wrong medium.
    check('TSY-25e a social thread with no channel field normalises to channel:null',
      normalize.normalizeThread({ id: 's_unknown_1', mailboxEmail: '+1415555000', lastMessageAt: '2026-08-21T10:00:00.000Z' }).channel === null,
      'expected null channel');

    await db.query(`UPDATE tantra_sync_state SET threads_synced_through=NULL WHERE company_id=$1`, [CO]);
    stub.threads = [{ id: 's_unknown_1', mailboxEmail: '+14155550142',
      participantEmail: '+14155559999', lastMessageAt: '2026-08-21T10:00:00.000Z' }];
    stub.messagesByThread['s_unknown_1'] = [{ gmailMessageId: 'u1', direction: 'inbound', bodyText: 'mystery', date: '2026-08-21T10:00:00.000Z' }];
    const unclassified = await req('POST', '/api/crm/tantra/tick', {});
    check('TSY-25f ...and the sweep skips it with a reason rather than guessing',
      (unclassified.json?.skipped || []).some(x => /channel could not be determined/.test(x)),
      JSON.stringify(unclassified.json?.skipped));
    const misfiled = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1 AND provider_message_id='tantra:u1'`, [CO]);
    check('TSY-25g ...so nothing was written into the wrong channel',
      misfiled.rows[0].n === 0, JSON.stringify(misfiled.rows[0]));

    // ══ 6. Identity safety ════════════════════════════════════════════════
    const link = await tantraSyncDb.linkIdentity(CO, wanda.id, { kind: 'whatsapp', value: '+14155550199' });
    check('TSY-24 re-linking an identity to the same contact is idempotent',
      link.conflict === false, JSON.stringify(link));

    const other = await contactDb.create({ company_id: CO, name: 'Impostor', email: `imp-${RUN}@ex.test` });
    const clash = await tantraSyncDb.linkIdentity(CO, other.id, { kind: 'whatsapp', value: '+14155550199' });
    check('TSY-25 a SECOND contact claiming one handle is reported, not silently repointed',
      clash.created === false && clash.conflict === true, JSON.stringify(clash));

    // ══ 7. Echo suppression (two-way sync convergence) ════════════════════
    await tantraSyncDb.recordSync(CO, wanda.id, { direction: 'pull', field: 'tags', value: 'vip' });
    check('TSY-26 a value we just PULLED is recognised as an echo and not pushed back',
      (await tantraSyncDb.isEcho(CO, wanda.id, 'tags', 'vip')) === true, 'echo');
    check('TSY-27 ...but a genuinely new value is not an echo',
      (await tantraSyncDb.isEcho(CO, wanda.id, 'tags', 'churned')) === false, 'not echo');

    // ══ 8. Watermark ══════════════════════════════════════════════════════
    // Written relative to wherever the sweeps above left it, rather than to a
    // fixed date — otherwise this asserts the ORDER of the tests, not the
    // monotonic property it exists to prove.
    const before28 = new Date((await tantraSyncDb.getState(CO)).threads_synced_through);
    await tantraSyncDb.advanceWatermark(CO, new Date(before28.getTime() - 86400000).toISOString());
    const afterBack = new Date((await tantraSyncDb.getState(CO)).threads_synced_through);
    check('TSY-28 the watermark never rewinds',
      afterBack.getTime() === before28.getTime(), `${before28.toISOString()} → ${afterBack.toISOString()}`);
    const fwd = new Date(before28.getTime() + 86400000).toISOString();
    await tantraSyncDb.advanceWatermark(CO, fwd);
    check('TSY-28b ...but it does move forward',
      new Date((await tantraSyncDb.getState(CO)).threads_synced_through).toISOString() === fwd, fwd);

    // ══ 9. Tenancy ════════════════════════════════════════════════════════
    const otherStatus = await req('GET', '/api/crm/tantra/status', undefined, CO2);
    check('TSY-29 another tenant sees its own (disconnected) Tantra status',
      otherStatus.json?.connected === false, JSON.stringify(otherStatus.json));

    const otherTick = await req('POST', '/api/crm/tantra/tick', {}, CO2);
    check('TSY-30 an unconnected tenant\'s tick is a 200 with ok:false, not a 500',
      otherTick.status === 200 && otherTick.json?.ok === false, JSON.stringify(otherTick.json));

    const leak = await db.query(
      `SELECT count(*)::int AS n FROM messages WHERE company_id=$1`, [CO2]);
    check('TSY-31 the mirror wrote nothing into the other tenant',
      leak.rows[0].n === 0, JSON.stringify(leak.rows[0]));

    const noAuth = await fetch(`${BASE}/api/crm/tantra/status`);
    check('TSY-32 the Tantra control surface requires auth',
      noAuth.status === 401 || noAuth.status === 403, String(noAuth.status));
  } finally {
    server.close();
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
