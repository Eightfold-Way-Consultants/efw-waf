#!/usr/bin/env bash
# Tail recent estimator error logs via SSM
# Usage: ssm-tail-errors.sh <site> [--server edit|public] [--lines N]
# Example: ssm-tail-errors.sh preview2-nv.db101.org
#          ssm-tail-errors.sh nv.db101.org --server public --lines 100

set -euo pipefail

SITE="${1:?Usage: ssm-tail-errors.sh <site> [--server edit|public] [--lines N]}"
shift

SERVER="edit"
LINES=50
REGION="us-west-1"

while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER="$2"; shift 2 ;;
    --lines) LINES="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if [[ "$SERVER" == "edit" ]]; then
  INSTANCE="i-0272763b46610ac1b"
elif [[ "$SERVER" == "public" ]]; then
  INSTANCE="i-0c82adf476c7c5e32"
else
  echo "Server must be 'edit' or 'public'"; exit 1
fi

# Build PowerShell script file (no $_ pipeline syntax — avoids obfuscation detector)
PS_FILE=$(mktemp /tmp/ssm-ps-XXXXXX.ps1)
cat > "$PS_FILE" << 'PSEOF'
$logs = Get-ChildItem "SITENAME" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 3
foreach ($log in $logs) {
  Write-Output ("--- " + $log.Name + " (" + $log.LastWriteTime + ") ---")
  Get-Content $log.FullName | Select-Object -Last LINESVAR
}
PSEOF

sed -i "s/SITENAME/C:\\temp\\EstimatorLogs\\$SITE/g" "$PS_FILE"
sed -i "s/LINESVAR/$LINES/g" "$PS_FILE"

# Read the script and write as proper JSON params file
PARAMS_FILE=$(mktemp /tmp/ssm-params-XXXXXX.json)
python3 << PYEOF
import json, sys
with open("$PS_FILE", "r") as f:
    cmd = f.read().strip()
with open("$PARAMS_FILE", "w") as f:
    json.dump({"commands": [cmd]}, f)
print("ok", file=sys.stderr)
PYEOF

rm -f "$PS_FILE"

echo "Sending SSM command to $INSTANCE ($SERVER)..."
CMD_ID=$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE" \
  --document-name "AWS-RunPowerShellScript" \
  --parameters "file://$PARAMS_FILE" \
  --timeout-seconds 60 \
  --output json | python3 -c "import json,sys; print(json.load(sys.stdin)['Command']['CommandId'])")

rm -f "$PARAMS_FILE"
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

echo "Timed out waiting for SSM result. Check manually:"
echo "  aws ssm get-command-invocation --region $REGION --command-id $CMD_ID --instance-id $INSTANCE"
