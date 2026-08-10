'use strict';
// ─── Credential encryption (AES-256-GCM) ──────────────────────────────────────
// Encrypts provider secrets (e.g. Twilio Auth Token) before they touch the DB.
// Key: CREDENTIALS_KEY env (64-hex = 32 bytes). If unset, a key is derived from
// INTERNAL_API_KEY via scrypt so local/dev still works — but set CREDENTIALS_KEY
// explicitly in any real deployment (rotating INTERNAL_API_KEY would otherwise
// make stored secrets undecryptable).
const crypto = require('crypto');

function key() {
  const hex = process.env.CREDENTIALS_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  const seed = process.env.INTERNAL_API_KEY || 'denchclaw-dev-fallback';
  return crypto.scryptSync(seed, 'denchclaw-cred-salt', 32);
}

// → "v1:<iv b64>:<tag b64>:<ciphertext b64>"
function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad ciphertext format');
  const [, ivB64, tagB64, ctB64] = parts;
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ctB64, 'base64')), d.final()]).toString('utf8');
}

// Convenience for encrypting/decrypting a JSON bundle of secrets.
function encryptJSON(obj) { return encrypt(JSON.stringify(obj || {})); }
function decryptJSON(blob) { const s = decrypt(blob); return s ? JSON.parse(s) : null; }

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON };
