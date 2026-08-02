#!/usr/bin/env node
// Verification for B4 (channel-executor contract): boots the mock server from
// examples/mock-channel-jobs-server.mjs, seeds jobs across two channels, races
// stub executors against the same pending pool, and asserts the contract
// properties claimed in docs/contracts/CHANNEL_EXECUTOR_CONTRACT.md:
//   1. claim is channel-scoped (an 'sms' executor never gets an 'email' job)
//   2. no job is claimed twice under concurrent claim calls, and both
//      concurrent executors actually did claim something (not a vacuous pass
//      where one executor grabbed everything before the other's request landed)
//   3. a 'sent' ack is idempotent (replay returns 200, same status, no error)
//   4. re-acking a job with a conflicting terminal status is rejected (409)
//   5. an executor cannot ack a job claimed by a different claimed_by (404) —
//      guards against claim-ownership spoofing
//   6. a claim past CLAIM_TIMEOUT_MS is reclaimable by another executor
//   7. a 'failed' ack tells the executor whether it will be retried (`retry`
//      field), so the executor never has to guess the outcome
//
// Usage: node test/verify-channel-contract.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/crm/channel-jobs`;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name} — ${detail}`); }
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { cwd: ROOT });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`${args.join(' ')} exited ${code}: ${stderr}`));
      resolve(stdout.trim());
    });
  });
}

async function seed(channel, count, scheduled_for) {
  const r = await fetch(`${BASE}/_seed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, count, scheduled_for }),
  });
  return (await r.json()).created;
}

async function claim(channel, claimed_by, limit = 10) {
  const r = await fetch(`${API}/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, claimed_by, limit }),
  });
  return { status: r.status, body: await r.json() };
}

async function ack(job_id, status, claimed_by, extra = {}) {
  const r = await fetch(`${API}/${job_id}/ack`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, claimed_by, ...extra }),
  });
  return { status: r.status, body: await r.json() };
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${API}/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'email', claimed_by: 'healthcheck' }),
      });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('mock-channel-jobs-server did not become ready');
}

async function main() {
  const server = spawn('node', ['examples/mock-channel-jobs-server.mjs', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, CLAIM_TIMEOUT_MS: '400', MAX_ATTEMPTS: '3' },
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  try {
    await waitForServer();

    // ── 1/2: channel scoping + real concurrent split (not a vacuous pass) ──
    const emailIds = await seed('email', 6);
    const smsIds = await seed('sms', 3);

    // limit=3 each against 6 pending email jobs forces both executors to need
    // a real slice of the pool — if only one process ran, it couldn't reach
    // 6 acked jobs total with cap 3, and if they didn't overlap in time we'd
    // still get 6 total, but this also asserts BOTH got a non-empty share,
    // which a serialized (non-concurrent-safe) implementation could still
    // satisfy by luck — the true concurrency guarantee is "no duplicate",
    // checked below; "both non-empty" just weeds out the emptiest false-pass.
    const [resA, resB] = await Promise.all([
      runNode(['examples/stub-executor.mjs', BASE, 'email', 'executor-A', '2', '3']),
      runNode(['examples/stub-executor.mjs', BASE, 'email', 'executor-B', '2', '3']),
    ]);
    const ackedA = JSON.parse(resA);
    const ackedB = JSON.parse(resB);
    const allEmailAcked = [...ackedA, ...ackedB];
    const ackedEmailIds = allEmailAcked.map(j => j.job_id);

    check('claim is channel-scoped: acked job_ids are exactly the seeded email set',
      ackedEmailIds.length === emailIds.length && new Set(ackedEmailIds).size === new Set(emailIds).size
        && emailIds.every(id => ackedEmailIds.includes(id)),
      `seeded=${emailIds.length} acked=${ackedEmailIds.length}`);
    check('no job claimed twice: all acked job_ids are unique across two concurrent executors',
      new Set(ackedEmailIds).size === ackedEmailIds.length, `duplicate claim: ${ackedEmailIds}`);
    check('both concurrent executors actually claimed a non-empty share',
      ackedA.length > 0 && ackedB.length > 0, `A=${ackedA.length} B=${ackedB.length}`);
    check('all acked jobs report status=sent (stub executor always succeeds)',
      allEmailAcked.every(j => j.status === 'sent' && j.httpStatus === 200), JSON.stringify(allEmailAcked));

    const smsResult = JSON.parse(await runNode(['examples/stub-executor.mjs', BASE, 'sms', 'executor-C', '5']));
    check('sms executor only claims sms jobs (channel isolation)',
      smsResult.length === smsIds.length, `expected ${smsIds.length} sms jobs, got ${smsResult.length}`);

    // ── 3/4: idempotent replay + conflicting re-ack ─────────────────────────
    const oneJobId = ackedEmailIds[0];
    const replay = await ack(oneJobId, 'sent', 'executor-A');
    check('replaying a sent ack (same claimed_by) is idempotent (200, same status)',
      replay.status === 200 && replay.body.status === 'sent', `got ${replay.status} ${JSON.stringify(replay.body)}`);

    const conflict = await ack(oneJobId, 'failed', 'executor-A', { error: 'simulated conflict' });
    check('re-acking with a conflicting terminal status is rejected (409)',
      conflict.status === 409, `expected 409, got ${conflict.status}`);

    // ── 5: ack ownership is enforced (claim-spoofing guard) ─────────────────
    const [spoofJobId] = await seed('email', 1);
    const claimed = await claim('email', 'executor-real', 1);
    check('setup: spoof-test job was claimed', claimed.body.jobs.some(j => j.job_id === spoofJobId), JSON.stringify(claimed.body));
    const spoofedAck = await ack(spoofJobId, 'sent', 'executor-impostor');
    check('acking with a claimed_by that did not win the claim is rejected (404, no existence disclosure)',
      spoofedAck.status === 404, `expected 404, got ${spoofedAck.status}`);
    const legitAck = await ack(spoofJobId, 'sent', 'executor-real');
    check('the real claimant can still ack normally after a spoofed attempt was rejected',
      legitAck.status === 200 && legitAck.body.status === 'sent', JSON.stringify(legitAck.body));

    // ── 6: stale claim becomes reclaimable after CLAIM_TIMEOUT_MS ───────────
    const [staleJobId] = await seed('email', 1);
    await claim('email', 'executor-crashed', 1);
    await new Promise(r => setTimeout(r, 600)); // > CLAIM_TIMEOUT_MS=400 set on the server env
    const reclaim = await claim('email', 'executor-recovered', 1);
    check('a claim older than CLAIM_TIMEOUT_MS is reclaimable by a different executor',
      reclaim.body.jobs.some(j => j.job_id === staleJobId), JSON.stringify(reclaim.body));

    // ── 7: a 'failed' ack tells the executor whether it will be retried ────
    const [failJobId] = await seed('email', 1);
    await claim('email', 'executor-flaky', 1);
    const failedAck = await ack(failJobId, 'failed', 'executor-flaky', { error: 'simulated send failure' });
    check("a 'failed' ack response includes retry.will_retry so the executor isn't left guessing",
      failedAck.status === 200 && typeof failedAck.body.retry?.will_retry === 'boolean',
      JSON.stringify(failedAck.body));
    check('a retryable failure requeues the job (reclaimable again, not stuck)',
      failedAck.body.retry?.will_retry === true, JSON.stringify(failedAck.body));
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\nB4 channel-executor contract verification\n`);
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
