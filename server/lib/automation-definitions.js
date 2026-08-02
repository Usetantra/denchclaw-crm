'use strict';
// ─── CP-D: the operator's actual automations ─────────────────────────────────
//
// Until now every sequence in this database was a test fixture. The pipelines
// were real, the executors were real, and there was nothing configured to send.
//
// The operator's instruction, verbatim in .loop/GOALS.md: the automation
// workflows are to be "designed **or borrowed from the existing automation
// workflows that we've created within the outreach engine or the nurturing
// engine**, with different EP integrations and different providers for
// different channels."
//
// So: borrowed where a ladder exists, authored where one does not, and the
// difference is marked on every definition below rather than blurred.
//
// ─── WHAT I FOUND UPSTREAM, INCLUDING WHAT IS NOT THERE ──────────────────────
//
// The reusable ladders live in two places, neither of them the engines' own
// route code:
//
//   * `pro-workflows/automation_core/channels/*.py` — per-channel `DEFAULT_STEPS`
//     for cold_email (0/72/120h), sms (0/72h), whatsapp (0/72h) and linkedin
//     (invite 0h, messages 96/168/240h, InMail 336h). This is the INVITE ladder:
//     cold outreach that turns a Prospect into an Invitee.
//   * `nurturing-engine/backend/app/sequences.py` — the post-registration
//     webinar reminder ladders (WhatsApp A0–A8, SMS S0–S4, Email E0–E7,
//     LinkedIn L0–L1) and a long-term ~90-day email drip N0–N9.
//
// **THE REMINDER LADDERS ARE NOT PORTED HERE, AND THAT IS A GAP, NOT AN
// OVERSIGHT.** They are the better asset of the two — production HTML, approved
// WhatsApp template SIDs — but every one of their steps is ANCHORED to a
// `webinar_at` timestamp with NEGATIVE offsets ("one week before", "one hour
// before"). This scheduler only knows "delay from the previous rung"
// (dispatch.js:627-629). Rewriting anchored offsets as relative delays would be
// a lie, and a half-port fires every already-past reminder at once — four
// messages to a real registrant inside a minute. So `registrants`,
// `auto_registrants` and `attendees` currently trigger NOTHING, and that is the
// next checkpoint (F38). The capability to port is itself already written and
// tested upstream — `nurturing-engine/backend/app/dispatcher.py:160-204`
// (`parse_webinar_at`, `anchored_state`, `step_due_state`, grace hours, and
// skip-past-as-MISSED rather than sent-late) — so F38 is a translation, not a
// design.
//
// **There is no sales-call No-Show ladder anywhere.** Every `no_show` upstream
// means "did not attend the WEBINAR" — a segment of the reminder ladder. The
// operator's No-Show Follow-ups 1–5 are about missing a booked SALES CALL:
// different event, different audience, different copy. It cannot be borrowed
// because it does not exist, so it is authored here and labelled as such.
//
// ─── WHY THE COPY COULD NOT SIMPLY BE PASTED ─────────────────────────────────
//
// Upstream writes `{{first_name}}`. In this CRM `{{...}}` is the deliberate
// ESCAPE for writing *about* a merge field, so a straight paste renders the
// literal text `{first_name}` — and because the escape is intentional, every
// guard correctly waves it through. Every borrowed string below is converted to
// single braces, and the tests assert the conversion rather than trusting it.
//
// Upstream also uses `{{cta_url}}`, `{{book_url}}`, `{{join_url}}`. Before CP-D
// none of those were known tokens, so `unresolvedTokensIn` returned nothing and
// the claim door would have passed "grab a time here: {book_url}" straight
// through to a real prospect. They are context tokens now (migration 025), and
// an unresolved one BLOCKS.
//
// ─── HOW THIS RESPECTS THE INVARIANT ─────────────────────────────────────────
//
// THE CRM MUST NEVER AUTO-ADVANCE A MANUAL STAGE. The No-Show ladder is the
// sharpest possible test of that, and it turns out to be the reason the
// operator's design is right: **No-Show Follow-up 1 is MANUAL and is the
// TRIGGER**. A human marks the no-show; that enrolment fires the ladder; and the
// ladder writes back only 2, 3, 4 and 5, every one of which is `mode:"auto"`.
// No step in this file writes back a manual stage, and `applyStageWriteback`
// would refuse it if one did.
//
// Deal Follow-ups 1/2/3 are MANUAL with no automation at all. The operator's
// 3/7/12-day figures describe when a human should act — they are not timers, and
// nothing here schedules them.

const DAY = 86400;
const HOUR = 3600;

