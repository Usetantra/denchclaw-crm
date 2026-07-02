'use strict';
// Env load: local ./.env (and real OS env) win; the shared automation env then
// fills the service-to-service handshake keys (INTERNAL_API_KEYS / CRM_API_KEY)
// so they live in ONE place alongside the engines. The CRM uses its OWN denchclaw
// DB, so the shared automation DATABASE_URL is never allowed to leak in.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config(); // local ./.env + OS env take priority
const _hadDbUrl = !!process.env.DATABASE_URL;
let _shared = process.env.AUTOMATION_ENV_FILE;
if (!_shared || !fs.existsSync(_shared)) {
  let dir = __dirname;
  for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
    const c1 = path.join(dir, 'automation-engines-shared', '.env.shared');
    const c2 = path.join(dir, '.env.shared');
    if (fs.existsSync(c1)) { _shared = c1; break; }
    if (fs.existsSync(c2)) { _shared = c2; break; }
    dir = path.dirname(dir);
  }
}
if (_shared && fs.existsSync(_shared)) dotenv.config({ path: _shared, override: false });
if (!_hadDbUrl) delete process.env.DATABASE_URL; // CRM must use its own denchclaw DB
const express = require('express');
const { initDatabase, healthCheck } = require('./db/index');

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const crmRouter = require('./routes/crm');
const chatRouter = require('./routes/chat');
const conversationsRouter = require('./routes/conversations');
const analyticsRouter = require('./routes/analytics');
app.use('/api/crm/chat', chatRouter);
app.use('/api/crm', conversationsRouter);
app.use('/api/crm', analyticsRouter);
app.use('/api/crm', crmRouter);

app.get('/health', async (req, res) => {
  try {
    const db = await healthCheck();
    res.json({ ok: true, service: 'denchclaw-crm', db });
  } catch (err) {
    res.status(503).json({ ok: false, service: 'denchclaw-crm', error: err.message });
  }
});

const PORT = process.env.PORT || 3100;

async function start() {
  // Listen first so /health answers (503) while the DB probe retries.
  // initDatabase() retries transient connection failures forever with
  // exponential backoff + jitter — it only rejects on CONFIG errors
  // (err.fatal, e.g. missing DATABASE_URL). Never exit on transient
  // pool errors: a crash↔restart loop under pm2 holds connection slots
  // and makes shared-Postgres pressure worse.
  app.listen(PORT, () => console.log(`[DenchClaw CRM] listening on :${PORT}`));
  await initDatabase();
}

start().catch(err => {
  if (err && err.fatal) {
    console.error('[DenchClaw CRM] Fatal startup error (config):', err.message);
    process.exit(1);
  }
  // Defensive: anything non-config is logged but does not kill the process.
  console.error('[DenchClaw CRM] Startup error (non-fatal, continuing):', err.message);
});

// Last-resort guards: a stray rejection/exception from a lost DB connection
// must not take the service down.
process.on('unhandledRejection', (err) => {
  console.error('[DenchClaw CRM] Unhandled rejection (non-fatal):', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('[DenchClaw CRM] Uncaught exception (non-fatal):', err && err.message ? err.message : err);
});
