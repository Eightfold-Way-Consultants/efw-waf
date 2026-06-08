---
title: WAF + CloudFront — edit-site first, then public-site
status: today
assignee: jack
priority: high
tags: [infrastructure, security, waf, cloudfront]
reorder: 2026-06-04
---

# WAF + CloudFront for DB101/HB101

## Summary
Deploy AWS WAF + CloudFront to block automated scanner traffic (28+ malicious IP clusters scanning for `.env`, `.git`, AI configs, WordPress paths on April 20).

**Strategic change (2026-06-04): Roll out on edit-site / preview2 first.** The edit-site is lower-traffic, the origin is a single IIS box (52.8.85.37), and CloudFront caching provides minimal benefit (all edit-site pages are CMS-generated dynamic content — essentially 0% cache hit rate). The primary value on edit-site is **WAF edge blocking** of scanner traffic. This validates WAF rules, the cache-bypass configuration, the WebDeploy-over-VPN flow, and Route53 TTL behavior before touching production public-site traffic. Public-site rollout only begins after edit-site has been in Count → Block for a full week with no surprises.

## Context
- Investigation: `memory/2026-04-21.md`
- Original WAF proposal (now superseded in phase order): `projects/f8-platform/waf-proposal.md`
- v2 with cache config: `projects/f8-platform/waf-proposal-v2-with-cache-config.md`
- DNS plan: `projects/f8-platform/dns-migration-plan.md`
- Review reports (round 7): `projects/f8-platform/waf-reviews/`
  - 01-disruption.md — WebDeploy, session state, TLS, DNS rollback, WAF false positives
  - 02-infra.md — Origin IPs ✅, zone count gap (18 vs 3), WAF ACLs (0 exist), ACM cert gap
  - 03-dynamic-paths.md — Cache bypass list: 3 missing paths found, 4+ likely missing
  - 04-route53.md — 18 zones total (plan covered 3), 9 additional zones with public-site A records, no wildcard ACM certs, apex ALIAS records needed

## Decisions
- **Edit-site first.** Lower blast radius, single origin, no estimator live traffic.
- **CloudFront + WAF** (not ALB) — blocks at edge, caches static content, lower cost.
- **WebDeploy** routes via VPN to non-routable IPs (10.3.x.x), no public exposure — must be re-verified end-to-end after edit-site cutover.
- **NACLs** can be decommissioned once WAF is active on a stack (WAF is superset). Defer NACL removal until public-site Phase B, after one clean week of edit-site Block mode.
- **Cache bypass** — plan's list is incomplete (review 03-dynamic-paths.md). Must add: `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`. Likely missing: `/auth/*`, `/download/*`, `*.ashx`.
- **Start in Count mode**, monitor 72h before switching to Block. (Edit-site gets a slightly longer 1-week Count window before Block given the new rollout order.)
- **ACM cert required before Phase 0** — no wildcard cert in us-east-1; must request `*.eightfoldway.com` before CloudFront distribution can be created.

## Phases (reordered — edit-site leads)

### Phase 0 — Edit-site Canary (preview2 first)

**⚠️ Pre-req (do first):** Request ACM cert for `*.eightfoldway.com` in `us-east-1` (CloudFront region). Validate via DNS TXT record. This blocks the CloudFront distribution creation — allow 30-60 min for cert issuance.

- [ ] **Pre-req:** Request ACM cert for `eightfoldway.com` + `*.eightfoldway.com` in `us-east-1`
- [ ] Confirm `preview2.eightfoldway.com` chain: `preview2` → `preview2-site.eightfoldway.com` → `s4.eightfoldway.com` → **52.8.85.37** (3 CNAME hops, all pointing to edit-site)
- [ ] Lower Route53 TTL on `preview2.eightfoldway.com` to 60s
- [ ] Create WAF Web ACL `edit-preview-web-acl` (Count mode, 7 rules — defined in `waf-proposal.md`)
- [ ] Create CloudFront distribution `cf-edit-preview` with:
  - Origin: 52.8.85.37 (HTTPS only, minimum origin TLS = TLSv1.2)
  - ACM cert: the new `*.eightfoldway.com` cert (us-east-1)
  - Cache policy: bypass all dynamic paths (see full list below)
  - WAF: `edit-preview-web-acl` attached (Count mode)
  - Alternate domain names: `preview2.eightfoldway.com`
- [ ] Pre-stage DNS revert record (have `preview2` → `preview2-site.eightfoldway.com` revert ready to flip in one click)
- [ ] Change `preview2` DNS to point at CloudFront domain
- [ ] Smoke test: load preview2 site, hit a dynamic path (`*.aspx`), hit a static path, verify WebDeploy still works via VPN
- [ ] Monitor 2 hours — check cache hit rate, WAF Count log, origin 200s

**Full cache-bypass list (updated from review 03):**
```
/path patterns/
/planning/*    /tw/*    /pdfreport/*    /l2svc/*    /f2svc/*
/ajax/*        /api/*   /chatpresence/* /auth/*    /download/*
/report/*      /export/*
/file patterns/
*.aspx         *.asmx   *.ashx
*_AppService.axd   ScriptResource.axd
```
*(Run codebase audit before Phase 1 to confirm completeness)*

### Phase 1 — Edit-site Full Migration (Count mode)
- [ ] Migrate remaining edit-site aliases to CloudFront: `edit-site.eightfoldway.com`, `s4.eightfoldway.com`, `brk-site.eightfoldway.com`, and all 30+ state previews
- [ ] **Run codebase audit** for all `*.ashx`, `*.asmx`, `*.axd` handlers — update cache-bypass list before migrating each alias
- [ ] Verify WebDeploy via VPN still works on at least one site end-to-end (port 8172 → 10.3.x.x)
- [ ] Verify CMS publish flow (PubBot) still works against the CloudFront-fronted site
- [ ] Add confirmed malicious IPs from the April 20 investigation to scanner-ips IP set
- [ ] Confirm CloudFront logs ship to a bucket we can read (S3 + lifecycle)
- [ ] Set CloudWatch alarms on WAF Count spikes and 5xx origin rate
- [ ] **Hold in Count mode for a full week** monitoring for false positives, broken paths, deploy regressions

