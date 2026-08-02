# RECEIPT CP-I-unified-inbox (cycle 3)

**Status: DONE.** Commit **`b97b7c5`** on `feat/consolidation`, on top of the CP-M merge `a2045a7`.
9 files, +2130/−6. Not pushed, not deployed. `git show --stat` confirms only ticket files landed —
nothing from `scratchpad/`, and `CONSOLIDATION_ROADMAP.md` still carries the operator's edit, unstaged.

## Files changed

| File | Why |
|---|---|
| `migrations/020_inbox_state.sql` **(NEW)** | `conversations.last_read_at` + `starred`, plus two indexes the unread scan and the contact-grouped list actually need. |
| `server/db/models/inbox.js` **(NEW)** | Contact-grouped list, the thread UNION, read/star state, open-deal resolution. |
| `server/routes/inbox.js` **(NEW)** | The eight endpoints, mounted at `/api/crm/inbox`. |
| `server/lib/ai-draft.js` **(NEW)** | Draft generation. Returns text and nothing else. |
| `server/routes/crm.js` | **One additive line**: exposes `CHANNEL_SENDERS` so the inbox resolves the same connected "From" instead of re-deriving it. |
| `server/server.js` | Mounts the new router (2 lines). |
| `web/index.html` | Additive three-pane Inbox + stage/tag chips. Main's per-channel table preserved under a `<details>`. |
| `test/unit-cpi-inbox.mjs` **(NEW)** + `test/run-local.sh` | 137 checks; registered in both runners. |

### Deviation, stated up front
The ticket lists `server/routes/conversations.js` for the new endpoints. **I put them in a new
`server/routes/inbox.js` instead.** CP-M had just hand-resolved `conversations.js` — main's composer
and the branch's CP1 mode gate + B2 enrollment hook all sit in one success path there — and adding a
second feature into it would park the next reconciliation on the most delicate merge surface in the
repo. Nothing in `conversations.js` changed; the new router reuses the same libraries so the two
cannot drift. Your own addendum asked me to keep that file a clean foundation, which is the same
reasoning.

## Migration
**020**, applied only to scratch. **Applies twice and three times cleanly** (proven in-suite and via
the standalone runner). `last_read_at` nullable, `starred NOT NULL DEFAULT false`, pre-existing rows
untouched — proven against a conversation created *before* a re-apply, not just by reading the DDL.

## Tests
**608 passed / 0 failed** on a fresh DB — **471 pre-CP-I, every one unmodified** + **137 new**.
```bash
node scratchpad/reset-db.mjs && DATABASE_URL_TEST=postgres://denchclaw@127.0.0.1:54339/denchclaw_test node scratchpad/apply-sql.mjs && bash scratchpad/run-suite.sh
```
contract 68 · tenancy 15 · tenants 12 · sequences 38 · b2 16 · limits 34 · b3 30 · api-keys 16 ·
a3 16 · cp1 83 · cp2 143 · **cpi 137**.

**Test isolation fixed along the way (CP-M follow-up F11).** `AUTOMATION_ENV_FILE=/nonexistent` does
*not* isolate the runner — it still finds `~/automation-engines-shared/.env.shared`, so
`RESEND_API_KEY` was live during tests and `isConfigured()` was true. The runners now set
`RESEND_API_KEY=""` and `CLOUDFLARE_AI_TOKEN=""` explicitly, so the suite cannot make a real Resend
or model call. Without this, CP-I's reply tests would have attempted real outbound email.

---

## Eval criteria

