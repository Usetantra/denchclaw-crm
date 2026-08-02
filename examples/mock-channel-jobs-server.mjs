#!/usr/bin/env node
// In-memory reference implementation of docs/contracts/channel-executor.openapi.yaml,
// used to self-test the CONTRACT SHAPE (claim/ack semantics: ownership, idempotency,
// claim-timeout reclaim, retry signaling) — not real CRM wiring. No Postgres, no auth
// layers (those already exist elsewhere in this repo and aren't what B4 is proving).
//
// IMPORTANT: this mock's claim loop is a plain synchronous `for` over an in-memory Map.
// It proves the STATE MACHINE (no job handed to two owners, timeout reclaim, idempotent/
// conflicting ack) is internally consistent. It does NOT prove a real Postgres
// implementation is concurrency-safe — that requires a single atomic
// `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` transaction;
// a naive SELECT-then-UPDATE under READ COMMITTED can double-claim even though this
// mock, being single-threaded JS, never will. Node's single-threadedness is a
// convenience for testing the state machine, not evidence about SQL concurrency.
//
// Usage: node examples/mock-channel-jobs-server.mjs [port]
// Exposes: POST /api/crm/channel-jobs/claim, POST /api/crm/channel-jobs/:id/ack,
//          POST /_seed (test-only, not part of the public contract)

import express from 'express';
import { randomUUID } from 'node:crypto';

const CLAIM_TIMEOUT_MS = Number(process.env.CLAIM_TIMEOUT_MS) || 300_000;
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS) || 3;
const CHANNELS = ['email', 'sms', 'whatsapp', 'ai_call', 'linkedin'];

const app = express();
app.use(express.json());

const jobs = new Map(); // job_id -> job record

function makeJob(overrides = {}) {
  const job_id = randomUUID();
  const job = {
    job_id,
    company_id: overrides.company_id || 'co_demo',
    contact_id: overrides.contact_id || randomUUID(),
    sequence_id: overrides.sequence_id || randomUUID(),
    step_id: overrides.step_id || randomUUID(),
    channel: overrides.channel || 'email',
    template_ref: overrides.template_ref || 'welcome_v1',
    payload: overrides.payload || {},
    scheduled_for: overrides.scheduled_for || new Date().toISOString(),
    attempt: 1,
    status: 'pending', // pending | claimed | sent | failed | skipped
    claimed_by: null,
    claimed_at: null,
    acked_status: null,
  };
  jobs.set(job_id, job);
  return job;
}

function isReclaimable(job) {
  if (job.status !== 'claimed') return false;
  return Date.now() - new Date(job.claimed_at).getTime() > CLAIM_TIMEOUT_MS;
}

// Test-only seeding hook — not part of the public contract.
app.post('/_seed', (req, res) => {
  const { channel, count = 1, scheduled_for } = req.body || {};
  const created = Array.from({ length: count }, () => makeJob({ channel, scheduled_for }));
  res.json({ created: created.map(j => j.job_id) });
});

app.post('/api/crm/channel-jobs/claim', (req, res) => {
  const { channel, limit = 10, claimed_by } = req.body || {};
  if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'invalid channel' });
  if (!claimed_by) return res.status(400).json({ error: 'claimed_by required' });
  if (limit > 100) return res.status(400).json({ error: 'limit exceeds max of 100' });

  const now = Date.now();
  const claimed = [];
  for (const job of jobs.values()) {
    if (claimed.length >= limit) break;
    if (job.channel !== channel) continue;
    if (new Date(job.scheduled_for).getTime() > now) continue;
    const eligible = job.status === 'pending' || isReclaimable(job);
    if (!eligible) continue;
    job.status = 'claimed';
    job.claimed_by = claimed_by;
    job.claimed_at = new Date().toISOString();
    claimed.push(job);
  }
  res.json({ jobs: claimed });
});

app.post('/api/crm/channel-jobs/:job_id/ack', (req, res) => {
  const job = jobs.get(req.params.job_id);
  const { status, error, claimed_by } = req.body || {};
  if (!claimed_by) return res.status(400).json({ error: 'claimed_by required' });
  // Same 404 whether the job doesn't exist or belongs to someone else — no
  // existence disclosure to a caller that never won the claim (matches the
  // rest of this API's row-scoping posture, see docs/API_CONTRACT.md).
  if (!job || !job.claimed_by || job.claimed_by !== claimed_by) {
    return res.status(404).json({ error: 'unknown job, or not claimed by this claimed_by' });
  }
  if (!['sent', 'failed', 'skipped'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  if (status === 'failed' && !error) {
    return res.status(400).json({ error: 'error required when status=failed' });
  }

  if (job.acked_status) {
    if (job.acked_status === status) {
      // Idempotent replay — same terminal status, no-op.
      return res.json({ ok: true, job_id: job.job_id, status: job.acked_status });
    }
    return res.status(409).json({ error: `job already acked as '${job.acked_status}', cannot re-ack as '${status}'` });
  }

  job.acked_status = status;
  job.status = status;

  let retry = null;
  if (status === 'failed') {
    const willRetry = job.attempt < MAX_ATTEMPTS;
    retry = {
      will_retry: willRetry,
      next_attempt_at: willRetry ? new Date(Date.now() + 60_000 * job.attempt).toISOString() : null,
      attempt: job.attempt,
      max_attempts: MAX_ATTEMPTS,
    };
    if (willRetry) {
      // Re-queue for another attempt. KNOWN GAP (documented in
      // CHANNEL_EXECUTOR_CONTRACT.md): unlike sent/skipped/dead-lettered-failed,
      // this is NOT idempotent against a duplicate ack call — clearing
      // claimed_by means a retried ack of this same outcome can no longer
      // match on ownership, so it would either 404 or (if re-claimed by then)
      // land against a different attempt. Solving this needs a per-attempt
      // idempotency key on the ack call, deferred to B3.
      job.status = 'pending';
      job.acked_status = null;
      job.attempt += 1;
      job.claimed_by = null;
      job.claimed_at = null;
    }
  }

  res.json({ ok: true, job_id: job.job_id, status, retry });
});

const port = Number(process.argv[2]) || 3199;
const server = app.listen(port, () => {
  if (process.send) process.send({ ready: true, port });
  console.log(`[mock-channel-jobs-server] listening on :${port}`);
});

process.on('SIGTERM', () => server.close());
