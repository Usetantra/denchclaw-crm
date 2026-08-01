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
const companiesRouter = require('./routes/companies');
const pipelinesRouter = require('./routes/pipelines');
const tenantsRouter = require('./routes/tenants');
const channelJobsRouter = require('./routes/channel-jobs');
const sequencesRouter = require('./routes/sequences');
const apiKeysRouter = require('./routes/api-keys');
const inboxRouter = require('./routes/inbox');
const templatesRouter = require('./routes/templates');
const executorsRouter = require('./routes/executors');
const automationsRouter = require('./routes/automations');
const webhooksRouter = require('./routes/webhooks');
const marketingRouter = require('./routes/marketing');
const marketingPublicRouter = require('./routes/marketing-public');

// CP-M union: this block conflicted because main added the /webhooks mount
// exactly where the branch added its four /api/crm routers. Selecting either
// side would have unmounted a whole feature with no test failure — inbound
// email, or all of A3/B1/B3/B7 at once. Both survive.
app.use('/webhooks', webhooksRouter); // provider → CRM (no internal key; secret-checked)
// CP-B public marketing surface — mounted OUTSIDE requireAuth and mounted TWICE
// on purpose. `/m` is the short, shareable prefix that goes into a prospect's
// invite link (`/m/i/<token>`), and it is deliberately not under `/api/` so a
// blanket "everything under /api needs a key" rule at the proxy can stay true.
// `/webhooks/marketing` is the same router at the path an operator will look for
// it, alongside the inbound-email webhook and the engines' own convention.
// DEPLOY NOTE: nginx must proxy BOTH prefixes for the invite links to resolve.
app.use('/m', marketingPublicRouter);
app.use('/webhooks/marketing', marketingPublicRouter);
app.use('/api/crm/marketing', marketingRouter);
app.use('/api/crm/chat', chatRouter);
app.use('/api/crm/companies', companiesRouter);
app.use('/api/crm/pipelines', pipelinesRouter);
app.use('/api/crm/tenants', tenantsRouter);
app.use('/api/crm/channel-jobs', channelJobsRouter);
app.use('/api/crm/sequences', sequencesRouter);
app.use('/api/crm/api-keys', apiKeysRouter);
app.use('/api/crm/inbox', inboxRouter);
app.use('/api/crm/templates', templatesRouter);
app.use('/api/crm/executors', executorsRouter);
app.use('/api/crm/automations', automationsRouter);
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
