#!/bin/bash
# DenchClaw CRM loop watchdog.
#
# Runs from launchd every 5 minutes, INDEPENDENT of any Claude Code window.
# If the loop has stalled, it relaunches a headless Claude on whichever phase
# .loop/STATE.json says is current.
#
# It CANNOT create quota. If the subscription is exhausted it detects the
# rate-limit, backs off exponentially, and resumes automatically once quota
# returns — surviving app restarts, session death and reboots.
#
# KILL SWITCH:  touch  .loop/watchdog/DISABLED
# UNINSTALL:    launchctl unload ~/Library/LaunchAgents/com.denchclaw.loop-watchdog.plist

set -uo pipefail

REPO="/Users/adithyamurali/denchclaw-crm"
WD="$REPO/.loop/watchdog"
LOG="$WD/watchdog.log"
BACKOFF_FILE="$WD/backoff.until"
STREAK_FILE="$WD/backoff.streak"
LOCK="$WD/lock"
STALL_MINUTES=12          # STATE.json untouched this long + nobody working = stalled
MAX_LOG_BYTES=2000000

# Resolve a REAL executable. `command -v claude` can resolve to a shell function
# name (the user's zsh wraps it), which is not executable — verified 2026-08-01.
resolve_claude() {
  local c
  c="$(command -v claude 2>/dev/null || true)"
  if [ -n "$c" ] && [ -x "$c" ]; then printf '%s' "$c"; return; fi
  # newest installed claude-code build wins
  local newest
  newest="$(ls -1d "$HOME/Library/Application Support/Claude/claude-code"/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1)"
  if [ -n "$newest" ] && [ -x "$newest" ]; then printf '%s' "$newest"; return; fi
  for p in /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.local/bin/claude"; do
    [ -x "$p" ] && { printf '%s' "$p"; return; }
  done
  printf ''
}
CLAUDE_BIN="$(resolve_claude)"

# macOS has no `timeout` (verified 2026-08-01 — GNU coreutils not installed).
# Portable replacement: run in background, kill after N seconds. Returns 124 on timeout.
run_with_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
    sleep 10; kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null ) & local killer=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill -TERM "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
  # 143 = SIGTERM from our killer
  [ "$rc" -eq 143 ] && rc=124
  return "$rc"
}

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# rotate
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_BYTES" ]; then
  mv "$LOG" "$LOG.1"; log "log rotated"
fi

# --- kill switch -------------------------------------------------------------
if [ -f "$WD/DISABLED" ]; then log "DISABLED file present — standing down"; exit 0; fi

# --- single instance ---------------------------------------------------------
if ! mkdir "$LOCK" 2>/dev/null; then
  # stale lock older than 60 min gets cleared
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || { log "lock contended — skip"; exit 0; }
    log "cleared stale lock"
  else
    log "another tick running — skip"; exit 0
  fi
fi
trap 'rm -rf "$LOCK"' EXIT

cd "$REPO" || { log "FATAL: repo missing"; exit 1; }

# --- hard safety gate: never operate off the feature branch -------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$BRANCH" != "feat/consolidation" ]; then
  log "GATE: branch is '$BRANCH', not feat/consolidation — refusing to act"; exit 0
fi

# --- quota backoff -----------------------------------------------------------
NOW=$(date +%s)
if [ -f "$BACKOFF_FILE" ]; then
  UNTIL=$(cat "$BACKOFF_FILE" 2>/dev/null || echo 0)
  if [ "$NOW" -lt "$UNTIL" ]; then
    log "quota backoff active — $(( (UNTIL-NOW)/60 ))m remaining"; exit 0
  fi
  rm -f "$BACKOFF_FILE"; log "backoff expired — probing"
fi

# --- is the loop actually stalled? -------------------------------------------
STATE="$REPO/.loop/STATE.json"
[ -f "$STATE" ] || { log "no STATE.json — nothing to drive"; exit 0; }

HANDOFF=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE','utf8')).handoff||'')}catch(e){console.log('')}" 2>/dev/null)
CP=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE','utf8')).cp||'')}catch(e){console.log('')}" 2>/dev/null)
PHASE=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE','utf8')).phase||'')}catch(e){console.log('')}" 2>/dev/null)

# ACTIVITY SIGNAL — this was wrong and it mattered.
# It used to look at .loop/STATE.json and LOG.md, which the ORCHESTRATOR rewrites every
# tick. So a stalled BUILDER was permanently invisible: my own bookkeeping made the loop
# look alive while nothing was being built. Verified 2026-08-01, builder idle 16 min while
# the watchdog logged "active" every 3 min.
#
# So the signal now depends on WHOSE turn it is:
#   handoff=build → only SOURCE changes or a new commit count. .loop writes prove nothing.
#   handoff=orch  → .loop writes are the orchestrator working, so they do count.
GITBUSY=$(find "$REPO/.git" -maxdepth 1 -newermt "-${STALL_MINUTES} minutes" \( -name 'index' -o -name 'COMMIT_EDITMSG' \) 2>/dev/null | head -1)
SRCBUSY=$(find "$REPO/server" "$REPO/test" "$REPO/migrations" "$REPO/web" -type f \
            \( -name '*.js' -o -name '*.mjs' -o -name '*.sql' -o -name '*.html' \) \
            -mmin -${STALL_MINUTES} 2>/dev/null | head -1)
LOOPBUSY=$(find "$REPO/.loop" -maxdepth 1 -type f \( -name 'STATE.json' -o -name 'LOG.md' \) -mmin -${STALL_MINUTES} 2>/dev/null | head -1)

