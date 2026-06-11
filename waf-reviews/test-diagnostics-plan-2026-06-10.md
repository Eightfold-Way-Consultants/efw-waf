# Test & Diagnostics Plan — WAF + CloudFront Rollout

**Date:** 2026-06-10
**Goal:** "I need to be sure I can quickly surface and repair issues as they become visible" — per-phase during rollout, and steady-state after.
**Sources of truth:** `waf-cloudfront-migration.md` (phases), `cloudformation/base.yaml` + `edge.yaml` + `redirect.yaml` (actual resources). Nothing below assumes infrastructure that isn't in those templates unless explicitly marked **PROPOSED**.

**Fixed names used throughout** (from the templates — account `874922373146`, all WAF/CloudFront ops in `us-east-1`):

| Thing | Name |
|---|---|
| Stacks | `efw-waf-base`, `efw-waf-edge-edit-cms`, `efw-waf-edge-preview2`, `efw-waf-edge-public`, (redirect: `efw-waf-redirect`) |
| Web ACLs (= CloudWatch `WebACL` dim) | `efw-edit-cms-web-acl`, `efw-preview2-web-acl`, `efw-public-web-acl` |
| Rule metric names (= CloudWatch `Rule` dim) | `IP-Blocklist-Scanners`, `SensitivePaths`, `AWS-IpReputation`, `AWS-CommonRuleSet`, `AWS-KnownBadInputs`, `Challenge-Estimator`, `RateLimit-Estimator`, `RateLimit` (+ `AWS-BotControl` if ever enabled) |
| Log bucket | `s3://aws-waf-logs-efw-874922373146` — WAF logs under `AWSLogs/874922373146/WAFLogs/cloudfront/<acl-name>/YYYY/MM/DD/HH/mm/`, CloudFront access logs under `cf-edit-cms/`, `cf-preview2/`, `cf-public/` |
| Secrets | `efw-waf/origin-verify`, `efw-waf/dist/preview2`, `efw-waf/dist/public` |
| Alarms (in template) | `efw-<env>-cf-5xx`, `efw-<env>-waf-blocked` → SNS `efw-waf-alarms` |
| Origins | web-04 `52.8.85.37` (internal `10.3.x.x`), web-06 `52.8.7.0` (internal `10.3.0.63`) |
| Rate limits | site-wide 500/IP/5min; `/planning/*` 300/IP/5min (published tiers) |

**Two reusable techniques used everywhere below:**

```bash
# (T1) Test THROUGH CloudFront before/without DNS cutover — point the request at the
# distribution while keeping the real Host/SNI. $CF = the stack's DistributionDomainName output.
curl -sI "https://mn.db101.org/" --connect-to "mn.db101.org:443:$CF:443"

# (T2) Bypass CloudFront and hit the origin directly (compare answers, isolate edge vs origin):
curl -sI "https://mn.db101.org/" --resolve "mn.db101.org:443:52.8.7.0"     # public/staging origin
curl -sI "https://db101-mn.eightfoldway.com/" --resolve "db101-mn.eightfoldway.com:443:52.8.85.37"
```
If (T1) works and (T2) works but the live hostname fails → DNS/propagation. If (T2) works and (T1) fails → CloudFront/WAF. If (T2) fails → origin. This triage is the first move in almost every decision tree in §3.

---

## 1. Per-phase test matrix

Phase order follows the repo plan: **preview2 canary leads** (Phase 0), then edit-cms (Phase 1), edit Block (2), public canary (3), public full incl. staging (4), public Block, then steady state.

### Phase P-1 — Template deploy (base + first edge stack), no DNS change

**Entry criteria**
- `aws cloudformation validate-template` + cfn-lint clean (done 2026-06-09); ACM cert ISSUED (done).
- `hb101.org` registry renewal confirmed (expires **2026-06-23** — hard gate before any hb101 cutover).
- Deploy with `--no-execute-changeset` first; review the change set (this is the first real test of the cross-stack `!ImportValue`s and the `{{resolve:secretsmanager}}` dynamic ref — lint did not prove these).

**Smoke tests (no user traffic at risk)**
```bash
# Stack health + outputs
aws cloudformation describe-stacks --stack-name efw-waf-base --region us-east-1 --query 'Stacks[0].StackStatus'
CF=$(aws cloudformation describe-stacks --stack-name efw-waf-edge-preview2 --region us-east-1 \
     --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text)

# WAF ACL exists, logging configured
aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1
aws wafv2 get-logging-configuration --resource-arn <WebAclArn> --region us-east-1

# Distribution answers on its default domain (wrong-Host page or 403 is fine; TLS must work)
curl -sI "https://$CF/"

# Through-CF with real Host BEFORE DNS (T1): expect 200, server header from IIS,
# x-cache: Miss from cloudfront, x-amz-cf-pop populated
curl -sI "https://preview2.eightfoldway.com/" --connect-to "preview2.eightfoldway.com:443:$CF:443"

# Static caching: second hit must be x-cache: Hit from cloudfront with Age header
curl -sI "https://preview2.eightfoldway.com/dist/site.css" --connect-to "preview2.eightfoldway.com:443:$CF:443"
curl -sI "https://preview2.eightfoldway.com/dist/site.css" --connect-to "preview2.eightfoldway.com:443:$CF:443"
# (substitute a real /dist/ or *.css asset from the page source)

# Dynamic stays uncached: *.aspx must show x-cache: Miss from cloudfront on EVERY hit
curl -sI "https://preview2.eightfoldway.com/some-page.aspx" --connect-to "preview2.eightfoldway.com:443:$CF:443"

# X-Origin-Verify resolved (not the literal '{{resolve:...}}' string): check it arrived at IIS —
# on web-04 IIS log/Failed Request Trace, or temporarily echo the header in a test page.
aws secretsmanager get-secret-value --secret-id efw-waf/origin-verify --query SecretString --output text
```
**Also:** confirm WAF log objects appear in `s3://aws-waf-logs-efw-874922373146/AWSLogs/874922373146/WAFLogs/cloudfront/efw-preview2-web-acl/` within ~10 min of sending test traffic, and CF access logs under `cf-preview2/` within ~1 h. **Create the Athena tables now (§2.2) — do not wait for an incident.**

**Exit criteria:** all of the above pass; change-set review showed no surprises; per-rule metrics visible in CloudWatch (`AWS/WAFV2`, see §2.1) after test traffic.

---

### Phase 0 — preview2 canary (`preview2.eightfoldway.com` → CloudFront, Count mode)

**Entry:** P-1 green; Route53 TTL on the record lowered to 60s ≥24h prior; **DNS snapshot + revert change-batch file written and tested with `--no-execute`** (see §4/§6 `dns-rollback.ps1`); perf baseline captured (`perf-baseline-edit-<date>.md` per master plan §A).

