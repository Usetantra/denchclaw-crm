#!/usr/bin/env bash
# ─── Install the claw.usetantra.com vhost, without touching anything else ────
# Run ON THE BOX as a user with sudo.
#
#   bin/deploy-claw.sh --dry-run     # show every command, execute nothing
#   bin/deploy-claw.sh
#
# The requirement this script is built around: the box ALREADY serves
# staging.usetantra.com with a certbot-managed certificate, and that site must
# not be disturbed. So:
#
#   - the certificate comes from `certbot certonly --webroot`, never `--nginx`.
#     The nginx plugin edits server blocks it judges relevant and can add a
#     global HTTPS redirect; certonly writes a certificate and edits nothing.
#   - the vhost is a NEW file in sites-available. No existing file is opened.
#   - it refuses to overwrite an existing claw vhost without --force.
#   - `nginx -t` runs BEFORE any reload, and a failed test aborts without
#     reloading, so a broken config can never take the box down.
set -uo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${DOMAIN:-claw.usetantra.com}"
SRC="deploy/nginx-claw.usetantra.com.conf"
DEST="/etc/nginx/sites-available/$DOMAIN"
LINK="/etc/nginx/sites-enabled/$DOMAIN"
WEBROOT="${WEBROOT:-/var/www/html}"
DRY=0; FORCE=0
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY=1
  [ "$a" = "--force" ] && FORCE=1
done

run() { if [ "$DRY" = 1 ]; then echo "  would run: $*"; else echo "  + $*"; "$@"; fi; }
fail() { echo "[deploy-claw] FATAL: $*"; exit 1; }

# THIS BOX IS SHARED. It serves staging.usetantra.com AND careers.growthclub.org
# (the latter is the default_server, which is why an unconfigured hostname lands
# there). So "did I break anything?" is a question about neighbours, not just
# about us — and the answer should be evidence, not assumption.
#
# Records every enabled vhost's HTTP status and certificate subject, so the same
# probe can be re-run after the reload and diffed.
neighbours() {
  local names
  names=$(sudo grep -rhoP '(?<=server_name )[^;]+' /etc/nginx/sites-enabled/ 2>/dev/null \
          | tr ' ' '\n' | grep -vE '^(_|localhost)$' | grep '\.' | sort -u)
  for n in $names; do
    [ "$n" = "$DOMAIN" ] && continue
    local code cn
    code=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "https://$n/" --resolve "$n:443:127.0.0.1" 2>/dev/null)
    cn=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$n" 2>/dev/null \
         | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//')
    echo "$n|$code|$cn"
  done
}

echo "[deploy-claw] domain=$DOMAIN  dry-run=$DRY"

# Hard refusal, not a warning. This script installs a vhost from a template and
# the ONE standing requirement of this whole exercise is that the existing
# staging site is not disturbed. DOMAIN is overridable for testing, so make it
# impossible to aim that override at the thing we are protecting.
case "$DOMAIN" in
  staging.usetantra.com|usetantra.com|api.usetantra.com|www.usetantra.com)
    fail "refusing to target $DOMAIN — this script only installs the NEW vhost. Editing an existing site is a deliberate, manual act."
    ;;
esac

# ── Preconditions ────────────────────────────────────────────────────────────
[ -f "$SRC" ] || fail "$SRC not found — run from the repo root"
command -v nginx >/dev/null || fail "nginx not installed"

echo "[deploy-claw] checking DNS"
# Ask the AUTHORITATIVE server, not the local resolver. A resolver that already
# answered NXDOMAIN for this name caches that negative for its TTL, so a record
# added minutes ago looks absent — and this script would refuse to proceed on a
# perfectly good setup.
auth_ns=$(dig +short NS "${DOMAIN#*.}" | head -1)
ip=$(dig +short A "$DOMAIN" ${auth_ns:+@"$auth_ns"} | tail -1)
if [ -z "$ip" ]; then
  fail "$DOMAIN does not exist at the authoritative server (${auth_ns:-system resolver}). Add the A record first, then re-run. See bin/dns-guard.sh."
fi
local_ip=$(dig +short A "$DOMAIN" | tail -1)
if [ -z "$local_ip" ]; then
  echo "  NOTE: authoritative says $ip, but this machine's resolver has a cached negative."
  echo "        Harmless for certbot (it uses public resolvers), but your own curl tests"
  echo "        will fail until the cache expires. Use --resolve to test in the meantime."
fi
here=$(dig +short A staging.usetantra.com | tail -1)
echo "  $DOMAIN -> $ip   (staging -> $here)"
[ "$ip" = "$here" ] || echo "  NOTE: not the same IP as staging — make sure that is intended."

if [ -e "$DEST" ] && [ "$FORCE" != 1 ]; then
  fail "$DEST already exists. Re-run with --force to replace it (it will be backed up first)."
fi

