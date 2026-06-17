#!/usr/bin/env bash
# A9/A10 WAF rate-limit burst against preview2-il (Count mode).
# A9: >300 GET /planning/* -> RateLimit-Estimator (limit 300/IP/5min)
# A10: >500 GET any path    -> RateLimit (limit 500/IP/5min)
# Lightweight extensionless 404 paths => fast origin 404, NO estimator/ECO compute.
set -u
HOST="https://preview2-il.db101.org"
UA="EFW-WAFTEST-20260617"
TOK="a9a10-20260617"
TOTAL_PLANNING=700      # A9 (> 300)
TOTAL_ANY=700           # A10 (combined with A9 toward the 500 any-path limit)
WAVE=50
SLEEP=14                # ~14 waves over ~3.5 min per phase

burst () {  # $1=label  $2=count  $3=path-prefix
  local label="$1" count="$2" prefix="$3" sent=0 wave_n
  echo "[$(date -u +%H:%M:%S)] $label START ($count reqs, prefix=$prefix)"
  while [ "$sent" -lt "$count" ]; do
    wave_n=0
    while [ "$wave_n" -lt "$WAVE" ] && [ "$sent" -lt "$count" ]; do
      sent=$((sent+1)); wave_n=$((wave_n+1))
      curl -s -o /dev/null --max-time 10 \
        -H "User-Agent: $UA" \
        "${HOST}${prefix}${sent}?waftest=${TOK}" &
    done
    wait
    echo "[$(date -u +%H:%M:%S)] $label sent=$sent"
    [ "$sent" -lt "$count" ] && sleep "$SLEEP"
  done
  echo "[$(date -u +%H:%M:%S)] $label DONE sent=$sent"
}

echo "=== A9/A10 burst start $(date -u +%H:%M:%SZ) from $(curl -s https://checkip.amazonaws.com) ==="
burst "A9-planning" "$TOTAL_PLANNING" "/planning/waftest9-"
burst "A10-anypath" "$TOTAL_ANY" "/waftest10-"
echo "=== A9/A10 burst end $(date -u +%H:%M:%SZ) ==="
