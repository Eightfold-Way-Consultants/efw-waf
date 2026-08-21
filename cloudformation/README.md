# cloudformation/ — WAF + CloudFront IaC structure

All WAF + CloudFront infrastructure is provisioned here. **Region is mandatory: `us-east-1`** — CloudFront-scope WAF (Web ACL + its IP sets + logging), the CloudFront viewer ACM cert, and CloudFront's CloudWatch metrics/alarms all only exist in us-east-1. (The *origins* are in us-west-1; only this control plane is pinned to us-east-1.)

Full narrative + decisions live in [`../waf-cloudfront-migration.md`](../waf-cloudfront-migration.md). This file is the structural map.

## Templates

| File | Deploy | Creates |
|---|---|---|
| `base.yaml` | **once** | Shared building blocks, exported for the edge stacks: `ScannerIpSet` + `AllowIpSet` (WAFv2 IP sets, empty seed), `WafLogBucket` (S3, `aws-waf-logs-efw-<acct>`), `OriginVerifySecret` (`efw-waf/origin-verify`), `AlarmTopic` (SNS, email-subscribed). No IAM, no traffic path. |
| `edge.yaml` | **twice** (preview2, public) | Per-tier `WebAcl` (+ logging), CloudFront `Distribution`, cache/origin-request/response-headers policies, `Alarm5xx` + `AlarmWafBlocked`, and a per-tier dist-id secret (`efw-waf/dist/<env>`). Imports everything from `base`. |
| `redirect.yaml` | once (Phase 4) | Small CloudFront dist + Function returning `301` to `https://hb101.org` for `housingbenefits101.org` + `*.housingbenefits101.org`. |
| `origin-sg.yaml` | **us-west-1**, per VPC-origin tier | One `AWS::EC2::SecurityGroupIngress` on the existing origin SG (`sg-06348763`, by id) allowing 443 from the service-managed `CloudFront-VPCOrigins-Service-SG`. **Lives in us-west-1** (the origin VPC's region — a stack can't manage cross-region resources; `edge.yaml` is us-east-1). Deploy **after** the VpcOrigin exists (that's when AWS creates the service SG). See "VPC origins" below. |
| `diagnostics.yaml` | once (Phase -1) | Athena/Glue over the S3 logs: db `efw_waf_logs`, WAF + CloudFront tables (date partition projection), workgroup `efw-diagnostics`, saved diagnostic queries. **Read-only metadata; no traffic path, no recycle.** |
| `www-redirect.yaml` | once | The reflexive-www distribution + its own 48-SAN ACM cert + strip-www Function: `301 www.<host>` → `<host>`. Records are UPSERTed by `www-redirect/point-records.py`, **not** by the stack (CFN RecordSets can only CREATE, and these names already existed pointing at s6). See [`www-redirect/README.md`](www-redirect/README.md). |
| `logon-telemetry.yaml` | once | **us-west-1.** Per-surface CloudWatch event groups, the Firehose subscription filters that tap prod (and deliberately do not tap preview), the S3 lake + Athena table, and the Turnstile alarms. |

The **edit-cms tier is deliberately NOT fronted** (Decision B): NTLM breaks behind any L7 proxy, and the tier is already auth-gated, so WAF adds ~nothing. Edit names + `q.db101.org` stay DNS'd direct to web-04. → **2 content distributions** (preview2, public) + 2 redirect distributions (apex/legacy bounce, reflexive-www).

## `efw-waf-base` exports (consumed by `edge.yaml` via `ImportValue`)
`efw-waf-base-ScannerIpSetArn`, `-AllowIpSetArn`, `-WafLogBucketArn`, `-WafLogBucketDomain`, `-OriginVerifySecretArn`, `-AlarmTopicArn`.

## `edge.yaml` key parameters
| Param | preview2 | public |
|---|---|---|
| `OriginDomainName` | `s4.eightfoldway.com` | `s6.eightfoldway.com` (FQDN only — IPs rejected; must never be DNS'd at CloudFront) |
| `AlternateDomainNames` | explicit `preview2-*` list | wildcards + apexes (`*.db101.org`, apexes, `*.hb101.org`, `*.vets101.org`, `www`/apex eightfoldway, explicit `turtles`/`preview`) |
| `WafRuleAction` | `Count` → `Block` | `Count` → `Block` |
| `RateLimit` / `PlanningRateLimit` | `1000` / `1000` | `1000` / `1000` |
| `OriginInstanceArn` | web-04 instance ARN (**required**) | web-06 instance ARN (**required**) |

## VPC origins (private origin — no public IP on the box)
CloudFront reaches the origin over a **service-managed ENI in the origin's private subnet** instead of resolving the public origin FQDN -- so the box needs no public IP. `OriginInstanceArn` (the tier's EC2 instance ARN) drives it: it creates the `AWS::CloudFront::VpcOrigin` and the `iis-vpc-origin` origin, which **all 9 cache behaviors target**. It is required -- there is no longer a public-origin fallback.

> **History.** Through 2026-08-04 the template carried BOTH origins plus a `TargetOrigin` (`public`|`vpc`) parameter, so the tier could be flipped back to the public `CustomOriginConfig` in one parameter during validation. web-06 depublicize Phase D #2 removed that fallback (the public IP it fell back to is being released), and preview2 was brought onto the collapsed template 2026-08-21. **The `TargetOrigin` rollback no longer exists on either tier** -- rollback from a bad origin change is now a template change, not a parameter flip.

**Key facts:** the VPC origin keeps `DomainName: s4/s6.eightfoldway.com`, so **SNI + cert validation + Host are identical to the public origin** — only *routing* moves to the private ENI (routing is driven by `VpcOriginId`, not DNS; the origin cert is validated against the Origin domain **or** the forwarded viewer Host, both wildcard-covered). `X-Origin-Verify` is preserved on the VPC origin. VPC origins is supported in **us-west-1 except AZ `usw1-az2`**; web-04 + web-06 are both `usw1-az3` (OK). The origin box's SG must allow 443 from the CloudFront VPC-origins ENI — that's `origin-sg.yaml` (us-west-1, separate stack; see below).

**Standing up a VPC origin on a NEW tier** (both current tiers are already on one):
1. Set `OriginInstanceArn` in the tier's param file and deploy → **creates the VpcOrigin** (ENI provisions, up to ~15 min) and points the behaviors at it.
2. Read the auto-created service SG id (`aws ec2 describe-security-groups --region us-west-1 --filters Name=group-name,Values=CloudFront-VPCOrigins-Service-SG --query 'SecurityGroups[0].GroupId'`), fill `params/origin-sg.json`, `deploy-stack.ps1 origin-sg` → opens origin `:443` to the ENI.
3. Validate (200s with `X-Cache: Miss`, cert OK, no 502).

Step 2 is a no-op for a tier sharing `sg-06348763` with an existing VPC-origin tier -- the service SG is shared, so the ingress rule already covers it.

## Deploy order
1. `aws cloudformation deploy --stack-name efw-waf-base --template-file cloudformation/base.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-1` → **then confirm the SNS subscription email** (else alarms are silent).
2. `efw-waf-edge-preview2` (preview2 params) — Phase 0 canary.
3. `efw-waf-edge-public` (public params) — only after preview2 is proven through Block.
4. `redirect.yaml` for housingbenefits101 (Phase 4).
5. `origin-sg` (us-west-1) -- after the first VpcOrigin exists (that's when AWS creates the service SG). See "VPC origins" above.
6. `www-redirect` + `www-redirect/point-records.py`, and `logon-telemetry` (us-west-1). Independent of the edge stacks.

Each stack owns its `cf-*` handle (`cf-<env>.eightfoldway.com`, an ALIAS → the dist via `GetAtt`); site leaf records CNAME to that handle. `Outputs.DistributionDomainName` is still emitted for reference/debugging (see "What is intentionally NOT in these stacks" below).

## What is intentionally NOT in these stacks (and why)
DNS is the cutover lever and must stay decoupled from the stack lifecycle:
- **ACM cert** — issued out-of-band, passed in as an ARN param, never recreated.
- **Per-site cutover records** — the `preview2-<state>` / apex flips stay **manual + staged** so the canary, 60s-TTL pre-lower, and one-click revert work without a stack update.
  What stays manual is only the **leaf** layer (the site CNAMEs / apex flips). The **`cf-*` handles they point at are STACK-managed** — see next bullet.
- **`cf-*` terminator handles are STACK-managed** (updated 2026-07-21 — this reverses the earlier "keep them manual" stance): `cf-preview2`/`cf-public` by `edge.yaml` (`CfHandle`/`CfHandleAAAA`), `cf-redirect.<zone>` by `redirect.yaml` (per-zone). Each is an **A+AAAA ALIAS → its dist via `!GetAtt Distribution.DomainName`**, so a dist rebuild/replacement **auto-updates the handle** and every leaf that CNAMEs to it self-heals — no manual repoint. That `GetAtt` self-heal is exactly the "distribution replacement" case the old manual approach was guarding against, now handled automatically. The residual risk (a *stack delete* removing the handle → NXDOMAIN dependents) is accepted: deleting an edge stack is a deliberate, rare act, not routine. Edge serves only subdomains (apexes bounce via the redirect stack), so one central handle per tier suffices — no per-zone records (unlike the redirect stack, whose apex ALIAS targets forced per-zone handles).

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

## Current state (2026-08-21)
All stacks deployed and serving. Both edge tiers run `WafRuleAction=Block` and reach their origin
**only** over a VPC origin; the two web ACLs are now rule-for-rule identical, including the three
`AWS-CommonRuleSet` sub-rules pinned to Count (`SizeRestrictions_BODY`, `NoUserAgent_HEADER`,
`UserAgent_BadBots_HEADER`) and `AWS-AdminProtection` pinned to Count pending its false-positive review.

| Stack | State |
|---|---|
| `efw-waf-base` | deployed |
| `efw-waf-edge-preview2` | deployed, Block, VPC-only origin (collapsed template applied 2026-08-21) |
| `efw-waf-edge-public` | deployed, Block, VPC-only origin |
| `efw-waf-redirect` | deployed -- **still answering 302**; its comment says "promote to 301 after verify" and the soak is long over (open item) |
| `efw-waf-www-redirect` | deployed, 48 hosts |
| `efw-waf-origin-sg` | deployed (us-west-1) |
| `efw-waf-diagnostics` | deployed |
| `logon-telemetry` | deployed (us-west-1) |

Templates pass `validate-template` + `cfn-lint`. For the whole as-built picture see [`../README.md`](../README.md).
