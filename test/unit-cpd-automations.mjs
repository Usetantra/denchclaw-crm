#!/usr/bin/env node
// DenchClaw CRM — CP-D: the operator's actual automations.
//
// Until this checkpoint every sequence in the database was a test fixture. These
// tests are about whether the borrowed ladders are REAL: whether the copy
// survived being ported between two systems whose merge syntax means opposite
// things, whether an unconfigured tenant is refused rather than sent a literal
// brace, and whether the No-Show ladder respects the invariant that outranks
// everything — no automation may auto-advance a MANUAL stage.
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import dispatchDb from '../server/db/models/dispatch.js';
import templatesDb from '../server/db/models/templates.js';
import automationsDb from '../server/db/models/automations.js';
import { DEFINITIONS, byKey, requiredTokens } from '../server/lib/automation-definitions.js';
import { CONTEXT_TOKENS, KNOWN_TOKENS } from '../server/lib/ai-draft.js';
import { getPipelineConfig, isManualStage } from '../server/db/pipeline.js';

const KEY = process.env.INTERNAL_API_KEY;
const BASE = process.env.CRM_API_BASE;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpd_co_' + RUN;
if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0; const results = [];
const check = (n, ok, d) => { if (ok) { pass++; results.push(`  PASS  ${n}`); } else { fail++; results.push(`  FAIL  ${n} — ${d}`); } };
const api = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'x-internal-key': KEY, 'x-company-id': CO, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
};

