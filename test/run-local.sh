#!/usr/bin/env bash
# DenchClaw CRM — local contract-test runner. This is what `npm test` runs.
#
# Boots a scratch Postgres (Docker postgres:16 unless DATABASE_URL_TEST is
# provided), applies migrate.sql + migrations/ in order, starts the server on a
# test port, and runs every suite in the table below.
#
# CP-AA: it no longer needs psql. Schema is applied by test/apply-schema.mjs
# using `pg`, which is already a dependency — so the suite runs on a machine with
# neither Docker nor psql, given only a local DATABASE_URL_TEST. Before this, the
# suites every verdict rests on were runnable only through an uncommitted mirror
# on one machine, which makes every green number a claim nobody else can check.
#
# NEVER points at staging: refuses any DATABASE_URL_TEST that doesn't look local.
set -uo pipefail
cd "$(dirname "$0")/.."

TEST_PORT="${TEST_PORT:-3101}"
PHASE="${PHASE:-CP5}"
KEY="ct-key-$$"
LIMITED="ct-limited-$$"
# CP-B: the public marketing webhooks fail CLOSED with no secret, so the test
# server needs one. Per-run, never a real deployment value.
MK_SECRET="ct-marketing-secret-$$"
# CP-M2's Twilio inbound webhook shares the inbound-email webhook's shared-secret
# guard (server/routes/webhooks.js) — set here so unit-cpm2-channel-compliance's
# STOP/START simulation (M2-14) isn't skipped.
IB_SECRET="ct-inbound-secret-$$"
# The public marketing webhooks derive the TENANT from the secret, so the suite's
# per-run tenant needs its own binding. RUN is pinned here (not left to the test's
# Date.now() default) precisely so the server, booted first, can know the tenant
# id the test will create.
MK_RUN="$$"
MK_SECRETS="{\"$MK_SECRET\":\"cpb_co_$MK_RUN\"}"
CONTAINER=""
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -n "${DATABASE_URL_TEST:-}" ]; then
  # UNCHANGED, deliberately. This is the only thing standing between a test run
  # and production DDL, so CP-AA did not touch it. `psql` is no longer required:
  # it is needed only INSIDE the container, which already ships it.
  case "$DATABASE_URL_TEST" in
    *localhost*|*127.0.0.1*) : ;;
    *) echo "FATAL: DATABASE_URL_TEST must be a local scratch DB (got a non-local host). Refusing."; exit 2 ;;
  esac
else
  command -v docker >/dev/null || { echo "FATAL: no DATABASE_URL_TEST and no docker — cannot create scratch DB"; exit 2; }
  CONTAINER="denchclaw-crm-test-$$"
  PG_PORT="${PG_PORT:-54339}"
  echo "[test] starting scratch postgres:16 container $CONTAINER on :$PG_PORT"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER=denchclaw -e POSTGRES_PASSWORD=test -e POSTGRES_DB=denchclaw_test \
    -p "127.0.0.1:${PG_PORT}:5432" postgres:16 >/dev/null
  for i in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U denchclaw -d denchclaw_test >/dev/null 2>&1; then break; fi
    [ "$i" = 60 ] && { echo "FATAL: scratch postgres did not become ready"; exit 2; }
    sleep 1
  done
  export DATABASE_URL_TEST="postgres://denchclaw:test@127.0.0.1:${PG_PORT}/denchclaw_test"
fi

echo "[test] applying schema: migrate.sql + migrations/*.sql (in order)"
# No psql. apply-schema.mjs re-checks the local-host rule itself, so the guard
# holds even when that file is run directly rather than through this script.
node test/apply-schema.mjs || { echo "FATAL: schema failed to apply"; exit 2; }

echo "[test] booting server on :$TEST_PORT"
DATABASE_URL="$DATABASE_URL_TEST" \
PORT="$TEST_PORT" \
INTERNAL_API_KEY="$KEY" \
INTERNAL_API_KEYS="{\"$KEY\":\"*\",\"$LIMITED\":[\"co_bound_only\"]}" \
AUTOMATION_ENV_FILE=/nonexistent \
MARKETING_WEBHOOK_SECRET="$MK_SECRET" \
MARKETING_WEBHOOK_SECRETS="$MK_SECRETS" \
MARKETING_PUBLIC_BASE="http://127.0.0.1:${TEST_PORT}" \
INBOUND_WEBHOOK_SECRET="$IB_SECRET" \
  RESEND_API_KEY="" CLOUDFLARE_AI_TOKEN="" \
node server/server.js &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${TEST_PORT}/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "FATAL: server did not become healthy"; exit 2; }
  sleep 1
done

# A healthy port is NOT proof the server is OURS. If another process already
# holds TEST_PORT, our `node server/server.js` fails to bind, /health answers
# from THEIR server, and every keyed request 401s against a key it has never
# heard of — which surfaces as dozens of phantom test failures with no hint of
# the real cause. (Observed for real: 88 "failures" that were one port clash.
# The tell was that the DB-only suites, which need no server, passed clean.)
#
# So prove the server accepts OUR key before running anything. A silent
# fall-through to the wrong server makes a green suite meaningless, and a red
# one a wild goose chase.
PROBE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "x-internal-key: $KEY" -H 'x-company-id: tantra' \
  "http://127.0.0.1:${TEST_PORT}/api/crm/contacts?limit=1" || echo 000)
