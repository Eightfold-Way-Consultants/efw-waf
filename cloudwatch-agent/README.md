# CloudWatch Agent config (Turnstile telemetry)

Source of truth for the **amazon-cloudwatch-agent** configuration that ships the
Turnstile telemetry event logs (twproxy / estimator / pdfreport) to CloudWatch Logs.

## Files

- `AmazonCloudWatch-windows.json` — the full agent config. Mirrors the live SSM
  String parameter **`AmazonCloudWatch-windows`** (region **us-west-1**) verbatim,
  plus three appended `logs.logs_collected.files.collect_list` entries for the
  telemetry globs (one per producer; prod/preview split is by `{hostname}`).
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
`C:\temp\{yyyy_MM}-{base}.txt` where
`base ∈ {twproxy-events, estimator-events, pdfreport-events}` — **no env in the
filename**. The prod/preview split is done by the agent's `{hostname}` interpolation
(same convention as `twproxy-logs/{hostname}`), so each of the three globs lands in a
**different log group per box**:

| Glob (`C:\temp\...`)         | Group template            | web-06 (prod) group                                    | web-04 (preview) group                                  |
|------------------------------|---------------------------|--------------------------------------------------------|---------------------------------------------------------|
| `*-twproxy-events.txt`       | `twproxy-events/{hostname}`   | `twproxy-events/ip-10-3-0-63.us-west-1.compute.internal`   | `twproxy-events/ip-10-3-0-122.us-west-1.compute.internal`   |
| `*-estimator-events.txt`     | `estimator-events/{hostname}` | `estimator-events/ip-10-3-0-63.us-west-1.compute.internal` | `estimator-events/ip-10-3-0-122.us-west-1.compute.internal` |
| `*-pdfreport-events.txt`     | `pdfreport-events/{hostname}` | `pdfreport-events/ip-10-3-0-63.us-west-1.compute.internal` | `pdfreport-events/ip-10-3-0-122.us-west-1.compute.internal` |

**All six groups are CFN-owned** (the logon-telemetry.yaml stack creates each group
and sets retention), so these agent entries deliberately **omit `retention_in_days`**
to avoid the agent fighting CloudFormation over the retention policy. Only the three
**prod** (`ip-10-3-0-63`) groups are lake-tapped by a subscription filter; the three
**preview** (`ip-10-3-0-122`) groups are hot-only. That isolation is **structural**
(hostname routing + prod-only taps), not dependent on any per-record or per-deploy env
field being set correctly.

No `timestamp_format` on the telemetry globs — the lines are pure JSON with an
internal `ts`, mirroring the existing `/logon/events` glob.

## prod/preview split is automatic — nothing to set on deploy

The emitter writes **env-less** filenames on every box. Which lake a box's telemetry
reaches is decided entirely by **which box it is**: the agent's `{hostname}` routes
**web-06 → the prod group** (lake-tapped) and **web-04 → the preview group** (hot-only).
There is **no `TelemetryEnv` appSetting** and **no per-app / per-deploy configuration** —
prod and preview deploys ship the identical app config, and a preview box physically
cannot write into a prod group. Nothing to remember, nothing to get wrong.

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
