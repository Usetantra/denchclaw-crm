#!/usr/bin/env node
// Reference stub executor — the shape an engine's channel executor implements
// against docs/contracts/channel-executor.openapi.yaml: claim a batch for its
// channel, "process" each job, ack the outcome.
//
// Usage: node examples/stub-executor.mjs <base_url> <channel> <claimed_by> [ticks]
// Returns the list of {job_id, status} it acked (for the verify script to assert on).

const [base, channel, claimedBy, ticksArg, limitArg] = process.argv.slice(2);
const ticks = Number(ticksArg) || 1;
const limit = Number(limitArg) || 10;

async function claim() {
  const r = await fetch(`${base}/api/crm/channel-jobs/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, limit, claimed_by: claimedBy }),
  });
  const body = await r.json();
  return body.jobs || [];
}

async function ack(job_id, status, extra = {}) {
  const r = await fetch(`${base}/api/crm/channel-jobs/${job_id}/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, claimed_by: claimedBy, ...extra }),
  });
  return { status: r.status, body: await r.json() };
}

// Stand-in for "actually send the email/SMS/call" — always succeeds here.
async function processJob(job) {
  return { status: 'sent', extra: { provider_message_id: `stub-${job.job_id}` } };
}

async function main() {
  const acked = [];
  for (let i = 0; i < ticks; i++) {
    const batch = await claim();
    for (const job of batch) {
      const { status, extra } = await processJob(job);
      const result = await ack(job.job_id, status, extra);
      acked.push({ job_id: job.job_id, status, httpStatus: result.status });
    }
    if (batch.length === 0) break;
  }
  console.log(JSON.stringify(acked));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
