#!/bin/bash
# analyze-local-iis-logs.sh [YYMMDD]
# Analyzes local IIS logs to find high-rate IPs and request patterns

set -euo pipefail

DATE=${1:-$(date +%y%m%d)}
LOG_DIR="/home/jack/.openclaw/workspace/data/iis-logs/$DATE"
OUTPUT_DIR="$LOG_DIR"
WHITELIST="52.8.7.0 127.0.0.1"

echo "=== IIS /planning/ Rate Analysis (Local) ==="
echo "Date: $DATE"
echo "Log directory: $LOG_DIR"
echo ""

# Extract all /planning/ requests with IP and timestamp
# IIS W3C format: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken
# Field 8 (index 7) = c-ip (client IP)
# Field 1 (index 0) = date
# Field 2 (index 1) = time

TEMP_FILE=$(mktemp)
trap "rm -f $TEMP_FILE" EXIT

echo "Extracting /planning/ requests..."
grep -h '/planning/' "$LOG_DIR"/W3SVC*/u_ex${DATE}.log | \
    awk '{print $9, substr($2,1,5), $5}' | \
    grep -vE "^($(echo $WHITELIST | tr ' ' '|'))" > "$TEMP_FILE"

TOTAL=$(wc -l < "$TEMP_FILE")
echo "Total requests (after whitelist): $TOTAL"
echo ""

if [ "$TOTAL" -eq 0 ]; then
    echo "No data to analyze."
    exit 0
fi

# Top 25 IP+minute slots
echo "=== Top 25 busiest IP+minute combos ==="
awk '{print $1 "|" $2}' "$TEMP_FILE" | \
    sort | uniq -c | sort -rn | head -25 | \
    awk '{printf "%5d req/min  IP: %-18s  %s\n", $1, substr($2,1,index($2,"|")-1), substr($2,index($2,"|")+1)}' | \
    tee "$OUTPUT_DIR/top-25-slots.txt"
echo ""

# Sustained high-rate IPs (>10 req/min across 2+ minutes)
echo "=== Sustained high-rate IPs (>10 req/min across 2+ minutes) ==="
awk '{print $1 "|" $2}' "$TEMP_FILE" | \
    sort | uniq -c | \
    awk '$1 > 10 {print}' | \
    awk '{ip=substr($2,1,index($2,"|")-1); count[ip]++; total[ip]+=$1}
         END {for (ip in count) if (count[ip] >= 2) print total[ip], count[ip], ip}' | \
    sort -rn | \
    awk '{printf "%s - %d hot minutes, %d total reqs\n", $3, $2, $1}' | \
    tee "$OUTPUT_DIR/sustained-high-rate-ips.txt"

echo ""
echo "=== Output files created ==="
echo "  $OUTPUT_DIR/top-25-slots.txt"
echo "  $OUTPUT_DIR/sustained-high-rate-ips.txt"
echo ""
echo "=== Done ==="
