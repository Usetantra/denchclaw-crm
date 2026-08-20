#!/usr/bin/env bash
# ─── Point the app's generated URLs at a hostname ────────────────────────────
#
#   bin/set-host.sh https://claw.usetantra.com            # show the diff
#   bin/set-host.sh https://claw.usetantra.com --write    # apply it
#
# These five variables are the ones that break SILENTLY when the hostname
# changes. Nothing in the app errors on a stale value — links simply point
# somewhere dead and provider callbacks land on the wrong box:
#
#   TWILIO_WEBHOOK_BASE_URL   the string Twilio's signature is HMAC'd over. A
#                             mismatch 403s every inbound SMS/WhatsApp, which
#                             also stops STOP/opt-out being recorded.
#   TWILIO_STATUS_CALLBACK    stamped on every outbound message. Stale means
#                             sends succeed but nothing ever leaves "queued".
#   MARKETING_PUBLIC_BASE     prospect-facing /m/i/<token> links.
#   PUBLIC_BASE_URL           fallback for the above.
#   APP_URL                   team invite links. The raw token is hash-only in
#                             the DB, so a bad link means revoke and re-invite.
#
# Editing .env by hand is five chances to typo one of them. This is idempotent:
# it updates a key in place if present, appends it if not, and never duplicates.
#
# It does NOT restart anything — read the diff, then restart deliberately.
set -uo pipefail
cd "$(dirname "$0")/.."

HOST="${1:-}"
WRITE=0; [ "${2:-}" = "--write" ] && WRITE=1
[ -n "$HOST" ] || { echo "usage: bin/set-host.sh https://claw.usetantra.com [--write]"; exit 2; }
case "$HOST" in
  https://*) : ;;
  http://*) echo "WARNING: http:// — Clerk requires https and cookies will not be Secure." ;;
  *) echo "FATAL: give a full origin, e.g. https://claw.usetantra.com"; exit 2 ;;
esac
HOST="${HOST%/}"
[ -f .env ] || { echo "FATAL: no .env in $(pwd)"; exit 2; }

# Refuse to rewrite a DEVELOPMENT .env with production URLs.
#
# This exists because it happened: a multi-line paste whose `ssh` line silently
# failed left every following command running on a laptop instead of the server,
# and this script cheerfully wrote claw.usetantra.com into the local .env. The
# damage was small and reversible, but CLERK_AUTHORIZED_PARTIES pointing at a
# host the local browser will never be on breaks local sign-in in a way that
# looks like a code bug.
#
# A DATABASE_URL on loopback is the clearest "this is not the server" signal
# available, and it is the same heuristic test/apply-schema.mjs already uses to
# protect production from the test harness — in the opposite direction.
DBURL=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)
case "$DBURL" in
  *localhost*|*127.0.0.1*)
    if [ "${FORCE_LOCAL:-0}" != 1 ]; then
      echo "REFUSING: this .env points at a LOCAL database ($(echo "$DBURL" | sed 's|.*@||'))."
      echo "          Setting production hostnames here would break local sign-in"
      echo "          (CLERK_AUTHORIZED_PARTIES would name a host your browser is never on)."
      echo
      echo "          If you meant to run this on the server, you are not on it —"
      echo "          check that your ssh actually connected."
      echo "          To override anyway: FORCE_LOCAL=1 bin/set-host.sh $HOST --write"
      exit 2
    fi
    echo "  (FORCE_LOCAL=1 — proceeding against a local .env)"
    ;;
esac

declare -a KEYS=(APP_URL MARKETING_PUBLIC_BASE PUBLIC_BASE_URL TWILIO_WEBHOOK_BASE_URL CLERK_AUTHORIZED_PARTIES)
declare -a VALS=("$HOST" "$HOST" "$HOST" "$HOST" "$HOST")
KEYS+=(TWILIO_STATUS_CALLBACK); VALS+=("$HOST/webhooks/twilio/status")

tmp=$(mktemp); cp .env "$tmp"
changed=0
for i in "${!KEYS[@]}"; do
  k="${KEYS[$i]}"; v="${VALS[$i]}"
  cur=$(grep -E "^${k}=" "$tmp" | head -1 | cut -d= -f2-)
  if [ "$cur" = "$v" ]; then
    printf "  =  %-26s %s\n" "$k" "$v"
    continue
  fi
  changed=1
  if grep -qE "^${k}=" "$tmp"; then
    printf "  ~  %-26s %s  ->  %s\n" "$k" "${cur:-(empty)}" "$v"
    # | as the delimiter: the values are URLs and contain /
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$tmp" && rm -f "$tmp.bak"
  else
    printf "  +  %-26s %s\n" "$k" "$v"
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
  fi
done

if [ "$changed" = 0 ]; then
  echo "[set-host] already correct — nothing to change"; rm -f "$tmp"; exit 0
fi

if [ "$WRITE" != 1 ]; then
  echo
  echo "[set-host] dry run — nothing written. Re-run with --write to apply."
  rm -f "$tmp"; exit 0
fi

backup=".env.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp .env "$backup"
cp "$tmp" .env
rm -f "$tmp"
echo
echo "[set-host] written. Previous .env saved as $backup"
echo "[set-host] now: pm2 restart denchclaw-crm && node bin/preflight.mjs"
echo
echo "[set-host] REMEMBER: env is only half of it. These live in THIRD-PARTY"
echo "           dashboards and still point at the old host:"
echo "             - Twilio console: the number's inbound webhook"
echo "             - Cloudflare Worker: CRM_WEBHOOK_URL"
echo "             - Tantra dashboard: /webhooks/tantra/<token>  (same token)"
echo "             - Zapier/Make/forms: each /webhooks/leads/<token>"
echo "           node bin/preflight.mjs lists which of those have ever been used."
