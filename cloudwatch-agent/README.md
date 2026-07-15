# CloudWatch Agent config (Turnstile telemetry)

Source of truth for the **amazon-cloudwatch-agent** configuration that ships the
Turnstile telemetry event logs (twproxy / estimator / pdfreport) to CloudWatch Logs.

## Files

- `AmazonCloudWatch-windows.json` — the full agent config. Mirrors the live SSM
  String parameter **`AmazonCloudWatch-windows`** (region **us-west-1**) verbatim,
  plus six appended `logs.logs_collected.files.collect_list` entries for the
  telemetry globs (a prod + a preview glob per producer; env is carried in the
  **filename**, set by the emitter — see below).
- `deploy-agent-config.ps1` — put the parameter + fetch-config on the target
  instances. Nothing runs on import; work happens only when the script is invoked.

## One parameter drives two boxes

**`AmazonCloudWatch-windows`** (us-west-1, type String) is the *single* config for
BOTH:

- **web-06** — `i-0c82adf476c7c5e32` — prod / public
- **web-04** — `i-0272763b46610ac1b` — preview2

There is no on-disk json on either instance; both `fetch-config` from this one
parameter. Env is **not** decided by the box — it is baked into each event's filename
by the emitter (see below) — so the same six globs serve both boxes: web-06 writes
prod *and* preview files (it co-hosts both tiers), web-04 writes only preview files.

> The Logon box **web-03b** uses a **separate** parameter
> (`WindowsAgentConfig-Logon`). It is **not** touched by anything in this folder.

## Log groups: who owns them

The emitter writes pure-JSON lines (internal `ts` field) to
`C:\temp\{yyyy_MM}-{surface}-{env}-events.txt` where
`surface ∈ {twproxy, estimator, pdfreport}` and `env ∈ {prod, preview}` — **env is in
the filename** (exactly like Logon's `logon-prod-events` / `logon-preview-events`). The
agent globs each surface's prod file into its tapped group and its preview file into an
untapped group. Fixed group names (no `{hostname}`) because prod and preview are
**co-hosted on one box** and cannot be split by box identity:

| Glob (`C:\temp\...`)                 | Log group (fixed)          | Tapped to lake? |
|--------------------------------------|----------------------------|-----------------|
| `*-twproxy-prod-events.txt`          | `/twproxy/events`          | **yes**         |
| `*-twproxy-preview-events.txt`       | `/twproxy-preview/events`  | no              |
| `*-estimator-prod-events.txt`        | `/estimator/events`        | **yes**         |
| `*-estimator-preview-events.txt`     | `/estimator-preview/events`| no              |
| `*-pdfreport-prod-events.txt`        | `/pdfreport/events`        | **yes**         |
| `*-pdfreport-preview-events.txt`     | `/pdfreport-preview/events`| no              |

**All six groups are CFN-owned** (the logon-telemetry.yaml stack creates each group
and sets retention), so these agent entries deliberately **omit `retention_in_days`**
to avoid the agent fighting CloudFormation over the retention policy. Only the three
**prod** groups are lake-tapped by a subscription filter; the three **preview** groups
are hot-only. Isolation is **structural** (prod-only taps + the emitter never writing a
`*-prod-events.txt` file for preview traffic).

No `timestamp_format` on the telemetry globs — the lines are pure JSON with an
internal `ts`, mirroring the existing `/logon/events` glob.

## How env is decided — `TelemetryEnv` appSetting, else request Host

The emitter (`F8TelemetryEmitter.ClassifyEnv`) resolves `env` per request:

1. **explicit `TelemetryEnv` appSetting wins** — estimator + pdfreport carry it per-tier
   in their deployed config (estimator `_final`/`_preview` + top-level preview2 config;
   pdfreport base=`preview` + `web.pdfreport-final.config`→`prod`); web-04 twproxy pins
   `preview` in `Web.Debug.config`.
2. **else classify the client-facing request Host** — the web-06 twproxy fallback (its
   `/tw` shares one physical config across `mn` + `preview-mn` and cannot carry a per-tier
   value): `prod` iff the host has no `preview` **and** ends with `.db101.org` /
   `.hb101.org` / `.vets101.org`; else `preview`.
3. **default `preview`** when neither fires (unknown / off-request) — so nothing
   un-attributable ever writes a prod file / taps the lake.

Env is a **per-tier deploy property**, not a per-box one (every surface co-hosts prod +
preview on one box). This is why box/`{hostname}` routing was wrong and was reverted.

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
