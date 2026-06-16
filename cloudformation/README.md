# cloudformation/ — WAF + CloudFront IaC structure

All WAF + CloudFront infrastructure is provisioned here. **Region is mandatory: `us-east-1`** — CloudFront-scope WAF (Web ACL + its IP sets + logging), the CloudFront viewer ACM cert, and CloudFront's CloudWatch metrics/alarms all only exist in us-east-1. (The *origins* are in us-west-1; only this control plane is pinned to us-east-1.)

Full narrative + decisions live in [`../waf-cloudfront-migration.md`](../waf-cloudfront-migration.md). This file is the structural map.

## Templates

| File | Deploy | Creates |
|---|---|---|
| `base.yaml` | **once** | Shared building blocks, exported for the edge stacks: `ScannerIpSet` + `AllowIpSet` (WAFv2 IP sets, empty seed), `WafLogBucket` (S3, `aws-waf-logs-efw-<acct>`), `OriginVerifySecret` (`efw-waf/origin-verify`), `AlarmTopic` (SNS, email-subscribed). No IAM, no traffic path. |
| `edge.yaml` | **twice** (preview2, public) | Per-tier `WebAcl` (+ logging), CloudFront `Distribution`, cache/origin-request/response-headers policies, `Alarm5xx` + `AlarmWafBlocked`, and a per-tier dist-id secret (`efw-waf/dist/<env>`). Imports everything from `base`. |
| `redirect.yaml` | once (Phase 4) | Small CloudFront dist + Function returning `301` to `https://hb101.org` for `housingbenefits101.org` + `*.housingbenefits101.org`. |

The **edit-cms tier is deliberately NOT fronted** (Decision B): NTLM breaks behind any L7 proxy, and the tier is already auth-gated, so WAF adds ~nothing. Edit names + `q.db101.org` stay DNS'd direct to web-04. → **2 content distributions** (preview2, public) + 1 redirect.

## `efw-waf-base` exports (consumed by `edge.yaml` via `ImportValue`)
`efw-waf-base-ScannerIpSetArn`, `-AllowIpSetArn`, `-WafLogBucketArn`, `-WafLogBucketDomain`, `-OriginVerifySecretArn`, `-AlarmTopicArn`.

## `edge.yaml` key parameters
| Param | preview2 | public |
|---|---|---|
| `OriginDomainName` | `s4.eightfoldway.com` | `s6.eightfoldway.com` (FQDN only — IPs rejected; must never be DNS'd at CloudFront) |
| `AlternateDomainNames` | explicit `preview2-*` list | wildcards + apexes (`*.db101.org`, apexes, `*.hb101.org`, `*.vets101.org`, `www`/apex eightfoldway, explicit `turtles`/`preview`) |
| `WafRuleAction` | `Count` → `Block` | `Count` → `Block` |
| `RateLimit` / `PlanningRateLimit` | `500` / `300` | `500` / `300` |

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

## Current state (2026-06-16)
- `efw-waf-base`: **deployed** (CREATE_COMPLETE, us-east-1). SNS email confirmation pending.
- `efw-waf-edge-preview2` / `-public`: not yet deployed.
- Templates pass `validate-template` + `cfn-lint`.
