'use strict';
// ─── Tantra mirror executor ──────────────────────────────────────────────────
// Same posture as the channel executors: NOT a daemon. One tick = one batch,
// driven by cron or an operator, so there is no extra process lifecycle to keep
// alive (routes/executors.js's header states the rule; this follows it).
//
// WHY A POLL AT ALL — this is the load-bearing consequence of Decision C
// ("consume only", we cannot change tantra-backend-v2):
//
// Tantra's outbound webhook catalogue is REPLY-SHAPED, not message-shaped —
// `email.replied`, `whatsapp.message.replied`, `linkedin.message.replied`. It
// emits nothing for a message WE send, nothing for a second inbound in a thread
// already replied to, and nothing when a thread first opens. `message.received`
// / `message.sent` / `conversation.created` do not exist, and un-gating them is
// a Tantra-side change we are not permitted to make. A webhook-only mirror would
// therefore be silently, permanently incomplete.
//
// So the sweep is the source of truth and the webhook is only a latency
// optimisation — a hint that one specific thread is worth re-reading NOW. That
// also disarms the unsigned-payload problem (tantra.md §2.3: there is no HMAC
// header, so anyone who learns the URL can forge events): a forged nudge costs
// one wasted API read and can inject nothing, because every byte we persist
// comes from an authenticated API response, never from the webhook body.

const tantraClient = require('./tantra-client');
const normalize = require('./tantra-normalize');
const engine = require('./tantra-sync-engine');
const tantraSync = require('../db/models/tantra-sync');
const channels = require('../db/models/channels');

const PROVIDER = 'tantra';

// Channels we mirror. Telegram is included because Tantra has it live and
// dropping it silently would lose real conversations; it is added to the CRM's
// channel vocabulary rather than discarded. SMS is absent from Tantra entirely
// and stays wholly CRM-side.
const MIRROR_CHANNELS = ['email', 'linkedin', 'whatsapp', 'telegram'];

// ─── connection ──────────────────────────────────────────────────────────────
// The key lives in channel_connections, encrypted at rest by crypto-box, the
// same treatment Twilio/Unipile/Resend credentials already get. It is never
// returned to a client: per tantra.md §2.1 Tantra's ScopesGuard is registered
// nowhere, so ANY valid key reaches every non-public route on that backend —
// contacts, campaigns, settings, billing. Whatever scopes are attached, the key
// we hold is effectively root, and it is stored accordingly.
async function getApiKey(companyId) {
  const conn = await channels.getConnection(companyId, PROVIDER);
  if (!conn || conn.status !== 'connected' || !conn.credentials) return null;
  return conn.credentials.api_key || conn.credentials.apiKey || null;
}

async function status(companyId) {
  const conn = await channels.getConnection(companyId, PROVIDER);
  const state = await tantraSync.getState(companyId);
  const connected = !!(conn && conn.status === 'connected' && conn.credentials);
  return {
    provider: PROVIDER,
    connected,
    blocked_reason: connected ? null : 'Tantra is not connected — add an API key in Settings → Integrations',
    account_ref: conn ? conn.account_ref : null,
    verified_at: conn ? conn.verified_at : null,
    watermark: state ? state.threads_synced_through : null,
    backfill_complete: state ? state.backfill_complete : false,
    backfill_cursor_page: state ? state.backfill_cursor_page : null,
    last_sweep_at: state ? state.last_sweep_at : null,
    last_error: state ? state.last_error : null,
    pending_nudges: await tantraSync.countPendingNudges(companyId),
    stats: state ? state.stats : {},
  };
}

