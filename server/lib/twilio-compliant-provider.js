'use strict';
// ─── The automated dispatcher's Twilio provider (CP-M2 → CP-C replacement) ────
// Retires twilio-send.js (env-configured, no compliance gate) from the SMS/
// WhatsApp executors. This is the same lib/twilio.js + compliance-gate.js path
// the manual composer already uses in routes/conversations.js — one send path,
// not two, per the user's explicit "replace it" decision.
//
// Mirrors linkedinProvider's shape (executors.js): permissive at the SYNC boot
// gate, because the connected identity is a per-tenant DB row and the boot gate
// has no tenant; the real check runs in the async, per-tick `preflight`. That is
// also where `companyId` gets stashed onto `ctx`, since `admitJob` doesn't
// receive it directly.
const channels = require('../db/models/channels');
const twilio = require('./twilio');
const complianceGate = require('./compliance-gate');

function twilioCompliantProvider(channel) {
  return {
    isConfigured: () => true,
    configReason: 'Twilio is not configured — this is checked per-tenant, not at boot',
    senderReason: `no connected ${channel} sender — connect Twilio and add a sender in Settings`,
    senderFor: () => 'per-tenant (channel_connections / channel_senders)',

    preflight: async (companyId) => {
      const conn = await channels.getConnection(companyId, 'twilio');
      if (!conn || conn.status !== 'connected' || !conn.credentials) {
        return { blocked: 'Twilio is not connected — connect it in Settings' };
      }
      const senders = await channels.listSenders(companyId, channel);
      const sender = senders.find(s => s.is_default) || senders[0];
      if (!sender) {
        return { blocked: `no connected ${channel === 'whatsapp' ? 'WhatsApp sender' : 'sending number'} — add one in Settings` };
      }
      return { sender: sender.identifier, creds: conn.credentials, companyId };
    },

    // Re-checked immediately before EVERY send — the same chokepoint the manual
    // composer passes through (routes/conversations.js), just reached from the
    // ladder instead of a reply. No `template` is passed: the automated path has
    // no template-authoring step wired up yet, so an out-of-window WhatsApp send
    // or a DLT-region SMS is correctly refused rather than waved through on a
    // fabricated APPROVED status.
    admitJob: async ({ job, contact, ctx, to }) => {
      const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) || {};
      const windowOpen = channel === 'whatsapp'
        ? !!(contact.cs_window_expires_at && new Date(contact.cs_window_expires_at) > new Date())
        : true;
      const g = await complianceGate.check({
        companyId: ctx.companyId, channel, contact, identifier: to,
        category: payload.category || 'conversational', windowOpen,
        destinationCountry: contact.destination_country,
      });
      if (!g.allowed) return `compliance gate: ${g.reason}`;
      return null;
    },

    send: async ({ to, payload, ctx }) => {
      const from = channel === 'whatsapp' && !String(ctx.sender).startsWith('whatsapp:')
        ? `whatsapp:${ctx.sender}` : ctx.sender;
      const dest = channel === 'whatsapp' && !String(to).startsWith('whatsapp:')
        ? `whatsapp:${to}` : to;
      const sent = await twilio.sendMessage({
        creds: ctx.creds, from, to: dest, body: payload.body,
        statusCallback: process.env.TWILIO_STATUS_CALLBACK || undefined,
      });
      // twilio.js speaks Twilio's own field names (sid/status); the executor
      // contract speaks id/providerStatus — the same translation
      // routes/conversations.js does inline for the manual composer path.
      return { id: sent.sid || null, providerStatus: sent.status || null };
    },
  };
}

module.exports = { twilioCompliantProvider };