echo "[deploy-claw] recording neighbouring sites on this shared box"
NEIGH_BEFORE=""
if [ "$DRY" != 1 ]; then
  NEIGH_BEFORE=$(neighbours)
  echo "$NEIGH_BEFORE" | sed 's/^/    /'
  [ -z "$NEIGH_BEFORE" ] && echo "    (none detected — continuing, but the post-check will be vacuous)"
else
  echo "  would probe every vhost in /etc/nginx/sites-enabled/"
fi

# ── Certificate: certonly, so no config is rewritten ─────────────────────────
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  echo "[deploy-claw] certificate already present, skipping certbot"
else
  echo "[deploy-claw] obtaining certificate (webroot; nginx config untouched)"
  run sudo certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring
fi

# ── Install the vhost ────────────────────────────────────────────────────────
echo "[deploy-claw] installing vhost"
[ -e "$DEST" ] && run sudo cp -a "$DEST" "$DEST.bak.$(date -u +%Y%m%dT%H%M%SZ)"
run sudo cp "$SRC" "$DEST"
run sudo ln -sf "$DEST" "$LINK"

# ── Fill in the stage-1 values from the box itself ───────────────────────────
# Both of these are knowable here, so asking a human to hand-edit a config file
# mid-deploy just adds a step where a typo produces a silent 502. Read them, or
# stop with a specific reason — never reload with a placeholder still in place.
if [ "$DRY" != 1 ]; then
  # The internal key the app is actually running with.
  KEY=$(grep -E '^INTERNAL_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
  if [ -z "$KEY" ]; then
    fail "INTERNAL_API_KEY not found in $(pwd)/.env — the /crm/api proxy needs it for stage 1. Set it, or fill the placeholder in $DEST by hand."
  fi
  # The htpasswd the existing site already uses. Reusing it means ONE credential
  # to rotate rather than two, and no new password to distribute.
  HTP=$(sudo grep -rhoP '(?<=auth_basic_user_file )[^;]+' /etc/nginx/sites-available/ 2>/dev/null \
        | tr -d ' ' | sort -u | head -1)
  if [ -z "$HTP" ]; then
    echo "  NOTE: no existing auth_basic_user_file found on this box."
    echo "        Create one, then re-run:  sudo htpasswd -c /etc/nginx/.htpasswd <user>"
    fail "refusing to install a /crm/ location with no working Basic-auth file — that would publish the dashboard."
  fi
  echo "[deploy-claw] using htpasswd: $HTP"

  # Escape for sed: the key is random base64/hex and could contain / or &.
  esc_key=$(printf '%s' "$KEY" | sed -e 's/[\/&|]/\\&/g')
  esc_htp=$(printf '%s' "$HTP" | sed -e 's/[\/&|]/\\&/g')
  sudo sed -i "s|REPLACE_WITH_INTERNAL_API_KEY|$esc_key|g" "$DEST"
  sudo sed -i "s|auth_basic_user_file /etc/nginx/.htpasswd;|auth_basic_user_file $esc_htp;|g" "$DEST"
  sudo sed -i "s|auth_basic_user_file /etc/nginx/.htpasswd;   # <- confirm the real path|auth_basic_user_file $esc_htp;|g" "$DEST"

  if sudo grep -q 'REPLACE_WITH_INTERNAL_API_KEY' "$DEST"; then
    fail "placeholder substitution did not take — refusing to reload with a placeholder key in $DEST"
  fi
  # The file now contains a live secret. Make sure it is not world-readable.
  sudo chmod 640 "$DEST"
  echo "[deploy-claw] stage-1 values written (config is chmod 640 — it holds the internal key)"
fi

# ── Test BEFORE reload. A failed test must never reach systemctl. ────────────
echo "[deploy-claw] testing config"
if [ "$DRY" = 1 ]; then
  echo "  would run: sudo nginx -t && sudo systemctl reload nginx"
else
  sudo nginx -t || fail "nginx -t failed — NOT reloading. The running config is untouched."
  sudo systemctl reload nginx || fail "reload failed"
fi

# ── Prove the neighbours are untouched ───────────────────────────────────────
if [ "$DRY" != 1 ] && [ -n "$NEIGH_BEFORE" ]; then
  echo "[deploy-claw] re-checking neighbouring sites"
  NEIGH_AFTER=$(neighbours)
  if [ "$NEIGH_BEFORE" = "$NEIGH_AFTER" ]; then
    echo "  ✓ every other site on this box responds identically (same status, same certificate)"
    echo "$NEIGH_AFTER" | sed 's/^/    /'
  else
    echo "  ✗ A NEIGHBOURING SITE CHANGED. Before / after:"
    diff <(echo "$NEIGH_BEFORE") <(echo "$NEIGH_AFTER") | sed 's/^/    /'
    echo
    echo "  The previous config was backed up next to $DEST. Restore it and reload."
    exit 1
  fi
fi

echo
echo "[deploy-claw] done. Verify — the last line proves staging was not disturbed:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://$DOMAIN/health          # 200"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://$DOMAIN/crm/            # 401"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' https://staging.usetantra.com/crm/  # still 401"
echo "  bin/dns-guard.sh verify"
