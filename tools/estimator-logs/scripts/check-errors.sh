#!/usr/bin/env bash
# Check estimator CloudWatch logs for errors
# Usage: check-errors.sh [--hours N] [--site SITE] [--server edit|public|both]
# Defaults: last 24 hours, all sites, both servers

set -euo pipefail

REGION="us-west-1"
HOURS=24
SITE=""
SERVER="both"
LIMIT=50

while [[ $# -gt 0 ]]; do
  case $1 in
    --hours) HOURS="$2"; shift 2 ;;
    --site) SITE="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

START_TIME=$(python3 -c "import time; print(int((time.time() - ${HOURS}*3600) * 1000))")

EDIT_GROUP="estimator-logs/ip-10-3-0-122.us-west-1.compute.internal"
PUBLIC_GROUP="estimator-logs/ip-10-3-0-63.us-west-1.compute.internal"

check_group() {
  local group="$1"
  local label="$2"
  local filter=""
  
  if [[ -n "$SITE" ]]; then
    filter="\"$SITE\""
  fi

  echo "=== $label ==="
  if [[ -n "$filter" ]]; then
    aws logs filter-log-events \
      --region "$REGION" \
      --log-group-name "$group" \
      --start-time "$START_TIME" \
      --filter-pattern "$filter" \
      --limit "$LIMIT" \
      --query 'events[*].message' \
      --output text 2>/dev/null || echo "(no events)"
  else
    aws logs filter-log-events \
      --region "$REGION" \
      --log-group-name "$group" \
      --start-time "$START_TIME" \
      --limit "$LIMIT" \
      --query 'events[*].message' \
      --output text 2>/dev/null || echo "(no events)"
  fi
  echo ""
}

if [[ "$SERVER" == "edit" || "$SERVER" == "both" ]]; then
  check_group "$EDIT_GROUP" "EDIT-SITE (efw.web.04d / 52.8.85.37)"
fi

if [[ "$SERVER" == "public" || "$SERVER" == "both" ]]; then
  check_group "$PUBLIC_GROUP" "PUBLIC-SITE (efw.web.06d / 52.8.7.0)"
fi
