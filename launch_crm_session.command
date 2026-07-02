#!/bin/zsh
# Launches a Claude Code session in the DenchClaw CRM repo, seeded with the
# two-pipeline handoff. Opened via `open` so it runs in its own Terminal window.
cd /Users/adithyamurali/denchclaw-crm || exit 1
exec /Users/adithyamurali/.local/bin/claude "Read SESSION_HANDOFF_2026_07_01_DENCHCLAW_PIPELINES.md in this repo, then begin the DenchClaw two-pipeline (Marketing + Sales) CRM build described in it. Start by running /spec on Task T1 — the pipeline data-model fork (single pipeline_key+stage on contacts vs. a deals-row-per-sales-journey) — and confirm the approach with me before writing any migration."
