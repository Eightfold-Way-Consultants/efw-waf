# cloudformation/ — WAF + CloudFront IaC structure

All WAF + CloudFront infrastructure is provisioned here. **Region is mandatory: `us-east-1`** — CloudFront-scope WAF (Web ACL + its IP sets + logging), the CloudFront viewer ACM cert, and CloudFront's CloudWatch metrics/alarms all only exist in us-east-1. (The *origins* are in us-west-1; only this control plane is pinned to us-east-1.)

Full narrative + decisions live in [`../waf-cloudfront-migration.md`](../waf-cloudfront-migration.md). This file is the structural map.

## Templates

| File | Deploy | Creates |
|---|---|---|
| `base.yaml` | **once** | Shared building blocks, exported for the edge stacks: `ScannerIpSet` + `AllowIpSet` (WAFv2 IP sets, empty seed), `WafLogBucket` (S3, `aws-waf-logs-efw-<acct>`), `OriginVerifySecret` (`efw-waf/origin-verify`), `AlarmTopic` (SNS, email-subscribed). No IAM, no traffic path. |
| `edge.yaml` | **twice** (preview2, public) | Per-tier `WebAcl` (+ logging), CloudFront `Distribution`, cache/origin-request/response-headers policies, `Alarm5xx` + `AlarmWafBlocked`, and a per-tier dist-id secret (`efw-waf/dist/<env>`). Imports everything from `base`. |
| `redirect.yaml` | once (Phase 4) | Small CloudFront dist + Function returning `301` to `https://hb101.org` for `housingbenefits101.org` + `*.housingbenefits101.org`. |
| `diagnostics.yaml` | once (Phase -1) | Athena/Glue over the S3 logs: db `efw_waf_logs`, WAF + CloudFront tables (date partition projection), workgroup `efw-diagnostics`, saved diagnostic queries. **Read-only metadata; no traffic path, no recycle.** |

The **edit-cms tier is deliberately NOT fronted** (Decision B): NTLM breaks behind any L7 proxy, and the tier is already auth-gated, so WAF adds ~nothing. Edit names + `q.db101.org` stay DNS'd direct to web-04. → **2 content distributions** (preview2, public) + 1 redirect.

## `efw-waf-base` exports (consumed by `edge.yaml` via `ImportValue`)
`efw-waf-base-ScannerIpSetArn`, `-AllowIpSetArn`, `-WafLogBucketArn`, `-WafLogBucketDomain`, `-OriginVerifySecretArn`, `-AlarmTopicArn`.

