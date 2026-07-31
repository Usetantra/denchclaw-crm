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
  RESEND_API_KEY="" CLOUDFLARE_AI_TOKEN="" \
node server/server.js &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${TEST_PORT}/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 30 ] && { echo "FATAL: server did not become healthy"; exit 2; }
  sleep 1
done

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
