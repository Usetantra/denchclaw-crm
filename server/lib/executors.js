'use strict';
// ─── CP-C: the channel executors, all from ONE implementation ────────────────
// Each entry is an instance of lib/channel-executor.js. There is deliberately no
// second sending path: adding a channel means adding a provider adapter here,
// never another executor.
//
// NOT PRESENT, and deliberately: **linkedin**. Its safety spine is NOT in the
// adapter — every rate limit, the send window, the accept gate and the
// reserve-before-send lease live in the outreach engine's linkedin_gate.py plus
// the orchestration order in its dispatcher, which is not a reusable function.
// Wrapping the adapter alone would send up to 400 invites in an hour, at 3am, to
// people who never accepted: the exact way a real account gets restricted. There
// is no safe partial version, so LinkedIn gets its own checkpoint.
// Recorded in .loop/DECISIONS_PENDING.md.
//
// Also deliberately absent: WhatsApp's Playwright browser mode. It drives a
// single global logged-in WhatsApp Web session with no rate limiting and no
// per-tenant identity, so multi-tenant traffic would send one tenant's messages
// from another's number until the session is banned. Business API only.
const { makeExecutor } = require('./channel-executor');
const resendEmail = require('./email-resend');
const twilio = require('./twilio-send');

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

const twilioProvider = (channel) => ({
  isConfigured: () => twilio.isConfigured(),
  configReason: 'Twilio is not configured (TWILIO_ACCOUNT_SID + credentials)',
  senderReason: channel === 'sms'
    ? 'no connected sending number for sms — set TWILIO_PHONE'
    : 'no connected sending number for whatsapp — set TWILIO_WHATSAPP (or TWILIO_PHONE)',
  senderFor: () => twilio.senderFor(channel),
  send: async ({ from, to, payload }) => twilio.sendMessage({
    channel, from, to, body: payload.body,
    // An approved template, when the copy declares one. Free-form text is only
    // deliverable inside WhatsApp's 24-hour session window; a template is how a
    // first-contact message legitimately gets through.
    contentSid: payload.content_sid || null,
    contentVariables: payload.content_variables || null,
  }),
});

const email = makeExecutor({
  channel: 'email', provider: emailProvider,
  enabledEnv: 'EMAIL_EXECUTOR_ENABLED', batchEnv: 'EMAIL_EXECUTOR_BATCH',
  recipientField: 'email',
});
const sms = makeExecutor({
  channel: 'sms', provider: twilioProvider('sms'),
  enabledEnv: 'SMS_EXECUTOR_ENABLED', batchEnv: 'SMS_EXECUTOR_BATCH',
  recipientField: 'phone',
});
const whatsapp = makeExecutor({
  channel: 'whatsapp', provider: twilioProvider('whatsapp'),
  enabledEnv: 'WHATSAPP_EXECUTOR_ENABLED', batchEnv: 'WHATSAPP_EXECUTOR_BATCH',
  recipientField: 'phone',
});

const byChannel = { email, sms, whatsapp };
module.exports = { byChannel, email, sms, whatsapp, CHANNELS: Object.keys(byChannel) };
