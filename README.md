# efw-waf -- edge infrastructure for DB101 / HB101

Infrastructure-as-code and operational docs for the CloudFront + WAF layer in front of the
DB101/HB101/Vets101 sites, plus the Turnstile bot gates and the telemetry that watches them.

**This README describes the system as built.** Everything is deployed and serving live traffic;
the migration-era planning documents are kept for the decision record and are labeled historical
in the document map below.

Verified against live AWS 2026-08-21.

---

## Request path

```
viewer
  -> CloudFront distribution (per tier; caches static, bypasses dynamic)
       -> WAF web ACL (per tier; 12 rules, Block)
            -> VPC origin: service-managed ENI in the origin's private subnet
                 -> IIS on web-04 (preview2) / web-06 (public + staging)
                      -> estimator app -> benefits engine (ECONorthwest, VPC peering)

edit-CMS tier (db101-*.eightfoldway.com, q.db101.org) is DELIBERATELY NOT FRONTED:
NTLM is connection-oriented and dies behind any L7 proxy, and the tier is already
auth-gated at IIS. Those names stay DNS'd direct to web-04.
```

Routing to the origin no longer uses the origin's public IP. Each distribution reaches its box
over a CloudFront VPC origin (private ENI). The origin `DomainName` is still
`s4`/`s6.eightfoldway.com`, but that name now serves only as the SNI and certificate anchor --
it does not drive routing. web-06 has no public viewer traffic left; releasing its Elastic IP is
the last open step (see Open items).

## Distributions

| Dist | ID | Aliases | Purpose |
|---|---|---|---|
| `efw-public` | `E14TU8NPRHUI0M` | 4 wildcards (`*.db101.org`, `*.hb101.org`, `*.vets101.org`, `www.eightfoldway.com`) | Public + staging content. Origin: web-06 VPC origin. |
| `efw-preview2` | `E1ZUT1S4LS09PI` | 28 explicit `preview2-*` names | Internal unstable mirror. Origin: web-04 VPC origin. |
| apex / legacy bounce | `E62IHCKTGN48T` | 9 (apexes + `*.housingbenefits101.org`, `*.disabilitybenefits101.org`) | CloudFront Function redirect. Apexes cannot CNAME, so they ALIAS here and bounce to the canonical host. |
| reflexive-www | `E35HA9WZDTRY2Y` | 48 (`www.<state>.db101/hb101.org`) | 301 `www.<host>` -> `<host>`. Own 48-SAN ACM cert. See `cloudformation/www-redirect/README.md`. |

Wildcards on the public dist mean **a new state site needs no WAF or CloudFront change** -- just
DNS and, if it needs `www.` coverage, a `www-redirect` regeneration. preview2 enumerates its
aliases (specific overrides wildcard), so a new state does need one alias there.

Every hostname terminates at one named handle: `s4`/`s6` (direct origin, edit tier) or
`cf-preview2`/`cf-public`/`cf-redirect.<zone>` (CNAME to the dist). The `cf-*` handles are
stack-managed A+AAAA ALIASes, so a distribution replacement self-heals every leaf pointing at them.

## WAF

Both tiers run the same 12-rule pipeline, in Block. Live as-built:

| Pri | Rule | Action | Notes |
|---|---|---|---|
| 0 | `IP-Allowlist-Override` | Allow | Empty seed. Add a legit /32 mid-incident for an instant terminating Allow, remove after tuning the rule that misfired. |
| 1 | `IP-Blocklist-Scanners` | Block | Manual IP set. |
| 2 | `SensitivePaths` | Block | `.git`, `.env`, `*.bak`, `*.config`, `elmah.axd`, `trace.axd`. Most file-fishing already 404s (wrong stack); this is the "getting lucky" net. |
| 3 | `AWS-IpReputation` | managed | |
| 4 | `AWS-CommonRuleSet` | managed | Three sub-rules pinned to Count on purpose -- see below. |
| 5 | `AWS-KnownBadInputs` | managed | |
| 6 | `AWS-SQLi` | managed | Added 2026-06-17: CommonRuleSet contains no SQLi coverage, which a WAF test found the hard way. |
| 7 | `AWS-Windows` | managed | We are a Windows/IIS stack. |
| 8 | `AWS-AdminProtection` | Count | Pinned pending a false-positive review. |
| 9 | `Challenge-Estimator` | Challenge | `/planning/*`. The centerpiece. |
| 10 | `RateLimit-Estimator` | Block | 1000 per 300s per IP. |
| 11 | `RateLimit` | Block | 1000 per 300s per IP. General backstop, not a bot tool. |

