'use strict';
// ─── CP-C2: the cross-channel send rails, ported from automation_core ────────
//
// These are `automation_core/channels/base.py:73-101` — the kill switch and the
// live allowlist. They live in their own file, and apply to EVERY channel,
// because that is what they are upstream: a rail on `channels/base`, not a
// LinkedIn feature. A kill switch that only stops LinkedIn is not a kill switch,
// and an allowlist that only constrains the channel you remembered is how a
// verification run emails a real customer.
//
// Both read `process.env` on EVERY call and are captured nowhere. That is
// deliberate and it is the difference between a control and a comment: an
// operator flipping the switch needs sending to stop within one tick, not on the
// next restart, and every executor calls its boot gate at the top of every tick.

const TRUTHY = ['1', 'true', 'yes', 'on'];

// Upstream's own variable name, so ONE setting stops the CRM and the engines
// together — during an incident nobody should have to remember two.
function killSwitchOn() {
  return TRUTHY.includes(String(process.env.LIVE_SENDS_DISABLED || '').trim().toLowerCase());
}

// Upstream's `normalize_address`: email-shaped channels compare lowercased,
// phone-bearing ones compare on digits alone, so '+1 (555) 000-1111' and
// '+15550001111' are the same person rather than two.
function normalizeAddress(channel, address) {
  const a = String(address || '').trim();
  if (!a) return '';
  if (['sms', 'whatsapp', 'whatsapp_group'].includes(channel)) return a.replace(/\D/g, '');
  return a.toLowerCase();
}

// Empty allowlist → normal operation (upstream's semantics exactly, so turning
// this on is opt-in and turning it off changes nothing). Non-empty → ONLY these
// recipients may receive a real send.
//
// The LinkedIn wrinkle: a "recipient" there is a profile URL, and the same
// person is reachable as `https://www.linkedin.com/in/jane-doe/` or
// `linkedin.com/in/jane-doe`. Comparing raw strings would let a typo in the
// allowlist read as "not allowed", which fails CLOSED and is therefore fine —
// but it would also let a trailing slash read as "not allowed" during a
// verification run, so LinkedIn compares on the profile slug.
function normalizeForMatch(channel, address) {
  const n = normalizeAddress(channel, address);
  if (channel !== 'linkedin') return n;
  const m = /linkedin\.com\/in\/([^/?#]+)/.exec(n);
  return m ? m[1] : n.replace(/\/+$/, '');
}

function liveSendAllowed(channel, address) {
  if (killSwitchOn()) return false;
  // ONE variable, deliberately. Upstream's `NURTURE_LIVE_ALLOWLIST` is NOT
  // honoured as a fallback: sharing the kill switch is a stated intent (one
  // lever during an incident), but silently adopting another engine's
  // per-recipient allowlist would stop CRM sends to everyone off that engine's
  // list, with no quarantine row and no operator surface — a system that has
  // stopped sending and cannot say why.
  const raw = String(process.env.LIVE_SEND_ALLOWLIST || '').trim();
  if (!raw) return true;
  const target = normalizeForMatch(channel, address);
  if (!target) return false;
  return raw.split(',')
    .map(s => normalizeForMatch(channel, s))
    .filter(Boolean)
    .includes(target);
}

module.exports = { killSwitchOn, liveSendAllowed, normalizeAddress, normalizeForMatch };