| # | Verdict | The check that proves it |
|---|---|---|
| **I1** | PASS | 020 applied 2× in-suite and 3× standalone; column types/nullability asserted; a pre-existing conversation re-migrated and still `NULL`/`false`. |
| **I2** | PASS | Two-channel contact appears **exactly once**; thread is `e1,l1,e2,l2` across email+linkedin with per-message channel. |
| **I3** | PASS | Unread on inbound → cleared on open → **both** conversations stamped → survives reload. |
| **I4** | PASS | inbound ⇒ `mine`, outbound ⇒ `theirs`, and replying **flips it live**. |
| **I5** | PASS | Server default filter is `mine`; the UI lands on "Your turn" (verified in-browser). |
| **I6** | PASS | `Unread ∧ LinkedIn ∧ "Acme"` composes, and **both** the channel and the query term are shown to actually narrow. |
| **I7** | PASS | Reply writes one `messages` row **and** a `message_sent` activity row and appears in the thread. |
| **I8** | PASS | whatsapp/sms/linkedin all report `delivered=false` + "Logged — not delivered"; the thread row carries the state. |
| **I9** | PASS | Note: 201, `sent=false`, **zero** `messages` rows, one `contact_activity` `type='note'`. |
| **I10** | PASS | One open deal ⇒ context; two ⇒ both returned with **no** auto-selection; a note with none chosen logs against the contact only. |
| **I11** | PASS | `/draft` creates **zero** messages, `sent=false`; sending needs a separate call; result has `ai_generated=true`. |
| **I12** | PASS | A **REAL** `ackJob(sent)` driven through the ack route — asserted to write **no** `messages` row — nevertheless renders with `source='sequence'`. Three distinct states proven: Sequence / AI-assisted / neither. |
| **I12b** | PASS | After replying the contact is **still read**. |
| **I12c** | PASS | Message inserted between fetch and stamp stays **unread** and is in the thread; a future `through` is clamped. |
| **I12d** | PASS | Closed conversation's messages appear, count toward unread, and **are stamped**. |
| **I12e** | PASS | `deal_id` closed / other contact / other tenant all rejected — on **reply as well as note**. |
| **I12f** | PASS | Hostile inbound ("ignore previous instructions…" + an `{"actions":…}` block) → text only, **no** stage change, **no** send; asserted the module exposes no action parser. |
| **I12g** | PASS | Zero-message contact: in `All`, absent from both turn filters, `turn=null`; tied timestamps order identically across calls. |
| **I12h** | PASS | Rail: identity, tags, score, activity, open deals with stage chip — all asserted populated. |
| **I12i** | PASS | Template resolves `{first_name}`; an **unknown** token is left verbatim rather than blanked. |
| **I13** | PASS | Global suppression refused on **all three** channels server-side; channel suppression blocks only that channel; thread reports both so the UI can disable Send with a reason. |
| **I14** | PASS | All **seven** endpoints cross-tenant ⇒ **404**; the list never shows another tenant's contacts. |
| **I15** | PASS | API round-trips hostile text intact; a static scan asserts no unescaped interpolation in the inbox UI block; verified in-browser that the payload renders as **text**. |
| **I16** | PASS | `unit-b2` 16/16 and `unit-cp1` 83/83 unmodified — the `isManualStage` gate and `enrollForTriggerStage` hook still fire. |
| **I17** | PASS | 608 on a fresh DB, all prior tests unmodified. |
| **I18** | **YOURS** | Browser evidence is the orchestrator's. My own smoke: lands on Your turn, unread clears on open, sequence badge renders, **zero console errors**. |
| **I19** | PASS | `label` **verbatim** (`"Scheduled Call"`, not lowercased); `mode` exposed; hue derives from `index`/`stage_count`, never a hardcoded key. |
| **I20** | PASS | Stage chips have **no** remove control; tags now render as chips, replacing the comma-joined string. |
| **I21** | PASS | Menu equals `getPipelineTransitions()` **asserted against the seeded config**, not a hardcoded list; an illegal target is absent; each target annotated with its mode. |
| **I22** | PASS | A **programmatic** advance into a manual stage is still **403** and the stage is unchanged; an illegal one is still 409. The chip is not a bypass. |
| **I23** | PASS | A **human** choosing a manual target succeeds and the chip becomes the manual stage. |

---

## Critic — Fable 5, two lenses (unread/thread correctness · injection/tenancy/XSS)

Both lenses ran after the suite. They were right about a lot. **Four HIGHs, all fixed, all with
regressions (`R-CPI`, 19 checks).**

1. **HIGH — the thread returned the OLDEST n.** `ORDER BY created_at ASC … LIMIT` meant that on any
   thread longer than the limit the operator never saw the newest inbound — the message they opened
   the thread to answer — and `read_through` froze below it, so the contact could never be marked
   read either. Deterministic, no race. **Fixed**: newest-n selected DESC in a subquery, re-sorted
   ASC for display. `R1` proves a `limit=3` thread returns `m3,m4,m5` and still clears unread.
2. **HIGH — `/read` fell open on a message-less contact.** The clamp was skipped when there were no
   messages, so any caller could stamp `last_read_at` years ahead during the real window where a
   conversation exists but its first message hasn't landed — and every later inbound was born read.
   **Fixed**: no messages ⇒ no stamp. `R2` proves the first inbound afterwards is unread.