// Upstream marks its DEFAULT_STEPS "TENANT-UNSAFE DEFAULT COPY … acceptable for
// the dogfood tenant only". That warning travels with the copy: this is real,
// specific, first-person outreach naming real clients, and it is the operator's
// own. Seeding it for a different tenant would put one tenant's voice and case
// studies into another's outreach, so the seeder says so out loud.
const DOGFOOD = 'copy is the operator\'s own first-person outreach — rewrite it before seeding another tenant';

// ─── 1. INVITE LADDERS — borrowed from automation_core/channels/* ────────────
// One sequence per channel, which is faithful to upstream: a campaign there runs
// its channels in PARALLEL, each with its own cadence, and the CRM's
// `enrollForTriggerStage` already supports several sequences sharing one trigger
// stage. Collapsing four channels into one linear ladder would have changed the
// behaviour while claiming to borrow it.
//
// Trigger: `prospects` (manual — a human puts someone on the list).
// Write-back: `invitees`, which is `mode:"auto"` and whose definition is
// literally "prospects that have been sent invites on different channels".
const INVITE_EMAIL = {
  key: 'webinar_marketing_invite_email',
  name: 'Webinar invite — email',
  source: 'borrowed: automation_core/channels/cold_email.py DEFAULT_STEPS',
  pipeline_key: 'webinar_marketing',
  trigger_stage: 'prospects',
  caveat: DOGFOOD,
  steps: [
    { channel: 'email', delay_seconds: 0, stage_writeback: 'invitees',
      subject: 'How {company} could automate its entire revenue funnel',
      body: 'Hi {first_name},\n\nI do a quick teardown of how {company} could build an automated '
        + 'pipeline — cold prospect to paying client, no manual follow-up. Worth 60 seconds? '
        + '→ {join_url}\n\n— {sender_name}' },
    { channel: 'email', delay_seconds: 72 * HOUR,
      subject: 'Following up — {company}',
      body: 'Hi {first_name},\n\nQuick follow-up. To make this concrete: we took Cavli Wireless from '
        + '$1M to $15M ARR by plugging in 187 automations. Happy to show you the exact funnel '
        + 'architecture for {company}: {join_url}\n\n— {sender_name}' },
    { channel: 'email', delay_seconds: 120 * HOUR,
      subject: 'Last note (for now) — a live funnel build',
      body: 'Hi {first_name},\n\nWe\'re running a live session where I build the full AI RevOps funnel '
        + 'end-to-end on screen. If revenue automation is ever on {company}\'s radar, this 60 minutes '
        + 'will save you months: {join_url}\n\n— {sender_name}\n\n{unsubscribe_url}' },
  ],
};

const INVITE_SMS = {
  key: 'webinar_marketing_invite_sms',
  name: 'Webinar invite — SMS',
  source: 'borrowed: automation_core/channels/sms.py DEFAULT_STEPS',
  pipeline_key: 'webinar_marketing',
  trigger_stage: 'prospects',
  caveat: DOGFOOD,
  steps: [
    { channel: 'sms', delay_seconds: 0, stage_writeback: 'invitees',
      body: 'Hi {first_name}! {sender_name} here. Quick q — what\'s the biggest gap in {company}\'s '
        + 'sales funnel right now? We fix exactly that with AI automation. Worth a look? → {join_url}' },
    { channel: 'sms', delay_seconds: 72 * HOUR,
      body: '{first_name} — last nudge. Running a live AI RevOps build next week. 60 min, real '
        + 'dashboard, real funnel. Seats are filling: {join_url}' },
  ],
};

const INVITE_WHATSAPP = {
  key: 'webinar_marketing_invite_whatsapp',
  name: 'Webinar invite — WhatsApp',
  source: 'borrowed: automation_core/channels/whatsapp.py DEFAULT_STEPS',
  pipeline_key: 'webinar_marketing',
  trigger_stage: 'prospects',
  caveat: DOGFOOD,
  // A COLD WhatsApp is business-initiated and outside any 24-hour session
  // window, which means Twilio requires an APPROVED CONTENT TEMPLATE — free-form
  // body is only deliverable once the contact has replied. The borrowed steps
  // carry body text, because upstream's approved SIDs
  // (nurturing-engine/backend/app/sequences.py:52-56) belong to the post-
  // registration REMINDER ladder, not to this cold invite copy.
  //
  // So this ladder installs PAUSED. Everything downstream is ready — CP-C's
  // executor already sends ContentSid + positional ContentVariables when the
  // payload declares one — but shipping it 'active' would queue cold sends that
  // the provider rejects one at a time, which reads as a broken executor rather
  // than as missing paperwork.
  blocked_until: 'an approved Twilio WhatsApp content template SID exists for this copy — a cold, '
    + 'business-initiated WhatsApp cannot be free-form. Add content_sid to the steps, then activate.',
  steps: [
    { channel: 'whatsapp', delay_seconds: 0, stage_writeback: 'invitees',
      body: 'Hi {first_name}! {sender_name} from Tantra here. I build AI revenue funnels for B2B '
        + 'founders. Got 60 seconds to see if this is relevant to {company}? → {join_url}' },
    { channel: 'whatsapp', delay_seconds: 72 * HOUR,
      body: '{first_name} — running a live session where I build a complete AI RevOps funnel '
        + 'end-to-end. Specifically useful for {company}-stage companies. Seats limited: {join_url}' },
  ],
};

