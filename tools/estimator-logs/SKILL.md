---
name: estimator-logs
description: Investigate BP101 Estimator errors from CloudWatch logs and on-disk log files via SSM. Use when asked about estimator errors, estimator crashes, calculation engine failures, edit-site or public-site application errors, or any db101/bp101 server-side issues. Covers both edit-site (preview2-*.db101.org) and public-site (*.db101.org) estimator instances across 15 states.
---

# Estimator Log Investigation

Three log sources, use in order:

1. **CloudWatch** — fast, for recent errors (seconds)
2. **SSM estimator logs** — deeper investigation, specific sessions (60-180s per query)
3. **SSM IIS request logs** — HTTP-level detail, 500 errors, request patterns (public-site server only)

## 1. CloudWatch (Quick Check)

```bash
# Last 24h, both servers
bash skills/estimator-logs/scripts/check-errors.sh

# Specific site, last 4 hours
bash skills/estimator-logs/scripts/check-errors.sh --hours 4 --site "preview2-nv.db101.org"

# Public site only
bash skills/estimator-logs/scripts/check-errors.sh --hours 24 --server public
```

CloudWatch watches `C:\temp\EstimatorLogs\**\*_Error.log` — may not capture all log files (only error-specific ones).

## 2. SSM On-Disk Logs (Deep Investigation)

```bash
# Tail recent logs for a specific state's edit-site
bash skills/estimator-logs/scripts/ssm-tail-errors.sh preview2-nv.db101.org

# Public site
bash skills/estimator-logs/scripts/ssm-tail-errors.sh nv.db101.org --server public --lines 100
```

SSM takes 60-180 seconds. Always target a specific site folder — never search the whole disk.

## Triage

1. Run CloudWatch check for recent errors
2. Identify the site (e.g., `preview2-nv.db101.org` = Nevada edit-site)
3. Classify: bot noise (`Invalid postback`) vs real bug (`EngineSession` / `fault exception`)
4. For real bugs: use SSM to get full session logs, then search codebase with `qmd search`

## Code Investigation

```bash
qmd search "EngineSession DoCalculationOutputs" -c f8-bp101-interface -n 5
qmd get qmd://f8-bp101-interface/session/EngineSession.cs
```

XML-RPC fault exceptions = Python engine bug, not C# interface bug.

## 3. IIS Request Logs (Public Site Only)

Active on public-site server (`i-0c82adf476c7c5e32`). Disabled on edit-site.

Script dynamically resolves site name → IIS site ID → log file:

```bash
# 500 errors for mi.db101.org today
bash skills/estimator-logs/scripts/ssm-iis-errors.sh mi.db101.org

# Custom pattern, more lines
bash skills/estimator-logs/scripts/ssm-iis-errors.sh mi.db101.org --pattern "500" --lines 50

# Specific date (UTC YYMMDD)
bash skills/estimator-logs/scripts/ssm-iis-errors.sh mi.db101.org --date 260223
```

Useful for: identifying bot IPs, request patterns, correlating error times with HTTP requests.

## Reference

See `references/log-groups.md` for CloudWatch details, estimator file paths, server details, and common error patterns.