async function main() {
  await db.initDatabase();
  await tenantDb.create({ id: CO, name: CO, slug: CO });

  // ── D-1 — the port hazard: two systems, opposite merge syntax ─────────────
  // Upstream writes {{first_name}}. Here {{...}} is the deliberate ESCAPE for
  // writing ABOUT a merge field, so a straight paste renders the literal text
  // {first_name} — and every guard correctly waves it through, because the
  // escape is intentional. This is asserted, not trusted.
  const allText = DEFINITIONS.flatMap(d => d.steps.map(s => `${s.subject || ''} ${s.body || ''}`)).join(' ');
  check('D-1 no borrowed {{token}} survived the port — a paste would have sent "Hi {first_name},"',
    !/\{\{/.test(allText), (allText.match(/\{\{\w+\}\}/g) || []).slice(0, 3).join(', '));
  check('D-1 …and the copy really does use merge tokens (not passing by having none)',
    /\{first_name\}/.test(allText) && /\{company\}/.test(allText), 'expected single-brace tokens');
  check('D-1 every token used is a KNOWN token — an unknown one fails SILENTLY',
    [...new Set([...allText.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]))].every(t => KNOWN_TOKENS.includes(t)),
    [...new Set([...allText.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]))].filter(t => !KNOWN_TOKENS.includes(t)).join(','));

  // ── D-2 — THE INVARIANT: no definition touches a manual stage ─────────────
  const cfgs = {};
  for (const pk of [...new Set(DEFINITIONS.map(d => d.pipeline_key))]) cfgs[pk] = await getPipelineConfig(CO, pk);
  const manualWrites = [];
  for (const d of DEFINITIONS) {
    for (const s of d.steps) {
      if (s.stage_writeback && isManualStage(cfgs[d.pipeline_key], s.stage_writeback)) {
        manualWrites.push(`${d.key} → ${s.stage_writeback}`);
      }
    }
  }
  check('D-2 NO automation writes back a MANUAL stage', manualWrites.length === 0, manualWrites.join('; '));
  check('D-2 Deal Follow-ups 1/2/3 have no automation at all — they are dates for a human, not timers',
    !DEFINITIONS.some(d => d.steps.some(s => String(s.stage_writeback || '').startsWith('deal_followup'))
      || String(d.trigger_stage || '').startsWith('deal_followup')), 'a deal follow-up is automated');
  check('D-2 the No-Show ladder is TRIGGERED by the manual stage and writes back only automated ones',
    byKey.webinar_sales_no_show.trigger_stage === 'no_show_followup_1'
      && isManualStage(cfgs.webinar_sales, 'no_show_followup_1')
      && byKey.webinar_sales_no_show.steps[0].stage_writeback == null,
    JSON.stringify(byKey.webinar_sales_no_show.steps[0].stage_writeback));

  // ── D-3 — the operator's cadence, and the trap inside it ─────────────────
  // The operator's figures are CUMULATIVE from Follow-up 1 (0/+3/+6/+9/+16), but
  // `delay_seconds` is the GAP FROM THE PREVIOUS RUNG — advanceEnrollment anchors
  // each step on its predecessor's ack (dispatch.js:627-629). Writing the
  // cumulative figures into the column sends the final email on day 34.
  // Asserting the column would have enshrined exactly that, so the cumulative
  // total is RECONSTRUCTED, and D-3b measures a real scheduled_for delta.
  const ns = byKey.webinar_sales_no_show.steps.map(s => s.delay_seconds / 86400);
  const cum = ns.reduce((a, d) => [...a, (a[a.length - 1] || 0) + d], []);
  check('D-3 the gaps between rungs are 0 / 3 / 3 / 3 / 7 days',
    JSON.stringify(ns) === JSON.stringify([0, 3, 3, 3, 7]), JSON.stringify(ns));
  check('D-3 …which lands the operator\'s cumulative 0 / +3d / +6d / +9d / +16d',
    JSON.stringify(cum) === JSON.stringify(byKey.webinar_sales_no_show.cumulative_days),
    `${JSON.stringify(cum)} vs ${JSON.stringify(byKey.webinar_sales_no_show.cumulative_days)}`);
  const ncum = byKey.marketing_long_term_nurture.steps
    .reduce((a, st) => [...a, (a[a.length - 1] || 0) + st.delay_seconds / 86400], []);
  check('D-3 the nurture drip really spans ~90 days, not ~335',
    JSON.stringify(ncum) === JSON.stringify(byKey.marketing_long_term_nurture.cumulative_days),
    `${JSON.stringify(ncum)}`);
  check('D-3 rung 1 fires IMMEDIATELY — the operator said "sent immediately after the no-show"',
    ns[0] === 0, String(ns[0]));
  check('D-3 …and writes back 2,3,4,5 in order',
    JSON.stringify(byKey.webinar_sales_no_show.steps.map(s => s.stage_writeback))
      === JSON.stringify([null, 'no_show_followup_2', 'no_show_followup_3', 'no_show_followup_4', 'no_show_followup_5']),
    JSON.stringify(byKey.webinar_sales_no_show.steps.map(s => s.stage_writeback)));

  // ── D-3b — MEASURED, not declared: walk two real rungs ───────────────────
  // The only assertion that would have caught the cumulative/relative mistake.
  const CAD = CO + '_cad';
  await tenantDb.create({ id: CAD, name: CAD, slug: CAD });
  const cadC = await contactDb.create({ name: 'Iris Blake', email: `cpd-iris-${RUN}@ex.test`, company_id: CAD, company_name: 'Blake Co' });
  for (const [k, v] of [['book_url', 'https://usetantra.com/book'], ['unsubscribe_url', 'https://usetantra.com/unsub'], ['sender_name', 'Adithya']]) {
    await templatesDb.setMergeDefault(CAD, k, v);
  }
  const cadSeed = await automationsDb.seed(CAD, 'webinar_sales_no_show');
  const cadE = await seqDb.enroll(CAD, { sequenceId: cadSeed.sequence_id, contactId: cadC.id });
  const rung1 = (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1', [cadE.id])).rows[0];
  check('D-3b rung 1 is due at enrolment', rung1 && new Date(rung1.scheduled_for) - new Date(cadE.enrolled_at) < 60_000,
    rung1 && String(new Date(rung1.scheduled_for) - new Date(cadE.enrolled_at)));
  const ackAt = new Date();
  await db.query(`UPDATE scheduled_actions SET status='claimed', claimed_by='cpd-cadence' WHERE id=$1`, [rung1.id]);
  await dispatchDb.ackJob(CAD, rung1.id, { claimedBy: 'cpd-cadence', status: 'sent' });
  const rung2 = (await db.query(
    `SELECT * FROM scheduled_actions WHERE enrollment_id=$1 AND id <> $2`, [cadE.id, rung1.id])).rows[0];
  const gapDays = rung2 ? (new Date(rung2.scheduled_for) - ackAt) / 86400000 : null;
  check('D-3b rung 2 is scheduled 3 DAYS after rung 1 was acked — measured, not declared',
    gapDays !== null && Math.abs(gapDays - 3) < 0.05, String(gapDays));

  // ── D-4 — seeding actually installs something that can fire ──────────────
  const seeded = await automationsDb.seed(CO, 'webinar_sales_no_show');
  check('D-4 the No-Show ladder installs', seeded.ok && seeded.installed, JSON.stringify(seeded));
  check('D-4 …with all five rungs', seeded.steps === 5, String(seeded.steps));
  const seq = await seqDb.getSequenceById(seeded.sequence_id, CO);
  check('D-4 …bound to its trigger stage, so a human marking the no-show starts it',
    seq.trigger_stage === 'no_show_followup_1' && seq.status === 'active', JSON.stringify(seq.trigger_stage));
  const steps = await seqDb.listSteps(seeded.sequence_id, CO);
  check('D-4 …every rung resolves through an EDITABLE template, not frozen inline copy',
    steps.every(s => s.template_ref && !s.body), JSON.stringify(steps.map(s => !!s.template_ref)));
  const tpl = await templatesDb.getTemplate(CO, steps[0].template_ref);
  check('D-4 …and that template carries the real copy', /Sorry we missed you/.test(tpl.subject || ''), tpl.subject);

  // ── D-5 — re-seeding never silently reverts a human's rewrite ────────────
  await templatesDb.upsertTemplate(CO, { ref: steps[0].template_ref, channel: 'email',
    subject: 'A HUMAN REWROTE THIS', body: 'Hi {first_name}, my own words. {book_url}' });
  const again = await automationsDb.seed(CO, 'webinar_sales_no_show');
  check('D-5 re-seeding reports already_installed rather than installing a second copy',
    again.ok && again.already_installed, JSON.stringify(again));
  const tpl2 = await templatesDb.getTemplate(CO, steps[0].template_ref);
  check('D-5 …and the human\'s copy is untouched', tpl2.subject === 'A HUMAN REWROTE THIS', tpl2.subject);
  const seqs = await seqDb.listSequences(CO, { pipelineKey: 'webinar_sales' });
  check('D-5 …exactly ONE sequence exists, not two', seqs.length === 1, String(seqs.length));
  const over = await automationsDb.seed(CO, 'webinar_sales_no_show', { overwrite: true });
  check('D-5 overwrite:true does replace it, but only when asked explicitly',
    over.installed === true && (await templatesDb.getTemplate(CO, steps[0].template_ref)).subject !== 'A HUMAN REWROTE THIS',
    JSON.stringify(over.installed));

  // ── D-6 — THE HEADLINE SAFETY FIX: {book_url} now BLOCKS ─────────────────
  // Before CP-D `book_url` was not a known token, so unresolvedTokensIn returned
  // nothing, the claim door's content guard passed, and the executor would have
  // sent "Pick a time: {book_url}" to a real prospect.
  check('D-6 the context tokens the borrowed copy needs are KNOWN tokens now',
    ['book_url', 'join_url', 'unsubscribe_url'].every(t => KNOWN_TOKENS.includes(t)), KNOWN_TOKENS.join(','));
  const c1 = await contactDb.create({ name: 'Nora Shaw', email: `cpd-nora-${RUN}@ex.test`, company_id: CO, company_name: 'Northwind' });
  const liveSteps = await seqDb.listSteps(over.sequence_id, CO);
  const unset = await templatesDb.resolveStepContent(CO, liveSteps[0], c1);
  check('D-6 with the tenant UNCONFIGURED the copy is refused, not sent',
    unset.resolved === false, JSON.stringify(unset.resolved));
  check('D-6 …naming the token', /book_url/.test(unset.reason || ''), unset.reason);
  check('D-6 …and pointing at the TENANT setting, not the contact record',
    /tenant setting/.test(unset.reason || '') && /merge-defaults/.test(unset.reason || ''), unset.reason);

  // ── D-7 — configure the tenant, and the same copy resolves ──────────────
  const put = await api('PUT', '/api/crm/automations/merge-defaults', {
    book_url: 'https://usetantra.com/book', unsubscribe_url: 'https://usetantra.com/unsubscribe',
    sender_name: 'Adithya', join_url: 'https://usetantra.com/webinar',
  });
  check('D-7 merge defaults save', put.status === 200, JSON.stringify(put.json));
  const bad = await api('PUT', '/api/crm/automations/merge-defaults', { booking_url: 'https://typo.test' });
  check('D-7 a typo\'d token is REFUSED, not silently dropped', bad.status === 400, JSON.stringify(bad.json));
  const ok1 = await templatesDb.resolveStepContent(CO, liveSteps[0], c1);
  check('D-7 the same step now resolves', ok1.resolved === true, ok1.reason);
  check('D-7 …with the real URL substituted, not a brace',
    /https:\/\/usetantra\.com\/book/.test(ok1.body) && !/\{book_url\}/.test(ok1.body), ok1.body.slice(0, 120));
  check('D-7 …and the contact\'s own name resolved too',
    /Hi Nora/.test(ok1.body) && !/\{first_name\}/.test(ok1.body), ok1.body.slice(0, 40));

  // ── D-8 — F-CP4a-1 closed: the claim door knows the NEW tokens ───────────
  // The door's pattern used to be a hardcoded '{(first_name|company|stage)}' —
  // a second copy of KNOWN_TOKENS that nothing kept in step. With six tokens
  // added, a stale copy would wave {book_url} straight through.
  const s2 = await seqDb.createSequence({ companyId: CO, name: `cpd door ${RUN}`, pipelineKey: 'webinar_sales' });
  // {webinar_date} is deliberately a token this tenant has NOT configured, so the
  // re-resolve pass cannot repair it and the door's refusal is the outcome under
  // test. (A repairable payload is D-17.)
  await seqDb.addStep(s2.id, CO, { stepOrder: 1, channel: 'email', subject: 'S', body: 'Hi {first_name}. {webinar_date}' });
  const e2 = await seqDb.enroll(CO, { sequenceId: s2.id, contactId: c1.id });
  const j2 = (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1', [e2.id])).rows[0];
  // Force a payload that CLAIMS to be resolved while still carrying a context
  // token — exactly what a future writer that skipped resolution would produce.
  await db.query(
    `UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute',
        payload = jsonb_build_object('content_resolved', true, 'subject', 'S',
                                     'body', 'Hi Nora. {webinar_date}')
      WHERE id = $1`, [j2.id]);
  const claimed = await dispatchDb.claimJobs(CO, 'email', 10, 'cpd-door-probe');
  check('D-8 the claim door REFUSES a payload still carrying an unresolvable context token',
    !claimed.some(j => j.id === j2.id), `claimed ${claimed.length} incl. the poisoned job`);
  await db.query(`UPDATE scheduled_actions SET payload = jsonb_set(payload,'{body}','"Hi Nora. https://ok.test"') WHERE id=$1`, [j2.id]);
  const claimed2 = await dispatchDb.claimJobs(CO, 'email', 10, 'cpd-door-probe');
  check('D-8 …and admits the same job once the token is gone (not refusing everything)',
    claimed2.some(j => j.id === j2.id), `claimed ${claimed2.length}`);
  check('D-8 ordinary braced prose is still NOT refused — "the {growth} framework" must send',
    (await import('../server/lib/ai-draft.js')).unresolvedTokensIn('the {growth} framework').length === 0,
    'braced prose was refused');

  // ── D-9 — a human marking the no-show actually starts the ladder ─────────
  const c2 = await contactDb.create({ name: 'Ravi Menon', email: `cpd-ravi-${RUN}@ex.test`, company_id: CO, company_name: 'Meridian' });
  const enrolled = await seqDb.enrollForTriggerStage(CO, c2.id, 'webinar_sales', 'no_show_followup_1');
  check('D-9 entering the MANUAL trigger stage enrols the contact',
    Array.isArray(enrolled) ? enrolled.length >= 1 : !!enrolled, JSON.stringify(enrolled && enrolled.length));
  const job = (await db.query(
    `SELECT sa.* FROM scheduled_actions sa JOIN enrollments e ON e.id = sa.enrollment_id
      WHERE e.contact_id = $1 ORDER BY sa.scheduled_for LIMIT 1`, [c2.id])).rows[0];
  check('D-9 …and rung 1 is queued', !!job, 'no job queued');
  check('D-9 …due immediately, per "sent immediately after the no-show"',
    job && new Date(job.scheduled_for) - new Date(job.created_at) < 60_000,
    job && String(new Date(job.scheduled_for) - new Date(job.created_at)));
  check('D-9 …CARRYING REAL COPY, not an empty payload',
    job && job.payload.content_resolved === true && /Ravi/.test(job.payload.body)
      && /usetantra\.com\/book/.test(job.payload.body),
    job && JSON.stringify(job.payload.body || '').slice(0, 120));

  // ── D-10 — the `automations` column answer ───────────────────────────────
  const proj = await api('GET', '/api/crm/automations/pipeline/webinar_sales');
  check('D-10 the pipeline reports what actually fires on it', proj.status === 200, String(proj.status));
  const nsRow = (proj.json.automations || []).find(a => a.trigger_stage === 'no_show_followup_1');
  check('D-10 …the No-Show ladder is listed with its trigger', !!nsRow, JSON.stringify(proj.json.automations));
  check('D-10 …and the stages it will advance', nsRow && nsRow.advances_stages_to.length === 4,
    JSON.stringify(nsRow && nsRow.advances_stages_to));
  const col = await db.query(
    `SELECT automations FROM crm_pipeline_configs WHERE key='webinar_sales' AND company_id IS NULL`);
  check('D-10 …while crm_pipeline_configs.automations stays EMPTY, deliberately — one source of truth',
    JSON.stringify(col.rows[0].automations) === '[]', JSON.stringify(col.rows[0].automations));

  // ── D-11 — the catalogue tells an operator what is missing BEFORE sending ─
  const cat = await api('GET', '/api/crm/automations');
  check('D-11 the catalogue lists every definition', cat.json.available.length === DEFINITIONS.length,
    String(cat.json.available.length));
  check('D-11 …marking BORROWED vs AUTHORED, because that was the operator\'s instruction',
    cat.json.available.some(a => /^borrowed:/.test(a.source)) && cat.json.available.some(a => /^AUTHORED/.test(a.source)),
    JSON.stringify(cat.json.available.map(a => a.source.slice(0, 12))));
  check('D-11 …and the No-Show ladder shows as installed',
    cat.json.available.find(a => a.key === 'webinar_sales_no_show').installed === true, 'not installed');
  const li = cat.json.available.find(a => a.key === 'webinar_marketing_invite_linkedin');
  check('D-11 the LinkedIn invite ladder carries per-step actions (invite → messages → InMail)',
    JSON.stringify(byKey.webinar_marketing_invite_linkedin.steps.map(s => s.linkedin_action))
      === JSON.stringify(['invite', 'message', 'message', 'message', 'inmail']),
    JSON.stringify(byKey.webinar_marketing_invite_linkedin.steps.map(s => s.linkedin_action)));

  // ── D-12 — seeding the LinkedIn ladder persists the actions ─────────────
  const liSeed = await automationsDb.seed(CO, 'webinar_marketing_invite_linkedin');
  check('D-12 the LinkedIn invite ladder installs', liSeed.ok, JSON.stringify(liSeed.error));
  const liSteps = await seqDb.listSteps(liSeed.sequence_id, CO);
  check('D-12 …with linkedin_action persisted per step, which is what CP-C2\'s gate reads',
    JSON.stringify(liSteps.map(s => s.linkedin_action)) === JSON.stringify(['invite', 'message', 'message', 'message', 'inmail']),
    JSON.stringify(liSteps.map(s => s.linkedin_action)));
  check('D-12 …and only the first rung moves Prospects → Invitees',
    liSteps.filter(s => s.stage_writeback).length === 1 && liSteps[0].stage_writeback === 'invitees',
    JSON.stringify(liSteps.map(s => s.stage_writeback)));
  check('D-12 an unknown automation key is a 400 with the list, not a crash',
    (await api('POST', '/api/crm/automations/nope/seed')).status === 400, 'expected 400');

  // ── D-13 — readiness is reported at INSTALL time ────────────────────────
  const CO2 = CO + '_bare';
  await tenantDb.create({ id: CO2, name: CO2, slug: CO2 });
  const bareSeed = await automationsDb.seed(CO2, 'webinar_sales_no_show');
  check('D-13 installing on an unconfigured tenant SUCCEEDS but says what is missing',
    bareSeed.ok && bareSeed.missing_merge_tokens.includes('book_url'),
    JSON.stringify(bareSeed.missing_merge_tokens));
  check('D-13 …and on the configured tenant nothing is missing',
    (await automationsDb.readiness(CO, byKey.webinar_sales_no_show)).missing_merge_tokens.length === 0,
    JSON.stringify((await automationsDb.readiness(CO, byKey.webinar_sales_no_show)).missing_merge_tokens));

  // ── D-14 — the two things the borrow LOST, caught by the research critic ──
  // A cold, business-initiated WhatsApp is outside any 24-hour session window,
  // so Twilio requires an APPROVED CONTENT TEMPLATE. Upstream's approved SIDs
  // belong to the post-registration reminder ladder, not to this cold copy — so
  // seeding this 'active' would queue cold sends the provider rejects one at a
  // time, which reads as a broken executor rather than as missing paperwork.
  const waSeed = await automationsDb.seed(CO, 'webinar_marketing_invite_whatsapp');
  check('D-14 the WhatsApp invite ladder installs PAUSED, not active', waSeed.status === 'paused',
    JSON.stringify(waSeed.status));
  check('D-14 …saying exactly what unblocks it', /approved Twilio WhatsApp content template/.test(waSeed.blocked_until || ''),
    String(waSeed.blocked_until));
  const waSeq = await seqDb.getSequenceById(waSeed.sequence_id, CO);
  check('D-14 …and PAUSED means genuinely inert, because the claim door requires an active sequence',
    waSeq.status === 'paused', waSeq.status);
  const waC = await contactDb.create({ name: 'Priya Rao', email: `cpd-priya-${RUN}@ex.test`, phone: '+15557654321', company_id: CO });
  await seqDb.enroll(CO, { sequenceId: waSeed.sequence_id, contactId: waC.id });
  await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute'
                   WHERE contact_id = $1`, [waC.id]);
  const waClaim = await dispatchDb.claimJobs(CO, 'whatsapp', 10, 'cpd-wa-probe');
  check('D-14 …a queued rung of a paused ladder is NOT handed out', waClaim.length === 0, String(waClaim.length));

  // The LinkedIn ladder's delays were borrowed; its SEND WINDOW lives on the
  // account (CP-C2), so the definition has to carry the instruction or the
  // borrow silently widened Tue/Wed/Thu 09:00–10:30 to CP-C2's weekday default.
  const liDef = byKey.webinar_marketing_invite_linkedin;
  check('D-14 the LinkedIn ladder carries its upstream send window as an install instruction',
    /Tue.*Wed.*Thu/.test(liDef.account_note || '') && /09:00/.test(liDef.account_note || ''),
    String(liDef.account_note));
  const catalogue = await api('GET', '/api/crm/automations');
  check('D-14 …and both warnings are visible in the CATALOGUE, before an operator picks one',
    catalogue.json.available.find(a => a.key === 'webinar_marketing_invite_whatsapp').installs_paused === true
      && !!catalogue.json.available.find(a => a.key === 'webinar_marketing_invite_linkedin').account_note,
    'warnings missing from the catalogue');

  // ── D-15 — overwrite is REFUSED once the ladder has run ──────────────────
  // scheduled_actions.step_id is ON DELETE CASCADE, so replacing the steps of a
  // ladder with history deletes its whole send ledger — which for LinkedIn IS
  // the rate-limit ledger — destroys the in-flight-send record the no-double-send
  // guarantee rests on, and strands every mid-ladder contact as active with a
  // NULL current step, unable to re-enrol.
  const guarded = await automationsDb.seed(CAD, 'webinar_sales_no_show', { overwrite: true });
  check('D-15 overwriting a ladder that has already run is REFUSED', guarded.ok === false,
    JSON.stringify(guarded).slice(0, 160));
  check('D-15 …saying how much history it would have destroyed',
    /cascade-delete/.test(guarded.error || '') && (guarded.sent_jobs > 0 || guarded.live_enrolments > 0),
    JSON.stringify({ sent: guarded.sent_jobs, live: guarded.live_enrolments }));
  const survived = await db.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_actions WHERE enrollment_id = $1`, [cadE.id]);
  check('D-15 …and the send ledger is intact', survived.rows[0].n >= 2, JSON.stringify(survived.rows[0]));
  const stillActive = await db.query(
    `SELECT current_step_id FROM enrollments WHERE id = $1`, [cadE.id]);
  check('D-15 …and the live enrolment still has a current step (not stranded)',
    stillActive.rows[0].current_step_id !== null, JSON.stringify(stillActive.rows[0]));

  // ── D-16 — seed identity is the definition key, not a mutable name ───────
  await db.query(`UPDATE sequences SET name = 'Renamed By A Human' WHERE id = $1`, [cadSeed.sequence_id]);
  const afterRename = await automationsDb.seed(CAD, 'webinar_sales_no_show');
  check('D-16 renaming a seeded ladder does NOT cause a duplicate install',
    afterRename.already_installed === true && afterRename.sequence_id === cadSeed.sequence_id,
    JSON.stringify(afterRename).slice(0, 120));
  const DEC = CO + '_dec';
  await tenantDb.create({ id: DEC, name: DEC, slug: DEC });
  const decoy = await seqDb.createSequence({ companyId: DEC, name: 'No-Show follow-up ladder', pipelineKey: 'webinar_sales' });
  await seqDb.addStep(decoy.id, DEC, { stepOrder: 1, channel: 'email', subject: 'MINE', body: 'my own words' });
  const afterDecoy = await automationsDb.seed(DEC, 'webinar_sales_no_show', { overwrite: true });
  const decoySteps = await seqDb.listSteps(decoy.id, DEC);
  check('D-16 …and a human\'s own sequence that happens to share the name is NOT clobbered',
    afterDecoy.sequence_id !== decoy.id && decoySteps.length === 1 && decoySteps[0].subject === 'MINE',
    JSON.stringify({ same: afterDecoy.sequence_id === decoy.id, steps: decoySteps.length }));

  // ── D-17 — a job frozen BEFORE the token set grew can still un-stick ─────
  // It is not content_resolved:false, so the old re-resolve pass never retried
  // it: refused at the door forever while readiness reported the ladder healthy.
  const frozenC = await contactDb.create({ name: 'Omar Diaz', email: `cpd-omar-${RUN}@ex.test`, company_id: CO });
  const fSeq = await seqDb.createSequence({ companyId: CO, name: `cpd frozen ${RUN}`, pipelineKey: 'webinar_sales' });
  await seqDb.addStep(fSeq.id, CO, { stepOrder: 1, channel: 'email', subject: 'Hi', body: 'Book here: {book_url}' });
  const fEnr = await seqDb.enroll(CO, { sequenceId: fSeq.id, contactId: frozenC.id });
  const fJob = (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1', [fEnr.id])).rows[0];
  await db.query(
    `UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute',
        payload = jsonb_build_object('content_resolved', true, 'subject', 'Hi',
                                     'body', 'Book here: {book_url}')
      WHERE id = $1`, [fJob.id]);
  check('D-17 the stale payload WOULD be refused by the door as it stands',
    new RegExp(templatesDb.UNRESOLVED_TOKEN_RE.replace(/\\\\/g, '\\')).test('Book here: {book_url}'),
    'the door pattern does not cover {book_url}');
  const afterFix = await dispatchDb.claimJobs(CO, 'email', 20, 'cpd-frozen-b');
  const fixed = await db.query('SELECT payload FROM scheduled_actions WHERE id=$1', [fJob.id]);
  check('D-17 …and the widened re-resolve pass RE-FREEZES it from the template',
    /usetantra\.com\/book/.test(fixed.rows[0].payload.body || '') && !/\{book_url\}/.test(fixed.rows[0].payload.body || ''),
    JSON.stringify(fixed.rows[0].payload.body));
  check('D-17 …so a job frozen before the token set grew becomes claimable again, rather than dying quietly',
    afterFix.some(j => j.id === fJob.id), 'still not claimable');

  // ── D-18 — the API can finally author a LinkedIn invite rung ─────────────
  const apiSeq = await api('POST', '/api/crm/sequences', { name: `cpd api ${RUN}`, pipeline_key: 'webinar_marketing' });
  const okStep = await api('POST', `/api/crm/sequences/${apiSeq.json.id || apiSeq.json.sequence?.id}/steps`,
    { step_order: 1, channel: 'linkedin', body: 'Hi {first_name}', linkedin_action: 'invite' });
  check('D-18 the API accepts linkedin_action, so an invite rung is authorable',
    okStep.status === 201 || okStep.status === 200, JSON.stringify(okStep.json).slice(0, 140));
  const badStep = await api('POST', `/api/crm/sequences/${apiSeq.json.id || apiSeq.json.sequence?.id}/steps`,
    { step_order: 2, channel: 'email', body: 'Hi {first_name}', linkedin_action: 'invite' });
  check('D-18 …and refuses it on a non-LinkedIn step rather than silently dropping it',
    badStep.status === 400, String(badStep.status));

  // ── D-19 — merge defaults are all-or-nothing ─────────────────────────────
  const partial = await api('PUT', '/api/crm/automations/merge-defaults',
    { join_url: 'https://changed.test', webinar_time: '   ' });
  check('D-19 a request with one blank value changes NOTHING', partial.status === 400, String(partial.status));
  const stillOld = await templatesDb.mergeDefaults(CO);
  check('D-19 …the good value in the same request was not written either',
    stillOld.join_url !== 'https://changed.test', String(stillOld.join_url));

  console.log(results.join('\n'));
  console.log(`\nCP-D automations: ${pass} passed / ${fail} failed`);
  await db.closeDatabase?.();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
