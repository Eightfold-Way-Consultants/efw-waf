#!/usr/bin/env bash
# Query IIS logs for a specific site on the public-site server
# Resolves site name → IIS site ID dynamically, then searches logs
# Usage: ssm-iis-errors.sh <site> [--pattern PATTERN] [--lines N] [--date YYMMDD]
# Example: ssm-iis-errors.sh mi.db101.org
#          ssm-iis-errors.sh mi.db101.org --pattern "500" --lines 30
#          ssm-iis-errors.sh mi.db101.org --date 260223

set -euo pipefail

SITE="${1:?Usage: ssm-iis-errors.sh <site> [--pattern PATTERN] [--lines N] [--date YYMMDD]}"
shift

PATTERN="500"
LINES=20
DATE=""
REGION="us-west-1"
INSTANCE="i-0c82adf476c7c5e32"  # public-site server

while [[ $# -gt 0 ]]; do
  case $1 in
    --pattern) PATTERN="$2"; shift 2 ;;
    --lines) LINES="$2"; shift 2 ;;
    --date) DATE="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if [[ -z "$DATE" ]]; then
  DATE_EXPR='(Get-Date).ToUniversalTime().ToString("yyMMdd")'
else
  DATE_EXPR="\"$DATE\""
fi

PS_CMD="\$siteId = (& C:\\Windows\\System32\\inetsrv\\appcmd.exe list site \"${SITE}\" 2>\$null) -replace '.*id:(\d+).*','\$1'; if (-not \$siteId) { Write-Output \"Site '${SITE}' not found\"; exit 1 }; Write-Output \"Site: ${SITE} -> W3SVC\$siteId\"; \$d=${DATE_EXPR}; \$logFile = \"C:\\inetpub\\logs\\LogFiles\\W3SVC\$siteId\\u_ex\$d.log\"; if (Test-Path \$logFile) { Select-String \$logFile -Pattern \"${PATTERN}\" | Select -Last ${LINES} | ForEach { \$_.Line } } else { Write-Output \"No log file: \$logFile\" }"

echo "Sending SSM command to public-site server..."
CMD_ID=$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE" \
  --document-name "AWS-RunPowerShellScript" \
  --parameters "commands=[\"$PS_CMD\"]" \
  --timeout-seconds 60 \
  --output json | python3 -c "import json,sys; print(json.load(sys.stdin)['Command']['CommandId'])")

echo "Command ID: $CMD_ID"
echo "Waiting for result (SSM takes 60-180s)..."

for i in $(seq 1 30); do
  sleep 10
  STATUS=$(aws ssm get-command-invocation --region "$REGION" \
    --command-id "$CMD_ID" --instance-id "$INSTANCE" \
    --query 'Status' --output text 2>/dev/null || echo "Pending")
  if [[ "$STATUS" == "Success" ]]; then
    aws ssm get-command-invocation --region "$REGION" \
      --command-id "$CMD_ID" --instance-id "$INSTANCE" \
      --query 'StandardOutputContent' --output text
    exit 0
  elif [[ "$STATUS" == "Failed" || "$STATUS" == "TimedOut" ]]; then
    echo "Command $STATUS"
    aws ssm get-command-invocation --region "$REGION" \
      --command-id "$CMD_ID" --instance-id "$INSTANCE" \
      --query 'StandardErrorContent' --output text
    exit 1
  fi
  echo "  ...waiting ($STATUS)"
done

echo "Timed out. Check manually:"
echo "  aws ssm get-command-invocation --region $REGION --command-id $CMD_ID --instance-id $INSTANCE"
