# Logon logging strategy — assessment + B→C upgrade plan (2026-07-10)

Status: **BUILT + DEPLOYED + VALIDATED end-to-end 2026-07-10.** Stack `logon-telemetry` live in us-west-1
(acct 874922373146); app leg committed (git Logon `main` 73e2e05) + published to preview & prod; agent
config pushed (SSM param `WindowsAgentConfig-Logon`, **Advanced tier** — config >4KB). Verified both envs
flow app→file→CW agent→`/logon(-preview)/events`; prod additionally →subscription→Firehose→S3→Glue→Athena
(`logon_telemetry.events` queried, rows returned). Preview isolation confirmed live (prod group tapped,
preview group has zero subscription filters). 3-agent code review done, all findings fixed. SNS topic
`logon-telemetry-alarms` created; jeastman@eightfoldway.com subscription **pending email confirmation**.
Originally written after soak-checking the 2026-07-09 fleet publish and hand-grepping
`C:\temp\2026_07-logon.txt` on web-03b — which is what surfaced "the logging feels crude." History below.

## TL;DR
- The **architecture** (two planes: alarmable metrics + forensic lines) is sound and deliberate. Keep it.
- The **forensic plane implementation** is crude in 5 concrete ways (below).
- Fix = structured CloudWatch Logs + Insights (hot) → kills the SSM hand-grep.
- **DECISION 2026-07-10 (revised): one-shot B+C, not B-then-C.** Firehose/S3/Glue have ~zero standing
  cost (Firehose bills per-GB, idle≈$0), the WAF Glue/Athena pattern already exists to copy, and building
  the lake now makes telemetry **durable from day one** (history accrues before per-site reporting is
  built) and lets CW-Logs retention be short (14d) immediately. The B-first gate was false economy.
- Template written: **`cloudformation/logon-telemetry.yaml`** (single stack, B+C).
- Still 3 legs: template + app `LogEventWriter` (pure-JSON emit) + agent collect_list. The app+agent legs
  were always shared between B and C, so one-shot adds no app work.
- Anti-pattern still avoided: app emits ONCE (to the file→CWL); C is a subscription-filter tap, not a 2nd
  emit path. Sink = **S3/Athena** (same as WAF/CloudFront in `diagnostics.yaml`). No BigQuery — BQ in this
  estate is ONLY the separate `efw-analytics` uptime monitor; nothing here exports to it.

---

## Current state (as-built)

Two independent planes, both fire-and-forget, both swallow errors (logging must never break auth):

**Plane 1 — metrics (alarmable).** Analytics classes call `PutMetricData` directly:
- `TurnstileVerify` dims Endpoint / Result(pass|fail|absent|pass-ratelimited|bypassed-auth) — `TurnstileAnalytics.cs`
- `TurnstileWidget` dims Event(solved|failed) / Action — `TurnstileWidgetAnalytics.cs` (the client beacon)
- `RateLimitBlock` dims Endpoint — `RateLimitAnalytics.cs`
- `Exceptions` dims Type — `CloudWatchFanoutModule.cs` (ELMAH `Logged` fan-out)
- Namespace = `Logon-Production` / `Logon-Preview` (env in namespace, not a dim), region us-west-1.
- **Verdict: good.** Cheap, alarmable, cardinality-disciplined (allowlist + sanitize on every dim).

**Plane 2 — forensic lines.** `efw.WebAPIUtil/LogTraceWriter.cs`:
- Appends `<DateTime.Now "u">: <text>` to `c:\temp\yyyy_MM-<TraceKey>.txt`.
- Structured events are JSON *embedded in a text line*: `… : TURNSTILE {json}` / `… : TSWIDGET {json}`.
- Month-prefixed files, 6-month retention, prune once/24h under a process-wide lock.
- CloudWatch **agent tails** `c:\temp\*-logon.txt` → log group `/logon/trace`, stream `{instance_id}`
  (`CloudWatch/WindowsAgentConfig-Logon.json`, SSM param `WindowsAgentConfig-Logon`). So the lines
  DO reach CloudWatch — they're just unstructured there.

Deliberately **not** in SQL: bot scans spike writes during the exact attack window; SQL isn't natively
alarmable; IP/hostname telemetry shouldn't sit next to credentials. (Sound reasoning — keep it.)

## Why it feels crude (5 real edges)

1. **No queryable structured sink.** Payload is JSON but wrapped in a text line; no Logs-Insights parse,
   no metric-filter, no Athena. The *only* way to size e.g. `error-300010` is regex over a temp file
   (exactly what we did 7/09 + 7/10). This is the "durable forensic sink still open" item parked in
   `turnstile-integration-plan-2026-06-17.md`. **This is the thing being felt.**