// The LinkedIn ladder carries `linkedin_action` per step (migration 024). Note
// the shape upstream chose and CP-C2 enforces: an INVITE first, then messages —
// and CP-C2's accept gate means those messages will not fire until the invite is
// actually ACCEPTED, no matter what the delays say. The cadence below is
// upstream's; the gate is what makes it safe.
const INVITE_LINKEDIN = {
  key: 'webinar_marketing_invite_linkedin',
  name: 'Webinar invite — LinkedIn',
  source: 'borrowed: automation_core/channels/linkedin.py DEFAULT_STEPS',
  pipeline_key: 'webinar_marketing',
  trigger_stage: 'prospects',
  caveat: DOGFOOD,
  // THE WINDOW CAME WITH THE LADDER, and a borrow that took the delays and left
  // it behind would be the "invent your own limits" mistake. Upstream pairs
  // these steps with DEFAULT_SEND_WINDOW = Tue/Wed/Thu 09:00–10:30
  // (automation_core/channels/linkedin.py:14) — narrower than the 07:00–18:00
  // account window CP-C2 defaults to, and it is the narrower one that binds.
  // CP-C2 put the window on `linkedin_accounts`, not on the sequence, so this
  // cannot enforce it — but it can say so at install time rather than let an
  // operator discover it after the account is restricted.
  account_note: 'upstream pairs this ladder with a Tue/Wed/Thu 09:00–10:30 send window — set '
    + "linkedin_accounts.active_days = ARRAY['Tue','Wed','Thu'] and active_start/active_end to "
    + '09:00/10:30 before activating it',
  steps: [
    { channel: 'linkedin', linkedin_action: 'invite', delay_seconds: 0, stage_writeback: 'invitees',
      body: 'Hi {first_name} — I build AI revenue funnels for B2B SaaS founders. Seen what {company} '
        + 'is doing and think we\'re aligned. Would love to connect.' },
    { channel: 'linkedin', linkedin_action: 'message', delay_seconds: 96 * HOUR,
      body: 'Hey {first_name}, thanks for connecting! Quick q: what\'s the biggest bottleneck between '
        + 'your top of funnel and a signed deal right now? I\'m building something that might be '
        + 'relevant — happy to share: {join_url}' },
    { channel: 'linkedin', linkedin_action: 'message', delay_seconds: 168 * HOUR,
      body: '{first_name} — just ran the numbers on a client in a similar space to {company}. 40% '
        + 'show-up rate on cold outreach → 80% after we plugged in a multi-channel automated funnel. '
        + 'Worth a 15-min breakdown of exactly how? → {join_url}' },
    { channel: 'linkedin', linkedin_action: 'message', delay_seconds: 240 * HOUR,
      body: 'Last note, {first_name}. We\'re running a live webinar — building an AI RevOps funnel '
        + 'from scratch in 60 minutes. Thought of {company} specifically: {join_url}' },
    { channel: 'linkedin', linkedin_action: 'inmail', delay_seconds: 336 * HOUR,
      subject: 'Worth 60 minutes, {first_name}?',
      body: 'Hi {first_name}, sharing something I think is genuinely relevant for {company}: we\'re '
        + 'running a live build session showing exactly how we take a cold prospect to a signed deal '
        + 'via automated funnels. No slides — live dashboard. If growing pipeline is on your radar: '
        + '{join_url}' },
  ],
};

