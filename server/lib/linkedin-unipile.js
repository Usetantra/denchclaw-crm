'use strict';
// ─── Unipile LinkedIn adapter ─────────────────────────────────────────────────
// Drives connected LinkedIn accounts through Unipile: list accounts, resolve
// profiles (connection distance), send messages (reply-in-chat or new chat),
// send connection invites, and mint hosted-auth links so users can connect
// additional accounts from the UI.
//
// Env: UNIPILE_API_KEY, UNIPILE_DSN, UNIPILE_LINKEDIN_ACCOUNT_ID (default
// account). Sending is additionally gated by LINKEDIN_SEND_ENABLED=true so a
// connected account is never messaged unintentionally.
//
// Verified live: GET /accounts, GET /users/{identifier}, and multipart
// POST /chats (returns { chat_id, message_id }).

function isConfigured() {
  return !!(process.env.UNIPILE_API_KEY && process.env.UNIPILE_DSN);
}

function sendEnabled() {
  return process.env.LINKEDIN_SEND_ENABLED === 'true';
}

function defaultAccountId() {
  return process.env.UNIPILE_LINKEDIN_ACCOUNT_ID || null;
}

function baseUrl() {
  const dsn = process.env.UNIPILE_DSN || '';
  return /^https?:\/\//.test(dsn) ? dsn : `https://${dsn}`;
}

async function unipile(method, path, { json, form } = {}) {
  const headers = { 'X-API-KEY': process.env.UNIPILE_API_KEY, accept: 'application/json' };
  let body;
  if (form) {
    body = new FormData();
    for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) body.append(k, v);
  } else if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const r = await fetch(`${baseUrl()}/api/v1${path}`, { method, headers, body });
  let j = {};
  try { j = await r.json(); } catch (_e) {}
  if (!r.ok) throw new Error(`Unipile ${r.status}: ${j.detail || j.message || j.error || j.title || 'request failed'}`);
  return j;
}

// Connected LinkedIn accounts → [{ id, name }] (for the From dropdown).
async function listAccounts() {
  const j = await unipile('GET', '/accounts');
  const items = j.items || j.accounts || (Array.isArray(j) ? j : []);
  return items
    .filter(a => String(a.type || '').toUpperCase().includes('LINKEDIN'))
    .map(a => ({ id: a.id || a.account_id, name: a.name || a.username || 'LinkedIn account' }));
}

// Resolve a LinkedIn profile (public identifier or provider id) as seen from an
// account → { providerId, name, distance, publicIdentifier }. distance is
// 'FIRST_DEGREE' when the account and the person are connected.
async function resolveProfile(identifier, accountId) {
  const j = await unipile('GET', `/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`);
  return {
    providerId: j.provider_id || j.member_id || null,
    name: j.name || `${j.first_name || ''} ${j.last_name || ''}`.trim(),
    distance: j.network_distance || j.distance || null,
    publicIdentifier: j.public_identifier || null,
    headline: j.headline || null,
  };
}

// Send a LinkedIn message: reply into an existing chat, or start a new chat with
// the recipient's provider id. Returns { id, chatId }.
async function sendMessage({ accountId, chatId, attendeeProviderId, text }) {
  if (!isConfigured()) throw new Error('Unipile LinkedIn not configured');
  if (!text) throw new Error('message text required');
  if (chatId) {
    const j = await unipile('POST', `/chats/${encodeURIComponent(chatId)}/messages`, { form: { text } });
    return { id: j.message_id || j.id || null, chatId };
  }
  const account = accountId || defaultAccountId();
  if (!account) throw new Error('no LinkedIn account selected');
  if (attendeeProviderId) {
    const j = await unipile('POST', '/chats', { form: { account_id: account, attendees_ids: attendeeProviderId, text } });
    return { id: j.message_id || null, chatId: j.chat_id || null };
  }
  throw new Error('no LinkedIn chat or recipient id — reply to a thread or resolve the profile first');
}

// Connection request with an optional note (LinkedIn caps notes at 300 chars).
async function sendInvite({ accountId, providerId, message }) {
  if (!isConfigured()) throw new Error('Unipile LinkedIn not configured');
  const body = { account_id: accountId || defaultAccountId(), provider_id: providerId };
  if (message) body.message = String(message).slice(0, 300);
  return unipile('POST', '/users/invite', { json: body });
}

// Hosted-auth link: the user opens this URL to connect a (new) LinkedIn account.
// The new account then appears in listAccounts().
async function hostedAuthLink({ notifyUrl, name } = {}) {
  if (!isConfigured()) throw new Error('Unipile not configured');
  const body = {
    type: 'create',
    providers: ['LINKEDIN'],
    api_url: baseUrl(),
    expiresOn: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h
  };
  if (notifyUrl) body.notify_url = notifyUrl;
  if (name) body.name = name;
  const j = await unipile('POST', '/hosted/accounts/link', { json: body });
  return { url: j.url || null };
}

module.exports = {
  isConfigured, sendEnabled, defaultAccountId,
  listAccounts, resolveProfile, sendMessage, sendInvite, hostedAuthLink,
};