// ─── one thread ──────────────────────────────────────────────────────────────
// `syncOneThread` takes a RAW Tantra thread; `syncNormalizedThread` takes one
// already through the normaliser. The list sweep normalises a whole page up
// front (so it can read `lastMessageAt` to decide whether to stop), and must
// call the latter — running a normalised object back through normalizeThread()
// would look for `id` on an object that now carries `externalThreadId` and
// silently drop every thread in the page.
async function syncNormalizedThread(companyId, apiKey, thread) {
  if (!thread || !thread.externalThreadId) return { skipped: 'unreadable thread' };

  let msgs = [];
  try {
    const payload = await tantraClient.getMessages(apiKey, thread.externalThreadId);
    msgs = normalize.normalizeMessageList(payload, {
      channel: thread.channel,
      accountRef: thread.accountRef,
    });
  } catch (e) {
    // One unreadable thread must not stall the sweep or freeze the watermark
    // behind it — report and move on.
    return { threadId: thread.externalThreadId, skipped: `messages unreadable: ${e.message}`, retryable: true };
  }

  return engine.syncThread(companyId, thread, msgs);
}

async function syncOneThread(companyId, apiKey, rawThread, { channelHint = null } = {}) {
  const thread = normalize.normalizeThread(rawThread, { channelHint });
  if (!thread) return { skipped: 'unreadable thread' };
  return syncNormalizedThread(companyId, apiKey, thread);
}

// ─── tick ────────────────────────────────────────────────────────────────────
// Nudges first (they are the low-latency path and the queue should not grow),
// then one incremental sweep page set.
//
// A blocked tick is `{ ok:false, reason }` and the ROUTE returns 200 for it —
// the house convention. "Tantra isn't connected" is an expected state, not a
// server error, and a 500 here would light up monitoring for a tenant that
// simply hasn't set the integration up.
async function tick(companyId, { maxPages = 3, limit = 25 } = {}) {
  const apiKey = await getApiKey(companyId);
  if (!apiKey) return { ok: false, reason: 'Tantra is not connected', threads: 0, messages: 0 };

  await tantraSync.getOrCreateState(companyId);
  const state = await tantraSync.getState(companyId);
  const watermark = state && state.threads_synced_through ? new Date(state.threads_synced_through) : null;

  const report = {
    ok: true, threads: 0, messages: 0, contactsCreated: 0,
    nudges: 0, pagesRead: 0, skipped: [], newestSeen: null,
  };
  // ISO timestamps of threads written this pass, and of threads that still need
  // another attempt. Together they decide how far the watermark may move.
  const synced = [];
  const unresolved = [];

  // ── nudges ──
  const nudges = await tantraSync.claimNudges(companyId, 25);
  for (const n of nudges) {
    report.nudges += 1;
    if (!n.thread_ref) continue;   // no thread id in the payload — the sweep will find it
    try {
      const raw = await tantraClient.getThread(apiKey, n.thread_ref);
      const r = await syncOneThread(companyId, apiKey, raw);
      if (r.skipped) report.skipped.push(r.skipped);
      else {
        report.threads += 1;
        report.messages += r.messagesWritten || 0;
        if (r.contactCreated) report.contactsCreated += 1;
      }
    } catch (e) {
      await tantraSync.failNudge(n.id, e.message);
      report.skipped.push(`nudge ${n.id}: ${e.message}`);
    }
  }

  // ── incremental sweep ──
  // Newest-first, stopping at the first page whose newest activity predates the
  // watermark. The stopping rule is the WATERMARK, not a page count: a page
  // count would either re-read the world every tick or silently stop short.
  let stop = false;
  for (let page = 1; page <= maxPages && !stop; page += 1) {
    let payload;
    try {
      payload = await tantraClient.listThreads(apiKey, { channels: MIRROR_CHANNELS, page, limit });
    } catch (e) {
      await tantraSync.recordSweep(companyId, { error: e.message });
      report.ok = false;
      report.reason = e.message;
      return report;
    }
    report.pagesRead += 1;

    const threads = normalize.normalizeThreadPage(payload);
    if (!threads.length) break;

    for (const t of threads) {
      if (t.lastMessageAt && (!report.newestSeen || t.lastMessageAt > report.newestSeen)) {
        report.newestSeen = t.lastMessageAt;
      }
      if (watermark && t.lastMessageAt && new Date(t.lastMessageAt) <= watermark) {
        // Everything from here back is already mirrored.
        stop = true;
        continue;
      }
      try {
        const r = await syncNormalizedThread(companyId, apiKey, t);
        if (r.skipped) {
          report.skipped.push(r.skipped);
          // Only a TRANSIENT skip holds the watermark. A decided one (two CRM
          // contacts claim the same identity) would otherwise stall the sweep
          // permanently, since re-reading produces the same refusal.
          if (r.retryable !== false && t.lastMessageAt) unresolved.push(t.lastMessageAt);
        } else {
          report.threads += 1;
          report.messages += r.messagesWritten || 0;
          if (r.contactCreated) report.contactsCreated += 1;
          if (t.lastMessageAt) synced.push(t.lastMessageAt);
        }
      } catch (e) {
        report.skipped.push(`thread ${t.externalThreadId}: ${e.message}`);
        if (t.lastMessageAt) unresolved.push(t.lastMessageAt);
      }
    }
  }

  // ── Where the watermark may safely move to ─────────────────────────────────
  // `report.ok` only reflects whether the LIST call succeeded. Advancing to the
  // newest thread SEEN would step over any individual thread that failed to
  // sync — and because the watermark is the sweep's stopping rule, that thread
  // would never be read again and its messages would be lost silently.
  //
  // So the mark moves to the newest thread we actually WROTE that is older than
  // the oldest still-unresolved one. Re-reading is free (writes are idempotent
  // on provider message id), so erring toward re-reading costs a request and
  // erring the other way costs data.
  const oldestUnresolved = unresolved.length ? unresolved.slice().sort()[0] : null;
  const safe = synced.filter(ts => !oldestUnresolved || ts < oldestUnresolved).sort();
  const advanceTo = safe.length ? safe[safe.length - 1] : null;
  if (report.ok && advanceTo) await tantraSync.advanceWatermark(companyId, advanceTo);
  report.watermarkAdvancedTo = advanceTo;
  report.heldBack = oldestUnresolved;
  await tantraSync.recordSweep(companyId, {
    error: null,
    stats: { threads: report.threads, messages: report.messages, pages: report.pagesRead },
  });

  return report;
}