2. **Synchronous open/write/close per line, under a global lock, on the request thread.**
   `File.AppendAllText` + `_lock` every line → serializes auth requests behind IO under a burst, worst
   exactly when logs matter most. (Same family as the estimator per-line-flush note.)
3. **Timestamp lies by design, correct only by luck.** Line prefix `DateTime.Now.ToString("u")` emits a
   trailing `Z` (implies UTC) while reading **local** time. Correct only because web-03b is UTC
   (confirmed 2026-07-10: `Get-TimeZone` = UTC, `Now == UtcNow`). Move/clone to a non-UTC host → every
   timestamp silently wrong. Filenames use `Now` too → month rolls at local midnight.
4. **`c:\temp` hardcoded as trace root** (`TRACE_ROOT`). "temp" connotes deletable; no ACL intent; shared
   with legacy `Logon.2.0.txt`.
5. **No correlation id between planes.** A metric spike can't be joined to specific forensic lines — no
   request/trace id on either side. You eyeball timestamps.

---

## Plane B — structured CloudWatch Logs (BUILD NOW)

Goal: query `outcome` / `reason` / `hostname` / `endpoint` without SSM-grepping a temp file, and design the
emission so C is later a config-add, not a refactor.

### B1. Emit a pure-JSON event per record on a **dedicated** stream
- Add a typed emitter (e.g. `LogEventWriter.Emit(object)`) that writes **one pure-JSON object per line**
  (no `<ts>: PREFIX ` wrapper) to a separate `TraceKey` → `c:\temp\yyyy_MM-logon-events.txt`.
  - Keeping it separate from the noisy request-trace file means the structured stream stays 100% JSON →
    Logs Insights auto-discovers fields and a JSON SerDe works downstream (C) with zero munging.
  - Every event carries: `ts` (**UtcNow, ISO-8601**), `type` (`turnstile`|`widget`|`ratelimit`|`exception`),
    `env`, plus the existing per-type fields, plus a `rid` correlation id (see B3).
- Point the CloudWatch agent at the new file → new log group **`/logon/events`** (leave `/logon/trace`
  for framework/breadcrumb noise). One-line add to `WindowsAgentConfig-Logon.json` + fetch-config.

### B2. Fix the 3 cheap edges while touching this code
- Timestamp → `DateTime.UtcNow` everywhere in the writer (prefix **and** filename bucket).
- `TRACE_ROOT` → configurable app-setting, default a real dir (e.g. `D:\logs\logon` or `%ProgramData%`),
  not `c:\temp`.
- Replace append-per-line with a kept-open buffered `StreamWriter` + periodic/`AutoFlush` timer (bounded
  by the same lock, flushed on interval) so a burst isn't N open/close syscalls. Keep IO-swallow.

### B3. Correlation id
- Stamp an `rid` (e.g. `HttpContext` request id / GUID) on both the metric (as no new dimension — put it
  in the **line** only) and the JSON event, so an alarm on a metric spike → `filter rid=…` in Insights
  pulls the exact forensic records.

### B4. Logs Insights queries (ship as saved queries)
- Solve rate: `filter type="widget" | stats sum(event="solved") as solved, sum(event="failed") as failed by bin(1h)`
- Failure reasons: `filter type="widget" and event="failed" | stats count() by reason, hostname`
  → the `error-300010` vs `unsolved` split, no SSM.
- Tokenless attempts: `filter type="turnstile" and outcome="absent" | stats count() by endpoint, ip`
- ratelimited:global watch: `filter type="turnstile" and outcome in ["fail","pass-ratelimited"] | ...`

### B5. Metric filters (optional, only if you want alarms off the *lines* not the PutMetricData plane)
- Generally unnecessary — Plane 1 already emits alarmable metrics. Skip unless a field you want to alarm on
  (e.g. `reason=error-300010` rate) isn't a metric dimension. If so, a metric filter over `/logon/events`
  is cheaper than adding a high-cardinality dimension.

**Effort:** ~½–1 day (writer change + agent config + saved queries). No new infra, no IAM beyond existing.
**Payoff:** the hand-grep dies; reason/hostname/outcome are queryable in seconds.

---

## Plane C — Firehose → S3 → Athena (BUILD WHEN per-site reporting is real)

C is a **tap on B's `/logon/events` group**, not a new emission path.

```
/logon/events  --subscription filter-->  Kinesis Firehose  -->  S3 (Parquet, dt=partitioned)  -->  Glue table  -->  Athena
```

### C1. Pipeline
1. **Subscription filter** on `/logon/events` (pattern `{ $.type = "turnstile" || $.type = "widget" }` or
   all) → Firehose. CloudWatch Logs assumes a role to write Firehose → **no app change**.
