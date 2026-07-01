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
const API_TARGET = (process.env.API_TARGET || 'http://localhost:3100').replace(/\/+$/, '');
const API_KEY    = process.env.INTERNAL_API_KEY;
const COMPANY_ID = process.env.DEFAULT_COMPANY_ID || 'growthclub';

if (!API_KEY) {
  console.error('[dev-web] INTERNAL_API_KEY is not set. Add it to .env (same key the API uses).');
  process.exit(1);
}

const app = express();

// Proxy /crm/api/* → <API_TARGET>/api/crm/* with the auth headers injected.
// Raw passthrough of the body so JSON/other payloads forward untouched.
app.use('/crm/api', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const target = `${API_TARGET}/api/crm${req.url}`; // req.url = subpath + querystring
  try {
    const headers = {
      'X-Internal-Key': API_KEY,
      'X-Company-Id': req.headers['x-company-id'] || COMPANY_ID,
      'Accept': req.headers['accept'] || 'application/json',
    };
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
  console.log(`[dev-web] proxying   /crm/api → ${API_TARGET}/api/crm  (key injected, company=${COMPANY_ID})`);
});
