#!/usr/bin/env bash
# DenchClaw CRM — local contract-test runner.
# Boots a scratch Postgres (Docker postgres:16 unless DATABASE_URL_TEST is
# provided), applies migrate.sql + migrations/ in order, starts the server on a
# test port, and runs test/contract.mjs at PHASE=CP5.
#
# NEVER points at staging: refuses any DATABASE_URL_TEST that doesn't look local.
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_PORT="${TEST_PORT:-3101}"
PHASE="${PHASE:-CP5}"
KEY="ct-key-$$"
LIMITED="ct-limited-$$"
# CP-B: the public marketing webhooks fail CLOSED with no secret, so the test
# server needs one. Per-run, never a real deployment value.
MK_SECRET="ct-marketing-secret-$$"
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

apply_sql() { # $1 = sql file
  if [ -n "$CONTAINER" ]; then
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U denchclaw -d denchclaw_test -q < "$1"
  else
    psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL_TEST" < "$1"
  fi
}

if [ -n "${DATABASE_URL_TEST:-}" ]; then
  case "$DATABASE_URL_TEST" in
    *localhost*|*127.0.0.1*) : ;;
    *) echo "FATAL: DATABASE_URL_TEST must be a local scratch DB (got a non-local host). Refusing."; exit 2 ;;
  esac
  command -v psql >/dev/null || { echo "FATAL: psql required to apply schema to DATABASE_URL_TEST"; exit 2; }
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
apply_sql migrate.sql
for f in migrations/0*.sql; do
  echo "[test]   $f"
  apply_sql "$f"
done

echo "[test] booting server on :$TEST_PORT"
DATABASE_URL="$DATABASE_URL_TEST" \
PORT="$TEST_PORT" \
INTERNAL_API_KEY="$KEY" \
INTERNAL_API_KEYS="{\"$KEY\":\"*\",\"$LIMITED\":[\"co_bound_only\"]}" \
AUTOMATION_ENV_FILE=/nonexistent \
MARKETING_WEBHOOK_SECRET="$MK_SECRET" \
MARKETING_WEBHOOK_SECRETS="$MK_SECRETS" \
MARKETING_PUBLIC_BASE="http://127.0.0.1:${TEST_PORT}" \
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
  kill $SERVER_PID 2>/dev/null
  exit 2
fi

echo "[test] running contract harness PHASE=$PHASE"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
LIMITED_API_KEY="$LIMITED" \
PHASE="$PHASE" \
node test/contract.mjs

echo "[test] running unit-tenancy tests (model/helper functions with no HTTP route)"
DATABASE_URL="$DATABASE_URL_TEST" node test/unit-tenancy.mjs

echo "[test] running unit-tenants tests (GOAL A2: tenant entity + resolution)"
DATABASE_URL="$DATABASE_URL_TEST" node test/unit-tenants.mjs

echo "[test] running unit-sequences tests (GOAL B1: sequence data model)"
DATABASE_URL="$DATABASE_URL_TEST" node test/unit-sequences.mjs

echo "[test] running B2 stage-triggered enrollment verification"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-b2-enrollment.mjs

echo "[test] running unit-limits tests (GOAL A5: quotas/suppression/quiet-hours)"
DATABASE_URL="$DATABASE_URL_TEST" node test/unit-limits.mjs

echo "[test] running B3 dispatcher verification (real claim/ack routes)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-b3-dispatcher.mjs

echo "[test] running unit-api-keys tests (GOAL A3: per-tenant API keys)"
DATABASE_URL="$DATABASE_URL_TEST" node test/unit-api-keys.mjs

echo "[test] running A3 API key auth-flow verification (real HTTP, DB-backed key)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-a3-api-key-auth.mjs

echo "[test] running CP1 funnel-pipelines verification (funnel_type + webinar stage machines)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-cp1-funnel-pipelines.mjs

echo "[test] running CP2 step-scheduler verification (enrollment -> queue -> ack -> stage write-back)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-cp2-step-scheduler.mjs

echo "[test] running CP-I unified inbox verification (unification -> unread -> thread union -> stage chips)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-cpi-inbox.mjs

echo "[test] running CP4a-0 message content store (nothing may queue a blank send)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-cp4a0-content.mjs

echo "[test] running CP4a email executor (local stub provider — NEVER a real key)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-cp4a-executor.mjs

echo "[test] running CP-B marketing stage ingestion (the automated marketing stages actually move)"
CRM_API_BASE="http://127.0.0.1:${TEST_PORT}" \
INTERNAL_API_KEY="$KEY" \
MARKETING_WEBHOOK_SECRET="$MK_SECRET" \
RUN="$MK_RUN" \
TEST_PORT="$TEST_PORT" \
DATABASE_URL="$DATABASE_URL_TEST" \
node test/unit-cpb-marketing.mjs