**Smoke (post-DNS, repeat the P-1 curls without `--connect-to`)**
```bash
dig +short preview2.eightfoldway.com   # → dxxxx.cloudfront.net
curl -sI https://preview2.eightfoldway.com/                          # 200, x-cache present
curl -sI http://preview2.eightfoldway.com/                           # 301 → https (edge redirect)
curl -sI https://preview2.eightfoldway.com/dist/<asset>.css          # Miss then Hit + Age
curl -sI "https://preview2.eightfoldway.com/<page>.htm"              # published tier: cached (Hit on 2nd)
curl -sI "https://preview2.eightfoldway.com/<page>.aspx"             # never cached
```

**Functional**
- Browse the preview2 site in a real browser (images, css, navigation).
- WebDeploy via VPN to 10.3.x.x still works (unchanged path — verify anyway).
- `ExportForPreview` → content visible. **Until `InvalidateCdn` ships, `*.htm` is cached up to 24h on this tier** — interim manual flush:
```bash
DIST_ID=$(aws secretsmanager get-secret-value --secret-id efw-waf/dist/preview2 --query SecretString --output text)
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/<changed-dir>/*"
```

**Monitoring during canary (2h active, then daily):** §2 count-mode review on `efw-preview2-web-acl`; `efw-preview2-cf-5xx` alarm quiet; public-url-checker status page clean (it doesn't monitor preview2 — rely on the curls + editors).

**Exit:** 48h+ with zero unexplained 4xx/5xx, cache behaving (Hit on static, Miss on dynamic), Count log shows no legit traffic matching Block-action rules, dynamic TTFB regression <100ms vs baseline.

---

### Phase 1 — edit-cms full migration (Count mode)

Aliases: `db101-<state>.eightfoldway.com`, `hb101-mn.eightfoldway.com`, `vets101.eightfoldway.com`, **`q.db101.org`** (must be re-pointed off the preview2 chain to the edit-cms distribution).

**Entry:** Phase 0 exit met; codebase audit of `*.ashx/*.asmx/*.axd` done; DNS revert files staged for every alias; `efw-waf-edge-edit-cms` deployed and (T1)-verified for at least one host per family.

**Smoke**
```bash
curl -sI https://db101-mn.eightfoldway.com/            # 401 NTLM challenge expected (not 200) — auth passes through
curl -sI https://q.db101.org/params.xml                 # 200, x-cache: Miss from cloudfront (q must NEVER cache)
curl -sI https://q.db101.org/tips.json                  # 200, Miss every time
curl -sI https://db101-mn.eightfoldway.com/dist/<asset>.css   # universal static: Hit on 2nd fetch
```
- public-url-checker hits `q.db101.org/*` hourly — **watch the status page / BigQuery for the first few hours after the q cutover**; it is the live regression detector for this host.

**Functional (the CMS canary trio)**
1. **Login** — NTLM/Negotiate auth into `https://db101-mn.eightfoldway.com/admin/` through CloudFront (NTLM is connection-oriented; this is the riskiest auth pattern behind a proxy — must test in a real browser, not curl).
2. **Edit + Save** — open the tree-control admin page, make an edit, save. This POSTs the **~45KB `__VIEWSTATE`** body. On cms tier `SizeRestrictions_BODY` is overridden to Count, but **`SQLi_BODY`/`CrossSiteScripting_BODY` are NOT** — in Count mode watch them (§2.4), in Block mode this is failure mode (e) in §3.
3. **Publish** — PubBot run completes against the fronted site; published output correct on staging/preview2.
- WebDeploy end-to-end on at least one site (port 8172 → VPN → 10.3.x.x).

**Exit:** 1 full week in Count with: clean §2 per-rule review (especially `AWS-CommonRuleSet` sub-rules on CMS POST bodies), CMS editors report no anomalies, q.db101.org checker uptime 100%, WebDeploy + PubBot verified.

---

### Phase 2 — edit-side Count→Block flip (edit-cms + preview2 ACLs)

**Entry:** the §2.5 pre-flip checklist returns "no legit traffic would have been blocked" for every rule on both ACLs; any dirty rule gets a `RuleActionOverride: Count` added to `edge.yaml` *before* the flip.

**Flip (a stack update; distribution untouched — takes ~2 min, WAF propagates <1 min):**
```bash
aws cloudformation deploy --stack-name efw-waf-edge-edit-cms --template-file cloudformation/edge.yaml \
  --region us-east-1 --parameter-overrides WafRuleAction=Block <…other params unchanged…>
```

**Smoke immediately after**
```bash
# Negative test — SensitivePaths must now BLOCK (403):
curl -s -o /dev/null -w '%{http_code}\n' https://db101-mn.eightfoldway.com/.env        # expect 403
curl -s -o /dev/null -w '%{http_code}\n' https://db101-mn.eightfoldway.com/web.config  # expect 403 (\.config$)
# Positive — admin still works:
#   browser: login → edit → SAVE (45KB postback) → verify saved.
```
**Exit:** 24h Block with `BlockedRequests` on each rule explainable as bot/probe traffic (§2 queries, now on `action='BLOCK'`), no editor complaints, `efw-edit-cms-waf-blocked` alarm quiet or explained.

---

### Phase 3 — public canary (`ak.db101.org`, Count mode)

**Entry:**
- Phase 2 clean for 1 week.
- **HARD GATE: print-server repoint verified.** On web-06, Puppeteer fetches `https://localhost` / `10.3.0.63` with explicit `Host:` header (NOT the public hostname). Verify *before* DNS: generate a PDF, then confirm in web-06 IIS logs the render request's `c-ip` is `127.0.0.1`/`10.3.0.63` — not `52.8.7.0`.
- `efw-waf-edge-public` deployed (Count); (T1) full test pass against `$CF` for `ak.db101.org` AND one staging host (`preview-ak.db101.org`) — both alias families live on this distribution.
- DNS snapshot + revert files staged; TTL 60s.

**Smoke (post-DNS)**
```bash
curl -sI https://ak.db101.org/                                   # 200, x-cache, x-amz-cf-pop
curl -sI https://ak.db101.org/<page>.htm; curl -sI https://ak.db101.org/<page>.htm   # Miss → Hit + Age
curl -sI https://ak.db101.org/planning/                          # 200 (Count mode: no challenge yet), Miss ALWAYS
curl -sI https://ak.db101.org/api/tips                           # 200, never cached
curl -s  https://ak.db101.org/robots.txt | grep -i planning      # Disallow intact
```

**Functional — the full estimator walk (the thing that pays the bills):**
1. Open `https://ak.db101.org/planning/`, launch an estimator (e.g. the benefits-to-work flow).
2. Walk ≥5 steps including POST postbacks; confirm the cookieless session token `(S(...))` stays in the URL and every step renders (each step is POST → 302 → GET; all three must traverse CloudFront cleanly).
3. Results page renders (the `query.aspx` results-polling pattern — multiple rapid requests — must not trip anything).
4. **Print the PDF** from results — exercises the repointed print server end-to-end.
5. Repeat the walk once more in the same browser (Count mode baseline; in Block mode this verifies one-challenge-per-immunity-window).

**Host-isolation spot-check (cache-key correctness):**
```bash
# Same path, two states — content MUST differ and each must cache independently.
curl -s https://ak.db101.org/<common-page>.htm | head -5
curl -s https://mn.db101.org/<common-page>.htm --resolve mn.db101.org:443:52.8.7.0 | head -5  # origin compare until mn is cut over
```

**Exit:** 2h supervised + 48h passive: estimator walks clean, PDF prints, checker green (`ak.db101.org` homepage is in the producer list — it becomes a real hourly canary the moment DNS flips), §2 Count review clean for public-ACL rules.

---

### Phase 4 — public full migration (all states + apexes + staging hosts, Count mode)

**Entry:** Phase 3 exit; apex ALIAS conversion plan reviewed (`db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`); per-host revert files staged; `housingbenefits101.org` redirect stack deployed and tested:
```bash
curl -sI "https://mn.housingbenefits101.org/some/path?x=1" --connect-to "mn.housingbenefits101.org:443:<redirect-CF>:443"
# expect: 301, location: https://hb101.org/some/path?x=1
```

**Smoke per migrated host family (scriptable — see §6 `smoke-host.ps1`):** homepage 200 + x-cache; one `.htm` Miss→Hit; `/planning/` 200 Miss; one `.css` Hit; apexes resolve via ALIAS (`dig db101.org` → CloudFront IPs, no more 52.8.7.0).

**Functional**
- Estimator walk + PDF on `mn.db101.org` (highest-traffic state) and `mn.hb101.org`.
- **Staging vs public isolation:** `preview-mn.db101.org` and `mn.db101.org` are on the SAME distribution — verify a page that differs between staging and public serves the right copy on each, twice (second hit = cache Hit must still be the right copy). This is the Host-in-cache-key proof; failure here = failure mode (c) in §3.
- **Publish → invalidation → fresh:** PubBot publish a visible `.htm` change → confirm `InvalidateCdn` fired (`aws cloudfront list-invalidations --distribution-id $DIST_ID`) → fetch shows new content with `x-cache: Miss` then re-cache. If the library isn't wired yet, the manual `create-invalidation` is a **required** step in the publish runbook for this phase.
- public-url-checker now covers all 18 state homepages + `mn.hb101.org` through CloudFront — watch `down.eightfoldway.com/checker` and the BigQuery `uptime_24h` view daily.

**Exit:** 72h Count, §2.5 pre-flip checklist green on `efw-public-web-acl`, checker 100%, no editor/user reports, invalidation proven.

### Phase 4b — public Count→Block flip

Same mechanics as Phase 2. Additional smoke after flip:
```bash
# Challenge is now LIVE on /planning/ — a bare curl must get the interstitial:
curl -s -o /dev/null -w '%{http_code}\n' -D - https://mn.db101.org/planning/ | grep -iE '^(HTTP|x-amzn-waf-action)'
# expect: 202 + x-amzn-waf-action: challenge
# Real browser: estimator loads with NO visible interruption, walk + PDF still work.
# Rate-limit negative test (optional, off-hours): loop >300 /planning/ hits from one IP in <5min → 403 by minute ~6.
```
**Supervised enforcement window (master plan §A):** within the first 2h of Block, run the FULL functional suite — estimator walk (fresh browser profile, i.e. no prior token), CMS save, PDF print, publish+invalidate, two-state isolation. **This is the only time Challenge solve behavior is actually measurable — capture `Challenge-Estimator` metrics now (§2.3).**

**Exit → post-rollout:** 1 clean week in Block → NACL decommission per plan; §5 steady-state monitoring takes over.

---

## 2. Count-mode analysis runbook

> Everything WAF here is `--region us-east-1` and `--scope CLOUDFRONT`. CloudWatch dimension `Region` = `Global`.

### 2.1 Metric names and dimensions (exact)

Namespace **`AWS/WAFV2`**. Dimensions: `WebACL=<acl-name>`, `Rule=<rule-metric-name>`, `Region=Global`.

| Question | Metric | Rule dim |
|---|---|---|
| What would each rule have blocked? (Count mode) | `CountedRequests` (Sum) | each of the 8 rule metric names |
| What is each rule blocking? (Block mode) | `BlockedRequests` (Sum) | same |
| Whole-ACL traffic baseline | `AllowedRequests`, `BlockedRequests` | `Rule=ALL` |
| Challenge issued (Block mode only) | `ChallengeRequests` | `Challenge-Estimator` |
| Challenge solved (token present) | `RequestsWithValidChallengeToken` | ACL-level |

```bash
# Per-rule counted hits, last 24h, hourly (repeat per Rule):
aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/WAFV2 \
  --metric-name CountedRequests --statistics Sum --period 3600 \
  --start-time $(date -u -d '24 hours ago' +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --dimensions Name=WebACL,Value=efw-public-web-acl Name=Rule,Value=AWS-CommonRuleSet Name=Region,Value=Global
```
(§6 `count-report.ps1` loops all 8 rules × 3 ACLs.)

**Sampled requests** (kept ~3 hours only — logs are the durable record):
```powershell
$acl = aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 `
       --query "WebACLs[?Name=='efw-public-web-acl'].ARN" --output text
$end = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$start = (Get-Date).ToUniversalTime().AddHours(-3).ToString('yyyy-MM-ddTHH:mm:ssZ')
aws wafv2 get-sampled-requests --web-acl-arn $acl --rule-metric-name AWS-CommonRuleSet `
  --scope CLOUDFRONT --time-window "StartTime=$start,EndTime=$end" --max-items 500 --region us-east-1
```
Sampled requests show full headers + URI + the **sub-rule** (`RuleNameWithinRuleGroup`) for managed groups — fastest way to see *which* CommonRuleSet rule matched.

**Rate-rule live state** (which IPs are currently over the limit — works in Count too):
```bash
ID=$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query "WebACLs[?Name=='efw-public-web-acl'].Id" --output text)
aws wafv2 get-rate-based-statement-managed-keys --scope CLOUDFRONT --region us-east-1 \
  --web-acl-name efw-public-web-acl --web-acl-id $ID --rule-name RateLimit-Estimator
```

### 2.2 Athena over the WAF S3 logs (set up at Phase P-1, one table per ACL)

```sql
-- Run once in Athena (us-east-1), database e.g. efw_waf_logs:
CREATE DATABASE IF NOT EXISTS efw_waf_logs;

CREATE EXTERNAL TABLE IF NOT EXISTS efw_waf_logs.waf_public (
  `timestamp` bigint, formatversion int, webaclid string,
  terminatingruleid string, terminatingruletype string, action string,
  terminatingrulematchdetails array<struct<conditiontype:string,sensitivitylevel:string,location:string,matcheddata:array<string>>>,
  httpsourcename string, httpsourceid string,
  rulegrouplist array<struct<rulegroupid:string,
      terminatingrule:struct<ruleid:string,action:string,rulematchdetails:array<struct<conditiontype:string,sensitivitylevel:string,location:string,matcheddata:array<string>>>>,
      nonterminatingmatchingrules:array<struct<ruleid:string,action:string,overriddenaction:string,rulematchdetails:array<struct<conditiontype:string,sensitivitylevel:string,location:string,matcheddata:array<string>>>>>,
      excludedrules:string>>,
  ratebasedrulelist array<struct<ratebasedruleid:string,limitkey:string,maxrateallowed:int>>,
  nonterminatingmatchingrules array<struct<ruleid:string,action:string,rulematchdetails:array<struct<conditiontype:string,sensitivitylevel:string,location:string,matcheddata:array<string>>>>>,
  requestheadersinserted array<struct<name:string,value:string>>,
  responsecodesent string,
  httprequest struct<clientip:string,country:string,headers:array<struct<name:string,value:string>>,uri:string,args:string,httpversion:string,httpmethod:string,requestid:string>,
  labels array<struct<name:string>>,
  captcharesponse struct<responsecode:string,solvetimestamp:bigint,failurereason:string>,
  challengeresponse struct<responsecode:string,solvetimestamp:bigint,failurereason:string>
)
PARTITIONED BY (`date` string)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
LOCATION 's3://aws-waf-logs-efw-874922373146/AWSLogs/874922373146/WAFLogs/cloudfront/efw-public-web-acl/'
TBLPROPERTIES (
  'projection.enabled'='true',
  'projection.date.type'='date', 'projection.date.format'='yyyy/MM/dd',
  'projection.date.range'='2026/06/01,NOW', 'projection.date.interval'='1', 'projection.date.interval.unit'='DAYS',
  'storage.location.template'='s3://aws-waf-logs-efw-874922373146/AWSLogs/874922373146/WAFLogs/cloudfront/efw-public-web-acl/${date}'
);
-- Clone as waf_preview2 / waf_edit_cms with the ACL name swapped in LOCATION + template.
```

And the CloudFront access logs (for cache + Host analysis):
```sql
CREATE EXTERNAL TABLE IF NOT EXISTS efw_waf_logs.cf_public (
  `date` date, `time` string, x_edge_location string, sc_bytes bigint, c_ip string,
  cs_method string, cs_host string, cs_uri_stem string, sc_status int, cs_referer string,
  cs_user_agent string, cs_uri_query string, cs_cookie string, x_edge_result_type string,
  x_edge_request_id string, x_host_header string, cs_protocol string, cs_bytes bigint,
  time_taken float, x_forwarded_for string, ssl_protocol string, ssl_cipher string,
  x_edge_response_result_type string, cs_protocol_version string, fle_status string,
  fle_encrypted_fields int, c_port int, time_to_first_byte float,
  x_edge_detailed_result_type string, sc_content_type string, sc_content_len bigint,
  sc_range_start bigint, sc_range_end bigint
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
LOCATION 's3://aws-waf-logs-efw-874922373146/cf-public/'
TBLPROPERTIES ('skip.header.line.count'='2');
```
`x_host_header` = the host the viewer asked for (state); `cs_host` = the dxxxx.cloudfront.net domain. Use `x_host_header` for all per-state analysis.

### 2.3 The core Count-mode question: "what legit traffic WOULD each rule have blocked?"

Count-mode matches appear in **two places**: top-level Count rules → `nonterminatingmatchingrules`; managed groups with `OverrideAction: Count` → `rulegrouplist[].nonterminatingmatchingrules`.

```sql
-- Q1: would-block volume per rule / sub-rule, last 7 days
SELECT r.ruleid AS rule, count(*) AS hits,
       count(DISTINCT httprequest.clientip) AS ips
FROM efw_waf_logs.waf_public
CROSS JOIN UNNEST(nonterminatingmatchingrules) AS t(r)
WHERE "date" >= date_format(current_date - interval '7' day, '%Y/%m/%d')
GROUP BY 1 ORDER BY 2 DESC;

-- Q1b: same for managed-group sub-rules (CommonRuleSet etc.)
SELECT g.rulegroupid, r.ruleid AS subrule, count(*) AS hits,
       count(DISTINCT httprequest.clientip) AS ips,
       arbitrary(httprequest.uri) AS example_uri
FROM efw_waf_logs.waf_public
CROSS JOIN UNNEST(rulegrouplist) AS t(g)
CROSS JOIN UNNEST(g.nonterminatingmatchingrules) AS t2(r)
WHERE "date" >= date_format(current_date - interval '7' day, '%Y/%m/%d')
GROUP BY 1,2 ORDER BY 3 DESC;

-- Q2: WHO would have been hit — separate humans from bots (UA + URI + cadence)
SELECT httprequest.clientip, r.ruleid,
       filter(httprequest.headers, h -> lower(h.name)='user-agent')[1].value AS ua,
       count(*) AS hits, min(from_unixtime("timestamp"/1000)) AS first_seen,
       max(from_unixtime("timestamp"/1000)) AS last_seen,
       array_agg(DISTINCT httprequest.uri) AS uris
FROM efw_waf_logs.waf_public
CROSS JOIN UNNEST(nonterminatingmatchingrules) AS t(r)
WHERE "date" >= date_format(current_date - interval '7' day, '%Y/%m/%d')
GROUP BY 1,2,3 ORDER BY hits DESC LIMIT 100;
```

### 2.4 Per-rule watch list (what "dirty" looks like, per rule, before any Block flip)

| Rule | Watch for | Verdict guide |
|---|---|---|
| `IP-Blocklist-Scanners` | anything at all (set ships empty) | any hit = the OpenClaw feed added an IP — verify it isn't a NAT |
| `SensitivePaths` | hits on `*.config` ending — legit ASP.NET sites never serve `.config`, but check `Q1` example URIs for surprises (e.g. an app path ending `.sql`/`.old`) | matches with browser UA + referer from our own pages = regex too broad → tighten before Block |
| `AWS-IpReputation` | gov/agency NAT IPs (e.g. `168.166.0.0/16` Missouri) appearing — reputation lists occasionally include shared NATs | any IP with human-paced estimator history (cross-check Q2 cadence) → needs scope-down or accept risk consciously |
| `AWS-CommonRuleSet` | **`SizeRestrictions_BODY` on cms ACL** (expected — overridden to Count permanently; volume = CMS save activity, sanity-check it matches editor count). **`SQLi_BODY` / `CrossSiteScripting_BODY` on BOTH cms and published ACLs** — the base64 ViewState (first 8KB inspected) is the classic false-positive. Also `GenericRFI_QUERYARGUMENTS` on estimator URLs with `(S(...))` tokens | any hit where UA=browser AND uri ends `.aspx` AND referer is our own site = false positive → add `RuleActionOverride: Count` for that sub-rule on that tier before Block |
| `AWS-KnownBadInputs` | hits on `/planning/` or `/api/` POSTs | same browser-UA test |
| `Challenge-Estimator` | in Count: volume = all unverified /planning/ traffic (baseline). **Solve-rate is NOT measurable in Count** — only the Phase 4b enforcement window shows it: `ChallengeRequests` vs `RequestsWithValidChallengeToken`, plus `challengeresponse.failurereason` in logs | post-flip: `RequestsWithValidChallengeToken / (ChallengeRequests + RequestsWithValidChallengeToken)` per hour; a flood of `challengeresponse` failures from browser UAs = real users stuck → see §3(d) |
| `RateLimit-Estimator` (300) | **near-misses**: Q3 below — any legit IP >200/5min is a future false positive; known gov NATs (Missouri `168.166.80.217` peaked 185) must stay under | if a verified-human NAT exceeds ~250, raise `PlanningRateLimit` before Block |
| `RateLimit` (500) | same analysis site-wide; remember the print server is fixed (no more 52.8.7.0 self-traffic) — if `52.8.7.0` shows up here, the repoint regressed | |

```sql
-- Q3: rate-limit near-miss — per-IP 5-min buckets on /planning/, worst offenders
SELECT httprequest.clientip,
       date_trunc('minute', from_unixtime("timestamp"/1000)) -
         interval '1' minute * (minute(from_unixtime("timestamp"/1000)) % 5) AS bucket5,
       count(*) AS reqs
FROM efw_waf_logs.waf_public
WHERE "date" >= date_format(current_date - interval '7' day, '%Y/%m/%d')
  AND lower(httprequest.uri) LIKE '/planning/%'
GROUP BY 1,2 HAVING count(*) > 200 ORDER BY reqs DESC;
-- Same query without the URI filter, HAVING > 350, for the site-wide 500 limit.
```

### 2.5 Pre-flip checklist (run per ACL; all must be true)

1. Q1/Q1b: every rule's would-block list is empty OR 100% attributable to bots/probes (Q2 UA + URI + cadence check on every IP with >10 hits).
2. Q3: no legit IP within 65% of either rate limit.
3. cms ACL: zero `SQLi_BODY`/`XSS_BODY` counted hits on `/admin/` POSTs (or overrides added).
4. `get-rate-based-statement-managed-keys` returns empty for both rate rules.
5. public-url-checker BigQuery `uptime_7d` = 100% for all fronted hosts.
6. Decision + evidence pasted into the phase log; any `RuleActionOverride` added is documented in `edge.yaml` comments.

---

## 3. Diagnosis decision trees

> **First move for everything:** (T2) origin-direct curl vs live-hostname curl. Origin broken → it's not the WAF/CDN; go to (g)/(h). Origin fine → edge problem; continue.

### (a) User reports 403 / "blocked" — identify the WAF rule in <5 min

1. Get from the user: **time (±5 min), their IP** (`https://checkip.amazonaws.com`), the URL, and ideally the **`Request ID`** shown on the CloudFront error page (it's the `x-amz-cf-id`).
2. **If within 3h** — sampled requests, no Athena needed (§6 `waf-why-blocked.ps1`): loop `get-sampled-requests` over all 8 rule metric names, grep for the IP. The match shows rule + sub-rule + full request.
3. **Else Athena** (logs land ~5 min after the event):
```sql
SELECT from_unixtime("timestamp"/1000) AS t, action, terminatingruleid,
       terminatingrulematchdetails, httprequest.uri, httprequest.args, responsecodesent
FROM efw_waf_logs.waf_public
WHERE "date" = date_format(current_date, '%Y/%m/%d')
  AND httprequest.clientip = '<IP>' AND action IN ('BLOCK','CHALLENGE','CAPTCHA')
ORDER BY "timestamp" DESC LIMIT 50;
```
4. **Override/rollback lever per rule:**

| Terminating rule | Immediate lever (minutes) | Proper fix |
|---|---|---|
| `IP-Blocklist-Scanners` | `aws wafv2 update-ip-set` on `efw-scanner-ips` removing the IP (get-ip-set → edit list → update with lock token) | fix the OpenClaw feed criteria |
| `SensitivePaths` | redeploy stack with that rule's action conditionally Count — fastest safe path: `WafRuleAction=Count` for the whole ACL if urgent | tighten the regex in `edge.yaml`, redeploy |
| `AWS-IpReputation` / `AWS-CommonRuleSet` / `AWS-KnownBadInputs` | add `RuleActionOverride: {Name: <sub-rule>, ActionToUse: Count}` in `edge.yaml`, deploy (~2 min) | keep override, document |
| `Challenge-Estimator` | see (d) | |
| `RateLimit-Estimator` / `RateLimit` | raise `PlanningRateLimit`/`RateLimit` param, redeploy (~2 min); rate-block self-expires as the rate drops | retune from Q3 data |
| anything, site is burning | `WafRuleAction=Count` redeploy (whole ACL back to monitor-only, ~2 min) | post-mortem, re-flip |

> **Gap (accepted or fix):** the template has **no allow-list IP set**, so there is no "let this one user through everything" lever — the smallest hammer today is a sub-rule override or whole-ACL Count. **PROPOSED:** add an empty `AllowIpSet` + priority-0 terminating Allow rule to `edge.yaml` as a pre-built emergency lever.

### (b) Stale content after publish

1. Confirm what the origin has: `curl -s https://mn.db101.org/<page>.htm --resolve mn.db101.org:443:52.8.7.0 | grep <new-text>` → origin fresh? If origin is stale → publish problem, not CDN.
2. `curl -sI https://mn.db101.org/<page>.htm` → look at `x-cache` + `Age`. `Hit` with large `Age` = cached old copy.
3. Did invalidation fire? `aws cloudfront list-invalidations --distribution-id $(aws secretsmanager get-secret-value --secret-id efw-waf/dist/public --query SecretString --output text)` — check timestamps + `get-invalidation` for paths/status.
4. No invalidation → InvalidateCdn not wired/failed (check PubBot logs, suppress/coalesce scope bug). **Fix now:** manual `create-invalidation --paths "/<dir>/*"`; wait for `Completed` (~1–2 min); re-curl expecting `Miss` then fresh content.
5. Invalidation exists but content still stale → path mismatch (invalidation is path-only, case-sensitive; `*` must be last char). Compare invalidation path vs `cs_uri_stem` in the CF log.

### (c) Wrong content / cross-site (state) bleed

This is the cache-key failure: Host fell out of the key, or a behavior with the wrong cache policy.
1. Reproduce: `curl -s https://mn.db101.org/<path> | head` vs `curl -s https://nv.db101.org/<path> | head` — identical bodies for state-specific pages = bleed.
2. Confirm at origin (T2 both hosts) — if origin also serves wrong content, it's IIS host-routing, not CloudFront.
3. Verify the live cache policy still whitelists Host:
```bash
aws cloudfront get-distribution-config --id <dist-id> --query 'DistributionConfig.CacheBehaviors.Items[].{p:PathPattern,c:CachePolicyId}'
aws cloudfront get-cache-policy --id <CachePolicyStatic-id> --query 'CachePolicy.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig'
# expect: whitelist [Host]
```
4. Athena cross-check — same URI serving Hits to two hosts is fine; the smoking gun is a Hit on host B *immediately after* the only Miss was on host A:
```sql
SELECT x_host_header, cs_uri_stem, x_edge_result_type, count(*) FROM efw_waf_logs.cf_public
WHERE cs_uri_stem='<path>' GROUP BY 1,2,3;
```
5. **Mitigate:** invalidate the affected path (clears ALL hosts), then fix the policy via stack deploy. If widespread: DNS revert (§4) while fixing.

### (d) Challenge loop / estimator broken — Challenge vs rate-limit vs origin

Symptoms: estimator won't load, spins, or loops back to start.
1. `curl -sI https://mn.db101.org/planning/` →
   - `202` + `x-amzn-waf-action: challenge` → WAF Challenge path (expected for curl; problem only if *browsers* also fail).
   - `403` → rate-limit or other Block rule → tree (a); `get-rate-based-statement-managed-keys` shows if the user's IP/NAT is rate-limited.
   - `5xx` → origin → tree (g).
   - `200` → edge fine; suspect app/session — check the `(S(...))` token survives redirects (a dropped session token loops the wizard to start; that's app-level, compare via (T2)).
2. Browser failing the challenge: user's browser console shows the interstitial failing (old browsers, JS blockers, embedded webviews). Athena: `challengeresponse.failurereason` + UA for that IP. Decide: acceptable loss vs scope-down.
3. Estimator-wide: check `ChallengeRequests` spike with flat `RequestsWithValidChallengeToken` (nobody passing = challenge infra issue) → **lever:** redeploy ACL with `WafRuleAction=Count` (challenge off, ~2 min) — rate-limit backstop also reverts, accept temporarily.
4. PDF print also failing alongside → print server fell back to public hostname → tree (f).

### (e) CMS save fails (editor reports error/timeout on Save)

1. Which tier? `db101-*.eightfoldway.com` = cms ACL — `SizeRestrictions_BODY` is permanently Count there, so a 403 on save means **another body rule** went terminating (`SQLi_BODY`, `XSS_BODY`).
2. Athena on `waf_edit_cms` by the editor's IP + `action='BLOCK'` (query in (a)); `terminatingrulematchdetails.location='BODY'` confirms.
3. **Lever:** add `RuleActionOverride: Count` for that sub-rule under the `IsCms` branch in `edge.yaml`, deploy (~2 min). The CMS is NTLM-gated — counting body rules on the cms tier is low risk.
4. If no WAF block: check response code — `413`/`502` from CloudFront on large posts → compare via (T2) direct-origin save; if direct works and CF fails with no WAF record, capture `x-amz-cf-id` and check origin timeout (default 30s response timeout) for slow saves.
5. NTLM auth loop (401 repeating) → connection reuse issue through CF → verify `OriginRequestPolicyDynamic` still forwards all headers; test direct origin to confirm.

### (f) Print server PDFs failing

1. Generate a PDF; on web-06 check the newest IIS log: is the render fetch arriving from `127.0.0.1`/`10.3.0.63` (good, origin-direct) or not arriving at all?
2. Not arriving + Puppeteer errors mentioning the public hostname or 202/403 → **the repoint regressed; Puppeteer is going through CloudFront and hitting the Challenge.** Confirm in Athena: `clientip='52.8.7.0' AND uri LIKE '/planning/%'` on `waf_public`.
3. Quick mitigations, in order: fix the print-server base URL (localhost/10.3.0.63 + `Host:` header); if blocked on a code fix, the documented fallback is a terminating Allow for `52.8.7.0/32` *before* rule 6 — that's an `edge.yaml` edit + deploy (no such rule exists today; do not improvise in console — template it).
4. If fetch arrives at IIS but PDF still bad → renderer/app problem, outside WAF scope (check Puppeteer/Chrome logs, TLS trust for the localhost cert — Puppeteer may need `ignoreHTTPSErrors` for the internal cert or fetch via `Host` header against the real cert).

### (g) Origin 502/504 from CloudFront

CloudFront 502 = TLS/protocol failure to origin; 504 = origin connect/response timeout.
1. Compare (T2): direct origin OK?
2. TLS check exactly as CloudFront sees it (origin is an IP; cert must cover the forwarded Host):
```bash
openssl s_client -connect 52.8.7.0:443 -servername mn.db101.org </dev/null 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
```
   Expired cert / SAN missing the host / TLS<1.2 = your 502. (Renewal on IIS is the classic silent breaker — the `efw.policy.cert-updater` flow must keep the IIS cert valid even though browsers never see it again.)
3. 504: origin overloaded or slow page >30s (origin response timeout). Check web-06 CPU + IIS logs `time-taken`; CloudFront `OriginLatency` metric if additional metrics enabled (§5). Long estimator computations near 30s → raise `OriginReadTimeout` in template (requires adding the property — not currently set, default 30s).
4. Per-distribution scope: `aws cloudwatch get-metric-statistics --namespace AWS/CloudFront --metric-name 5xxErrorRate --dimensions Name=DistributionId,Value=<id> Name=Region,Value=Global ...` and the `efw-<env>-cf-5xx` alarm history.
5. Widespread + origin healthy + TLS fine → check AWS Health Dashboard (CloudFront event) → consider DNS revert (h).

### (h) Whole-site down — DNS rollback

Trigger: checker red across hosts / `efw-public-cf-5xx` firing / nothing loads, and the fault is edge-side (T2 origin-direct works).
```powershell
# Pre-staged at each cutover (see §6 dns-snapshot.ps1). Rollback = apply the revert batch:
$zone = aws route53 list-hosted-zones-by-name --dns-name db101.org. --max-items 1 --query 'HostedZones[0].Id' --output text
aws route53 change-resource-record-sets --hosted-zone-id $zone --change-batch file://dns-revert/db101-org.json
aws route53 get-change --id <ChangeId>   # wait for INSYNC (~60s)
```
Revert batch shape (CNAME hosts):
```json
{ "Comment": "ROLLBACK to origin 2026-06-10",
  "Changes": [
    { "Action": "UPSERT", "ResourceRecordSet": { "Name": "mn.db101.org.", "Type": "CNAME", "TTL": 60,
        "ResourceRecords": [ { "Value": "s6.db101.org." } ] } },
    { "Action": "UPSERT", "ResourceRecordSet": { "Name": "db101.org.", "Type": "A", "TTL": 60,
        "ResourceRecords": [ { "Value": "52.8.7.0" } ] } }
  ] }
```
(Apexes that were ALIAS-to-CloudFront revert to plain `A 52.8.7.0`.) Time-to-effect: INSYNC ~60s + 60s TTL + resolver lag → **plan on 5–8 minutes**, not "instant". Verify: `dig +short mn.db101.org @8.8.8.8` until it returns the s6 chain / 52.8.7.0, then a clean browser test. Leave the distribution running (re-cutover is another DNS flip).

---

## 4. Rollback levers table

| Phase | Lever (smallest first) | How | Time-to-effect | Blast radius |
|---|---|---|---|---|
| P-1 (no DNS) | delete/iterate stacks freely | `aws cloudformation delete-stack` | n/a | none — no traffic |
| 0 preview2 canary | DNS revert `preview2.eightfoldway.com` | §3(h) revert batch | 5–8 min | preview2 canary host only |
| 1 edit-cms | per-host DNS revert; or all edit aliases | revert batch per zone | 5–8 min | that host / edit tier; editors fall back to direct origin (works — origin SG still open until Phase 5) |
| 1 (q.db101.org misbehaving) | repoint `q.db101.org` back to `preview2-site.db101.org` chain | revert batch | 5–8 min | CMS utility consumers + checker |
| 2 / 4b Block flip | `WafRuleAction=Count` redeploy of the one edge stack | `cloudformation deploy --parameter-overrides WafRuleAction=Count` | ~2 min (WAF update propagates <1 min) | that tier's enforcement only; caching/DNS untouched — **preferred lever for any WAF false-positive storm** |
| 2 / 4b single rule | `RuleActionOverride: Count` (managed sub-rule) or param raise (rate limits) in `edge.yaml` | stack deploy | ~2 min | one rule on one tier |
| any | remove IP from `efw-scanner-ips` | `wafv2 update-ip-set` (lock token!) | <1 min | one IP |
| 3/4 public | DNS revert per host family (state CNAMEs → `s6.db101.org`; apexes → A 52.8.7.0) | pre-staged batches | 5–8 min | per host; full revert = all batches, site keeps running direct as today |
| 4 redirect stack | revert `housingbenefits101.org` records to prior targets | snapshot batch | 5–8 min | hb101-MN brand hosts |
| last resort | disable distribution | `aws cloudfront update-distribution` Enabled=false | 5–15 min to deploy globally — **slower than DNS revert; almost never the right lever** | every alias on that distribution goes 4xx — do DNS revert FIRST |
| Phase 5 (later) | do NOT lock origin SG to CloudFront prefix list until all rollback paths above are retired — SG lockdown breaks the "fall back to direct origin" property | | | |

**Pre-stage rule:** no DNS change happens without (1) `list-resource-record-sets` snapshot saved to `dns-revert/<zone>-snapshot-<date>.json`, (2) a tested revert batch file, both committed to this repo.

---

## 5. Post-rollout monitoring

### 5.1 Alarms (template already has two; create these in addition — **PROPOSED**, add to `edge.yaml` or a small `monitoring.yaml`)

| Alarm | Metric (namespace / dims) | Threshold | Rationale |
|---|---|---|---|
| `efw-<env>-cf-5xx` *(exists)* | `AWS/CloudFront 5xxErrorRate`, DistributionId, Region=Global | avg >5% over 2×5min | origin or TLS failure |
| `efw-<env>-waf-blocked` *(exists)* | `AWS/WAFV2 BlockedRequests`, WebACL, Rule=ALL | Sum >1000/5min | attack or false-positive storm |
| `efw-<env>-cf-4xx` | `4xxErrorRate` same dims | avg >15% over 3×5min (tune to baseline week) | broken links after publish, WAF 403s surface here too |
| `efw-public-cachehit-floor` | `CacheHitRate` (requires `create-monitoring-subscription` — small extra cost, enable on **public** dist only) | avg <40% over 6×10min during business hours | cache policy regression = origin load returns |
| `efw-public-origin-latency` | `OriginLatency` p90 (same subscription) | >2500ms over 3×5min | web-06 distress before users notice |
| `efw-public-challenge-pass` | metric math: `RequestsWithValidChallengeToken / (ChallengeRequests+RequestsWithValidChallengeToken)` | <0.5 for 3×15min (only meaningful with steady /planning/ traffic; TreatMissingData=notBreaching) | challenge breaking real users |
| `efw-public-ratelimit-block` | `BlockedRequests`, Rule=`RateLimit-Estimator` | Sum >50/5min | a NAT (= an office full of real users) just got cut off |
| **Count-mode watch** | `CountedRequests`, Rule=ALL, per ACL | Sum >2000/5min | **nothing alarms during Count windows today** — this is the only tripwire while rules are non-enforcing |

```bash
# Enable the additional CloudFront metrics (public dist):
aws cloudfront create-monitoring-subscription --distribution-id <public-dist-id> \
  --monitoring-subscription 'RealtimeMetricsSubscriptionConfig={RealtimeMetricsSubscriptionStatus=Enabled}'
```
Also: subscribe the owner's email/SMS to `efw-waf-alarms` SNS (the topic exists; it has no subscriptions in the template — **an unsubscribed alarm topic is a silent pager**).

### 5.2 public-url-checker — covers vs gaps

**Covers (hourly, retried, BigQuery history, status page):** 18 state `*.db101.org` homepages, `mn.hb101.org`, `q.db101.org` XML/JSON endpoints, `rts.hb101.org` (out of migration scope). Homepages traverse CloudFront after Phase 4 → it IS the post-rollout liveness monitor for the public dist + edit-cms (via q).

**Gaps:**
1. **No `/planning/` coverage** — and the naive fix is wrong: the checker is a non-browser HTTP client, so once Challenge is in Block mode a queued `/planning/` URL would get the 202 interstitial and **permanently false-alarm**.
2. No `vets101.org`, no `eightfoldway.com` apex, no staging (`preview-*`) or preview2 hosts, no edit-cms hosts (NTLM makes that awkward anyway), no static-asset (cache-path) probe, no redirect-stack check.
3. Liveness only — no content assertion (a cached error page that 200s looks "up").

**Minimal additions (PROPOSED, in preference order):**
- **(cheap, do first)** Add to `producer.mjs`: `https://vets101.org/`, one `preview-mn.db101.org` URL, one cached `.htm` URL, and `https://mn.housingbenefits101.org/` (assert it loads — the 301 lands on hb101). One-line list edits.
- **Estimator synthetic:** a CloudWatch Synthetics canary (Puppeteer, headless Chrome) that opens `https://mn.db101.org/planning/`, clicks into one estimator, and submits one step — every 30 min. Headless Chrome *should* solve the silent challenge but **must be verified during the Phase 4b enforcement window**; if it fails, exempt it via a scope-down on `Challenge-Estimator` (NOT statement: header `x-efw-canary: <secret from Secrets Manager>`) — a narrow, secret-based exemption, unlike the dropped spoofable bot allowlist. Alert to the same `efw-waf-alarms` topic. This closes the single biggest blind spot: **nothing today tells you the estimators are broken for real users.**

### 5.3 Weekly review query set (15 minutes, Mondays)

1. §2.3 Q1/Q1b on all three ACLs, `action IN ('BLOCK')` variant — top blocked rules/IPs; anything with browser UA + own-site referer → false-positive investigation.
2. §2.4 Q3 near-miss (both limits) — are gov NATs drifting toward the caps?
3. Challenge health: weekly `ChallengeRequests` vs `RequestsWithValidChallengeToken` sums; `challengeresponse.failurereason` breakdown.
4. Cache efficiency (Athena `cf_public`):
```sql
SELECT x_edge_result_type, count(*) AS n, round(100.0*count(*)/sum(count(*)) over(),1) AS pct
FROM efw_waf_logs.cf_public WHERE "date" >= current_date - interval '7' day GROUP BY 1 ORDER BY 2 DESC;
-- and top origin-cost URIs:
SELECT cs_uri_stem, count(*) n, round(avg(time_taken),3) avg_s FROM efw_waf_logs.cf_public
WHERE x_edge_result_type='Miss' AND "date" >= current_date - interval '7' day
GROUP BY 1 ORDER BY n*avg_s DESC LIMIT 25;
```
5. `/planning/` origin load trend (is the Challenge actually suppressing bot load?): weekly Miss count + total `time_taken` for `cs_uri_stem LIKE '/planning/%'`, compare to the 2026-06-08 pre-WAF baseline (5,624 reqs/~29 min server time).
6. checker BigQuery: `SELECT * FROM uptime_monitoring.uptime_7d ORDER BY uptime_pct ASC` + `downtime_incidents` for the week.
7. Invalidation spend sanity: `aws cloudfront list-invalidations` count for the month (free tier = 1,000 paths).

---

## 6. Tooling stubs

Drop in `tools/` (PowerShell 5.1-safe). All read-only except the explicitly-named rollback/invalidation actions.

**`waf-why-blocked.ps1 <IP> [<aclName>]`** — answer "which rule hit this user" from sampled requests (last 3h):
```powershell
param([Parameter(Mandatory)][string]$Ip, [string]$Acl = 'efw-public-web-acl')
$arn = aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query "WebACLs[?Name=='$Acl'].ARN" --output text
$end = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$start = (Get-Date).ToUniversalTime().AddHours(-3).ToString('yyyy-MM-ddTHH:mm:ssZ')
$rules = 'IP-Blocklist-Scanners','SensitivePaths','AWS-IpReputation','AWS-CommonRuleSet',
         'AWS-KnownBadInputs','Challenge-Estimator','RateLimit-Estimator','RateLimit'
foreach ($r in $rules) {
  $json = aws wafv2 get-sampled-requests --web-acl-arn $arn --rule-metric-name $r `
          --scope CLOUDFRONT --time-window "StartTime=$start,EndTime=$end" --max-items 500 --region us-east-1
  $hits = ($json | ConvertFrom-Json).SampledRequests | Where-Object { $_.Request.ClientIP -eq $Ip }
  foreach ($h in $hits) {
    "{0}  rule={1}  sub={2}  {3} {4}" -f $h.Timestamp, $r, $h.RuleNameWithinRuleGroup, $h.Request.Method, $h.Request.URI
  }
}
# Older than 3h? -> Athena query in test-diagnostics-plan §3(a).
```

**`count-report.ps1`** — per-rule CountedRequests (24h) across all three ACLs:
```powershell
$acls = 'efw-edit-cms-web-acl','efw-preview2-web-acl','efw-public-web-acl'
$rules = 'IP-Blocklist-Scanners','SensitivePaths','AWS-IpReputation','AWS-CommonRuleSet',
         'AWS-KnownBadInputs','Challenge-Estimator','RateLimit-Estimator','RateLimit'
$end = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$start = (Get-Date).ToUniversalTime().AddDays(-1).ToString('yyyy-MM-ddTHH:mm:ssZ')
foreach ($a in $acls) { foreach ($r in $rules) {
  $j = aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/WAFV2 `
       --metric-name CountedRequests --statistics Sum --period 86400 --start-time $start --end-time $end `
       --dimensions "Name=WebACL,Value=$a" "Name=Rule,Value=$r" "Name=Region,Value=Global" | ConvertFrom-Json
  $sum = ($j.Datapoints | Measure-Object -Property Sum -Sum).Sum
  if ($sum -gt 0) { "{0,-26} {1,-22} {2,8}" -f $a, $r, [int]$sum }
}}
```

**`cache-check.ps1 <url>`** — Hit/Miss/Age/PoP in one shot (double fetch):
```powershell
param([Parameter(Mandatory)][string]$Url)
1..2 | ForEach-Object {
  $h = curl.exe -sI $Url
  $line = ($h | Select-String -Pattern '^(HTTP|x-cache|age|x-amz-cf-pop|x-amz-cf-id)' ) -join '   '
  "fetch $($_): $line"
}
```

**`smoke-host.ps1 <host> [-Planning]`** — per-host smoke used in Phases 0–4b:
```powershell
param([Parameter(Mandatory)][string]$HostName, [switch]$Planning)
function Check($u,$expect) { $c = curl.exe -s -o NUL -w '%{http_code}' $u; "{0,-60} {1}  (want {2})" -f $u,$c,$expect }
Check "https://$HostName/" 200
Check "http://$HostName/"  301
Check "https://$HostName/.env" '403 in Block / 404 in Count'
if ($Planning) { Check "https://$HostName/planning/" '200 Count / 202 Block(curl)' }
& "$PSScriptRoot\cache-check.ps1" "https://$HostName/robots.txt"
```

**`dns-snapshot.ps1 <zoneName>`** — run BEFORE every cutover; pairs with the revert batches:
```powershell
param([Parameter(Mandatory)][string]$Zone)
$id = aws route53 list-hosted-zones-by-name --dns-name "$Zone." --max-items 1 --query 'HostedZones[0].Id' --output text
$stamp = Get-Date -Format yyyyMMdd-HHmm
New-Item -ItemType Directory -Force "$PSScriptRoot\..\dns-revert" | Out-Null
aws route53 list-resource-record-sets --hosted-zone-id $id |
  Out-File -Encoding utf8 "$PSScriptRoot\..\dns-revert\$($Zone -replace '\.','-')-snapshot-$stamp.json"
"Snapshot saved. Now hand-write the revert batch for the records you are about to change."
```

**`flush-path.ps1 <tier> <path>`** — interim manual invalidation until InvalidateCdn ships (tier = preview2|public):
```powershell
param([Parameter(Mandatory)][ValidateSet('preview2','public')][string]$Tier,
      [Parameter(Mandatory)][string]$Path)
$dist = aws secretsmanager get-secret-value --secret-id "efw-waf/dist/$Tier" --query SecretString --output text
aws cloudfront create-invalidation --distribution-id $dist --paths $Path
```

**`origin-tls-check.sh <host> <ip>`** (bash) — the (g) 502 first move:
```bash
#!/usr/bin/env bash
openssl s_client -connect "$2:443" -servername "$1" </dev/null 2>/dev/null \
 | openssl x509 -noout -subject -dates -ext subjectAltName
curl -s -o /dev/null -w 'direct-origin: %{http_code} ttfb=%{time_starttransfer}s\n' "https://$1/" --resolve "$1:443:$2"
```
