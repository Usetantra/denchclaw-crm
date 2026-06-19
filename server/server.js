'use strict';
require('dotenv').config();
const express = require('express');
const { initDatabase, healthCheck } = require('./db/index');

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const crmRouter = require('./routes/crm');
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
  await initDatabase();
  app.listen(PORT, () => console.log(`[DenchClaw CRM] listening on :${PORT}`));
}

start().catch(err => {
  console.error('[DenchClaw CRM] Fatal startup error:', err.message);
  process.exit(1);
});