// ─── 2. THE NO-SHOW LADDER — AUTHORED, because it does not exist upstream ────
//
// TIMING, AND THE TRAP IN IT. The operator's figures are CUMULATIVE from
// Follow-up 1: 0 / +3d / +6d / +9d / +16d (.loop/GOALS.md:77). This engine's
// `delay_seconds` is NOT cumulative — `advanceEnrollment` anchors each rung on
// "when its predecessor was ACKED" (dispatch.js:627-629), so the numbers below
// are the GAPS BETWEEN rungs: 0, 3, 3, 3, 7. Writing the operator's cumulative
// figures straight into the column would have sent the final email on day 34
// instead of day 16, and put the `no_show_followup_5` write-back on the sales
// board more than two weeks late.
//
// `cumulative_days` is carried alongside purely so the two can be checked
// against each other, and the test measures a REAL scheduled_for delta rather
// than reading the column back.
//
// Rung 1 fires immediately, because the operator said so in as many words:
// "followups are sent immediately after the no-show or sales call".
//
// EMAIL ONLY, and that is a deliberate default rather than an omission. A
// missing recipient QUARANTINES the job, and a quarantined job is never acked,
// so the enrolment never advances — the ladder STALLS at that rung (see F37).
// Everyone who books a sales call has an email address; not everyone has a phone
// number on file. A seeded default that silently freezes a real follow-up ladder
// for every contact without a phone is a bad default. Channels are per-step, so
// an operator adds SMS or WhatsApp deliberately, for a segment they know has
// phone numbers.
const NO_SHOW = {
  key: 'webinar_sales_no_show',
  name: 'No-Show follow-up ladder',
  source: 'AUTHORED — no sales-call no-show ladder exists in either engine; every upstream '
    + '`no_show` means "did not attend the webinar", which is a different event entirely',
  pipeline_key: 'webinar_sales',
  // MANUAL, and deliberately: a human marks the no-show, and that is what starts
  // the ladder. The invariant is not merely respected here, it is the design.
  trigger_stage: 'no_show_followup_1',
  caveat: DOGFOOD,
  cumulative_days: [0, 3, 6, 9, 16],
  steps: [
    // Rung 1 writes back nothing: the contact is already in Follow-up 1 — that
    // is what triggered this — and Follow-up 1 is MANUAL, so writing it back
    // would be the CRM touching a manual stage.
    { channel: 'email', delay_seconds: 0,
      subject: 'Sorry we missed you, {first_name} — grab another slot?',
      body: 'Hi {first_name},\n\nWe had you down for a call today and didn\'t manage to connect — '
        + 'no problem at all, it happens.\n\nThe offer stands: 30 minutes where we walk {company}\'s '
        + 'funnel, find the 2–3 biggest leaks, and you keep the ranked fix list either way.\n\n'
        + 'Pick a time that actually works: {book_url}\n\n— {sender_name}' },
    { channel: 'email', delay_seconds: 3 * DAY, stage_writeback: 'no_show_followup_2',
      subject: 'Still worth 30 minutes for {company}?',
      body: 'Hi {first_name},\n\nFollowing up on the call we didn\'t get to have.\n\nOne thing worth '
        + 'knowing before you decide: the teams we help usually think they have a funnel problem, and '
        + 'they have a *stage-conversion* problem — one leaky step nobody is measuring. That is a '
        + '30-minute conversation, not a project.\n\n{book_url}\n\n— {sender_name}' },
    { channel: 'email', delay_seconds: 3 * DAY, stage_writeback: 'no_show_followup_3',
      subject: 'A concrete number, {first_name}',
      body: 'Hi {first_name},\n\nMaking this less abstract. Cavli Wireless ran a fully manual sales '
        + 'process at $1–2M ARR. We built the automated funnels underneath their motion — they are '
        + 'now at $15M ARR and a $35M valuation.\n\nSame approach, applied to {company}\'s numbers, '
        + 'in half an hour: {book_url}\n\n— {sender_name}' },
    { channel: 'email', delay_seconds: 3 * DAY, stage_writeback: 'no_show_followup_4',
      subject: 'Should I close your file, {first_name}?',
      body: 'Hi {first_name},\n\nI don\'t want to keep landing in your inbox if the timing is wrong — '
        + 'genuinely fine either way.\n\nIf it is simply not now, ignore this and I will stop. If it '
        + 'is worth 30 minutes: {book_url}\n\n— {sender_name}' },
    { channel: 'email', delay_seconds: 7 * DAY, stage_writeback: 'no_show_followup_5',
      subject: 'Last one — the fix list, no call needed',
      body: 'Hi {first_name},\n\nLast note from me on this.\n\nIf a call is not the right shape, reply '
        + 'with one line about where {company}\'s pipeline actually stalls and I will send back the '
        + 'two things I would change first. No call, no pitch.\n\nAnd if you would rather just talk: '
        + '{book_url}\n\n— {sender_name}\n\n{unsubscribe_url}' },
  ],
};

