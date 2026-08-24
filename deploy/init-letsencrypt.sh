#!/usr/bin/env bash
# ─── One-time Let's Encrypt bootstrap for the compose stack ──────────────────
# Solves the chicken-and-egg: nginx won't start without a certificate, and
# certbot's HTTP-01 challenge needs nginx already answering on :80. So we:
#   1. drop a throwaway self-signed cert where nginx expects the real one
#   2. start nginx (it now boots)
#   3. delete the dummy and ask certbot for the real cert via the ACME webroot
#   4. reload nginx to pick up the real cert
#
# Run ONCE, on the VM, from the repo root, AFTER `docker compose build`:
#     EMAIL=you@example.com bash deploy/init-letsencrypt.sh
#
# Re-running is safe: pass STAGING=1 first if you want to rehearse against
# Let's Encrypt's staging CA (avoids burning the strict rate limit on typos).
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${DOMAIN:-claw.usetantra.com}"
EMAIL="${EMAIL:-}"
STAGING="${STAGING:-0}"
COMPOSE="docker compose"

[ -n "$EMAIL" ] || { echo "FATAL: set EMAIL=you@example.com (Let's Encrypt expiry notices)"; exit 1; }
[ -f .env ]      || { echo "FATAL: .env not found — create it first (deploy/env.docker.example)"; exit 1; }

cert_path="/etc/letsencrypt/live/$DOMAIN"

echo "### 1/4  Creating a throwaway self-signed cert so nginx can boot …"
$COMPOSE run --rm --entrypoint "\
  sh -c 'mkdir -p $cert_path && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout $cert_path/privkey.pem \
      -out    $cert_path/fullchain.pem \
      -subj \"/CN=$DOMAIN\"'" certbot

echo "### 2/4  Starting nginx with the dummy cert …"
$COMPOSE up -d proxy

echo "### 3/4  Deleting the dummy cert and requesting the real one …"
$COMPOSE run --rm --entrypoint "\
  sh -c 'rm -rf /etc/letsencrypt/live/$DOMAIN /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf'" certbot

staging_arg=""
[ "$STAGING" != "0" ] && staging_arg="--staging"

$COMPOSE run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $staging_arg \
    --email $EMAIL --agree-tos --no-eff-email \
    -d $DOMAIN \
    --rsa-key-size 4096 --non-interactive" certbot

echo "### 4/4  Reloading nginx with the real certificate …"
$COMPOSE exec proxy nginx -s reload

echo "### Done. https://$DOMAIN should now serve a trusted certificate."
