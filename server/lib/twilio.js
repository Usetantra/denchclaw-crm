'use strict';
// ─── Twilio adapter (compliance-gated path) ───────────────────────────────────
// Talks to Twilio's REST API on behalf of a company's DB-connected credentials
// (server/db/models/channels.js, AES-256-GCM at rest via crypto-box.js). Accepts
// either Account SID + Auth Token, or Account SID + API Key SID/Secret (preferred).
// This module handles the "connect" verb (verify credentials, list numbers) plus
// sending/Content-API calls; every send is expected to have already passed
// server/lib/compliance-gate.js (consent, suppression, 24h window, DLT).
//
// twilio-send.js (CP-C) is retired from the automated channel-jobs executor —
// this module is now that path too (see .loop/DECISIONS_PENDING.md, CP-M2:
// "replace it"). Every automated send passes compliance-gate.js first, exactly
// like the manual composer path in routes/conversations.js.
//
// Overridable base so the send path can be exercised against a LOCAL STUB,
// mirroring twilio-send.js's TWILIO_API_BASE seam — without it this module
// cannot be tested without hitting real Twilio.
const API_BASE = () =>
  String(process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, '');
const base = () => `${API_BASE()}/2010-04-01`;

// creds: { account_sid, auth_token?, api_key_sid?, api_key_secret? }
function authHeader(creds) {
  const user = creds.api_key_sid || creds.account_sid;
  const pass = creds.api_key_secret || creds.auth_token;
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function call(creds, path) {
  const r = await fetch(`${base()}/Accounts/${encodeURIComponent(creds.account_sid)}${path}`, {
    headers: { Authorization: authHeader(creds), accept: 'application/json' },
  });
  let j = {};
  try { j = await r.json(); } catch (_e) {}
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || j.detail || 'request failed'}`);
  return j;
}

// Confirm the credentials are valid → { account_sid, friendly_name, status }.
async function verify(creds) {
  if (!creds || !creds.account_sid) throw new Error('account_sid required');
  if (!(creds.auth_token || (creds.api_key_sid && creds.api_key_secret))) {
    throw new Error('auth_token or api_key_sid+api_key_secret required');
  }
  const a = await call(creds, '.json');
  return { account_sid: a.sid, friendly_name: a.friendly_name, status: a.status };
}

// List the account's phone numbers (for choosing a sender).
async function listNumbers(creds) {
  const j = await call(creds, '/IncomingPhoneNumbers.json?PageSize=100');
  return (j.incoming_phone_numbers || []).map(n => ({
    phone_number: n.phone_number,
    friendly_name: n.friendly_name,
    sms: !!(n.capabilities && n.capabilities.sms),
    mms: !!(n.capabilities && n.capabilities.mms),
    voice: !!(n.capabilities && n.capabilities.voice),
  }));
}

// List the account's WhatsApp senders (separate from phone numbers — WhatsApp
// registration lives in the Messaging Senders API, not IncomingPhoneNumbers).
async function listWhatsAppSenders(creds) {
  const r = await fetch('https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp', {
    headers: { Authorization: authHeader(creds), accept: 'application/json' },
  });
  let j = {};
  try { j = await r.json(); } catch (_e) {}
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || 'whatsapp senders request failed'}`);
  return (j.senders || []).map(s => ({
    sender_id: s.sender_id,                              // e.g. "whatsapp:+16088880152"
    status: s.status,                                   // ONLINE | OFFLINE | …
    quality: (s.properties && s.properties.quality_rating) || null,
    tier: (s.properties && s.properties.messaging_limit) || null,
  }));
}

// ── Content API (templates) ───────────────────────────────────────────────────
// Twilio Content is the authoring surface for WhatsApp templates; submitting a
// content resource for WhatsApp approval forwards it to Meta and reports status.
const contentBase = 'https://content.twilio.com/v1';

