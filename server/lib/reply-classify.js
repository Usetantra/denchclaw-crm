'use strict';
// ─── Inbound-text classification ─────────────────────────────────────────────
//
// BORROWED, per the operator's instruction to reuse the engines rather than
// reinvent: `classifyReply` is a direct port of `classify_reply` from
// ~/nurturing-engine/backend/app/events.py (and its verbatim twin in
// ~/outreach-engine/backend/app/webhooks.py). The regexes are carried over
// as-is, including the reasoning baked into them:
//   · a bare leading "stop" only counts at the START of the message, so
//     "stop by my office" is not read as an opt-out;
//   · explicit unsubscribe intent matches ANYWHERE, because compliance bias
//     should favour over-suppressing.
//
// `classifyInterest` is NEW, and it is deliberately the most conservative thing
// in this codebase, for one reason:
//
//   Auto-registration is a SENDING decision. Moving a contact into
//   `auto_registrants` fires sequence enrollment, which mails them. A false
//   positive here does not produce a wrong number on a dashboard — it emails a
//   real person who did not ask to be emailed, and the likeliest source of a
//   false positive is the reply that says "not interested, remove me".
//
// So: an opt-out or an auto-reply can NEVER be interest. An explicit negation
// can NEVER be interest. And "no signal" is not a maybe — it is a no.

// ─── STOP / unsubscribe (ported verbatim) ────────────────────────────────────
const STOP_RE = /(^\s*(stop|stopall|cancel|end|quit|optout|opt-?out)\b)|(\bunsubscribe\b)|(\bremove me\b)/i;

// ─── Out-of-office / robot (ported verbatim) ─────────────────────────────────
const AUTO_RE = new RegExp(
  'out of (the )?office|auto[-\\s]?reply|automatic reply|on (vacation|holiday|leave|annual leave)|' +
  'away from my (desk|email)|will (reply|respond|be back)|currently (away|unavailable)|' +
  'do[\\s-]?not[\\s-]?reply|noreply|delivery status notification|undeliverable',
  'i'
);

/**
 * 'stop' | 'auto' | 'human' — identical semantics to the engines' classify_reply.
 */
function classifyReply(body) {
  const b = String(body == null ? '' : body).trim();
  if (!b) return 'human';
  if (STOP_RE.test(b)) return 'stop';
  if (AUTO_RE.test(b)) return 'auto';
  return 'human';
}

// ─── Interest ────────────────────────────────────────────────────────────────
// Checked BEFORE the positive patterns and beating them outright. "Yes, but I'm
// not interested in the webinar" must not register anyone just because it opens
// with "yes".
const NEGATION_RE = new RegExp(
  "\\bnot interested\\b|\\bno,? thanks\\b|\\bno thank you\\b|\\bnot for me\\b|" +
  "\\bnot (right )?now\\b|\\b(please )?(don'?t|do not) (contact|email|message)\\b|" +
  "\\bmaybe (next|another) time\\b|\\bpass\\b|\\bnot relevant\\b|\\bwrong person\\b|" +
  "\\bno longer (with|at)\\b|\\bleft the company\\b",
  'i'
);

// Explicit affirmatives only. Every alternative here is something a person had
// to actively type about attending — there is no "sounds ok" or lone "yes",
// because a lone "yes" in an email thread routinely answers a different
// question than the one we asked.
const INTEREST_RE = new RegExp(
  "\\bcount me in\\b|\\bsign me up\\b|\\bplease register me\\b|\\bregister me\\b|" +
  "\\b(i'?m|i am|we'?re|we are) (very |really |definitely )?interested\\b|" +
  "\\binterested in (joining|attending|the webinar|this)\\b|" +
  "\\b(i'?d|i would|we'?d|we would) (love|like) to (join|attend|register|come)\\b|" +
  "\\bi'?ll (be there|attend|join|come)\\b|\\bi will (attend|join|be there)\\b|" +
  "\\b(send|share) me the (link|details|invite|joining link)\\b|" +
  "\\bhow do i (register|join|sign up)\\b|\\bwhere do i (register|sign up)\\b|" +
  "\\bsave me a (seat|spot|place)\\b|\\bput me down\\b|\\bplease add me\\b",
  'i'
);

/**
 * Does this inbound text express interest in joining the webinar?
 *
 * Returns { interested: boolean, kind: 'stop'|'auto'|'human', reason: string }.
 * `interested` is true ONLY for a human message with an explicit affirmative and
 * no negation. Everything else — empty, robot, opt-out, negated, or merely
 * ambiguous — is false, and `reason` says which, so the ingest can record WHY a
 * stage did not move instead of leaving a silent no-op.
 */
function classifyInterest(body) {
  const kind = classifyReply(body);
  const b = String(body == null ? '' : body).trim();
  if (!b) return { interested: false, kind, reason: 'empty message' };
  // An opt-out is the strongest possible signal and it points the other way.
  if (kind === 'stop') return { interested: false, kind, reason: 'opt-out / unsubscribe intent' };
  // A robot did not express interest. Note that an OOO frequently contains
  // "will reply" and other warm-sounding phrasing — this branch is why that
  // never reaches the affirmative patterns.
  if (kind === 'auto') return { interested: false, kind, reason: 'automated / out-of-office reply' };
  if (NEGATION_RE.test(b)) return { interested: false, kind, reason: 'explicit negative' };
  if (INTEREST_RE.test(b)) return { interested: true, kind, reason: 'explicit interest' };
  return { interested: false, kind, reason: 'no explicit interest signal' };
}

// ─── Calendar RSVP ───────────────────────────────────────────────────────────
// The operator's path 1 is "invitees that respond YES / MAYBE to cold calendar
// invite outreach" — so YES and MAYBE both auto-register, and only a decline
// (or an unrecognised value) does not. Covers the spellings the common
// providers actually emit: Google/Microsoft Graph ('accepted'/'tentativelyAccepted'),
// raw iCalendar PARTSTAT ('ACCEPTED'/'TENTATIVE'/'DECLINED'), and plain english.
const RSVP_YES = new Set(['accepted', 'accept', 'yes', 'attending', 'confirmed', 'going']);
const RSVP_MAYBE = new Set(['tentative', 'tentativelyaccepted', 'maybe', 'unsure', 'perhaps']);
const RSVP_NO = new Set(['declined', 'decline', 'no', 'not attending', 'notattending', 'rejected']);

/**
 * 'yes' | 'maybe' | 'no' | null (unrecognised — never treated as a yes).
 */
function normalizeRsvp(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!v) return null;
  if (RSVP_YES.has(v)) return 'yes';
  if (RSVP_MAYBE.has(v)) return 'maybe';
  if (RSVP_NO.has(v)) return 'no';
  return null;
}

module.exports = { classifyReply, classifyInterest, normalizeRsvp, STOP_RE, AUTO_RE, INTEREST_RE, NEGATION_RE };