3. **HIGH — the keyset cursor lost contacts.** Cursor was the timestamp alone with `IS NOT NULL`, so
   contacts tied at a page boundary were skipped and message-less contacts were unreachable from
   page 2. **Fixed**: composite `(timestamp|contact_id)` row-value cursor with NULL folded to
   `-infinity`. `R3` pages three tied contacts at `limit=2` and reaches all of them plus the
   message-less one.
4. **HIGH — a per-deal stage chip could advance a DIFFERENT deal.** `/advance` picks the newest
   non-terminal deal itself, and CP-I may not add a `deal_id` parameter without creating the new
   transition path D11 forbids. **Fixed**: the chip carries `advanceable`, and only the deal
   `/advance` would actually act on is interactive; the others render inert with the reason.
   `R5` proves both directions and that a single-deal contact is unaffected.

Also fixed: **the "AI-assisted" badge was unreachable** — the UI hardcoded `ai_generated:false` even
for Draft-with-AI sends, so every AI-assisted reply audited as purely human. Now tracked from draft
provenance and cleared the moment the human edits. **The read watermark lost microseconds** —
JSON/JS `Date` are millisecond-precision, Postgres stores microseconds, so the stamp landed just
*behind* the message it covered; the thread now hands out `read_through_exact`. **`message_sent`
excluded by name** from the union (it also ends in `_sent`; it was previously excluded only by an
accident of how `addActivity` nests its payload — one refactor from rendering every reply twice).
Plus: malformed cursor ⇒ 400 not 500; `ownedContact` no longer launders a DB outage into 404;
colour-map lookups guarded against prototype-chain keys.

### Raised and NOT fixed — with reasons
- **A backdated inbound is born read.** Inherent to any timestamp watermark: a message whose
  `created_at` precedes an existing stamp never shows as unread. Real for imports and for a slow
  webhook transaction (`created_at` is transaction start). Fixing it properly needs a monotonic
  sequence rather than a timestamp — a schema change well beyond CP-I. **Follow-up F15.**
- **An executor may override `activity.type`.** The channel-executor contract offers a free-form
  `activity.type`; anything not ending in `_sent` would miss the union and that send would not
  appear. The dispatcher's default is `<channel>_sent` and no executor in-repo overrides it.
  **Follow-up F16 — CP4a should pin this.**
- **Foreign `deal_id` returns 400, not 404.** All four rejection cases (closed / other contact /
  other tenant / nonexistent) return an identical message, so there is no existence oracle. The
  house 404 rule is about *resource* addressing; this is body validation. Documented, not changed.
- **Both critics confirmed what the design claims**: no SQL injection (every interpolation is
  parameterised; the one literal fragment is a constant), no XSS in the inbox block (every
  attacker-controllable value goes through `esc()`, every dynamic attribute is double-quoted), AI
  draft output reaches no parser/executor/sender, tenancy holds on all endpoints, and closed
  conversations are correctly included everywhere.

---

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

### Seed
`scratchpad/seed-CP-I-inbox.mjs` (untracked). I ran it; it works, including a **real** CP2 ack.
```bash
CRM_API_BASE=http://127.0.0.1:3102 INTERNAL_API_KEY=<key> DATABASE_URL=<your scratch db> CPI_TAG=orch node scratchpad/seed-CP-I-inbox.mjs
```
Creates, under `tantra` (override with `CPI_TENANT`) and printing every id:
1. **Ava Twochannel** — email **and** LinkedIn, last inbound → one row, "Your turn".
2. **Ben Twodeals** — two open deals → selector, defaulted to none.
3. **Cara Suppressed** — global suppression → Send disabled.
4. **Dev Chanblock** — email-only suppression → other channels still allowed.
5. **Eli Outbound** — last outbound → "Their turn".
6. **Fay Sequence** — a **real** claim+ack, so the thread shows a genuine "Sequence" badge.
7. **Gus Zeromsg** — conversation, no messages → `All` only, no turn.
8. **XSS probe** — markup in the name, tags and body.

