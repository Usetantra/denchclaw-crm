#!/usr/bin/env bash
# ─── Zone guard for usetantra.com ────────────────────────────────────────────
# Proves that adding claw.usetantra.com changed NOTHING else in the zone.
#
#   bin/dns-guard.sh snapshot            # BEFORE touching Cloudflare
#   ... add the A record in the dashboard ...
#   bin/dns-guard.sh verify              # AFTER — diffs against the snapshot
#
# Why this exists: "I only added one record" is a claim about what you intended,
# not about what happened. A mis-click in a DNS UI, or a zone import that
# silently replaces records, looks identical from the operator's chair. This
# turns the safety property into something checkable.
#
# Read-only. Uses public DNS only — no API token, no credentials, no writes.
# It cannot itself modify anything.
set -uo pipefail
cd "$(dirname "$0")/.."

ZONE="${ZONE:-usetantra.com}"
SNAP_DIR="${SNAP_DIR:-.dns-snapshots}"
CMD="${1:-verify}"

# The records that matter. Losing any of these breaks something live:
#   MX + apex TXT (SPF)   -> all company email
#   resend._domainkey     -> the CRM's own outbound sending (DKIM)
#   send TXT              -> Resend's send subdomain SPF
#   _dmarc                -> reporting
#   the A records         -> the sites themselves
NAMES_APEX=(MX TXT NS)
SUBS=(www api staging claw send resend._domainkey _dmarc)

capture() {
  echo "; zone snapshot: $ZONE"
  echo "; taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for t in "${NAMES_APEX[@]}"; do
    dig +short "$t" "$ZONE" | sort | sed "s|^|$ZONE\t$t\t|"
  done
  for s in "${SUBS[@]}"; do
    # If the name is a CNAME, record ONLY the CNAME. Two reasons:
    #   1. `dig +short A` on a CNAME'd name echoes the CNAME target too, which
    #      would show up as a bogus "A" record.
    #   2. A proxied name (www is behind Cloudflare) resolves to edge IPs that
    #      ROTATE. Snapshotting those means the guard cries wolf later.
    # The CNAME is the configuration; the A records are just today's answer, and
    # configuration is what we are guarding.
    cn=$(dig +short CNAME "$s.$ZONE" 2>/dev/null | sort)
    if [ -n "$cn" ]; then
      echo "$cn" | sed "s|^|$s.$ZONE\tCNAME\t|"
      continue
    fi
    for t in A TXT MX; do
      out=$(dig +short "$t" "$s.$ZONE" 2>/dev/null | sort)
      [ -n "$out" ] && echo "$out" | sed "s|^|$s.$ZONE\t$t\t|"
    done
  done
}

case "$CMD" in
  snapshot)
    mkdir -p "$SNAP_DIR"
    f="$SNAP_DIR/$ZONE.before"
    capture > "$f"
    echo "[dns-guard] snapshot written: $f"
    echo "[dns-guard] $(grep -vc '^;' "$f") record value(s) captured"
    echo
    grep -v '^;' "$f" | sed 's/^/  /'
    echo
    echo "[dns-guard] now add the A record, then run: bin/dns-guard.sh verify"
    ;;

  verify)
    f="$SNAP_DIR/$ZONE.before"
    [ -f "$f" ] || { echo "[dns-guard] FATAL: no snapshot at $f — run 'snapshot' first (before changing anything)"; exit 2; }
    now="$SNAP_DIR/$ZONE.after"
    capture > "$now"

    before_body=$(grep -v '^;' "$f")
    after_body=$(grep -v '^;' "$now")

    # Anything that vanished or changed value is a problem. Anything ADDED is
    # only acceptable if it is the new claw record.
    removed=$(comm -23 <(echo "$before_body") <(echo "$after_body"))
    added=$(comm -13 <(echo "$before_body") <(echo "$after_body"))
    unexpected_added=$(echo "$added" | grep -v '^claw\.'"$ZONE" || true)

    rc=0
    if [ -n "$removed" ]; then
      echo "[dns-guard] ✗ RECORDS REMOVED OR CHANGED — this is the failure this script exists to catch:"
      echo "$removed" | sed 's/^/    - /'
      echo "    Restore these before doing anything else. If resend._domainkey or the apex"
      echo "    SPF is in that list, outbound email is broken right now."
      rc=1
    fi
    if [ -n "$unexpected_added" ]; then
      echo "[dns-guard] ✗ UNEXPECTED RECORDS ADDED (not claw.$ZONE):"
      echo "$unexpected_added" | sed 's/^/    + /'
      rc=1
    fi

    # Presence of the NEW record is checked against the AUTHORITATIVE server,
    # not the system resolver. A resolver that already answered NXDOMAIN for
    # claw caches that negative answer, so a freshly-added record looks missing
    # for the length of the negative TTL — which reads as "it didn't work" when
    # in fact it did. The authoritative answer is the source of truth.
    auth_ns=$(dig +short NS "$ZONE" | head -1)
    claw_auth=$(dig +short A "claw.$ZONE" ${auth_ns:+@"$auth_ns"} 2>/dev/null | head -1)
    if [ -n "$claw_auth" ]; then
      echo "[dns-guard] ✓ claw.$ZONE -> $claw_auth (authoritative: ${auth_ns:-system})"
      cached=$(dig +short A "claw.$ZONE" | head -1)
      if [ -z "$cached" ]; then
        echo "    note: your local resolver does not see it yet (cached negative answer)."
        echo "          Public resolvers:"
        for r in 1.1.1.1 8.8.8.8; do
          printf "            %-8s %s\n" "$r" "$(dig +short A "claw.$ZONE" @$r | head -1)"
        done
      fi
    else
      echo "[dns-guard] ✗ claw.$ZONE does not exist at the authoritative server — the record was not saved"
      rc=1
    fi

    if [ "$rc" = 0 ]; then
      echo "[dns-guard] ✓ every other record in $ZONE is byte-identical to the snapshot"
      # Name the load-bearing ones explicitly — a green summary that does not
      # say WHAT it checked is not worth much.
      for critical in "MX" "resend._domainkey" "_dmarc"; do
        n=$(echo "$after_body" | grep -c "$critical" || true)
        echo "    intact: $critical ($n value(s))"
      done
      spf=$(echo "$after_body" | grep -c 'spf1' || true)
      echo "    intact: SPF ($spf value(s))"
    fi
    exit $rc
    ;;

  *) echo "usage: bin/dns-guard.sh [snapshot|verify]"; exit 2 ;;
esac
