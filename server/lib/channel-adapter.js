'use strict';
// ─── Channel adapter registry (provider abstraction) ──────────────────────────
// A uniform contract every channel/provider implements, so the CRM's send path,
// webhook ingestion and template sync are provider-agnostic. Swapping a provider
// (e.g. WhatsApp Cloud API → a BSP) is a new adapter registration, not a rewrite.
//
// An adapter implements a subset of:
//   isConfigured()                         → boolean
//   resolveSender(ctx)                     → { identifier, ... }        (which connected sender)
//   send({ to, body, template, media, from, meta })  → { providerId, status, ... }
//   parseInbound(payload)                  → normalized inbound event
//   parseStatus(payload)                   → normalized status event
//   syncTemplates()                        → [templates]               (WhatsApp/DLT)
//   verifySignature(req)                   → boolean                    (webhook auth)
//
// Phase A ships the registry + contract only; concrete Twilio adapters land in the
// provider phase. Capability flags let the UI/gate adapt without hard-coding.

const registry = new Map(); // channel → adapter

function register(channel, adapter) {
  registry.set(channel, adapter);
  return adapter;
}

function get(channel) {
  return registry.get(channel) || null;
}

function has(channel) {
  const a = registry.get(channel);
  return !!(a && (typeof a.isConfigured !== 'function' || a.isConfigured()));
}

function capabilities(channel) {
  const a = registry.get(channel);
  if (!a) return {};
  return {
    send: typeof a.send === 'function',
    inbound: typeof a.parseInbound === 'function',
    status: typeof a.parseStatus === 'function',
    templates: typeof a.syncTemplates === 'function',
    signature: typeof a.verifySignature === 'function',
  };
}

module.exports = { register, get, has, capabilities, registry };