async function contentCall(creds, method, path, payload) {
  const r = await fetch(`${contentBase}${path}`, {
    method,
    headers: { Authorization: authHeader(creds), 'content-type': 'application/json', accept: 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (_e) {}
  if (!r.ok) throw new Error(`Twilio Content ${r.status}${j.code ? ' [' + j.code + ']' : ''}: ${j.message || 'request failed'}`);
  return j;
}

// Map our template definition → the appropriate Twilio Content `types`.
function buildContentTypes(t) {
  const buttons = t.buttons || [];
  const cta = buttons.filter(b => /url|phone/i.test(b.type));
  const qr = buttons.filter(b => /quick/i.test(b.type));
  const types = {};
  if (cta.length) {
    types['twilio/call-to-action'] = {
      body: t.body,
      actions: cta.map(b => /phone/i.test(b.type)
        ? { type: 'PHONE_NUMBER', title: b.title, phone: b.phone }
        : { type: 'URL', title: b.title, url: b.url }),
    };
  } else if (qr.length) {
    types['twilio/quick-reply'] = { body: t.body, actions: qr.map((b, i) => ({ title: b.title, id: b.id || `btn_${i}` })) };
  } else if (t.header && t.header.media) {
    types['twilio/media'] = { body: t.body, media: [t.header.media] };
  } else {
    types['twilio/text'] = { body: t.body };
  }
  return types;
}

// Create a Content resource → { sid }.
async function createContent(creds, t) {
  const payload = {
    friendly_name: t.name,
    language: t.language || 'en',
    variables: t.variables_map || {},
    types: buildContentTypes(t),
  };
  const j = await contentCall(creds, 'POST', '/Content', payload);
  return { sid: j.sid, ...j };
}

// Submit a content resource for WhatsApp (Meta) approval under a category.
async function submitApproval(creds, contentSid, { name, category }) {
  return contentCall(creds, 'POST', `/Content/${contentSid}/ApprovalRequests/whatsapp`, { name, category });
}

// Current approval status for a content resource.
async function fetchApproval(creds, contentSid) {
  const j = await contentCall(creds, 'GET', `/Content/${contentSid}/ApprovalRequests`);
  const wa = j.whatsapp || (j.approval_requests && j.approval_requests.whatsapp) || {};
  return { status: (wa.status || j.status || 'unknown'), category: wa.category || null, rejection_reason: wa.rejection_reason || null, raw: j };
}

async function deleteContent(creds, contentSid) {
  return contentCall(creds, 'DELETE', `/Content/${contentSid}`);
}

const TIMEOUT_MS = parseInt(process.env.TWILIO_TIMEOUT_MS, 10) || 15000;

// Send an SMS/MMS/WhatsApp message. from/to are already channel-formatted
// (WhatsApp = "whatsapp:+…"). Pass contentSid+contentVariables to send an
// approved template. Returns { sid, status, error_code }.
//
// Errors carry the same classification contract twilio-send.js established
// (configError / definitive / transient / outcomeUnknown), because
// lib/twilio-compliant-provider.js — the automated dispatcher's provider —
// branches on it exactly like every other channel-executor provider does.
async function sendMessage({ creds, from, to, body, mediaUrl, statusCallback, messagingServiceSid, contentSid, contentVariables }) {
  const params = new URLSearchParams();
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid); else params.set('From', from);
  params.set('To', to);
  if (contentSid) {
    params.set('ContentSid', contentSid);
    if (contentVariables) params.set('ContentVariables', typeof contentVariables === 'string' ? contentVariables : JSON.stringify(contentVariables));
  } else if (body != null) params.set('Body', String(body));
  if (mediaUrl) params.set('MediaUrl', mediaUrl);
  if (statusCallback) params.set('StatusCallback', statusCallback);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r;
  try {
    r = await fetch(`${base()}/Accounts/${encodeURIComponent(creds.account_sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: authHeader(creds), 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error(
      err.name === 'AbortError'
        ? `Twilio: no response within ${TIMEOUT_MS}ms — the message may or may not have been sent`
        : `Twilio: network fault (${err.message}) — the message may or may not have been sent`
    );
    e.outcomeUnknown = true;
    throw e;
  }
  let j = {};
  try { j = await r.json(); } catch (_e) {}
  finally { clearTimeout(timer); }

  if (!r.ok) {
    const msg = j.message || j.detail || `HTTP ${r.status}`;
    const e = new Error(`Twilio ${r.status}${j.code ? ' [' + j.code + ']' : ''}: ${msg}`);
    if (r.status === 401 || r.status === 403) { e.configError = true; e.definitive = true; }
    else if (r.status === 429 || j.code === 20429) { e.transient = true; }
    else if (r.status >= 400 && r.status < 500) e.definitive = true;
    else e.outcomeUnknown = true;
    e.status = r.status; e.providerCode = j.code || null;
    throw e;
  }
  return { sid: j.sid, status: j.status, error_code: j.error_code || null };
}

function isConfigured() { return true; } // connection-scoped; creds passed per call

module.exports = {
  verify, listNumbers, listWhatsAppSenders, sendMessage,
  createContent, submitApproval, fetchApproval, deleteContent,
  isConfigured, TIMEOUT_MS, API_BASE, __providerName: 'twilio',
};
