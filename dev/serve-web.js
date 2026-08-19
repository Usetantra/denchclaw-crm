'use strict';
// ─── Local dev shim for the DenchClaw CRM dashboard ──────────────────────────
// The committed API server (server/server.js) serves ONLY /api/crm + /health.
// The browser dashboard (web/index.html) is served in production by an nginx
// proxy that (a) hosts the page at /crm/ and (b) injects the X-Internal-Key
// auth header on every /crm/api call. This script reproduces that proxy locally
// so you can open the full UI at http://localhost:4100/crm/ .
//
//   Terminal 1:  npm run dev            # the real API on :3100
//   Terminal 2:  node dev/serve-web.js  # this shim on :4100
//   Browser:     http://localhost:4100/crm/
//
// Uses only deps already installed (express + dotenv) + Node's global fetch.

const path = require('path');
const express = require('express');
require('dotenv').config(); // pull INTERNAL_API_KEY from the same .env the API uses

const WEB_PORT   = process.env.WEB_PORT || 4100;
// Follows PORT so this shim keeps working when the API is not on its default
// port — .env sets PORT and nothing else told this file about it.
const API_TARGET = (process.env.API_TARGET || `http://localhost:${process.env.PORT || 3100}`).replace(/\/+$/, '');
const API_KEY    = process.env.INTERNAL_API_KEY;
const COMPANY_ID = process.env.DEFAULT_COMPANY_ID || 'growthclub';
// When Clerk is configured, this shim stops injecting the internal key and
// forwards the browser's Bearer token instead — mirroring what nginx does in
// production. Without this, every local test would exercise the KEY path while
// production exercises the CLERK path, and local green would prove nothing.
const CLERK_MODE = Boolean(process.env.CLERK_SECRET_KEY || process.env.CLERK_JWT_KEY);

if (!API_KEY && !CLERK_MODE) {
  console.error('[dev-web] INTERNAL_API_KEY is not set. Add it to .env (same key the API uses),');
  console.error('          or set CLERK_SECRET_KEY / CLERK_JWT_KEY to run the Clerk path instead.');
  process.exit(1);
}

const app = express();

// Proxy /crm/api/* → <API_TARGET>/api/crm/* with the auth headers injected.
// Raw passthrough of the body so JSON/other payloads forward untouched.
app.use('/crm/api', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const target = `${API_TARGET}/api/crm${req.url}`; // req.url = subpath + querystring
  try {
    const headers = { 'Accept': req.headers['accept'] || 'application/json' };
    if (CLERK_MODE) {
      // Humans authenticate as themselves. Note what is NOT set: no internal
      // key and no company id, so a browser cannot name its own tenant.
      if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    } else {
      headers['X-Internal-Key'] = API_KEY;
      headers['X-Company-Id'] = req.headers['x-company-id'] || COMPANY_ID;
    }
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody && req.body && req.body.length ? req.body : undefined,
    });

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error(`[dev-web] proxy error ${req.method} ${target}:`, err.message);
    res.status(502).json({ error: 'dev proxy failed to reach API', detail: err.message });
  }
});

// Serve the dashboard at /crm/ (matches the production mount anchor).
app.use('/crm', express.static(path.join(__dirname, '..', 'web')));
app.get('/', (_req, res) => res.redirect('/crm/'));

app.listen(WEB_PORT, () => {
  console.log(`[dev-web] dashboard  → http://localhost:${WEB_PORT}/crm/`);
  console.log(`[dev-web] proxying   /crm/api → ${API_TARGET}/api/crm  ${
    CLERK_MODE ? '(Clerk mode: Bearer forwarded, NO key injected)' : `(key injected, company=${COMPANY_ID})`}`);
});
