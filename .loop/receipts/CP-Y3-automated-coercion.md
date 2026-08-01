# RECEIPT CP-Y3-automated-coercion (cycle 12)

**Status: DONE.** Commit ``ee9e4f1`` on `feat/consolidation`. 3 files, +122/−6. **No migration** — 027
still free. **Suite 1085 / 0** — `unit-cpy` now **55** (20 new).

## The fix

One helper, `isAutomatedRequest(body)`, in `server/lib/stage-authority.js` — which already owns the
invariant and `manualStageRefusal`. Used at **all three** sites (`crm.js` contact `/advance`, deal
create, deal PATCH). **No inline comparison survives** in the file; I checked by asserting that
`req.body.automated === true` appears nowhere after the edit rather than by reading the diff.

The asymmetry is the design, and it is worth restating because it looks lopsided until you name what
each direction breaks:

- **ABSENT ⇒ human.** The UI sends no such field. Treating absence as "robot" would 403 every real
  user's PATCH — that direction breaks the product for everyone, so it stays permissive.
- **PRESENT but unrecognisable ⇒ AUTOMATED.** A caller that bothered to send the field is a program.
  That direction breaks nothing and closes the hole.

Only an explicit, recognisable "no" — `false`, `"false"`, `"0"`, `""` — counts as not automated.

**This does not make the flag a security boundary,** and CP-Y3 does not change that. It is still
honour-system, still self-declared, and A7's identity work is what would change it. What it does is
make the flag mean what it says when a well-behaved caller sets it — which was the point of having
it, and was not true before.

## Acceptance

| | Result |
|---|---|
| **C1** `"true"` / `1` / `"TRUE"` all 403 on a manual stage | **PASS** (Y-12) — over real HTTP, on a NULL-`pipeline_key` deal, at `won`; deal unmoved in every case. Also asserted on **CREATE**, not only PATCH |
| **C2** `false` / `"false"` / `"0"` behave as human | **PASS** (Y-13), plus `""` |
| **C3** no `automated` field ⇒ still a human (200) | **PASS** (Y-14) — and the deal actually moves. This is the one that protects the product rather than the invariant |
| **C4** automated writes to an `auto` stage still succeed | **PASS** (Y-15) — a *string*-flagged robot still moves `contacted → booked` |
| **C5** suite green | **PASS**, 1085/0 |

**Y-11** covers the helper directly across 13 cases, including `" True "` (whitespace), `1`/`"1"`,
and `'engine'` — an unrecognisable value resolving to **automated**, which is the asymmetry stated as
an assertion rather than a comment.

**Y-15 also covers the CONTACT `/advance` path**, which none of your probes reached: `webinar_marketing`'s
first stage `prospects` is manual, so a string-flagged robot is refused there too, and the same call
with no flag succeeds. (My first attempt used `webinar_sales` and got a 404 for lack of an active
deal — it is a deal-entity pipeline, so that fixture would have tested nothing. Worth saying because
a 404 there looks like a pass if you only check "not 200".)

## On the sweep you did

Your S1/S2 — create at `won` via an explicit key, and re-key + manual stage in one automated PATCH —
are the two I would not have thought to write, and the second is the interesting one: it is the only
path where the gate has to be evaluated against the *destination* pipeline rather than the deal's
current one. It passes because CP-Y2 resolves the config from `deal.pipeline_key` **after** the rekey
block has already assigned it, which was luck rather than design. It is now load-bearing, so it is
worth one of us pinning it — you have the probe; say the word and I will bank it as a test.

## --- TEST BRIEF FOR THE ORCHESTRATOR ---

| Probe | Expect |
|---|---|
| `PATCH {stage:'won', automated:"true"}` on a built-in deal | **403**, unmoved — the reported hole |
| same with `1`, `"1"`, `"TRUE"`, `" True "` | **403** |
| same with `"engine"` or any unrecognised value | **403** — present-but-unknown resolves to automated |
| same with `false`, `"false"`, `"0"`, `""` | **200**, moves — an explicit "no" is a human |
| **`PATCH {stage:'won'}` with NO flag** | **200**, moves — the C3 control; this is what the UI does |
| `POST /deals {stage:'won', automated:"true"}` | **403** |
| `PATCH {stage:'booked', automated:"true"}` from `contacted` | **200** — a string-flagged robot may still write an `auto` stage |
| `POST /contacts/:id/advance {pipeline_key:'webinar_marketing', stage:'prospects', automated:"true"}` | **403**; without the flag, **200** |

## Gate hit
**None.** No push, no deploy, no live DDL, no secrets. `CONSOLIDATION_ROADMAP.md` unstaged,
`scratchpad/` not committed.

## Follow-ups
Unchanged: **F44** `DEFAULT_DEAL_STAGES` vs the seeded `sales` config disagree on
`lead`/`proposal_accepted` · **F42** a no-mode stage is neither manual nor automatable and shows no UI
glyph · **F43** `sequences.pipeline_key` is free text.

## Next
Unchanged: **F38, the anchored scheduler** — a port of `nurturing-engine/.../dispatcher.py:160-204`,
and still the last thing between the marketing funnel and being real. `registrants`,
`auto_registrants` and `attendees` trigger nothing until it lands.