### Phase 2 — Edit-site Block Activation
- [ ] After 1 week clean in Count, switch all WAF rules from Count → Block
- [ ] Document any WAF false-positive matches that required rule tuning
- [ ] Confirm NACLs on the edit-site SG/SG are still in place as defense-in-depth
- [ ] Lock down: security group on 52.8.85.37 restricts 80/443 to CloudFront prefix list (still optional — see Phase 5)

### Phase 3 — Public-site Canary (lowest-traffic alias)

**⚠️ Pre-req:** Request ACM cert for `*.db101.org` (or add to existing cert) in `us-east-1`.

- [ ] Pick lowest-traffic public-site alias (e.g. `ak.db101.org`) as canary
- [ ] Lower Route53 TTL to 60s
- [ ] Create CloudFront distribution `cf-public-canary` with origin = 52.8.7.0
- [ ] Reuse / extend `db101-public-web-acl` WAF Web ACL (Count mode, 7 rules)
- [ ] Migrate canary DNS
- [ ] Smoke test: full estimator flow (login → run → save), static content, API endpoints
- [ ] Monitor 2 hours

### Phase 4 — Public-site Full Migration

**⚠️ DNS scope:** Core public-site zones: `db101.org`, `hb101.org`, `vets101.org`, `eightfoldway.com` (4 zones). The Route53 zones `njdisabilitybenefits.org`, `njdb101.net`, `njdb101.com`, `njdb101.org` have A records to 52.8.7.0 but their nameservers are delegated to **NameFind.com** (parked/placeholder) — Route53 records are dead. Excluded unless explicitly reactivated.

**⚠️ Apex A records:** Apex A records pointing directly to 52.8.7.0 need ALIAS conversion before CloudFront can front them:
1. Change A → ALIAS (Route53 auto-converts when target is CloudFront)
2. Delete the old A record
3. Safe at 60s TTL.

- [ ] Migrate `s6.db101.org` and remaining aliases → all 48 public-state sites + hb101.org + vets101.org
- [ ] Convert apex A records for in-scope zones → ALIAS → CloudFront domain
- [ ] Run 72h Count mode on public-site
- [ ] Switch public-site WAF rules from Count → Block
- [ ] Decommission NACLs on public-site SG

### Phase 5 — Origin Isolation (Optional, edit-site first)
- [ ] Add NAT Gateway to vpc-331ad056
- [ ] Remove public IPs from EC2 instances (edit-site 52.8.85.37 first, then public-site 52.8.7.0)
- [ ] Restrict security group to CloudFront prefix list (`com.amazonaws.global.cloudfront.origin-facing`)

## Cost
- Baseline (edit-site + public-site, Count mode): **$25-35/mo**
- With Bot Control on both: $45-55/mo
- With NAT Gateway (Phase 5): +$45/mo

## DNS Records (Key aliases)
- `s6.db101.org` → s6.eightfoldway.com → 52.8.7.0 (public-site, **Phase 3+**)
- `s6c.eightfoldway.com` → A 52.8.7.0 (hb101 public, **Phase 4**)
- `s6a.eightfoldway.com` → A 52.8.7.0 (alternate, **Phase 4**)
- `edit-site.eightfoldway.com` → s4.eightfoldway.com → 52.8.85.37 (**Phase 1**)
- `s4.eightfoldway.com` → A 52.8.85.37 (**Phase 1**)
- `brk-site.eightfoldway.com` → A 52.8.85.37 (**Phase 1**)
- `preview2.eightfoldway.com` → `preview2-site.eightfoldway.com` → `s4.eightfoldway.com` → 52.8.85.37 (**Phase 0 canary**)
- State preview2 records: `preview2-{state}.db101.org`, `preview2.vets101.org`, `preview2-site.hb101.org`, `preview2-site.housingbenefits101.org` — all chain through s4 → 52.8.85.37

## Malicious IP Summary
- 28 unique IPs across 3 ASNs (Azure 57%, GCP 18%, others 25%)
- None targeted `/planning/` specifically — all scanning for credential files
- Only 1 IP (35.202.26.185, GCP) touched `/planning/` at all (6 requests out of 288)

## Reviewer Findings (round 7 — complete)
- **Disruption threats (01-disruption.md):** WebDeploy LOW risk (VPN path); session state LOW risk for single-IIS; TLS LOW risk; DNS rollback is 5-8 min (plan says "instant" — overconfident); WAF Count→Block MEDIUM risk (check Count logs before switching); **ACM cert gap is HIGH risk (blocks Phase 0)**
- **Infrastructure accuracy (02-infra.md):** Origin IPs verified ✅; **4 core zones** (db101.org, hb101.org, vets101.org, eightfoldway.com); **0 WAF ACLs exist** (must create); **no wildcard ACM certs** in us-east-1 (Phase 0 blocked); 5 existing CF distributions noted; cache-bypass list incomplete
- **Dynamic paths (03-dynamic-paths.md):** Plan misses `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`; likely misses `/auth/*`, `/download/*`, `*.ashx`; static paths (`/content/*`, `/images/*`) can be cached
- **Route53 (04-route53.md):** 4 core zones; 5 NameFind/parked zones excluded (Route53 records dead despite valid A entries); **9 apex A records need ALIAS conversion** before CloudFront; `preview2` chain spans 4 zones via cross-zone CNAME
