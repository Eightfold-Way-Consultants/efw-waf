# CloudWatch Agent config (Turnstile telemetry)

Source of truth for the **amazon-cloudwatch-agent** configuration that ships the
Turnstile telemetry event logs (twproxy / estimator / pdfreport) to CloudWatch Logs.

## Files

- `AmazonCloudWatch-windows.json` — the full agent config. Mirrors the live SSM
  String parameter **`AmazonCloudWatch-windows`** (region **us-west-1**) verbatim,
  plus six appended `logs.logs_collected.files.collect_list` entries for the new
  telemetry globs.
- `deploy-agent-config.ps1` — put the parameter + fetch-config on the target
  instances. Nothing runs on import; work happens only when the script is invoked.

## One parameter drives two boxes

**`AmazonCloudWatch-windows`** (us-west-1, type String) is the *single* config for
BOTH:

- **web-06** — `i-0c82adf476c7c5e32` — prod / public
- **web-04** — `i-0272763b46610ac1b` — preview2

There is no on-disk json on either instance; both `fetch-config` from this one
parameter. The config uses `{hostname}` / `{instance_id}` interpolation so one value
serves both boxes.

> The Logon box **web-03b** uses a **separate** parameter
> (`WindowsAgentConfig-Logon`). It is **not** touched by anything in this folder.

## Log groups: who owns them

The emitter writes pure-JSON lines (internal `ts` field) to
`C:\temp\{yyyy_MM}-{base}-{env}.txt` where
`base ∈ {twproxy-events, estimator-events, pdfreport-events}` and
`env ∈ {production, preview}`.

| Glob (`C:\temp\...`)                    | Log group                   | Owner / retention |
|-----------------------------------------|-----------------------------|-------------------|
| `*-twproxy-events-production.txt`       | `/twproxy/events`           | **CFN** (logon-telemetry.yaml) — retention omitted here |
| `*-estimator-events-production.txt`     | `/estimator/events`         | **CFN** — retention omitted here |
| `*-pdfreport-events-production.txt`     | `/pdfreport/events`         | **CFN** — retention omitted here |
| `*-twproxy-events-preview.txt`          | `/twproxy-preview/events`   | **agent** — `retention_in_days: 14` |
| `*-estimator-events-preview.txt`        | `/estimator-preview/events` | **agent** — `retention_in_days: 14` |
| `*-pdfreport-events-preview.txt`        | `/pdfreport-preview/events` | **agent** — `retention_in_days: 14` |

**Prod groups are CFN-owned** (the logon-telemetry.yaml stack creates the group and
sets retention — same pattern as the existing `/logon/events` glob), so the prod
entries here deliberately **omit `retention_in_days`** to avoid the agent fighting
CloudFormation over the retention policy. **Preview groups are agent-owned**: the
agent auto-creates them and applies the 14-day retention set here.

No `timestamp_format` on the telemetry globs — the lines are pure JSON with an
internal `ts`, mirroring the existing `/logon/events` glob.

## CRITICAL: preview deploys MUST set `TelemetryEnv=preview`

The emitter picks the filename `env` from the app's **`TelemetryEnv`** appSetting,
which **defaults to `production`**. That default is correct for prod deploys.

But the preview deploys — **web-04 preview2** (estimator / twproxy) and **web-06
pdfreport4-preview** — **MUST set appSetting `TelemetryEnv=preview`**. Otherwise the
preview emitter writes `*-production.txt`, which matches the **prod** glob above and
**leaks preview telemetry into the CFN-tapped production lake**.

- Prod deploys: leave `TelemetryEnv` at the default (`production`).
- Preview deploys: **explicitly set `TelemetryEnv=preview`.**

## Deploy

> Not run automatically. Run manually when you intend to ship a config change.

```powershell
# put the parameter, then fetch-config on web-06 + web-04 (default targets)
.\deploy-agent-config.ps1

# one box only, and re-fetch without re-uploading the parameter
.\deploy-agent-config.ps1 -InstanceIds i-0c82adf476c7c5e32 -SkipPut

# upload the parameter only, no instance fetch
.\deploy-agent-config.ps1 -SkipFetch
```

The script validates the json locally, `put-parameter --overwrite`s
`AmazonCloudWatch-windows` (String, us-west-1) from the file, then sends
`amazon-cloudwatch-agent-ctl.ps1 -a fetch-config -m ec2 -s -c
ssm:AmazonCloudWatch-windows` to each target via `AWS-RunPowerShellScript` and polls
each invocation to `Success`.