**Deliberate Count pins inside CommonRuleSet** (they look like oversights otherwise):

- `SizeRestrictions_BODY` -- a heavy estimator walk POSTs ~8136 bytes against an 8192 gate. Too
  close to enforce without breaking real sessions.
- `NoUserAgent_HEADER` -- blocking it broke our own no-UA uptime monitors.
- `UserAgent_BadBots_HEADER` -- false positives on legitimate clients.

**Why Challenge carries the load.** Log analysis showed the busy `/planning/` IPs are humans behind
shared government and agency NATs, so per-IP rate limiting punishes real users while a per-browser
challenge does not. The threat a per-IP view cannot see -- a distributed headless fleet -- is exactly
what Challenge catches and rate limits miss. AWS managed rules cover probes but never fire on a
well-formed scraper GET, and that bot *load* is the actual pain.

## Turnstile

Cloudflare Turnstile gates the four form surfaces that reach a server, in Enforce:

| Surface | System | Endpoints |
|---|---|---|
| Logon | `logon` | `register`, `forgot`, `resend` |
| Estimator | `estimator` | `share` (Share Session), `pdfshare` (Email This Report) |
| Feedback proxy | `twproxy` | `feedback` |

One production sitekey, managed/interaction-only. `pdfshare` alone soft-passes an absent token
(a real-user widget failure should not eat a report the user already generated); every other
surface fails closed. Server-to-server callers bypass via an authenticated principal, not an
exemption.

## Telemetry

Each surface emits one JSON schema to its own CloudWatch group -- `/logon/events`,
`/twproxy/events`, `/estimator/events`, `/pdfreport/events`, each with an untapped `-preview`
twin. Production groups have subscription filters to Firehose into the S3 lake and an Athena
table; preview groups have none, which is what keeps preview data out of production analytics.

`tools/soak-report/` renders the whole funnel (Cloudflare issuance -> client widget beacon ->
server verify) as a self-contained HTML report, emailed daily at 07:37 by the `EFW-SoakReport`
scheduled task. See `tools/soak-report/` and the alarms `logon-widget-failed-spike` /
`logon-verify-absent-spike`.

WAF and CloudFront logs land in S3 and are queryable through Athena (`efw_waf_logs`, workgroup
`efw-diagnostics`) -- see `cloudformation/diagnostics.yaml`.

## Deploying

All CloudFront-scope resources are pinned to **us-east-1** (WAF web ACL, viewer ACM cert,
CloudFront metrics). Origin-side resources are us-west-1.

```
cloudformation/deploy-stack.ps1 <stack>
```

Parameters live in real files under `cloudformation/params/*.json`, deliberately not
`UsePreviousValue` -- the deployed configuration should be readable from the repo. Stacks:

| Stack | Region | What |
|---|---|---|
| `base` | us-east-1 | IP sets, WAF log bucket, origin-verify secret, alarm topic. Deploy once. |
| `edge` | us-east-1 | Per tier (preview2, public): web ACL, distribution, cache/origin policies, alarms. |
| `redirect` | us-east-1 | Apex and legacy-domain bounce distribution. |
| `www-redirect` | us-east-1 | The 48-host reflexive-www distribution, cert and function. Records are managed by `www-redirect/point-records.py`, not the stack. |
| `origin-sg` | **us-west-1** | Ingress on the origin SG allowing 443 from the CloudFront VPC-origins service SG. Must be us-west-1; deploy after the VpcOrigin exists. |
| `logon-telemetry` | us-east-1 | Telemetry log groups, Firehose, lake, alarms. |
| `diagnostics` | us-east-1 | Athena/Glue over the WAF + CloudFront logs. Read-only. |