// ─── 3. LONG-TERM NURTURE — borrowed, structure over copy ───────────────────
// `nurturing-engine/backend/app/sequences.py` LONG_TERM_EMAIL_STEPS, N0–N9 at
// day 0/3/7/14/21/30/42/56/72/90. Upstream is explicit that the copy is
// "placeholder-quality BY DESIGN — the Content engine / Yogi rewrites per tenant;
// the structure is the deliverable", and that judgement is carried over intact
// rather than quietly upgraded: the cadence and the every-third-touch soft CTA
// are the borrowed asset.
//
// `trigger_stage` is NULL — enrol manually. The operator's marketing pipeline has
// no stage that means "not ready, keep warm", so inventing an automatic trigger
// would be putting words in their mouth about their own funnel.
// The tuple is (cumulative day, GAP-from-previous hours, subject, body, CTA).
// Upstream's own column header is explicit — "delay_hours since previous"
// (nurturing-engine/backend/app/sequences.py:203) — and its values are
// 72/96/168/168/216/288/336/384/432h. Copying the cumulative DAY LABELS into a
// relative engine would have stretched a ~90-day drip to ~335 days: the cadence
// is the borrowed asset, and it is the thing that would have been corrupted.
const NURTURE_DAYS = [
  [0, 0, 'Welcome — what to expect from me',
    'Thanks for connecting. Every week or two I share one practical way teams like {company} plug '
    + 'revenue leaks with automation — no fluff, no pitch.', null],
  [3, 72, 'The one funnel metric most teams never track',
    '[PLACEHOLDER: the leak-rate metric — why stage-conversion beats volume]', null],
  [7, 96, 'Case study: manual pipeline → automated engine',
    '[PLACEHOLDER: mini case study with one concrete number]',
    'Curious what this would look like for {company}? Grab a free 30-min funnel look → {book_url}'],
  [14, 168, '3 automations you can ship this week',
    '[PLACEHOLDER: three quick-win automations, two sentences each]', null],
  [21, 168, 'Why most nurture sequences die (and the fix)',
    '[PLACEHOLDER: reply-handling, segmentation, timing]', null],
  [30, 216, 'A 10-minute funnel self-audit',
    '[PLACEHOLDER: checklist the reader can run today]',
    'Want a second pair of eyes on the audit? Book a free evaluation → {book_url}'],
  [42, 288, 'What good looks like: the RevOps dashboard',
    '[PLACEHOLDER: what a single-screen revenue dashboard shows, tool-agnostic]', null],
  [56, 336, 'The follow-up math nobody does',
    '[PLACEHOLDER: expected value of touch 5+ vs touch 1]', null],
  [72, 384, 'From {company}\'s stage: the 90-day fix list',
    '[PLACEHOLDER: how a prioritised fix list gets built, one example row]',
    'I\'ll build the first three rows of yours with you, free → {book_url}'],
  [90, 432, 'Keeping in touch (and what\'s next)',
    '[PLACEHOLDER: light check-in; invite a reply — replies pause the ladder by design]', null],
];

const NURTURE = {
  key: 'marketing_long_term_nurture',
  name: 'Long-term nurture (~90 days)',
  source: 'borrowed: nurturing-engine/backend/app/sequences.py LONG_TERM_EMAIL_STEPS (N0–N9)',
  pipeline_key: 'webinar_marketing',
  trigger_stage: null,
  caveat: 'upstream marks this copy placeholder-quality BY DESIGN — the cadence and the '
    + 'every-third-touch soft CTA are the borrowed asset, not the words',
  cumulative_days: NURTURE_DAYS.map(([day]) => day),
  steps: NURTURE_DAYS.map(([day, gapHours, subject, para, cta]) => ({
    channel: 'email',
    delay_seconds: gapHours * HOUR,
    subject,
    body: `Hi {first_name},\n\n${para}\n${cta ? `\n${cta}\n` : ''}\n— {sender_name}\n\n{unsubscribe_url}`,
  })),
};

const DEFINITIONS = [INVITE_EMAIL, INVITE_SMS, INVITE_WHATSAPP, INVITE_LINKEDIN, NO_SHOW, NURTURE];
const byKey = Object.fromEntries(DEFINITIONS.map(d => [d.key, d]));

// Which context tokens a definition needs, so the seeder can tell an operator
// what to configure BEFORE the first send rather than after the first refusal.
function requiredTokens(def) {
  const { CONTEXT_TOKENS } = require('./ai-draft');
  const text = def.steps.map(s => `${s.subject || ''} ${s.body || ''}`).join(' ');
  return CONTEXT_TOKENS.filter(t => new RegExp(`\\{${t}\\}`).test(text));
}

module.exports = { DEFINITIONS, byKey, requiredTokens, KEYS: DEFINITIONS.map(d => d.key) };