// ─── backfill ────────────────────────────────────────────────────────────────
// The cold-start walk, separate from the sweep and resumable, because a large
// tenant will not finish in one tick. Operator-triggered.
async function backfill(companyId, { pages = 5, limit = 50 } = {}) {
  const apiKey = await getApiKey(companyId);
  if (!apiKey) return { ok: false, reason: 'Tantra is not connected' };

  await tantraSync.getOrCreateState(companyId);
  const state = await tantraSync.getState(companyId);
  if (state && state.backfill_complete) {
    return { ok: true, done: true, note: 'backfill already complete', threads: 0, messages: 0 };
  }

  let page = (state && state.backfill_cursor_page) || 1;
  const report = { ok: true, done: false, threads: 0, messages: 0, pagesRead: 0, skipped: [], fromPage: page };

  for (let i = 0; i < pages; i += 1) {
    let payload;
    try {
      payload = await tantraClient.listThreads(apiKey, { channels: MIRROR_CHANNELS, page, limit });
    } catch (e) {
      await tantraSync.recordSweep(companyId, { error: e.message, backfillCursorPage: page });
      return { ...report, ok: false, reason: e.message };
    }
    report.pagesRead += 1;

    const threads = normalize.normalizeThreadPage(payload);
    if (!threads.length) { report.done = true; break; }

    for (const t of threads) {
      try {
        const r = await syncNormalizedThread(companyId, apiKey, t);
        if (r.skipped) report.skipped.push(r.skipped);
        else { report.threads += 1; report.messages += r.messagesWritten || 0; }
      } catch (e) {
        report.skipped.push(`thread ${t.externalThreadId}: ${e.message}`);
      }
    }
    page += 1;
  }

  await tantraSync.recordSweep(companyId, {
    error: null,
    backfillCursorPage: page,
    backfillComplete: report.done,
    stats: { backfill_threads: report.threads, backfill_messages: report.messages },
  });
  report.nextPage = page;
  return report;
}

module.exports = { PROVIDER, MIRROR_CHANNELS, getApiKey, status, tick, backfill, syncOneThread };
