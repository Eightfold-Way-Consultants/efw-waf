# Estimator Log Sources

## 1. CloudWatch Logs (fastest for recent errors)

Region: **us-west-1**

| Log Group | Server | Instance ID | Role |
|---|---|---|---|
| `estimator-logs/ip-10-3-0-122.us-west-1.compute.internal` | efw.web.04d (52.8.85.37) | i-0272763b46610ac1b | Edit-sites |
| `estimator-logs/ip-10-3-0-63.us-west-1.compute.internal` | efw.web.06d (52.8.7.0) | i-0c82adf476c7c5e32 | Public-sites |

CloudWatch agent watches: `C:\temp\EstimatorLogs\**\*_Error.log`

### Quick queries

```bash
# Last 24 hours, both servers
bash skills/estimator-logs/scripts/check-errors.sh

# Last 4 hours, specific site
bash skills/estimator-logs/scripts/check-errors.sh --hours 4 --site "preview2-nv.db101.org"

# Manual query
aws logs filter-log-events --region us-west-1 \
  --log-group-name "estimator-logs/ip-10-3-0-122.us-west-1.compute.internal" \
  --start-time $(date -d '24 hours ago' +%s000) \
  --filter-pattern "Application_Error" \
  --limit 20 --query 'events[*].message' --output text
```

## 2. On-Disk Logs via SSM (for deeper investigation)

SSM commands to us-west-1 servers take **60-180 seconds** to return. Be targeted.

### File structure

```
C:\temp\EstimatorLogs\
├── preview2-ak.db101.org\        (edit-site per state)
│   ├── <date>_Error.log          (error log - CW watches these)
│   └── <date>_Trace.log          (trace/info log)
├── preview2-az-es.db101.org\     (Spanish variant)
├── ...
├── _EC2AMAZ-*_YYYYMM_App.log    (monthly app-level log)
```

Public site likely mirrors this with `XX.db101.org\` folders instead of `preview2-XX`.

### Targeted SSM queries

Always use `get-command-invocation` (faster than `list-command-invocations`).

```bash
# Get recent errors for a specific state
aws ssm send-command --region us-west-1 \
  --instance-ids i-0272763b46610ac1b \
  --document-name "AWS-RunPowerShellScript" \
  --parameters 'commands=["Get-ChildItem C:\\temp\\EstimatorLogs\\preview2-nv.db101.org\\*_Error.log | Sort LastWriteTime -Desc | Select -First 1 | ForEach { Get-Content $_.FullName | Select -Last 50 }"]' \
  --timeout-seconds 60 --output json

# List all states with recent activity (last 7 days)
aws ssm send-command --region us-west-1 \
  --instance-ids i-0272763b46610ac1b \
  --document-name "AWS-RunPowerShellScript" \
  --parameters 'commands=["Get-ChildItem C:\\temp\\EstimatorLogs -Directory | Where { $_.LastWriteTime -gt (Get-Date).AddDays(-7) } | Select Name,LastWriteTime | Sort LastWriteTime -Desc | Format-Table -Auto"]' \
  --timeout-seconds 60 --output json

# Check monthly app log
aws ssm send-command --region us-west-1 \
  --instance-ids i-0272763b46610ac1b \
  --document-name "AWS-RunPowerShellScript" \
  --parameters 'commands=["Get-ChildItem C:\\temp\\EstimatorLogs\\_*_App.log | Sort LastWriteTime -Desc | Select -First 1 | ForEach { Get-Content $_.FullName | Select -Last 30 }"]' \
  --timeout-seconds 60 --output json
```

### Polling SSM results

```bash
# Send command, capture ID
CMD_ID=$(aws ssm send-command ... --output json | python3 -c "import json,sys; print(json.load(sys.stdin)['Command']['CommandId'])")

# Poll (wait 90+ seconds for us-west-1 servers)
aws ssm get-command-invocation --region us-west-1 \
  --command-id "$CMD_ID" \
  --instance-id i-0272763b46610ac1b \
  --query '[Status,StandardOutputContent]' --output json
```

## Log Message Format

```
<date> <time>.<seq> <timestamp_ms> <site>: <category>: <message>
```

- **site**: `preview2-XX.db101.org` (edit) or `XX.db101.org` (public)
- **category**: `Application_Error`, `EngineSession.DoCalculationOutputs`, etc.

## Site Naming

State codes: ak, az, ca, co, ga, ia, il, ky, mi, mn, mo, nc, nj, nv, oh
Spanish variants: append `-es` (e.g., `preview2-az-es.db101.org`)

## Common Error Patterns

| Pattern | Severity | Cause |
|---|---|---|
| `Invalid postback or callback argument` | Low | Bot/scanner stale form submissions |
| `'dict' object has no attribute 'X'` | High | Python engine bug (attribute vs bracket notation) |
| `Server returned a fault exception: [-32603]` | High | Python engine internal error via XML-RPC |
| `Global fatal exception` | Varies | Unhandled exception in Application_Error — check inner exception |

## Instance IDs

| Instance | Name | IP | Role | Region |
|---|---|---|---|---|
| i-0272763b46610ac1b | efw.web.04d edit-site | 52.8.85.37 | Edit/preview sites | us-west-1 |
| i-0c82adf476c7c5e32 | efw.web.06d public-site | 52.8.7.0 | Production public sites | us-west-1 |
| i-0997a73b08f6e5862 | efw.web.03b logon | 54.153.101.192 | Login/auth server | us-west-1 |
