// ─── Database Connection ─────────────────────────────────────────────────────
// PostgreSQL is required. Server will crash on boot if DATABASE_URL is not
// set or the initial probe fails. No JSON fallback — silent fallbacks hide
// data-loss bugs.

const { Pool } = require('pg');

let pool = null;
let ready = false;

const POOL_CONFIG = {
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'FATAL: DATABASE_URL is not configured. DenchClaw CRM requires PostgreSQL.'
    );
  }

  console.log('[db] Connecting to PostgreSQL via DATABASE_URL');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ...POOL_CONFIG,
  });

  pool.on('error', (err) => {
    console.error('[db] Pool error:', err.message);
  });

  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW() AS now');
    console.log(`[db] Connected successfully at ${res.rows[0].now}`);
  } finally {
    client.release();
  }

  ready = true;
  console.log('[db] Database ready (PostgreSQL)');
}

async function shutdownDatabase() {
  try {
    if (pool) {
      await pool.end();
      console.log('[db] Connection pool closed');
    }
  } catch (err) {
    console.error('[db] Error during shutdown:', err.message);
  } finally {
    pool = null;
    ready = false;
  }
}

async function query(text, params) {
  if (!pool) {
    throw new Error('[db] query() called before initDatabase()');
  }
  return pool.query(text, params);
}

async function getClient() {
  if (!pool) {
    throw new Error('[db] getClient() called before initDatabase()');
  }
  return pool.connect();
}

function isReady() {
  return ready && !!pool;
}

async function healthCheck() {
  if (!pool) throw new Error('Database pool not initialized');
  const start = Date.now();
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return { ok: true, latency_ms: Date.now() - start };
  } finally {
    client.release();
  }
}

function getPoolStats() {
  if (!pool) return { mode: 'uninitialized', total: 0, idle: 0, waiting: 0 };
  return {
    mode: 'postgresql',
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

module.exports = {
  get pool() { return pool; },
  query,
  getClient,
  initDatabase,
  shutdownDatabase,
  isReady,
  healthCheck,
  getPoolStats,
};