if [ "$HANDOFF" = "build" ]; then
  ACTIVE="$GITBUSY$SRCBUSY"          # deliberately EXCLUDES .loop
else
  ACTIVE="$GITBUSY$SRCBUSY$LOOPBUSY"
fi

if [ -n "$ACTIVE" ]; then
  log "active ($CP/$PHASE handoff=$HANDOFF) — real source/git activity, no action"
  exit 0
fi

if [ "$HANDOFF" = "operator" ]; then
  log "STALLED at $CP/$PHASE but handoff=operator — a human decision is owed, not a relaunch"
  exit 0
fi

# --- build the continuation prompt -------------------------------------------
case "$HANDOFF" in
  build) ROLE="the BUILD session. Read .loop/STATE.json and .loop/tickets/\${TICKET}.md and continue the build/merge exactly where it stopped." ;;
  orch)  ROLE="the ORCHESTRATOR/TESTER session. Read .loop/STATE.json and the receipt, then verify INDEPENDENTLY (rebuild the scratch DB, re-run the suite, re-apply the migration, drive the browser with your own drivers) and write .loop/verdicts/<ticket>.md." ;;
  *)     log "unknown handoff '$HANDOFF' — no action"; exit 0 ;;
esac

PROMPT="AUTONOMOUS WATCHDOG RESUME. The DenchClaw CRM consolidation loop at $REPO has been idle for over ${STALL_MINUTES} minutes. You are $ROLE

Current state: cp=$CP phase=$PHASE handoff=$HANDOFF.

FIRST, verify state yourself — do not trust this prompt: cat .loop/STATE.json; ls -lT .loop/tickets .loop/receipts .loop/verdicts; git log --oneline -3; git status --short; ls .git/MERGE_HEAD 2>/dev/null.

Then continue the loop: advance the current phase, append one line to .loop/LOG.md, and update .loop/STATE.json (including handoff) before you stop.

HARD RULES — these are gates, stop and surface rather than violate: git fetch origin before any commit; feat/consolidation ONLY; never push to main; never deploy; never restart prod; never apply live DDL; never change nginx; never touch secrets/.env/*.pem; never commit anything from scratchpad/; leave CONSOLIDATION_ROADMAP.md's uncommitted operator edit unstaged. Docker is wedged machine-wide — use the embedded Postgres on :54339, never restart Docker. Builder owns :3101; orchestrator owns :3102 and :8899.

If you hit a quota/rate limit, WRITE .loop/STATE.json AND the receipt BEFORE stopping so the next tick can resume cleanly."

# --- run ---------------------------------------------------------------------
log "STALLED at $CP/$PHASE handoff=$HANDOFF — launching headless Claude"
OUT="$WD/last-run.txt"
: > "$OUT"

if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  log "FATAL: no executable claude binary found — cannot relaunch. Fix PATH or reinstall Claude Code."
  exit 1
fi

# --- preflight: is the headless CLI authenticated? ---------------------------
# Verified 2026-08-01: the desktop app injects credentials into ITS OWN sessions;
# `claude -p` does not inherit them and reports "Not logged in". Without a one-time
# `claude login` in a terminal, the watchdog can monitor but cannot relaunch.
# Detect it loudly rather than burn ticks failing silently.
AUTHPROBE="$WD/authprobe.txt"
probe() { "$CLAUDE_BIN" --bare -p "ok" --permission-mode bypassPermissions \
           --dangerously-skip-permissions > "$AUTHPROBE" 2>&1; }
run_with_timeout 90 probe || true
if grep -qiE 'not logged in|please run /login|unauthorized|authentication' "$AUTHPROBE" 2>/dev/null; then
  touch "$WD/NEEDS_LOGIN"
  log "BLOCKED: headless CLI is NOT AUTHENTICATED ('Not logged in'). The loop is stalled at $CP/$PHASE and I cannot relaunch it."
  log "        ONE-TIME FIX (human, in a terminal):  claude login"
  log "        Until then this watchdog monitors and logs but cannot drive the build."
  exit 0
fi
rm -f "$WD/NEEDS_LOGIN"

run_claude() { "$CLAUDE_BIN" --bare -p "$PROMPT" \
  --permission-mode bypassPermissions --dangerously-skip-permissions >> "$OUT" 2>&1; }
run_with_timeout 3600 run_claude
RC=$?

# --- quota / rate-limit detection --------------------------------------------
if grep -qiE 'rate.?limit|429|quota|usage limit|too many requests|exceeded your' "$OUT"; then
  STREAK=$(cat "$STREAK_FILE" 2>/dev/null || echo 0); STREAK=$((STREAK+1))
  [ "$STREAK" -gt 6 ] && STREAK=6
  echo "$STREAK" > "$STREAK_FILE"
  MINS=$(( 5 * (2 ** (STREAK-1)) ))       # 5,10,20,40,80,160 min
  [ "$MINS" -gt 160 ] && MINS=160
  echo $(( NOW + MINS*60 )) > "$BACKOFF_FILE"
  log "QUOTA/RATE LIMIT hit (rc=$RC) — backing off ${MINS}m (streak=$STREAK); will auto-resume"
  exit 0
fi

echo 0 > "$STREAK_FILE"
if [ "$RC" -eq 124 ]; then
  log "run TIMED OUT after 60m (rc=124) — will retry next tick"
elif [ "$RC" -ne 0 ]; then
  log "run exited rc=$RC — see $OUT; will retry next tick"
else
  NEWH=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE','utf8')).handoff||'')}catch(e){console.log('')}" 2>/dev/null)
  log "run OK — handoff now '$NEWH' (was '$HANDOFF')"
fi
exit 0
