#!/usr/bin/env bash
# run-iis-rate-check-planning-only.sh — Run planning-only rate analysis via SSM

set -euo pipefail

DATE_STRING="${1:?Usage: $0 <YYMMDD>}"
SCRIPT_PATH="${2:-/home/jack/.openclaw/workspace/skills/estimator-logs/scripts/iis-rate-check-planning-only.ps1}"
INSTANCE_ID="i-0c82adf476c7c5e32"
REGION="us-west-1"
OUTPUT_DIR="/tmp/iis-rate-check-$DATE_STRING"

# Encode script as base64 (ASCII-only)
SCRIPT_BASE64=$(base64 -w 0 "$SCRIPT_PATH")

# Run via SSM
aws ssm send-command \
  --instance-id "$INSTANCE_ID" \
  --document-name "AWS-RunPowerShellScript" \
  --parameters "{\"commands\":[\"[System.Text.Encoding]::ASCII.GetString([System.Convert]::FromBase64String('$SCRIPT_BASE64')) | iex\"],\"executionTimeout\":[\"3600\"]}" \
  --region "$REGION" \
  --output text \
  --query "Command.CommandId" > "$OUTPUT_DIR/command-id.txt"

COMMAND_ID=$(cat "$OUTPUT_DIR/command-id.txt")

# Wait for completion and download results
echo "Waiting for command $COMMAND_ID to complete..."
while true; do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --region "$REGION" \
    --query "Status" \
    --output text)
  
  if [[ "$STATUS" == "Success" ]]; then
    break
  elif [[ "$STATUS" == "Failed" || "$STATUS" == "Cancelled" || "$STATUS" == "TimedOut" ]]; then
    echo "ERROR: Command failed with status $STATUS" >&2
    exit 1
  fi
  
  sleep 10
  echo -n "."
done

echo "Command completed. Downloading results..."

# Download output files
aws ssm list-command-invocations \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --region "$REGION" \
  --query "CommandInvocations[0].CommandPlugins[0].OutputS3Location" \
  --output text | awk '{print $2}' > "$OUTPUT_DIR/s3-path.txt"

S3_PATH=$(cat "$OUTPUT_DIR/s3-path.txt")
if [[ -z "$S3_PATH" ]]; then
  echo "ERROR: No S3 output path found" >&2
  exit 1
fi

aws s3 cp "$S3_PATH" "$OUTPUT_DIR/" --recursive

# Verify output files
echo "Rate analysis complete. Results saved to $OUTPUT_DIR:"
ls -l "$OUTPUT_DIR/"

# Upload to S3 for local access
aws s3 cp "$OUTPUT_DIR/" "s3://efw.backup/tmp/iis-rate-check-$DATE_STRING/" --recursive