DNS leaf records are intentionally **not** in the stacks: they are the cutover and rollback lever
and must stay decoupled from stack lifecycle.

## Operational rules worth knowing

- **No DNS deletion for "dead" names.** Repoint or catch-all instead. A deleted name has burned us.
- **Business hours (Mon-Fri 08:00-17:00 PT):** do not publish a site to its live public tier, and
  do not edit web-06's `applicationHost.config` -- it recycles every pool and wipes in-process
  estimator sessions for live users.
- Both web-04 and web-06 run a **catch-all 404 site** (blank host binding, SNI off) so an unmatched
  Host returns a clean 404 instead of a connection reset surfacing as a CloudFront 502.
- `/planning` dynamic paths are cache-bypassed; WAF is the only lever there.
- WebDeploy (8172) runs over VPN, never through CloudFront.

## Open items

- **web-06 depublicize, Phase D #3 and #4** -- create a web-06-only security group and release EIP
  `52.8.7.0` (`eipalloc-b5c725d0`). Soak-cleared 2026-08-05; the EIP is still attached and web-06 is
  still on the shared default SG `sg-06348763`. Past #4 the "flip DNS back to s6" rollback is gone.
  Pre-flight: re-check `.pubxml` WebDeploy targets still pinned to `s6.eightfoldway.com`.
- **Apex bounce is still 302.** The distribution comment says "302 soak, promote to 301 after
  verify"; the soak is long over and `https://db101.org/` still answers 302. Promote or record the
  decision to stay.
- **`AWS-AdminProtection`** still Count pending the false-positive review.

## Document map

**Current:**

| File | Purpose |
|---|---|
| `cloudformation/README.md` | Stack-by-stack structure, VPC origins, DNS model, per-stack deploy state. |
| `cloudformation/www-redirect/README.md` | The reflexive-www stack, the ACM SAN limit, adding a state. |
| `cloudwatch-agent/README.md` | Agent config that ships the telemetry files. |
| `tools/soak-report/` | Turnstile funnel report and its daily mail job. |
| `tools/dns-cutover/`, `tools/estimator-logs/` | Cutover scripting and estimator log pulls. |
| `src/Cdn/README.md` | Shared CloudFront invalidation library used by PubBot and the export path. |
| `waf-reviews/` | Design and review documents, including `web06-depublicize-plan-2026-07-28.md`, `dist-thumbprint-plan-2026-07-03.md`, `cloudfront-invalidation-design-2026-06-24.md`. Individual files vary in currency; each is dated. |

**Historical** -- written during the migration, kept for the decision record. Read these for *why*,
not for current state:

| File | |
|---|---|
| `waf-cloudfront-migration.md` | Master plan and phase checkboxes as of the migration. |
| `waf-proposal.md`, `waf-proposal-v2-with-cache-config.md` | Original and revised proposals. |
| `dns-migration-plan.md` | The DNS cutover plan. |
| `planning-challenge-findings.md` | Log analysis behind the Challenge decision. |
| `waf-reviews/01-disruption.md` .. `04-route53.md` | Phase R review reports. |

**Related security work** (separate projects, same posture goal): `csp-hardening.md`,
`csp-hardening-research.md`, `csp-dopostback-refactor.md`, `csp-window-open-print-refactor.md`,
`sri-external-resources.md`, and the raw SecurityScorecard CSVs.

## History

The project began 2026-04-20, when IIS logs showed 28 unique malicious IPs scanning for `.env`,
`.git`, AI config files, WordPress paths, and credential targets, mostly from Azure (57%) and
Google Cloud (18%). The existing defense was Layer 3 NACL IP blocking -- a blunt tool that could
not see paths, could not challenge a browser, and had to be updated by hand per attacker.

CloudFront plus WAF was chosen over ALB plus WAF for edge blocking reach (200+ PoPs versus
in-region only), static caching, and cost. Rollout ran preview2 first as canary, every rule in
Count for a soak window before Block, then public. preview2 reached Block 2026-06-17, public
cut over to CloudFront 2026-07-30, and public WAF reached Block 2026-08-01. The origin-isolation
phase, originally sketched as a NAT gateway, was ultimately solved with CloudFront VPC origins at
no extra cost.
