#!/usr/bin/env node
// DenchClaw CRM — CP-Y: automation may only set a stage declared `auto`.
//
// The defect: `applyStageWriteback` asked "is this stage declared MANUAL?",
// which answers false for a stage that declares nothing — and the legacy
// marketing/sales pipelines declare nothing on any stage. A sequence step moved
// a real deal to `won`.
//
// Every refusal below is paired with a POSITIVE CONTROL, because a gate that
// blocks everything passes a refusal test and is not a fix. Y-2 is the one that
// matters: a `webinar_marketing` step writing back `invitees` (declared `auto`)
// must still apply.
import db from '../server/db/index.js';
import tenantDb from '../server/db/models/tenants.js';
import contactDb from '../server/db/models/contacts.js';
import seqDb from '../server/db/models/sequences.js';
import dispatchDb from '../server/db/models/dispatch.js';
import { getPipelineConfig, isManualStage, mayAutomationSetStage } from '../server/db/pipeline.js';
import { manualStageRefusal, isAutomatedRequest } from '../server/lib/stage-authority.js';
import executors from '../server/lib/executors.js';
import templatesDb from '../server/db/models/templates.js';

const KEY = process.env.INTERNAL_API_KEY;
const BASE = process.env.CRM_API_BASE;
const RUN = process.env.RUN || String(Date.now());
const CO = 'cpy_co_' + RUN;
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
  let n = 0;

  // Builds a ladder whose single step writes back `target` on `pipelineKey`,
  // drives it through the REAL claimJobs → ackJob path, and reports where the
  // entity ended up. Nothing is simulated: this is the path the defect used.
  async function driveWriteback({ pipelineKey, from, target, isDeal }) {
    n += 1;
    const c = await contactDb.create({ name: `CPY P${n}`, email: `cpy-${n}-${RUN}@ex.test`, company_id: CO });
    if (!isDeal) {
      await db.query('UPDATE contacts SET marketing_stage = $2 WHERE id = $1', [c.id, from]);
    }
    let dealId = null;
    if (isDeal) {
      const d = await db.query(
        `INSERT INTO deals (company_id, contact_id, title, stage, value, pipeline_key)
         VALUES ($1,$2,$3,$4,50000,$5) RETURNING id`,
        [CO, c.id, `CPY deal ${n}`, from, pipelineKey]);
      dealId = d.rows[0].id;
    }
    const s = await seqDb.createSequence({ companyId: CO, name: `cpy ${RUN} ${n}`, pipelineKey });
    const st = await seqDb.addStep(s.id, CO, {
      stepOrder: 1, channel: 'email', subject: 'S', body: 'Hi {first_name}', stageWriteback: target });
    const e = await seqDb.enroll(CO, { sequenceId: s.id, contactId: c.id });
    const job = (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1', [e.id])).rows[0];
    await db.query(`UPDATE scheduled_actions SET scheduled_for = now() - interval '1 minute' WHERE id=$1`, [job.id]);

    const claimed = await dispatchDb.claimJobs(CO, 'email', 5, `cpy-${n}`);
    const mine = claimed.find(j => j.id === job.id);
    if (!mine) return { claimable: false };
    const ack = await dispatchDb.ackJob(CO, job.id, { claimedBy: `cpy-${n}`, status: 'sent' });
    const after = isDeal
      ? (await db.query('SELECT stage FROM deals WHERE id=$1', [dealId])).rows[0].stage
      : (await db.query('SELECT marketing_stage FROM contacts WHERE id=$1', [c.id])).rows[0].marketing_stage;
    const notes = (await db.query(
      `SELECT type, message, data FROM contact_activity
        WHERE contact_id=$1 AND type='stage_writeback_refused' ORDER BY created_at DESC LIMIT 1`, [c.id])).rows[0];
    return { claimable: true, ackStatus: ack?.httpStatus, after, note: notes, contact: c, dealId, stepId: st.id };
  }

  // ── Y-1 — THE DEFECT: a robot must not mark a legacy deal `won` ───────────
  const won = await driveWriteback({ pipelineKey: 'sales', from: 'onboarding', target: 'won', isDeal: true });
  check('Y-1 POSITIVE CONTROL — the job really was claimable and acked', won.claimable && won.ackStatus === 200,
    JSON.stringify({ claimable: won.claimable, ack: won.ackStatus }));
  check('Y-1 !!! a sequence step CANNOT mark a legacy deal `won`', won.after === 'onboarding',
    `deal is now stage='${won.after}'`);
  check('Y-1 …and the timeline says why, naming wanted/found/reason',
    won.note && won.note.data.wanted === 'won' && won.note.data.found === 'onboarding'
      && !!won.note.data.reason, JSON.stringify(won.note && won.note.data));
  check('Y-1 …with the reason distinguishing "nobody declared this automatable" from "a human owns it"',
    won.note && ['manual_stage', 'stage_not_automatable'].includes(won.note.data.reason), JSON.stringify(won.note?.data?.reason));

  // ── Y-2 — THE POSITIVE CONTROL THAT MATTERS ─────────────────────────────
  // A fix that blocks every write-back is not a fix.
  const inv = await driveWriteback({ pipelineKey: 'webinar_marketing', from: 'prospects', target: 'invitees' });
  check('Y-2 POSITIVE CONTROL — a step writing back a declared-`auto` stage STILL APPLIES',
    inv.after === 'invitees', `contact is at '${inv.after}', expected 'invitees'`);
  check('Y-2 …and no refusal note was written', !inv.note, JSON.stringify(inv.note && inv.note.message));

  // A second positive control on the LEGACY pipeline itself, so Y-1 cannot be
  // passing merely because legacy write-backs are now blocked wholesale.
  const eng = await driveWriteback({ pipelineKey: 'marketing', from: 'queued', target: 'engaged' });
  check('Y-2 POSITIVE CONTROL on the LEGACY pipeline — `engaged` is declared auto and still applies',
    eng.after === 'engaged', `contact is at '${eng.after}', expected 'engaged'`);

  // ── Y-3 — the automated ADVANCE path refuses too ────────────────────────
  const salesCfg = await getPipelineConfig(CO, 'sales');
  const bare = { key: 'bare', stages: [{ key: 'a', transitions: ['b'] }, { key: 'b', transitions: [] }] };
  check('Y-3 a stage with NO mode is refused to automation',
    !!manualStageRefusal({ pipeline: bare, pipelineKey: 'bare', stage: 'b', automated: true }),
    'a no-mode stage was allowed');
  check('Y-3 …with error_code stage_not_automatable, not manual_stage',
    manualStageRefusal({ pipeline: bare, pipelineKey: 'bare', stage: 'b', automated: true }).body.error_code
      === 'stage_not_automatable',
    JSON.stringify(manualStageRefusal({ pipeline: bare, pipelineKey: 'bare', stage: 'b', automated: true }).body.error_code));
  check('Y-3 …while a declared-manual stage still says manual_stage',
    manualStageRefusal({ pipeline: salesCfg, pipelineKey: 'sales', stage: 'won', automated: true }).body.error_code
      === 'manual_stage', 'expected manual_stage');
  check('Y-3 …and a HUMAN is refused nothing',
    manualStageRefusal({ pipeline: bare, pipelineKey: 'bare', stage: 'b', automated: false }) === null
      && manualStageRefusal({ pipeline: salesCfg, pipelineKey: 'sales', stage: 'won', automated: false }) === null,
    'a human was refused');
  check('Y-3 …and a declared-auto stage passes for automation',
    manualStageRefusal({ pipeline: salesCfg, pipelineKey: 'sales', stage: 'contacted', automated: true }) === null,
    'an auto stage was refused to automation');

  // ── Y-4 — a HUMAN can still set `won` over HTTP ─────────────────────────
  const hc = await contactDb.create({ name: 'CPY Human', email: `cpy-human-${RUN}@ex.test`, company_id: CO });
  const hd = await db.query(
    `INSERT INTO deals (company_id, contact_id, title, stage, value, pipeline_key)
     VALUES ($1,$2,'CPY human deal','onboarding',50000,'sales') RETURNING id`, [CO, hc.id]);
  const humanWin = await api('PATCH', `/api/crm/deals/${hd.rows[0].id}`, { stage: 'won' });
  check('Y-4 a HUMAN can still mark a deal won', humanWin.status === 200,
    `${humanWin.status} ${JSON.stringify(humanWin.json)}`);
  check('Y-4 …and it actually moved',
    (await db.query('SELECT stage FROM deals WHERE id=$1', [hd.rows[0].id])).rows[0].stage === 'won',
    'deal did not move');
  const robotWin = await api('PATCH', `/api/crm/deals/${hd.rows[0].id}`, { stage: 'lost', automated: true });
  // A SECOND HOLE, found by this test rather than reported in the ticket: the
  // PATCH mode gate sat inside an `if (funnel_type)` branch, and the legacy
  // `sales` pipeline has none — so a robot could set `won`/`lost` over HTTP with
  // nothing checking it. Closing the scheduler's path and leaving the HTTP path
  // open would have fixed the reproduction, not the defect.
  check('Y-4 …but the SAME call marked automated is 403, on a LEGACY pipeline too',
    robotWin.status === 403, `${robotWin.status} ${JSON.stringify(robotWin.json).slice(0, 120)}`);
  check('Y-4 …and the deal did not move',
    (await db.query('SELECT stage FROM deals WHERE id=$1', [hd.rows[0].id])).rows[0].stage === 'won',
    'a robot moved a legacy deal over HTTP');

  // ── Y-5 — the predicates are genuinely different questions ──────────────
  check('Y-5 mayAutomationSetStage is NOT the negation of isManualStage',
    mayAutomationSetStage(bare, 'b') === false && isManualStage(bare, 'b') === false,
    'a no-mode stage should be neither manual NOR automatable');
  check('Y-5 …isManualStage is unchanged, so the UI glyph does not move',
    isManualStage(salesCfg, 'contacted') === false && isManualStage(salesCfg, 'won') === true,
    'isManualStage changed meaning');
  check('Y-5 …an unknown stage is not automatable', mayAutomationSetStage(salesCfg, 'nope') === false, 'unknown stage allowed');

  // ── Y-6 — every seeded pipeline now declares a mode on every stage ──────
  const all = await db.query('SELECT key, stages FROM crm_pipeline_configs WHERE company_id IS NULL');
  const gaps = all.rows.flatMap(r => r.stages.filter(s => !s.mode).map(s => `${r.key}.${s.key}`));
  check('Y-6 no seeded stage is left without a declared mode', gaps.length === 0, gaps.join(', '));
  const sales = all.rows.find(r => r.key === 'sales').stages;
  check('Y-6 `won` and `lost` are MANUAL',
    ['won', 'lost'].every(k => sales.find(s => s.key === k).mode === 'manual'), 'won/lost not manual');
  check('Y-6 …and `responded` stays AUTO, or every inbound reply stops advancing',
    all.rows.find(r => r.key === 'marketing').stages.find(s => s.key === 'responded').mode === 'auto',
    'responded is no longer auto');

  // ═══ CP-Y2 — the BUILT-IN sales pipeline, where `won` actually lives ═════
  //
  // CP-Y hoisted the PATCH mode gate out of an `if (funnel_type)` condition and
  // into the `else` arm — the arm for deals with an EXPLICIT pipeline_key. But
  // `POST /deals` normalises the built-in sales pipeline to NULL, so built-in
  // deals take the `if` arm. The gate landed one branch short of the stages
  // that matter, and a robot could still mark a deal Won.
  //
  // Every check below runs on a deal with pipeline_key = NULL, which is what
  // the earlier round never exercised.
  const mkBuiltin = async (stage = 'onboarding') => {
    n += 1;
    const c = await contactDb.create({ name: `CPY2 P${n}`, email: `cpy2-${n}-${RUN}@ex.test`, company_id: CO });
    const created = await api('POST', '/api/crm/deals',
      { title: `CPY2 deal ${n}`, contact_id: c.id, value: 90000, stage });
    return created.json;
  };

  const b1 = await mkBuiltin('onboarding');
  check('Y-7 a built-in deal really is stored with pipeline_key = NULL — the branch this missed',
    (await db.query('SELECT pipeline_key FROM deals WHERE id=$1', [b1.id])).rows[0].pipeline_key === null,
    JSON.stringify((await db.query('SELECT pipeline_key FROM deals WHERE id=$1', [b1.id])).rows[0]));

  // B1
  const b1Robot = await api('PATCH', `/api/crm/deals/${b1.id}`, { stage: 'won', automated: true });
  check('Y-7 B1 — an automated PATCH to `won` on a BUILT-IN deal is 403', b1Robot.status === 403,
    `${b1Robot.status} ${JSON.stringify(b1Robot.json).slice(0, 120)}`);
  check('Y-7 B1 …and the deal did not move',
    (await db.query('SELECT stage FROM deals WHERE id=$1', [b1.id])).rows[0].stage === 'onboarding',
    'a robot moved a built-in deal to won');
  check('Y-7 B1 …refused as manual_stage, because 026 declares built-in `won` manual',
    b1Robot.json && b1Robot.json.error_code === 'manual_stage', JSON.stringify(b1Robot.json?.error_code));

  // B2 — creation, the second write point
  const c2 = await contactDb.create({ name: 'CPY2 Create', email: `cpy2-create-${RUN}@ex.test`, company_id: CO });
  const b2 = await api('POST', '/api/crm/deals',
    { title: 'CPY2 minted at won', contact_id: c2.id, value: 90000, stage: 'won', automated: true });
  check('Y-8 B2 — an automated CREATE directly at `won` is 403, not 201', b2.status === 403,
    `${b2.status} ${JSON.stringify(b2.json).slice(0, 120)}`);
  const minted = await db.query(`SELECT COUNT(*)::int AS n FROM deals WHERE contact_id=$1`, [c2.id]);
  check('Y-8 …and no deal was minted at all', minted.rows[0].n === 0, JSON.stringify(minted.rows[0]));
  const b2Human = await api('POST', '/api/crm/deals',
    { title: 'CPY2 human at won', contact_id: c2.id, value: 90000, stage: 'won' });
  check('Y-8 …while a HUMAN may still create one there', b2Human.status === 201,
    `${b2Human.status} ${JSON.stringify(b2Human.json).slice(0, 120)}`);

  // B3 — the positive control, and the orchestrator's point that their earlier
  // one proved nothing because the path was ungated. Now it is gated, so this
  // asserts something for the first time.
  const b3 = await mkBuiltin('contacted');
  const b3Robot = await api('PATCH', `/api/crm/deals/${b3.id}`, { stage: 'booked', automated: true });
  check('Y-9 B3 POSITIVE CONTROL — an automated PATCH to a declared-`auto` stage still 200s',
    b3Robot.status === 200, `${b3Robot.status} ${JSON.stringify(b3Robot.json).slice(0, 140)}`);
  check('Y-9 B3 …and the deal actually moved',
    (await db.query('SELECT stage FROM deals WHERE id=$1', [b3.id])).rows[0].stage === 'booked',
    'the deal did not move — the gate is now blocking legitimate automation');
  const b3Create = await api('POST', '/api/crm/deals',
    { title: 'CPY2 auto create', contact_id: c2.id, value: 1000, stage: 'contacted', automated: true });
  check('Y-9 B3 …and an automated CREATE at a declared-`auto` stage still 201s',
    b3Create.status === 201, `${b3Create.status} ${JSON.stringify(b3Create.json).slice(0, 120)}`);

  // B4
  const b4 = await mkBuiltin('onboarding');
  const b4Human = await api('PATCH', `/api/crm/deals/${b4.id}`, { stage: 'won' });
  check('Y-10 B4 — a HUMAN PATCH to `won` still 200s', b4Human.status === 200,
    `${b4Human.status} ${JSON.stringify(b4Human.json).slice(0, 120)}`);
  check('Y-10 B4 …and the deal moved',
    (await db.query('SELECT stage FROM deals WHERE id=$1', [b4.id])).rows[0].stage === 'won', 'deal did not move');

  // The gate must not have eaten the TRANSITION checks, which live in both arms
  // and were deliberately left alone.
  const b5 = await mkBuiltin('contacted');
  const illegal = await api('PATCH', `/api/crm/deals/${b5.id}`, { stage: 'won' });
  check('Y-10 the transition check still runs on the built-in arm (contacted → won is 409)',
    illegal.status === 409, `${illegal.status} ${JSON.stringify(illegal.json).slice(0, 120)}`);

  // ═══ CP-Y3 — the flag itself was fail-open ═══════════════════════════════
  // All three gate sites read `req.body.automated === true`. The STRING "true"
  // — what a form-encoded or loosely-typed client sends — is not `true`, so the
  // caller was treated as a HUMAN and the gate never fired. An unexpected value
  // OPENED the gate: the original defect's shape, one layer up.
  //
  // The asymmetry is deliberate. ABSENT means human, because the UI sends no
  // such field and breaking that breaks the product for every real user.
  // PRESENT-but-unrecognisable means AUTOMATED, because a caller that bothered
  // to send the field is a program.
  const unit = [
    [undefined, false, 'absent ⇒ human (the UI sends nothing)'],
    [{}, false, 'no field ⇒ human'],
    [{ automated: true }, true, 'boolean true'],
    [{ automated: 'true' }, true, 'STRING "true" — the reported hole'],
    [{ automated: 'TRUE' }, true, 'case-insensitive'],
    [{ automated: ' True ' }, true, 'whitespace-tolerant'],
    [{ automated: 1 }, true, 'numeric 1'],
    [{ automated: '1' }, true, 'string "1"'],
    [{ automated: 'engine' }, true, 'unrecognisable ⇒ AUTOMATED, not human'],
    [{ automated: false }, false, 'boolean false'],
    [{ automated: 'false' }, false, 'string "false"'],
    [{ automated: '0' }, false, 'string "0"'],
    [{ automated: '' }, false, 'empty string'],
  ];
  const wrong = unit.filter(([body, want]) => isAutomatedRequest(body) !== want);
  check(`Y-11 the coercion helper is right on all ${unit.length} cases`, wrong.length === 0,
    wrong.map(([b, w, why]) => `${why}: wanted ${w}`).join('; '));

  // C1 — over real HTTP, on the built-in pipeline, at the stage that matters.
  for (const truthy of ['true', 'TRUE', 1, '1']) {
    const d = await mkBuiltin('onboarding');
    const r = await api('PATCH', `/api/crm/deals/${d.id}`, { stage: 'won', automated: truthy });
    check(`Y-12 C1 — automated=${JSON.stringify(truthy)} is refused (403) on a manual stage`,
      r.status === 403, `${r.status} ${JSON.stringify(r.json).slice(0, 90)}`);
    check(`Y-12 C1 …and the deal did not move (${JSON.stringify(truthy)})`,
      (await db.query('SELECT stage FROM deals WHERE id=$1', [d.id])).rows[0].stage === 'onboarding',
      'a string-flagged robot moved the deal');
  }
  const cr = await api('POST', '/api/crm/deals',
    { title: 'CPY3 string flag', contact_id: c2.id, value: 1, stage: 'won', automated: 'true' });
  check('Y-12 C1 …and CREATE honours the string flag too', cr.status === 403,
    `${cr.status} ${JSON.stringify(cr.json).slice(0, 90)}`);

  // C2 — an explicit "no" is still a human.
  for (const falsy of [false, 'false', '0', '']) {
    const d = await mkBuiltin('onboarding');
    const r = await api('PATCH', `/api/crm/deals/${d.id}`, { stage: 'won', automated: falsy });
    check(`Y-13 C2 — automated=${JSON.stringify(falsy)} behaves as a HUMAN (200)`,
      r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 90)}`);
  }

  // C3 — THE POSITIVE CONTROL THAT PROTECTS THE PRODUCT.
  const c3 = await mkBuiltin('onboarding');
  const c3r = await api('PATCH', `/api/crm/deals/${c3.id}`, { stage: 'won' });
  check('Y-14 C3 POSITIVE CONTROL — NO automated field at all is still a human (200)',
    c3r.status === 200, `${c3r.status} ${JSON.stringify(c3r.json).slice(0, 90)}`);
  check('Y-14 C3 …and the deal moved — the UI sends no such field, and this is what real users do',
    (await db.query('SELECT stage FROM deals WHERE id=$1', [c3.id])).rows[0].stage === 'won',
    'the UI path broke');

  // C4 — a string-flagged robot may still write a declared-`auto` stage.
  const c4 = await mkBuiltin('contacted');
  const c4r = await api('PATCH', `/api/crm/deals/${c4.id}`, { stage: 'booked', automated: 'true' });
  check('Y-15 C4 — a string-flagged robot may still write a declared-`auto` stage (200)',
    c4r.status === 200, `${c4r.status} ${JSON.stringify(c4r.json).slice(0, 90)}`);
  check('Y-15 C4 …and it moved', (await db.query('SELECT stage FROM deals WHERE id=$1', [c4.id])).rows[0].stage === 'booked',
    'legitimate automation was blocked');

  // The CONTACT /advance path reads the same helper. `webinar_marketing`'s
  // first stage `prospects` is MANUAL, and the mode gate runs before transition
  // legality — so a string-flagged robot must be refused there too.
  // (`webinar_sales` is a DEAL-entity pipeline and would 404 for lack of an
  // active deal, which would have tested the wrong thing entirely.)
  const c5c = await contactDb.create({ name: 'CPY3 Contact', email: `cpy3-${RUN}@ex.test`, company_id: CO });
  const c5r = await api('POST', `/api/crm/contacts/${c5c.id}/advance`,
    { pipeline_key: 'webinar_marketing', stage: 'prospects', automated: 'true' });
  check('Y-15 the CONTACT /advance path honours the string flag as well (403)',
    c5r.status === 403, `${c5r.status} ${JSON.stringify(c5r.json).slice(0, 120)}`);
  const c5h = await api('POST', `/api/crm/contacts/${c5c.id}/advance`,
    { pipeline_key: 'webinar_marketing', stage: 'prospects' });
  check('Y-15 …while the same call with no flag is a human and succeeds',
    c5h.status === 200, `${c5h.status} ${JSON.stringify(c5h.json).slice(0, 120)}`);

  // ═══ CP-Z — a channel accepted at the front door with nothing behind it ═══
  //
  // `ai_call` is in five channel whitelists and no executor exists for it, so a
  // step could be created, a job queued, and the claim door would hand it to a
  // worker that does not exist. It came back `claimed` and stayed there.

  // Z4 — the sendable set is DERIVED, not a second hand-maintained list.
  check('Z-1 the sendable set is exactly the executor registry\'s own keys',
    JSON.stringify(executors.CHANNELS) === JSON.stringify(Object.keys(executors.byChannel)),
    JSON.stringify(executors.CHANNELS));
  check('Z-1 …so a channel with no provider adapter cannot be sendable',
    executors.canSend('ai_call') === false && executors.canSend('carrier_pigeon') === false,
    'an executor-less channel reported sendable');

  // Z3 — POSITIVE CONTROL: the four real channels are untouched.
  check('Z-2 POSITIVE CONTROL — email, sms, whatsapp and linkedin are all still sendable',
    ['email', 'sms', 'whatsapp', 'linkedin'].every(ch => executors.canSend(ch)),
    JSON.stringify(executors.CHANNELS));

  // Z2 — the front door.
  const zSeq = await api('POST', '/api/crm/sequences', { name: `cpz ${RUN}`, pipeline_key: 'webinar_sales' });
  const zSeqId = zSeq.json.id || zSeq.json.sequence?.id;
  const zStep = await api('POST', `/api/crm/sequences/${zSeqId}/steps`,
    { step_order: 1, channel: 'ai_call', body: 'Hi {first_name}' });
  check('Z-3 creating a step on an executor-less channel is refused at the FRONT DOOR (422)',
    zStep.status === 422, `${zStep.status} ${JSON.stringify(zStep.json).slice(0, 120)}`);
  check('Z-3 …naming the channel and what IS sendable, so the message is actionable',
    zStep.json && zStep.json.channel === 'ai_call' && Array.isArray(zStep.json.sendable_channels)
      && zStep.json.sendable_channels.includes('email'), JSON.stringify(zStep.json));
  const zTpl = await api('POST', '/api/crm/templates',
    { ref: `cpz_${RUN}`, channel: 'ai_call', body: 'Hi {first_name}' });
  check('Z-3 …and copy PINNED to such a channel is refused too', zTpl.status === 422,
    `${zTpl.status} ${JSON.stringify(zTpl.json).slice(0, 100)}`);
  const zOk = await api('POST', `/api/crm/sequences/${zSeqId}/steps`,
    { step_order: 1, channel: 'email', subject: 'S', body: 'Hi {first_name}' });
  check('Z-3 POSITIVE CONTROL — a step on a REAL channel is still created',
    zOk.status === 201 || zOk.status === 200, `${zOk.status} ${JSON.stringify(zOk.json).slice(0, 100)}`);

  // Z1 — the claim door, driven with a job that got in before the front door
  // existed (which is the real population: rows already in the queue).
  const zC = await contactDb.create({ name: 'CPZ Legacy', email: `cpz-${RUN}@ex.test`, company_id: CO });
  const zS2 = await seqDb.createSequence({ companyId: CO, name: `cpz legacy ${RUN}`, pipelineKey: 'webinar_sales' });
  const zSt = await seqDb.addStep(zS2.id, CO, { stepOrder: 1, channel: 'email', subject: 'S', body: 'Hi {first_name}' });
  await db.query(`UPDATE sequence_steps SET channel='ai_call' WHERE id=$1`, [zSt.id]);
  const zE = await seqDb.enroll(CO, { sequenceId: zS2.id, contactId: zC.id });
  const zJob = (await db.query('SELECT * FROM scheduled_actions WHERE enrollment_id=$1', [zE.id])).rows[0];
  await db.query(`UPDATE scheduled_actions SET channel='ai_call', scheduled_for=now()-interval '1 minute' WHERE id=$1`, [zJob.id]);
  const zClaimed = await dispatchDb.claimJobs(CO, 'ai_call', 10, 'cpz-probe');
  check('Z-4 the claim door hands out NOTHING for an executor-less channel', zClaimed.length === 0,
    `claimed ${zClaimed.length}`);
  const zAfter = (await db.query('SELECT status, attempt FROM scheduled_actions WHERE id=$1', [zJob.id])).rows[0];
  check('Z-4 …and the job is LEFT PENDING, not stranded at `claimed`', zAfter.status === 'pending',
    `status=${zAfter.status}`);
  check('Z-4 …consuming no retry, so wiring a provider later drains the queue by itself',
    zAfter.attempt === zJob.attempt, `${zAfter.attempt} vs ${zJob.attempt}`);

  // Z3 again, but through the CLAIM DOOR rather than the registry — a fix that
  // narrowed the sendable set too far would pass everything above and break the
  // product.
  const zLive = await contactDb.create({ name: 'CPZ Live', email: `cpz-live-${RUN}@ex.test`, company_id: CO });
  const zS3 = await seqDb.createSequence({ companyId: CO, name: `cpz live ${RUN}`, pipelineKey: 'webinar_sales' });
  await seqDb.addStep(zS3.id, CO, { stepOrder: 1, channel: 'email', subject: 'S', body: 'Hi {first_name}' });
  const zE3 = await seqDb.enroll(CO, { sequenceId: zS3.id, contactId: zLive.id });
  await db.query(`UPDATE scheduled_actions SET scheduled_for=now()-interval '1 minute' WHERE enrollment_id=$1`, [zE3.id]);
  const zEmail = await dispatchDb.claimJobs(CO, 'email', 10, 'cpz-live');
  check('Z-5 POSITIVE CONTROL — an email job STILL claims normally through the same door',
    zEmail.length >= 1, `claimed ${zEmail.length}`);

  console.log(results.join('\n'));
  console.log(`\nCP-Y automation gate: ${pass} passed / ${fail} failed`);
  await db.closeDatabase?.();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
