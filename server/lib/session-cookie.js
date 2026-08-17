'use strict';
// ─── Minimal cookie read/write for the session ────────────────────────────────
// One cookie, one purpose — not worth a dependency (cookie-parser/express-
// session). httpOnly always (never readable from page JS — the token is a
// bearer credential); Secure only in production, because a browser silently
// drops a Secure cookie set over plain http, which would make local dev
// (http://127.0.0.1:8787) look like login "succeeds" but the session never
// sticks — a much worse failure mode than the (accepted, since this is a
// first-party same-origin cookie) risk of sending it over http locally.
const COOKIE_NAME = 'dc_session';

function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeMs) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

module.exports = { COOKIE_NAME, readSessionCookie, setSessionCookie, clearSessionCookie };
