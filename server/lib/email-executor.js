'use strict';
// ─── CP4a rev 2: the email executor ──────────────────────────────────────────
// The first thing in this system that put real mail in front of real people.
//
// CP-C generalised this file. Its logic now lives in lib/channel-executor.js and
// email is one instance of it, alongside sms and whatsapp — because the CP-C rule
// is that there must not be a second sending path, and the five properties this
// executor was built to guarantee are exactly the ones every channel needs:
//
//   1. an UNKNOWN outcome is never retried (a duplicate to a real person is
//      irreversible; a delayed message is recoverable),
//   2. the attempt is recorded BEFORE the send, by compare-and-set, because no
//      provider we use offers an idempotency key,
//   3. per-instance `claimed_by`, so a reclaim cannot double-ack,
//   4. a boot gate requiring an EXPLICITLY configured sender, because a key with
//      no sender used to dead-letter jobs and a dead-letter exits the enrollment
//      terminally,
//   5. a content guard immediately before the provider call.
//
// This module is kept as the email-shaped entry point so existing callers and
// CP4a's banked tests bind to the same names. The behaviour is unchanged.
const { email } = require('./executors');

module.exports = {
  tick: (companyId, opts) => email.tick(companyId, opts),
  bootGate: () => email.bootGate(),
  contentProblem: (payload) => email.contentProblem(payload),
  listQuarantine: (companyId, opts) => email.listQuarantine(companyId, opts),
  releaseQuarantine: (companyId, jobId, decision) => email.releaseQuarantine(companyId, jobId, decision),
  senderFor: () => email.senderFor(),
  get INSTANCE_ID() { return email.INSTANCE_ID; },
};
