#!/usr/bin/env node
// Reference channel executor (roadmap B4) — the minimal loop an engine implements
// to own a sequence channel. Claims due jobs for CHANNEL, "sends" them (here: a
// no-op log), and reports the result back. Dependency-free; see
// docs/EXECUTOR_CONTRACT.md. Start the CRM with SEQUENCE_EXTERNAL_CHANNELS=<channel>
// so the built-in dispatcher leaves those jobs for this executor.
//
//   CRM_API_BASE=http://127.0.0.1:3100 INTERNAL_API_KEY=<key> COMPANY=tantra \
//     CHANNEL=whatsapp POLL_MS=3000 node scripts/reference-executor.mjs

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
const COMPANY = process.env.COMPANY || 'tantra';
const CHANNEL = process.env.CHANNEL || 'whatsapp';
const POLL_MS = Math.max(1000, parseInt(process.env.POLL_MS, 10) || 3000);
const ONCE = process.env.ONCE === '1'; // single pass (for tests)

if (!KEY) { console.error('INTERNAL_API_KEY required'); process.exit(2); }

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-company-id': COMPANY },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

// Replace this with a real provider send. Return { provider_message_id } or throw.
async function send(job) {
  const to = job.contact.phone || job.contact.wa_id || job.contact.email || job.contact.id;
  const preview = job.message.template_id ? `template ${job.message.template_id}` : JSON.stringify(job.message.body);
  console.log(`  [send:${job.channel}] → ${to}  ${preview}`);
  return { provider_message_id: 'REF-' + job.job_id.slice(0, 8) };
}

async function pass() {
  const claim = await api('POST', '/api/crm/sequences/jobs/claim', { channel: CHANNEL, limit: 10 });
  const jobs = (claim.json && claim.json.jobs) || [];
  if (!jobs.length) return 0;
  console.log(`claimed ${jobs.length} ${CHANNEL} job(s)`);
  for (const job of jobs) {
    try {
      const { provider_message_id } = await send(job);
      await api('POST', `/api/crm/sequences/jobs/${job.job_id}/result`, { status: 'sent', provider_message_id });
    } catch (e) {
      await api('POST', `/api/crm/sequences/jobs/${job.job_id}/result`, { status: 'failed', error: String(e && e.message || e) });
    }
  }
  return jobs.length;
}

if (ONCE) {
  // Let in-flight keep-alive sockets close before exiting (avoids a Windows libuv
  // assertion when process.exit races undici's socket teardown).
  pass()
    .then(n => { console.log(`done (${n} processed)`); setTimeout(() => process.exit(0), 300).unref(); })
    .catch(e => { console.error(e); setTimeout(() => process.exit(1), 300).unref(); });
} else {
  console.log(`reference executor: channel=${CHANNEL} company=${COMPANY} base=${BASE} poll=${POLL_MS}ms`);
  const loop = () => pass().catch(e => console.error('pass error:', e.message)).finally(() => setTimeout(loop, POLL_MS));
  loop();
}