2. **Firehose** delivery stream: buffer 60s/5MB; **dynamic partitioning** `dt=!{yyyy-MM-dd}` (+ optional
   `hostfamily`); optional **record-format-conversion JSON→Parquet** via a Glue schema; deliver to
   `s3://efw-logon-telemetry/events/dt=…/`.
3. **Glue table** `logon_events` — reuse the **partition-projection** pattern already in
   `diagnostics.yaml` (`projection.date.*` — no crawler). Columns = the flat JSON event shape.
4. **Athena** named queries + a per-site view `WHERE hostname IN (<client host family>)` — same shape as
   the `efw-analytics` per-site pattern (`PROPERTY_TO_URL` → `WHERE check_url=…`), Athena instead of BQ.
5. **Lifecycle:** S3 → Glacier/Deep-Archive after N months. Retention = years for pennies.

### C2. Cost / latency (all trivial at current volume)
- Firehose min ~60s to S3 (cold, not real-time). Firehose $0.029/GB, S3 pennies, Athena $5/TB **scanned**
  → Parquet + date partition = per-site query scans MB = sub-cent.
- Contrast B (CW Logs) $0.50/GB ingest — fine at this volume, but C is where you'd park long retention.

### C3. One real friction (be honest)
- **Region + account split breaks the "single WAF pane."** `diagnostics.yaml` (Glue `efw_waf_logs`,
  Athena workgroup) is **us-east-1** (CloudFront-scope WAF/CF log bucket). Logon telemetry is **us-west-1**
  and in the DEFAULT account `874922373146` (where twproxy/turnstile-prod live), not necessarily the WAF
  account. So a single Athena query joining auth events to WAF blocks is **cross-region + cross-account** —
  not free. Options: (a) accept a *separate* us-west-1 Glue DB for logon (no WAF join — most per-site
  reports don't need it); (b) ship/replicate logon Parquet to the us-east-1 bucket to get the join;
  (c) Athena cross-account via Lake Formation / cross-account catalog. **Chosen: (a)** — separate us-west-1
  Glue DB, per the template. Add the join only if a report actually needs it.
- **Sink = S3/Athena, same estate as the WAF/CloudFront logs. No BigQuery.** (The only BQ in this org is
  the separate `efw-analytics` uptime monitor — unrelated, nothing here exports to it.)

**Effort:** ~2–3 days (Firehose + subscription filter + Glue table + Athena queries + IAM; new us-west-1
stack `logon-telemetry.yaml` per C3a).

---

## Does B+C make sense? — yes, as hot/cold, not as parallel builds

| | B — CW Logs Insights | C — S3 / Athena |
|---|---|---|
| temperature | hot (seconds) | cold (minutes) |
| use | incident triage, alarms, "last hour" | per-site client reports, durable retention, WAF join |
| retention cost | pricey at scale | cheap forever (S3) |
| build | ~½–1 day | ~2–3 days |

Single structured emission → CW Logs (B) → subscription filter → Firehose → S3 (C). C plugs onto B; B is
not throwaway. **Do NOT** have the app write both a file and Firehose (two emit paths, drift, double
failure modes).

## Recommendation / sequencing (REVISED 2026-07-10 → one-shot)
1. **Deploy `cloudformation/logon-telemetry.yaml`** (us-west-1, acct 874922373146) — log group + retention
   + Insights queries + alarms (hot) AND S3 + Firehose + Glue + Athena (cold), one stack. Deploy CF FIRST,
   before wiring the agent, to own the group + retention without the auto-create race.
2. **App leg:** add `LogEventWriter` emitting pure-JSON events (fields per the Glue `events` table) to
   `…-logon-events.txt`; fix edges 2/3/4 in `LogTraceWriter` (UtcNow, buffered writer, configurable root)
   + stamp `rid`. Replace the ad-hoc `"TURNSTILE "+json` / `"TSWIDGET "+json` lines.
3. **Agent leg:** add the `…-logon-events.txt` collect_list entry → `/logon/events` in
   `WindowsAgentConfig-Logon.json`; fetch-config + restart.
4. **Deferred (consumption only):** the per-site *client report generator* on top of Athena — build when
   the report is a committed deliverable. Sink is Athena; nothing here goes to BigQuery.
5. Volume today is tiny (26 widget events/20h, 262 verify lines/10 days) → cost is a rounding error either
   way; one-shot's win is durable-from-day-one + never-revisit, not throughput.

### Preview vs production split
Both IIS sites run on the **same box** (web-03b / i-0997a73b08f6e5862): `logon.db101.org` (prod, Web.Release,
`TraceFile=logon`, namespace `Logon-Production`) and `preview-logon.db101.org` (preview, Web.Debug,
`TraceFile=preview-logon`, namespace `Logon-Preview`).
- **Metric plane** already splits by namespace → alarms target `Logon-Production` (prod-only). ✓
- **Log plane today is comingled**: agent glob `c:\temp\*-logon.txt` matches BOTH trace files → one
  `/logon/trace` stream, told apart only by content. Do NOT inherit this for the lake.
- **Design (SEPARATE GROUPS per env, not one-group+env-filter):** isolation must be **structural, not
  data-dependent** — an `env`-field FilterPattern would make lake safety hinge on `LogEventWriter` stamping
  `env` correctly every time (a bug → preview leaks into prod client data). Separate groups make preview
  physically unable to reach the lake: the subscription filter lives ONLY on `/logon/events`. `env` stays
  in the record for convenience but is no longer load-bearing for isolation.
- **Filename convention (ours to set — the fix, not clever globs).** The legacy nesting (`logon` vs
  `preview-logon`, both ending `-logon`) is why they comingle today, because prod's env is *implicit*.
  Adopt: **`YYYY_MM-logon-<env>-<plane>.txt`**, env ∈ {prod, preview} (ALWAYS explicit), plane ∈
  {events, trace}. Every (env,plane) glob is then trivially non-overlapping and BOTH planes split cleanly:
  | file base | glob | group | retention |
  |---|---|---|---|
  | `logon-prod-events` | `*-logon-prod-events.txt` | `/logon/events` | 14d, tapped to S3 |
  | `logon-preview-events` | `*-logon-preview-events.txt` | `/logon-preview/events` | 7d, hot-only |
  | `logon-prod-trace` | `*-logon-prod-trace.txt` | `/logon/trace` | 30d |
  | `logon-preview-trace` | `*-logon-preview-trace.txt` | `/logon-preview/trace` | 7d |
  Driven by two config-transformed app-settings: `TraceFile` (Release=`logon-prod-trace`,
  Debug=`logon-preview-trace`) + new `EventFile` (Release=`logon-prod-events`, Debug=`logon-preview-events`).
  Legacy `*-logon.txt` files age out under existing retention; drop the legacy `*-logon.txt` agent glob
  once rotated. `logon-` prefix still disambiguates from `Favorites2.txt` etc. in `c:\temp`.

### Verify-before-deploy (template TODOs)
- Firehose `ProcessingConfiguration` processor/param names (`Decompression` / `CloudWatchLogProcessing` /
  `AppendDelimiterToRecord`) against the current Firehose API — these unwrap the CWL subscription wrapper
  to clean JSON rows (no Lambda), the one piece the WAF-logs-native-to-S3 setup didn't need.
- `LogEventWriter` JSON field names MUST match the Glue `events` table columns (ts/type/env/rid/endpoint/
  outcome/event/action/reason/hostname/ip/ua/mode/allowed/tokenpresent/errorcodes/ratelimited).
- Alarm thresholds (widget-failed >25/hr, absent >20/hr) are placeholders — tune to observed baselines;
  alarms are gated on `AlarmSnsTopicArn` (empty = not created). Pick/confirm the SNS topic.
- Parquet is a later scan-cost optimization; template lands JSON+gzip (mirrors WAF JsonSerDe) for a
  lower-risk first deploy.

## Touch list (when B is greenlit)
- `efw.WebAPIUtil/LogTraceWriter.cs` — UtcNow; configurable root; buffered writer. (Also used by other
  services — check blast radius: twproxy/Favorites2/Vault helpers reference `efw.WebAPIUtil`.)
- New `LogEventWriter` (or a `TraceKey`-scoped mode) for the pure-JSON `/logon/events` stream.
- `TurnstileAnalytics.cs` / `TurnstileWidgetAnalytics.cs` / `RateLimitAnalytics.cs` — emit the JSON event
  alongside the existing metric (replace the ad-hoc `"TURNSTILE "+json` line).
- `CloudWatch/WindowsAgentConfig-Logon.json` — add the `-logon-events.txt` collect_list → `/logon/events`.
- Saved Logs-Insights queries (B4) — commit as a doc or a small CFN of `AWS::Logs::QueryDefinition`.

## Cross-refs
- Parked sink item: `waf-reviews/turnstile-integration-plan-2026-06-17.md` ("Analytics layer" + "Open
  decisions → durable forensic sink leaning Athena").
- Reuse target: `cloudformation/diagnostics.yaml` (Glue partition-projection pattern, Athena workgroup).
- Agent config: `Logon2.2/Logon2.2/CloudWatch/README.md`.
- Per-site pattern precedent: `efw-analytics` `uptime-site-report.js` (`PROPERTY_TO_URL`).