if [ "$PROBE" != "200" ]; then
  echo "FATAL: :$TEST_PORT answered /health but rejected our key (HTTP $PROBE)."
  echo "       Another server is almost certainly holding that port — this run"
  echo "       would produce phantom failures against someone else's process."
  echo "       Free the port, or set TEST_PORT to one you own."
  exit 2
fi

# ─── The suite table ─────────────────────────────────────────────────────────
# ONE list. The "N/M suites reported" denominator is derived from it, so a suite
# cannot be added here and quietly left out of the tally — which is precisely how
# an entire 88-test suite once vanished from a runner while the total still
# looked healthy.
export CRM_API_BASE="http://127.0.0.1:${TEST_PORT}"
export INTERNAL_API_KEY="$KEY"
export LIMITED_API_KEY="$LIMITED"
export DATABASE_URL="$DATABASE_URL_TEST"
export PHASE

SUITES=(
  "contract (PHASE=$PHASE)|node test/contract.mjs"
  "unit-tenancy|node test/unit-tenancy.mjs"
  "unit-tenants|node test/unit-tenants.mjs"
  "unit-sequences|node test/unit-sequences.mjs"
  "unit-b2-enrollment|node test/unit-b2-enrollment.mjs"
  "unit-limits|node test/unit-limits.mjs"
  "unit-b3-dispatcher|node test/unit-b3-dispatcher.mjs"
  "unit-api-keys|node test/unit-api-keys.mjs"
  "unit-a3-api-key-auth|node test/unit-a3-api-key-auth.mjs"
  "unit-cp1-funnel-pipelines|node test/unit-cp1-funnel-pipelines.mjs"
  "unit-cp2-step-scheduler|node test/unit-cp2-step-scheduler.mjs"
  "unit-cpi-inbox|node test/unit-cpi-inbox.mjs"
  "unit-cp4a0-content|node test/unit-cp4a0-content.mjs"
  "unit-cp4a-executor|node test/unit-cp4a-executor.mjs"
  "unit-cpb-marketing|env MARKETING_WEBHOOK_SECRET=$MK_SECRET RUN=$MK_RUN TEST_PORT=$TEST_PORT node test/unit-cpb-marketing.mjs"
  "unit-cpc-channels|node test/unit-cpc-channels.mjs"
  "unit-cpc2-linkedin|node test/unit-cpc2-linkedin.mjs"
  "unit-cpd-automations|node test/unit-cpd-automations.mjs"
  "unit-cpy-automation-gate|node test/unit-cpy-automation-gate.mjs"
  "unit-cpm2-channel-compliance|env INBOUND_WEBHOOK_SECRET=$IB_SECRET node test/unit-cpm2-channel-compliance.mjs"
  "unit-cpm3-settings|node test/unit-cpm3-settings.mjs"
)

TOTAL_SUITES=${#SUITES[@]}
REPORTED=0
PASSED=0
FAILED=0
BROKEN=""
SILENT=""

for entry in "${SUITES[@]}"; do
  name="${entry%%|*}"
  cmd="${entry#*|}"
  echo ""
  echo "=== $name ==="
  out="$(eval "$cmd" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | tail -3
  if [ "$rc" -ne 0 ]; then BROKEN="$BROKEN $name"; fi

  # Suites print either "N passed, M failed" or "N passed / M failed". Matching
  # only one form is how a tally silently reads TOTAL: 0 while nineteen suites
  # are reporting hundreds — so both are matched, and a suite that printed
  # NEITHER is named rather than counted as an empty success.
  counts="$(printf '%s\n' "$out" | grep -oE '[0-9]+ passed[ ,/]+[0-9]+ failed' | tail -1)"
  if [ -z "$counts" ]; then
    SILENT="$SILENT $name"
    continue
  fi
  REPORTED=$((REPORTED + 1))
  p="$(printf '%s' "$counts" | grep -oE '^[0-9]+')"
  f="$(printf '%s' "$counts" | grep -oE '[0-9]+ failed$' | grep -oE '^[0-9]+')"
  PASSED=$((PASSED + p))
  FAILED=$((FAILED + f))
done

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "  TOTAL: $PASSED passed / $FAILED failed"
echo "  $REPORTED/$TOTAL_SUITES suites reported"
[ -n "$SILENT" ] && echo "  !! RAN BUT PRINTED NO COUNT:$SILENT"
[ -n "$BROKEN" ] && echo "  !! EXITED NON-ZERO:$BROKEN"
echo "──────────────────────────────────────────────────────────────"

# A harness that can report green but not red is worse than no harness. Three
# separate things make a run RED, and all three are checked: a failing
# assertion, a suite that crashed before it could report, and a suite that
# vanished from the tally entirely — the last one being the failure mode that
# hides inside a healthy-looking total.
if [ "$FAILED" -ne 0 ] || [ -n "$BROKEN" ] || [ "$REPORTED" -ne "$TOTAL_SUITES" ]; then
  echo "SUITE FAILED"
  exit 1
fi
echo "SUITE GREEN"