## `edge.yaml` key parameters
| Param | preview2 | public |
|---|---|---|
| `OriginDomainName` | `s4.eightfoldway.com` | `s6.eightfoldway.com` (FQDN only — IPs rejected; must never be DNS'd at CloudFront) |
| `AlternateDomainNames` | explicit `preview2-*` list | wildcards + apexes (`*.db101.org`, apexes, `*.hb101.org`, `*.vets101.org`, `www`/apex eightfoldway, explicit `turtles`/`preview`) |
| `WafRuleAction` | `Count` → `Block` | `Count` → `Block` |
| `RateLimit` / `PlanningRateLimit` | `1000` / `1000` | `1000` / `1000` |

## Deploy order
1. `aws cloudformation deploy --stack-name efw-waf-base --template-file cloudformation/base.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-1` → **then confirm the SNS subscription email** (else alarms are silent).
2. `efw-waf-edge-preview2` (preview2 params) — Phase 0 canary.
3. `efw-waf-edge-public` (public params) — only after preview2 is proven through Block.
4. `redirect.yaml` for housingbenefits101 (Phase 4).

Read each stack's `Outputs.DistributionDomainName` — that's the value the manual `cf-*` terminator record points at (see below).

## What is intentionally NOT in these stacks (and why)
DNS is the cutover lever and must stay decoupled from the stack lifecycle:
- **ACM cert** — issued out-of-band, passed in as an ARN param, never recreated.
- **Per-site cutover records** — the `preview2-<state>` / apex flips stay **manual + staged** so the canary, 60s-TTL pre-lower, and one-click revert work without a stack update.
- **`cf-*` terminator records** (`cf-preview2`/`cf-public`/`cf-redirect` → each dist's domain) — **manual, deliberately not stack-owned.** They're the stable anchors live site records point at, so a stack delete or distribution *replacement* must not be able to delete them (that would NXDOMAIN every dependent site = mass outage). The stack only *outputs* the dist domain; a human sets/updates the one `cf-*` record from it. `DeletionPolicy: Retain` was rejected (orphan conflicts on re-create).

## DNS model (summary)
Every hostname terminates at one named terminator: `s4`/`s6` (direct origins) or `cf-preview2`/`cf-public`/`cf-redirect` (CNAME → dist). Cutover = point a site CNAME at its `cf-*` terminator (CloudFront routes on the site's own Host/SNI, so the `cf-*` name needs no alias/cert — but each site hostname does). Revert = point the site CNAME back at `s4`/`s6`. Apexes ALIAS straight at the dist (can't CNAME). Origins (`s4`/`s6.eightfoldway.com`) are never DNS'd at CloudFront (loop).

## Diagnostics — Athena/Glue over the S3 logs (`diagnostics.yaml`)
Read-only SQL over the WAF + CloudFront logs already in the log bucket — **no data copied, no origin/runtime impact, no recycle.** Stand up at Phase -1 so logs are queryable during the preview2 soak and instantly during a cutover incident (not defined under pressure). Athena uses the **Glue Data Catalog** as its metastore, so the tables are `AWS::Glue::Table` resources.

Creates:
- **Database** `efw_waf_logs`.
- **WAF tables** `waf_preview2`, `waf_public` — JSON SerDe; partitioned by `date` (yyyy/MM/dd) via **partition projection** (no manual `ADD PARTITION`). `waf_public` is empty until Phase 3/4.
- **CloudFront tables** `cf_preview2`, `cf_public` — tab-delimited W3C; flat prefix; 2 header lines skipped. `cf_public` empty until Phase 4.
- **Workgroup** `efw-diagnostics` — query results → `s3://aws-waf-logs-efw-<acct>/athena-results/`.
- **Saved queries** (`AWS::Athena::NamedQuery`): action-by-rule, blocked-detail, count-mode would-block (top-level + managed sub-rules — the core Count→Block gate question), rate-limit near-miss, CF cache-result breakdown.

Deploy (no IAM capability needed): `aws cloudformation deploy --stack-name efw-waf-diagnostics --template-file cloudformation/diagnostics.yaml --region us-east-1`

Query — console: Athena → workgroup **efw-diagnostics**, database **efw_waf_logs**, "Saved queries". CLI:
```
aws athena start-query-execution --region us-east-1 --work-group efw-diagnostics \
  --query-execution-context Database=efw_waf_logs \
  --query-string 'SELECT action, count(*) FROM efw_waf_logs.waf_preview2 WHERE "date">='"'"'2026/06/17'"'"' GROUP BY action'
# then: aws athena get-query-results --region us-east-1 --query-execution-id <id>
```
**Always filter `"date"` (yyyy/MM/dd)** so projection prunes to just those days (cheap; ~$5/TB scanned). Full DDL/query narrative: [`../waf-reviews/test-diagnostics-plan-2026-06-10.md`](../waf-reviews/test-diagnostics-plan-2026-06-10.md) §2.

## Current state (2026-06-19)
- `efw-waf-base`: **deployed** (CREATE_COMPLETE, us-east-1). SNS email confirmation pending.
- `efw-waf-edge-preview2`: **deployed, Block mode, soaking** (XFF logging, body-size→Count, cookie/auth redaction applied).
- `efw-waf-edge-public` / `redirect.yaml`: not yet deployed (Phase 3/4).
- `efw-waf-diagnostics`: **deployed** (Glue db `efw_waf_logs` + WAF/CF tables + `efw-diagnostics` workgroup + saved queries; test query verified against `waf_preview2`).
- Templates pass `validate-template` + `cfn-lint`.
