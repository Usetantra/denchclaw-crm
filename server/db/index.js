// ─── Database Connection ─────────────────────────────────────────────────────
// PostgreSQL is required. The server refuses to start only on CONFIG errors
// (missing DATABASE_URL). Transient connection failures (e.g. "remaining
// connection slots are reserved", "too many clients", network blips) are
// retried forever with exponential backoff + jitter — the process must NEVER
// exit-loop on shared-Postgres pressure, because the pm2 crash↔restart cycle
// itself holds connection slots and makes the pressure worse.
// No JSON fallback — silent fallbacks hide data-loss bugs.

const { Pool } = require('pg');

let pool = null;
let ready = false;

const POOL_CONFIG = {
  // Modest, explicit cap. Box-wide budget rule: the sum of ALL engines' pools
  // + workers on this host must stay well under 150 (max_connections=200,
  // superuser slots reserved). See README "Connection budget".
  max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

// Retry policy: 1s → 2s → 4s → … capped at 30s, ±25% jitter.
const RETRY_BASE_MS = parseInt(process.env.DB_RETRY_BASE_MS, 10) || 1000;
const RETRY_CAP_MS = parseInt(process.env.DB_RETRY_CAP_MS, 10) || 30000;

function retryDelayMs(attempt) {
  const exp = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1); // ±25%
  return Math.max(250, Math.round(exp + jitter));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function initDatabase() {
  if (!process.env.DATABASE_URL) {
    // Config error — NOT retryable. The caller may exit.
    const err = new Error(
      'FATAL: DATABASE_URL is not configured. DenchClaw CRM requires PostgreSQL.'
    );
    err.fatal = true;
    throw err;
  }

  console.log('[db] Connecting to PostgreSQL via DATABASE_URL');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ...POOL_CONFIG,
  });

  // Runtime errors on idle clients (server restart, lost connection, slot
  // pressure) must NOT crash the process. pg emits 'error' on the pool for
  // backend-terminated idle clients; log and let the pool replace them.
  pool.on('error', (err) => {
    console.error('[db] Pool error (non-fatal):', err.message);
  });

  // Initial probe with retry + exponential backoff + jitter. Never gives up:
  // a CRM that waits for Postgres beats a crash loop that hogs pm2 restarts
  // and connection slots.
  for (let attempt = 0; ; attempt++) {
    try {
      const client = await pool.connect();
      try {
        const res = await client.query('SELECT NOW() AS now');
        console.log(`[db] Connected successfully at ${res.rows[0].now}` +
          (attempt > 0 ? ` (after ${attempt + 1} attempts)` : ''));
      } finally {
        client.release();
      }
      break;
    } catch (err) {
      const delay = retryDelayMs(attempt);
      console.error(
        `[db] Connection attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
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
