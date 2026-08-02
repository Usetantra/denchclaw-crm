# CP-UI — post-CP-Y UI regression check: **PASS**

CP-Y, CP-Y2 and CP-Y3 changed the gate the UI reads, and **migration 026 gave the legacy
pipelines per-stage `mode` for the first time.** The stage chips and the advance menu are built
from that same config. I last drove this UI *before* any of it landed, so nobody had looked at
what changed on screen.

## 15 passed / 0 failed

| # | Check | Result |
|---|---|---|
| U1 | the app still loads with every tab after three gate changes | PASS |
| U2 | all 8 tabs still render (×8) | PASS |
| U3 | the legacy-`sales` deal is on the board | PASS |
| U4 | the inbox still lists conversations | PASS |
| U5 | **the MANUAL stage still renders its person glyph — CP-T's marker survived 026** | PASS |
| U6 | the right rail still shows the CRM record | PASS |
| U7 | **the stage chip menu still offers LEGAL targets — not silently empty after 026** | PASS |
| U8 | no page-level 4xx/5xx and no pageerrors across every tab | PASS |

**U7 was the real risk.** The menu is built from `getPipelineTransitions()`, and a bad config
shape after 026 would have produced an *empty* menu — which renders as "nothing is allowed"
rather than as an error, so it would have shipped silently. It offers exactly three targets and
they are the legal ones: `no_show_followup_2`, `scheduled_call`, `disqualified`. Illegal targets
are **absent**, not disabled, which is the CP-T decision holding.

Screenshot `.loop/EVIDENCE/POST-CPY/POSTCPY-chip-menu.png` shows it: `◆ No-Show Follow-up 1 👤`
in both the list row and the STAGE rail, the open menu with its three legal targets, the activity
trail reading back the real stage history, and the composer with its deal-context chip.

## Four probe defects of mine, one of which printed a falsehood

1. **A stale shim from an earlier session already owned :8899**, so my shim died on `EADDRINUSE`
   and every request hit the old one with an old key — 23 console 401s and six failures that were
   entirely my harness. The other holder was `orch-resend-stub.mjs`; I moved to :8903 rather than
   kill processes I hadn't positively identified as mine.
2. This shim serves `web/` at **root**, not `/crm/` — a different shim than the one that owned 8899.
3. I clicked the first `.chip-stage`, which is the **inert** list-row chip (index.html:985 renders
   it `inert:true` with no `data-stagechip`), and read its empty menu as a regression. The
   interactive chip is the rail's.
4. **U3's detail string was hardcoded** — it printed "Rowan Ellis present" *while failing*. A
   status line that contradicts its own verdict is worse than no detail; now computed.

## The one console line that remains, and why it is not an app error

A reproducible `Failed to load resource … 404` appears with **no corresponding page-level request
event** — `requestfinished`, `requestfailed` and `response` all see nothing. That combination is
the signature of the browser's *internal* favicon fetch, which Playwright does not surface as a
page request; and `/favicon.ico` does 404 here because `web/` ships no favicon (it holds
`index.html` and the workflow page only).

I asserted on **page-level** 4xx/5xx rather than muting the console, so a genuine app 404 would
still fail U8. Cosmetic, not dispatched: worth a favicon eventually, but it is not a defect.

**Verdict: no UI regression from the three gate changes.**
