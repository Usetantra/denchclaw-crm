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
import { manualStageRefusal } from '../server/lib/stage-authority.js';

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

  console.log(results.join('\n'));
  console.log(`\nCP-Y automation gate: ${pass} passed / ${fail} failed`);
  await db.closeDatabase?.();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
