'use strict';
// ─── CP-C: the channel executors, all from ONE implementation ────────────────
// Each entry is an instance of lib/channel-executor.js. There is deliberately no
// second sending path: adding a channel means adding a provider adapter here,
// never another executor.
//
// CP-C2 adds **linkedin**, and only now that its safety spine came with it. The
// spine is NOT in the adapter — every rate limit, the send window, the accept
// gate and the reserve-before-send lease live in the outreach engine's
// linkedin_gate.py plus the orchestration order in its dispatcher, which is not
// a reusable function there. Wrapping the adapter alone would send up to 400
// invites in an hour, at 3am, to people who never accepted: the exact way a real
// account gets restricted. So the gate was ported first (lib/linkedin-gate.js)
// and it runs at the CLAIM DOOR, where it can actually refuse.
//
// Deliberately absent: WhatsApp's Playwright browser mode. It drives a
// single global logged-in WhatsApp Web session with no rate limiting and no
// per-tenant identity, so multi-tenant traffic would send one tenant's messages
// from another's number until the session is banned. Business API only.
const { makeExecutor } = require('./channel-executor');
const resendEmail = require('./email-resend');
const { twilioCompliantProvider } = require('./twilio-compliant-provider');
const unipile = require('./unipile-send');
const linkedinGate = require('./linkedin-gate');
const { query } = require('../db/index');
const { getPipelineConfig } = require('../db/pipeline');
const { advanceContactStage, isAutomatedRequest } = require('./stage-authority');
const tasksDb = require('../db/models/tasks');

// Email keeps its exact boot-gate wording: CP4a's banked tests assert it, and
// naming the real env var is what makes the refusal actionable.
const emailProvider = {
  isConfigured: () => resendEmail.isConfigured(),
  configReason: 'RESEND_API_KEY is not configured',
  senderReason: 'no explicitly configured sending address for email — set CHANNEL_SENDERS',
  senderFor: () => {
    // The connected identity comes from CHANNEL_SENDERS, read FRESH — a safety
    // gate must not depend on module load order — and with NO fallback to the
    // built-in defaults, which exist only to populate the composer's picker.
    // An operator who configured nothing must not have real outreach go out
    // from an address they never chose.
    if (!process.env.CHANNEL_SENDERS) return null;
    let table;
    try { table = JSON.parse(process.env.CHANNEL_SENDERS); }
    catch {
      console.error('[CRM][email-executor] CHANNEL_SENDERS is not valid JSON — refusing to send rather than falling back to a default sender');
      return null;
    }
    const senders = (table && table.email) || [];
    const chosen = senders.find(s => s && s.default) || senders[0];
    return chosen && chosen.identity ? chosen.identity : null;
  },
  send: async ({ from, to, payload, idempotencyKey }) => {
    const sent = await resendEmail.sendEmail({
      from, to, subject: payload.subject, text: payload.body,
      replyTo: process.env.INBOUND_REPLY_TO || undefined, idempotencyKey,
    });
    return { id: sent.id || null, providerStatus: null };
  },
};