### UI path
**Inbox tab** → three panes: `filters+list ‖ thread ‖ contact record`. Lands on **Your turn**.
Left: All/Unread/Your turn/Their turn/Starred, channel select, search. Rows carry channel badges, a
stage chip and an unread dot. Middle: interleaved thread, per-message channel badge, **Sequence** /
**AI-assisted** badges, amber dashed bubble + "Logged — not delivered" where applicable, composer
`Reply | Note | Templates` with a channel picker and **Draft with AI**. Right: identity, score,
suppression banner, **stage chip**, **tag chips**, activity.
Main's per-channel table is preserved under **"Conversations by channel"** at the bottom.

### API probes
| Probe | Expect |
|---|---|
| `GET /api/crm/inbox` | `filter:"mine"` (the default) |
| `GET /api/crm/inbox?filter=all` | Ava **once**, with `channels:["email","linkedin"]` |
| `GET /api/crm/inbox/<ava>/thread` | interleaved thread; `read_through_exact` present |
| `POST /api/crm/inbox/<ava>/read {through:<read_through_exact>}` | clears unread |
| `GET /api/crm/inbox/<fay>/thread` | one row, `source:"sequence"`, `automated:true` |
| `POST /api/crm/inbox/<ava>/reply {channel:"whatsapp",body:"x"}` | 201, `delivered:false` + note |
| `POST /api/crm/inbox/<cara>/reply {channel:"email",body:"x"}` | **403** |
| `POST /api/crm/inbox/<dev>/reply {channel:"email"…}` / `{channel:"linkedin"…}` | **403** / **201** |
| `POST /api/crm/inbox/<ben>/note {body:"x"}` | 201, `sent:false`, `deal_id:null` |
| `POST /api/crm/inbox/<ava>/draft {channel:"email"}` | text, `messages_created:0` |
| `GET /api/crm/inbox/<ava>/thread` as another tenant | **404** |

### What "working" looks like (the automation, not the render)
An operator opens one tab and can see **everything** said to a person — including the messages the
CRM sent autonomously, which exist nowhere in `messages` — knows whose turn it is, and cannot
accidentally mail someone who has withdrawn consent or imply a send that never happened.

### Gotchas that will otherwise read as bugs
- **G-1 — post `read_through_exact`, not `read_through`.** The rounded value lands a few
  microseconds behind the newest message and unread will not clear. The UI does this correctly.
- **G-2 — a sequence send does NOT flip the turn.** By design: an autonomous send doesn't discharge
  a human's obligation. So an unanswered contact stays under "Your turn" even after the ladder fires,
  while the snippet shows the send. Deliberate, and `R4` locks it in.
- **G-3 — `/read` now requires `through`.** Calling it bare is a 400, not "mark all read".
- **G-4 — the older of two same-pipeline deals has an INERT chip** with a tooltip. That is the
  wrong-deal fix, not a broken chip.
- **G-5 — email shows "Logged — not delivered"** unless `RESEND_API_KEY` **and** a connected sender
  are both present. Set both to see a real delivery.

### NOT visible in the UI — inspect these instead
1. **`ai_generated` provenance** — the "AI-assisted" badge only appears if the body came from Draft
   with AI and was not subsequently edited. Check `messages.ai_generated`.
2. **The read watermark** — `conversations.last_read_at` per conversation; the UI shows only the
   resulting bold/not-bold.
3. **Cursor pagination** — the UI does not paginate yet; probe `next_cursor` directly.
4. **Which deal a note landed on** — `contact_activity.data.deal_id`.
5. **`I12f` prompt-injection inertness** — nothing visible; assert no stage change and no new
   `messages` row after `POST /draft` on the hostile contact.

---

## Gate hit
**None.** No deploy, no push to main, no live DDL, no nginx, no secrets. `:3101` released;
`:3102`/`:8899` never touched. Everything measured on my own `denchclaw_build_cpi` —
**`denchclaw_test` is yours and I did not touch it this cycle.** Next unused migration is **021**.

## Follow-ups
- **F15** a backdated/late-committing inbound can be born read — needs a monotonic sequence, not a timestamp.
- **F16** pin `activity.type` in the executor contract so a send can't fall out of the thread union.
- **F17** no template-body store exists (`sequence_steps` carries only `template_ref`), so Templates
  resolves tokens over the ref itself.
- **F18** the inbox list issues one `listOpenDeals` per row; fine at current volumes, wants batching.
- **F19** CP-M's `trust proxy` / `X-Forwarded-For` allowlist bypass is still open and still an
  operator decision.
