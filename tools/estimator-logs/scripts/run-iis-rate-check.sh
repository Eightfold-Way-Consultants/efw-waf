#!/bin/bash
# run-iis-rate-check.sh [YYMMDD]
# Downloads IIS logs from S3 (uploaded by the IIS server's nightly cron) and
# runs local rate analysis. HTML report is uploaded to demo.hb101.org.
#
# Pipeline:
#   IIS cron (08:00 UTC)  → s3://efw.backup/iis-logs/YYMMDD/   (done by IIS server)
#   This script (10:00 UTC) → download + analyze + HTML report  (done by this server)
#
# Default date: today (yyyyMMdd). Example: run-iis-rate-check.sh 260503
#
# Output: printed to stdout. Exit 0 on success, 1 on failure.
# HTML report: https://demo.hb101.org/iis-rate-check/iis-analysis-YYYY-MM-DD.html

set -euo pipefail

# Default: analyze yesterday's logs (IIS uploads previous day's logs to S3 at 08:00 UTC).
# Use a date argument to backfill or analyze a specific date.
DATE=${1:-$(date -d 'yesterday' +%y%m%d)}
YYYY_MM_DD="20${DATE:0:2}-${DATE:2:2}-${DATE:4:2}"  # e.g. 2026-05-03

S3_BUCKET="efw.backup"
S3_PREFIX="iis-logs/$DATE"
REPORT_BUCKET="demo.hb101.org"
REPORT_PREFIX="iis-rate-check"
REPORT_KEY="$REPORT_PREFIX/iis-analysis-$YYYY_MM_DD.html"
REPORT_URL="https://$REPORT_BUCKET/$REPORT_KEY"

LOCAL_DIR="/home/jack/.openclaw/workspace/data/iis-logs/$DATE"
WHITELIST="52.8.7.0 127.0.0.1 ::1"
ANALYZE_SCRIPT="$(cd "$(dirname "$0")" && pwd)/analyze-local-iis-logs.sh"
HTML_GENERATOR="$(cd "$(dirname "$0")" && pwd)/generate-iis-rate-report.py"

echo "[run-iis-rate-check] Date=$DATE  S3=s3://$S3_BUCKET/$S3_PREFIX/"
echo ""

# ── 1. Download from S3 ──────────────────────────────────────────────────────
LOG_COUNT=0
if [ -d "$LOCAL_DIR" ]; then
    LOG_COUNT=$(find "$LOCAL_DIR" -name 'u_ex*.log' -type f | wc -l)
fi
if [ "$LOG_COUNT" -gt 0 ]; then
    echo "[run-iis-rate-check] Reusing $LOG_COUNT existing log files in $LOCAL_DIR"
else
    mkdir -p "$LOCAL_DIR"
    echo "[run-iis-rate-check] Downloading from s3://$S3_BUCKET/$S3_PREFIX/ ..."
    aws s3 cp "s3://$S3_BUCKET/$S3_PREFIX/" "$LOCAL_DIR/" --recursive --region us-west-1
    echo "[run-iis-rate-check] Download complete"
fi

# ── 2. Run local analysis ────────────────────────────────────────────────────
echo ""
echo "[run-iis-rate-check] Running local analysis ..."
bash "$ANALYZE_SCRIPT" "$DATE" > "$LOCAL_DIR/analysis.txt" 2>&1 || true
cat "$LOCAL_DIR/analysis.txt"
echo ""

# ── 3. Generate HTML report ──────────────────────────────────────────────────
echo "[run-iis-rate-check] Generating HTML report ..."
python3 "$HTML_GENERATOR" \
    --date "$DATE" \
    --log-dir "$LOCAL_DIR" \
    --whitelist "$WHITELIST" \
    --output "$LOCAL_DIR/iis-analysis-$DATE.html"

# ── 4. Upload report to S3 ──────────────────────────────────────────────────
echo "[run-iis-rate-check] Uploading to s3://$REPORT_BUCKET/$REPORT_KEY ..."
aws s3 cp "$LOCAL_DIR/iis-analysis-$DATE.html" "s3://$REPORT_BUCKET/$REPORT_KEY" \
    --region us-west-1 \
    --content-type "text/html; charset=utf-8" \
    --cache-control "no-cache"

# ── 5. CloudFront invalidation ───────────────────────────────────────────────
echo "[run-iis-rate-check] Creating CloudFront invalidation for /$REPORT_KEY ..."
CF_DISTRO="E7ED0X655XU9M"
INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$CF_DISTRO" \
    --paths "/$REPORT_KEY" \
    --region us-west-1 \
    --query "Invalidation.Id" \
    --output text)
echo "[run-iis-rate-check] Invalidation ID: $INVALIDATION_ID"

echo ""
echo "REPORT_URL=$REPORT_URL"
echo "=== Done ==="