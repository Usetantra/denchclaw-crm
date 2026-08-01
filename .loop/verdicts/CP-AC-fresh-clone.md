# CP-AC — fresh-clone integrity: **PASS**

Every suite run this session happened inside my working tree, which carries 11 untracked files.
If any test depended on one of them, the backup on origin would be **illusory** — present but
unusable. This settles it by cloning the pushed branch and running it with nothing else.

## Result

    git clone --branch feat/consolidation <origin>  →  8dc5398, matches origin exactly
    npm install                                     →  INSTALL_EXIT=0
    DATABASE_URL_TEST=<local> npm test              →  TOTAL: 1102 passed / 0 failed
                                                       19/19 suites reported
                                                       SUITE GREEN · EXITCODE=0

**Nothing from my working tree was involved.** A fresh clone plus `npm install` is sufficient.

## The record travelled too

| | |
|---|---|
| verdicts | **18** |
| receipts | **16** |
| `DEPLOY_RUNBOOK.md` | present |
| `GOALS.md` (operator's verbatim spec) | present |
| `.loop/EVIDENCE` | **0 — gitignored on purpose**, every screenshot regenerable by re-running a probe |
| `scratchpad/` | **absent** — never committed, per the standing rule |

So someone cloning this branch gets the code, the tests, the operator's own spec, the deploy
runbook, and the reasoning behind all 18 verdicts — and does **not** get 3.5M of regenerable PNGs
or any of my scratch probes.

## This also validates the README I wrote last tick

The instructions were verified from a clean clone rather than from the tree where I'd already
learned every quirk — which is the only way that documentation claim is worth anything.

**Verdict: the backup is genuinely usable, not merely present.**
