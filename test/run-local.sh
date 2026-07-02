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
