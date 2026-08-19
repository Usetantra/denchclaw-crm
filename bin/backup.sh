#!/usr/bin/env bash
# ─── Database backup ─────────────────────────────────────────────────────────
# There was no backup story at all, which means a bad migration or a mistaken
# DELETE had no recovery path. This is the minimum that fixes that.
#
#   bin/backup.sh                  # write a compressed dump, prune old ones
#   bin/backup.sh --verify         # also prove the dump restores (slow, worth it)
#   BACKUP_DIR=/mnt/backups bin/backup.sh
#
# Uses pg_dump's custom format (-Fc): compressed, and restorable selectively
# with pg_restore, which a plain SQL dump cannot do.
#
# ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
# It writes to LOCAL DISK. A local backup survives a bad deploy or a fat-fingered
# query; it does NOT survive losing the box. Ship BACKUP_DIR somewhere else —
# object storage, another host, anything — or this is only half a backup. That
# step is deliberately left to you because it needs credentials this repo should
# not hold.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && . ./.env && set +a
: "${DATABASE_URL:?DATABASE_URL is not set}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/denchclaw}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/denchclaw-$STAMP.dump"
VERIFY=0
[ "${1:-}" = "--verify" ] && VERIFY=1

command -v pg_dump >/dev/null || { echo "FATAL: pg_dump not found"; exit 2; }
mkdir -p "$BACKUP_DIR" || { echo "FATAL: cannot create $BACKUP_DIR"; exit 2; }

echo "[backup] $STAMP -> $OUT"
if ! pg_dump --format=custom --no-owner --no-acl --file="$OUT" "$DATABASE_URL"; then
  echo "[backup] FAILED — pg_dump returned non-zero"
  rm -f "$OUT"
  exit 1
fi

SIZE=$(wc -c < "$OUT" | tr -d ' ')
# A dump far too small to be real is the classic silent failure: the file
# exists, cron is happy, and it restores to nothing.
if [ "$SIZE" -lt 10000 ]; then
  echo "[backup] FAILED — dump is only ${SIZE} bytes, which cannot be a real database"
  exit 1
fi
echo "[backup] wrote ${SIZE} bytes"

# An unverified backup is a hope, not a backup. This restores into a scratch
# database and counts the tables, then drops it.
if [ "$VERIFY" = 1 ]; then
  command -v pg_restore >/dev/null || { echo "[backup] pg_restore not found, skipping verify"; exit 0; }
  BASE_URL="${DATABASE_URL%/*}"
  SCRATCH="denchclaw_verify_$$"
  echo "[backup] verifying by restoring into $SCRATCH"
  if psql "$BASE_URL/postgres" -q -c "CREATE DATABASE $SCRATCH" 2>/dev/null; then
    pg_restore --no-owner --no-acl --dbname="$BASE_URL/$SCRATCH" "$OUT" >/dev/null 2>&1
    N=$(psql "$BASE_URL/$SCRATCH" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)
    psql "$BASE_URL/postgres" -q -c "DROP DATABASE $SCRATCH" 2>/dev/null
    if [ "${N:-0}" -lt 10 ]; then
      echo "[backup] VERIFY FAILED — restored only ${N} tables"
      exit 1
    fi
    echo "[backup] verified — restores to ${N} tables"
  else
    echo "[backup] could not create a scratch DB; verify skipped"
  fi
fi

# Prune. Runs only after a SUCCESSFUL dump, so a run of failures can never
# delete the last good backup.
DELETED=$(find "$BACKUP_DIR" -name 'denchclaw-*.dump' -type f -mtime "+$RETAIN_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' ')
[ "${DELETED:-0}" -gt 0 ] && echo "[backup] pruned $DELETED backup(s) older than $RETAIN_DAYS days"

COUNT=$(find "$BACKUP_DIR" -name 'denchclaw-*.dump' -type f | wc -l | tr -d ' ')
echo "[backup] ok — $COUNT backup(s) retained in $BACKUP_DIR"

# ── Restoring ────────────────────────────────────────────────────────────────
#   createdb denchclaw_restore
#   pg_restore --no-owner --no-acl -d "$BASE_URL/denchclaw_restore" <dump>
#
# Restore into a NEW database and inspect it before pointing anything at it.
# Never pg_restore over a live database to "fix" it — that is how a partial
# restore turns one bad table into a bad database.