// ─── LinkedIn ────────────────────────────────────────────────────────────────
// The sender is a DB row, not an env var, because the connected identity is what
// carries the caps, the window and the timezone — an env-var account id would be
// an identity with no limits attached to it. So `preflight` resolves the account
// per tick (which is also how a paused account stops sending within one poll),
// and `senderFor` exists only to make the status endpoint honest before any
// tenant is known.
const linkedinProvider = {
  isConfigured: () => unipile.isConfigured(),
  configReason: 'Unipile is not configured (UNIPILE_API_KEY + UNIPILE_DSN)',
  senderReason: 'no connected LinkedIn account — connect one in linkedin_accounts',
  // Deliberately permissive at BOOT and strict at TICK: which account sends is a
  // per-tenant question, and the boot gate has no tenant. `preflight` below is
  // the real gate, and it refuses by name.
  senderFor: () => unipile.senderFor() || 'per-tenant (linkedin_accounts)',

  // Per tick, per tenant. This is where "the kill switch is checked per tick,
  // not per boot" becomes true for the account state as well as the env var.
  preflight: async (companyId) => {
    const pre = await linkedinGate.preScan(companyId);
    if (!pre.allow) return { blocked: `linkedin gate: ${pre.reason}` };
    return { sender: pre.account.account_id, account: pre.account };
  },

  // Re-checked immediately before EVERY send, not once per scan.
  admitJob: async ({ ctx }) => linkedinGate.admitJobNow(ctx.account),

  send: async ({ from, to, payload, job, contact }) => {
    // While an allowlist is active the target is derived from the profile URL
    // ONLY. The allowlist is checked against `contact.linkedin_url`, but the
    // normal path prefers a cached `metadata.linkedin_provider_id` — so a stale
    // provider_id would send to somebody the allowlist never cleared, during the
    // exact run whose whole purpose is that nobody unexpected is contacted.
    const fenced = !!String(process.env.LIVE_SEND_ALLOWLIST || '').trim();
    const target = (fenced ? null : unipile.publicIdentifier(contact)) ||
      (to && /linkedin\.com\/in\//i.test(to) ? unipile.publicIdentifier({ linkedin_url: to }) : null) ||
      (fenced ? null : unipile.publicIdentifier(contact));
    if (!target) {
      const e = new Error('contact has no resolvable LinkedIn identifier');
      e.definitive = true;
      throw e;
    }
    return unipile.sendAction({
      // The account the CLAIM DOOR stamped, not the one preflight happened to
      // resolve. They are the same today, but the caps were counted against the
      // stamped one — sending on any other account would leave a send that no
      // ledger ever counted.
      accountId: job.linkedin_account_id || from,
      // The action was decided and STAMPED by the claim door, which is the only
      // place that counted it against the per-type cap. Reading it back here —
      // rather than re-deriving it — is what keeps the count and the send from
      // ever describing different actions.
      action: job.linkedin_action || 'message',
      target, body: payload.body, subject: payload.subject || null,
    });
  },

  onSent: async ({ companyId, job, contact, ctx, sent }) => {
    if ((job.linkedin_action || 'message') !== 'invite') return;
    await linkedinGate.recordInvite(companyId, job.linkedin_account_id || ctx.account.account_id, job.contact_id, {
      providerId: sent.id || null, linkedinUrl: (contact && contact.linkedin_url) || null,
    });
  },

  onIneligible: async ({ companyId, job, ctx, error }) =>
    linkedinGate.markIneligible(companyId, job.linkedin_account_id || ctx.account.account_id, job.contact_id, error.message),
};

// ─── Action (F-WF: GHL-style workflows) ───────────────────────────────────────
// Not a message provider — the "send" IS the effect (add/remove a tag, change
// a pipeline stage, create a task, or fire an outbound webhook). Always
// configured/has-a-sender: there is no external account to connect, so the
// boot gate can never legitimately refuse an action step the way "no Twilio
// number" refuses an SMS one.
const actionProvider = {
  isConfigured: () => true,
  senderFor: () => 'workflow-action',
  send: async ({ payload, job, contact }) => {
    const companyId = job.company_id;
    const cfg = payload.action_config || {};
    switch (payload.action_type) {
      case 'add_tag':
      case 'remove_tag': {
        if (!cfg.tag || !String(cfg.tag).trim()) { const e = new Error('add_tag/remove_tag requires config.tag'); e.configError = true; e.definitive = true; throw e; }
        const tag = String(cfg.tag).trim();
        const current = contact.tags || [];
        const next = payload.action_type === 'add_tag'
          ? (current.includes(tag) ? current : [...current, tag])
          : current.filter(t => t !== tag);
        await query('UPDATE contacts SET tags=$1, updated_at=now() WHERE id=$2 AND company_id=$3', [next, contact.id, companyId]);
        // A workflow that adds a tag another workflow triggers on chains
        // naturally — same as a human adding that tag by hand. Two workflows
        // tagging each other back and forth would loop forever; that is on
        // the operator who wired it that way, the same tradeoff GHL itself
        // makes rather than banning cross-workflow tag triggers outright.
        if (payload.action_type === 'add_tag' && !current.includes(tag)) {
          await seqDbForActions().enrollForTriggerTag(companyId, contact.id, tag);
        }
        return { id: null, providerStatus: payload.action_type };
      }
      case 'change_stage': {
        if (!cfg.pipeline_key || !cfg.stage) { const e = new Error('change_stage requires config.pipeline_key and config.stage'); e.configError = true; e.definitive = true; throw e; }
        const pipeline = await getPipelineConfig(companyId, cfg.pipeline_key);
        if (!pipeline) { const e = new Error(`unknown pipeline '${cfg.pipeline_key}'`); e.configError = true; e.definitive = true; throw e; }
        const crmRouter = require('../routes/crm');
        const r = await advanceContactStage({
          companyId, contact, pipelineKey: cfg.pipeline_key, pipeline, stage: cfg.stage,
          automated: true, reason: 'workflow action', actor: 'workflow',
          recordActivity: crmRouter.addContactActivity,
        });
        // A refused transition (illegal, manual-only, suppressed) is a
        // workflow authored against a pipeline shape that changed since —
        // definitive, not a transient hiccup to retry.
        if (!r.ok) { const e = new Error(r.body?.error || 'stage change refused'); e.definitive = true; throw e; }
        return { id: null, providerStatus: cfg.stage };
      }
      case 'create_task': {
        if (!cfg.title) { const e = new Error('create_task requires config.title'); e.configError = true; e.definitive = true; throw e; }
        const dueInDays = Number.isFinite(cfg.due_in_days) ? cfg.due_in_days : 1;
        const dueAt = new Date(Date.now() + dueInDays * 86400000);
        const task = await tasksDb.create(companyId, {
          contactId: contact.id, title: cfg.title, notes: cfg.notes || null, dueAt,
          autoGenerated: true, sourcePipelineKey: null, sourceStageKey: null,
        });
        return { id: task.id, providerStatus: 'created' };
      }
      case 'webhook_out': {
        if (!cfg.url) { const e = new Error('webhook_out requires config.url'); e.configError = true; e.definitive = true; throw e; }
        const body = { contact: { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone, company_name: contact.company_name, tags: contact.tags }, ...(cfg.payload || {}) };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let r;
        try {
          r = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        } catch (err) {
          const e = new Error(`webhook_out: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
          e.outcomeUnknown = true; clearTimeout(timer); throw e;
        }
        clearTimeout(timer);
        if (!r.ok) {
          const e = new Error(`webhook_out: target returned HTTP ${r.status}`);
          if (r.status === 429) e.transient = true;
          else if (r.status >= 400 && r.status < 500) e.definitive = true;
          else e.outcomeUnknown = true;
          throw e;
        }
        return { id: null, providerStatus: String(r.status) };
      }
      default: {
        const e = new Error(`unknown workflow action_type '${payload.action_type}'`);
        e.configError = true; e.definitive = true;
        throw e;
      }
    }
  },
};
// Lazy require — sequences.js does not require executors.js, but avoiding a
// module-load-order assumption either way is one line cheaper than debugging
// a circular-require someday.
function seqDbForActions() { return require('../db/models/sequences'); }

const email = makeExecutor({
  channel: 'email', provider: emailProvider,
  enabledEnv: 'EMAIL_EXECUTOR_ENABLED', batchEnv: 'EMAIL_EXECUTOR_BATCH',
  recipientField: 'email',
});
const sms = makeExecutor({
  channel: 'sms', provider: twilioCompliantProvider('sms'),
  enabledEnv: 'SMS_EXECUTOR_ENABLED', batchEnv: 'SMS_EXECUTOR_BATCH',
  recipientField: 'phone',
});
const whatsapp = makeExecutor({
  channel: 'whatsapp', provider: twilioCompliantProvider('whatsapp'),
  enabledEnv: 'WHATSAPP_EXECUTOR_ENABLED', batchEnv: 'WHATSAPP_EXECUTOR_BATCH',
  recipientField: 'phone',
});

const linkedin = makeExecutor({
  channel: 'linkedin', provider: linkedinProvider,
  enabledEnv: 'LINKEDIN_EXECUTOR_ENABLED', batchEnv: 'LINKEDIN_EXECUTOR_BATCH',
  recipientField: 'linkedin_url',
});

// recipientField:'id' — an action step has no external address to send to;
// "the recipient" is just the contact the action applies to, and every
// contact row has an id, so this can never spuriously quarantine for "no
// recipient" the way a contact with no phone/email legitimately would.
const action = makeExecutor({
  channel: 'action', provider: actionProvider,
  enabledEnv: 'ACTION_EXECUTOR_ENABLED', batchEnv: 'ACTION_EXECUTOR_BATCH',
  recipientField: 'id',
});

const byChannel = { email, sms, whatsapp, linkedin, action };

// ─── CP-Z: the SENDABLE set, derived and never hand-maintained ───────────────
// Five whitelists elsewhere accept `ai_call` as a channel, and nothing here can
// build an executor for it — so a step could be created, a job queued, and the
// claim door would hand that job to a worker that does not exist. It came back
// `claimed` and stayed there: accepted at the front door with nothing behind it.
//
// This is `Object.keys(byChannel)`, so it cannot drift from what actually
// exists. Adding a provider adapter above is the ONLY way to make a channel
// sendable — there is deliberately no second list to update and forget.
//
// SENDABLE is not the same question as RECORDABLE, and conflating them would
// have been the wrong fix. An AI call that happened out of band is a real event
// worth logging on the timeline, and inbox/marketing-event ingestion rightly
// still accept `ai_call`. What the CRM cannot do is QUEUE ONE TO BE SENT.
const CHANNELS = Object.keys(byChannel);
const canSend = (channel) => Object.prototype.hasOwnProperty.call(byChannel, channel);

module.exports = { byChannel, email, sms, whatsapp, linkedin, action, CHANNELS, canSend };
