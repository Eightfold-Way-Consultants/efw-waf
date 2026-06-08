# WAF + CloudFront Proposal: Protecting DB101/HB101 IIS Infrastructure

**Date:** 2026-04-21
**Authors:** Figaro
**Stakeholders:** Jack Eastman

---

## Executive Summary

Deploy **AWS WAF + CloudFront** in front of both public-site and edit-site IIS servers. WAF blocks malicious traffic at the edge. CloudFront caches static content to reduce IIS load. Specific cache bypass rules ensure dynamic content (/planning/, /tw/, /pdfreport/, .aspx) is never cached and always passes through to the origin.

**Estimated cost:** $25-60/month depending on rule choices.
**WebDeploy:** Continues direct access via VPN (port 8172 not handled by WAF or CloudFront). The edit-site security group should restrict port 8172 to VPN CIDRs only (10.0.0.0/16, 10.10.0.0/16). No public exposure needed.
**NACLs:** Can be removed once WAF is active (WAF is a superset of NACL functionality).

---

## Why CloudFront + WAF Over ALB + WAF

| Factor | CloudFront + WAF | ALB + WAF |
|--------|------------------|-----------|
| Bot blocking | Blocked at edge (200+ PoPs) | Blocked at ALB (in-region only) |
| Performance | Static content cached at edge, reduced IIS load | All traffic hits region ALB → EC2 |
| Origin IP hiding | Yes — CF IPs only visible | No — ALB needs public endpoint |
| Setup | Low — create distributions, point to existing IPs | Medium — reconfigure VPC, targets |
| Cache control | Full control via cache behaviors | No caching |
| Cost | Lower (~$25-60/mo) | Higher ($40-50/mo) |

**CloudFront wins.** Static assets cached at edge reduce IIS load by 60-80%. Malicious traffic blocked at CloudFront before reaching your infrastructure.

---

## IIS Virtual Applications (from live server config)

Scraped from `Get-WebApplication` and web.config files on `efw.web.06d` (public-site):

**Global virtual apps (exist on all sites):**
| Path | App Pool | Purpose |
|------|----------|---------|
| `/planning` | Planning Pool 4.0 | Benefits estimator app (per-state virtual apps under each site) |
| `/tw` | twproxy (Public Pool 4.0) | Teamwork proxy integration |
| `/pdfreport` | Planning Pool 4.0 | PDF report generation |

**Per-site web.config paths found in wwwroot:**
| Path Pattern | Sites | Purpose |
|--------------|-------|---------|
| `*/planning/_final/` | All state sites | Staging/final planning files |
| `*/planning/_preview/` | All state sites | Preview planning files |
| `/l2svc` | Some state sites | Logon service redirect (API endpoint) |
| `/f2svc` | Some state sites | Favorites service redirect (API endpoint) |
| `/g/` | MN, MI, AZ, CA | Glossary |
| `/forums/` | Some state sites | Forum pages |
| `/hit/` | MN, CA | HIT integration |
| `/chatpresence/chatpresence/` | MN only | Chat presence widget |
| `/_hub/`, `/_hub3/` | MN only | Hub integrations |
| `/master/planning/` | CO | Master planning content |

**Edit-site apps** (`efw.web.04d`):
CMS admin, preview sites, and PubBot staging — all paths are dynamic, no caching.

---

## CloudFront Cache Behavior Configuration (Critical)

CloudFront caches everything by default. We must explicitly bypass for dynamic content.

### Public-Site Distribution (db101.org, *.db101.org, etc.)

| Priority | Path Pattern | Cache Behavior | TTL | Purpose |
|----------|--------------|---------------|----|---------|
| 1 | `/planning/*` | **Bypass Cache** | — | Estimator — session state, forms, calculators (100% dynamic) |
| 2 | `/l2svc/*` | **Bypass Cache** | — | Logon service redirect (API endpoint) |
| 3 | `/f2svc/*` | **Bypass Cache** | — | Favorites service redirect (API endpoint) |
| 4 | `/tw/*` | **Bypass Cache** | — | Teamwork proxy (100% dynamic) |
| 5 | `/pdfreport/*` | **Bypass Cache** | — | PDF generation (100% dynamic) |
| 6 | `/chatpresence/*` | **Bypass Cache** | — | Chat widget (100% dynamic) |
| 7 | `/api/*` | **Bypass Cache** | — | Content API (100% dynamic) |
| 8 | `/ajax/*` | **Bypass Cache** | — | AJAX endpoint (100% dynamic) |
| 8 | `*_final/*` | **Bypass Cache** | — | Staging content (all dynamic) |
| 9 | `*_preview/*` | **Bypass Cache** | — | Preview content (all dynamic) |
| 10 | `*.aspx` | **Bypass Cache** | — | WebForms pages (all dynamic) |
| 11 | `*.css`, `*.js`, `*.woff*`, `*.svg`, `*.ico` | Cache | 86400s | Static assets (long-lived) |
| 12 | `*.jpg`, `*.png`, `*.gif`, `*.webp` | Cache | 86400s | Images (long-lived) |
| 13 | `/` | Cache | 3600s | Homepage (short cache, content updates frequent) |
| 14 | `*` (Default) | Cache | 3600s | Catch-all for unmapped paths |

**Key CloudFront settings:**
- Viewer protocol: **HTTPS Only** (no HTTP)
- Query String Forward: **All** (required for /planning/ state, API calls)
- Cookie Forward: **All** (for session state)
- Host Header: Forwarded to origin (required for IIS host-header routing)
- Compression: **Yes** (GZIP)
- Origin Custom Header: `X-Origin-Verify: <secret>` (helps verify traffic came from CloudFront)

### Edit-Site Distribution (edit-sites, preview-sites)

| Priority | Path Pattern | Cache Behavior | TTL |
|----------|--------------|---------------|----|
| 1 | `/*` (default) | **Bypass Cache** | — |

The edit-site is 100% dynamic (CMS, WebForms, API, PubBot staging). Never cache.

---

## WAF Web ACL Configuration

### Web ACL 1: Public Sites (`db101-public-web-acl`)

**Scope:** CloudFront (global)
**Default action:** Allow

| # | Rule Name | Type | Action | Purpose |
|---|-----------|------|--------|---------|
| 1 | `AWS-BotControl` | Managed Rule Group (AWSManagedRulesBotControlRuleSet) | Count→Block | Amazon Bot Control — identifies and categorizes all bot traffic |
| 2 | `AWS-CommonRules` | Managed Rule Group (AWSManagedRulesCommonRuleSet) | Count→Block | OWASP Core Rule Set — SQLi, XSS, path traversal, RCE |
| 3 | `AWS-KnownBadInputs` | Managed Rule Group (AWSManagedRulesKnownBadInputsRuleSet) | Count→Block | Blocks known malicious IPs (Tor, scanner clouds) |
| 4 | `RateLimit-100req-5min` | Rate-based | Count→Block | Any IP exceeding 100 requests in 5 minutes |
| 5 | `IP-Blacklist` | IP Set | Count→Block | Manual blocklist for verified malicious IPs from investigations |
| 6 | `Allow-Googlebot` | Regex Match + IP Set | Allow | Allow Googlebot IPs with valid User-Agent (two-layer verification) |
| 7 | `Allow-Bingbot` | Regex Match + IP Set | Allow | Allow Bingbot IPs with valid User-Agent (two-layer verification) |

### Web ACL 2: Edit/Preview Sites (`edit-preview-web-acl`)

Same rules as Public ACL, with stricter rate limit (50 req/5 min).

---

## Legitimate Bot Allowlisting

Two-layer verification required: match User-Agent **AND** verify IP is in search engine's published range. Prevents spoofing.

### Rule: `Allow-Googlebot`
```
IF (User-Agent contains "Googlebot") AND (SourceIP in googlebot-ips) THEN Allow
```

**googlebot-ips IP Set:**
```
8.34.208.0/20, 8.35.192.0/20, 23.236.48.0/20, 23.251.128.0/19,
34.64.0.0/10, 34.128.0.0/10, 35.184.0.0/13, 35.192.0.0/14,
35.196.0.0/15, 35.198.0.0/16, 35.199.0.0/16, 35.200.0.0/13,
35.208.0.0/12, 35.224.0.0/12, 35.240.0.0/13,
64.233.160.0/19, 66.102.0.0/20, 66.249.64.0/19,
70.32.128.0/19, 72.14.192.0/18, 74.125.0.0/16, 108.170.192.0/18,
108.177.0.0/17, 142.250.0.0/15, 172.217.0.0/16, 172.253.0.0/16,
173.194.0.0/16, 209.85.128.0/17, 216.58.192.0/19, 216.239.32.0/19
```

### Rule: `Allow-Bingbot`
```
IF (User-Agent contains "bingbot") AND (SourceIP in bingbot-ips) THEN Allow
```

**bingbot-ips IP Set:**
```
13.66.0.0/16, 13.104.0.0/16, 15.229.0.0/16, 15.230.0.0/16,
20.36.0.0/14, 20.40.0.0/13, 20.48.0.0/12, 20.64.0.0/12,
20.80.0.0/12, 20.96.0.0/11, 20.128.0.0/16, 20.136.0.0/14,
20.140.0.0/15, 20.143.0.0/16, 20.150.0.0/15, 20.160.0.0/12,
20.176.0.0/14, 20.180.0.0/14, 20.184.0.0/13, 20.192.0.0/10,
40.77.167.0/24, 40.126.0.0/16, 52.224.0.0/11,
157.55.0.0/16, 168.61.0.0/16, 168.62.0.0/15, 66.175.0.0/18
```

---

## Implementaton Plan

### Phase 1: Public Sites WAF + CloudFront (Week 1)

**Step 1.1: Create WAF IP Sets**
- `googlebot-ips` (32 CIDR ranges — Google's published crawler IPs)
- `bingbot-ips` (28 CIDR ranges — Microsoft's published crawler IPs)
- `scanner-ips` (28 scanner IPs from our investigation)

**Step 1.2: Create WAF Web ACL (`db101-public-web-acl`)**
- All rules initially set to **Count mode** (monitor only, zero blocking)
- Includes Bot Control, OWASP Core, Known Bad Inputs, Rate Limit, IP Blacklist, Googlebot/Bingbot allowlists

**Step 1.3: Create CloudFront Distribution**
- Origin: `52.8.7.0` (public-site)
- **12 cache behaviors** (as table above) — critical to bypass cache for /planning/*, /tw/*, /pdfreport/*, *.aspx, etc.
- Attach WAF Web ACL
- Custom header `X-Origin-Verify: <secret>` added to origin requests

**Step 1.4: Test Before DNS Change**
```bash
# Test via CloudFront, not DNS yet
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/

# Verify dynamic content works:
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/planning/
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/planning/b2w2_ak_start.aspx
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/api/tips

# Verify static content is cached:
curl -I https://<cloudfront-domain>/styles/main.css  # Should show X-Cache: Hit
```

**Step 1.5: Switch DNS**
1. Update DNS for all 15 db101/hb101 sites: CNAME → CloudFront domain
2. Use TTL 300s for easy rollback
3. Keep old IPs active for 48h fallback

### Phase 2: Edit-Site WAF + CloudFront (Week 2)
1. Create WAF Web ACL `edit-preview-web-acl` with stricter rate limits (50 req/5min)
2. Create CloudFront distribution with origin `52.8.85.37` (edit-site)
3. **Cache behavior:** `/*` → Bypass Cache (100% dynamic, no caching)
4. Test CMS login, page editing, preview, PubBot staging
5. **WebDeploy:** Direct VPN access to `52.8.85.37:8172` (no CloudFront involvement)
6. After 48h in Count mode, switch WAF rules to Block

### Phase 3: WAF Rule Activation (Week 3)
After 72 hours in Count mode on both distributions:
1. Review WAF logs for false positives
2. Switch all rules from Count → Block
3. Add confirmed malicious IPs to IP blacklist
4. Set CloudWatch alarms: `WAFBlockedRequests > 1000/5min`

### Phase 4: Origin Isolation (Optional, Long-term)
1. Add NAT Gateway to `efw.vpc.02-web1b` subnet (~$45/mo)
2. Remove public IPs from EC2 (or restrict to VPN/SSM only)
3. Security group: HTTP/HTTPS allow from CloudFront IP ranges only
4. Verify SSM, CloudWatch, S3, Windows Update still work through NAT
5. **WebDeploy:** SSM Session Manager port-forward or VPN direct access

---

## Cost Breakdown

| Item | Cost | Notes |
|------|------|-------|
| WAF Web ACL (public) | $5/mo | |
| WAF Web ACL (edit) | $5/mo | |
| OWASP Core Rule Set | $0 | Included free |
| Known Bad Inputs | $0 | Included free |
| Custom rules (rate limit, IP blacklist, allowlists) | ~$5/mo | ~5 rules |
| CloudFront data transfer | $8-15/mo | $0.085/GB (100-180GB/mo estimate) |
| CloudFront request processing | $6/mo | ~10M requests/mo |
| **Total baseline** | **$25-35/mo** | |
| + AWS Bot Control (optional) | +$20/mo | $10/mo per ACL × 2 |
| **Total with Bot Control** | **$45-55/mo** | |
| + NAT Gateway (Phase 4) | +$45/mo | Optional, for origin isolation |

---

## What This Blocks (Our Investigation)

| Threat | How WAF Blocks It |
|--------|------------------|
| Azure scanner farms (16 IPs, 100+ req/min) | IP Reputation + Rate Limit (100 req/5min) |
| GCP crawlers (4 IPs) | IP Reputation + Bot Control |
| .env/.git harvesters | OWASP Core Rule Set (path patterns) |
| AI config scanners | OWASP Core + IP Blacklist |
| WP wlwmanifest scanners | Bot Control (non-browser agents) |
| SQL injection probes | OWASP Core Rule Set |
| Spoofed Googlebot | Allowlist (User-Agent + IP range verification) |

---

## FAQ

**Q: Won't CloudFront caching break the estimators?**
A: No. Cache is bypassed for `/planning/*`, `*.aspx`, and all virtual apps. Every request goes to origin. Session state passes via URL parameters, never cached.

**Q: What about WebDeploy?**
A: CloudFront only handles HTTP/HTTPS (80/443). WebDeploy (port 8172) continues direct to `52.8.85.37` via VPN. No change to workflow.

**Q: Are NACLs still needed after WAF is deployed?**
A: **No.** WAF is a superset of NACL functionality — smarter, faster, context-aware (Layer 7 vs. Layer 3). The 28-IP NACL rules we added earlier can be removed once WAF is active. If you want layer-3 defense-in-depth, keep them. But they're not required.

**Q: What if legitimate traffic is blocked?**
A: All rules start in Count mode. Monitor logs for 72 hours. If legitimate patterns are detected:
1. Review rule specificity in WAF logs
2. Adjust rate limits if needed
3. Create allowlist rules for known-good IPs
4. Switch to Block after confidence is high

---

## Appendix: 28 Malicious IPs to Blacklist

```json
{
  "Name": "scanner-ips",
  "Scope": "CLOUDFRONT",
  "IPAddressVersion": "IPV4",
  "Addresses": [
    "104.28.228.78/32", "23.101.4.52/32", "34.71.208.184/32", "38.76.194.177/32",
    "208.84.101.224/32", "62.171.160.12/32", "158.94.210.128/32", "140.245.114.136/32",
    "78.142.18.40/32", "35.202.26.185/32", "132.196.3.209/32", "74.248.131.114/32",
    "135.225.35.148/32", "136.118.167.180/32", "172.190.142.176/32", "172.213.242.226/32",
    "20.82.177.137/32", "66.175.211.202/32", "4.231.224.223/32", "20.251.55.245/32",
    "52.178.176.146/32", "172.161.6.233/32", "20.203.199.44/32", "74.248.99.208/32",
    "51.120.70.13/32", "134.199.162.240/32", "170.64.219.32/32"
  ]
}
```

---

## Appendix: Full DNS Migration Plan

**See complete analysis at:** `projects/f8-platform/dns-migration-plan.md`

### Canary Test: One Small Site First (Day 0)

Migrate `ak.db101.org` alone to CloudFront:

```bash
# 1. Create CloudFront + WAF distribution (Count mode, all cache bypasses in place)
# 2. Change ak.db101.org DNS (TTL 60s)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z3T3K8XH9ZMBIW \
  --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"ak.db101.org","Type":"CNAME","TTL":60,"ResourceRecords":[{"Value":"<cloudfront-domain>"}]}}]}'

# 3. Test
curl -I https://ak.db101.org/                           # 200, check caching headers
curl -I https://ak.db101.org/planning/                   # Bypass cache
curl -I https://ak.db101.org/planning/b2w2_ak_start     # Estimator works
curl -I https://ak.db101.org/styles/main.css             # Cached (X-Cache: Hit)

# 4. If clean after 2 hours → proceed. If not → rollback:
#    Change ak.db101.org CNAME back to s6.db101.org
```

### One-Change Migration: How We Migrate All Sites

**Key insight:** Our DNS uses aliases, not individual A records.

**Public-site chain:**
```
ak.db101.org → CNAME s6.db101.org → CNAME s6.eightfoldway.com → A 52.8.7.0
```

**To migrate all 15 public-state sites, we change ONE record:**
`s6.db101.org` from CNAME `s6.eightfoldway.com` → CNAME `<cloudfront-domain>`

This instantly migrates `ak.db101.org`, `ca.db101.org`, `mn.db101.org`, etc. All 48 CNAME records chain through `s6.db101.org`.

**Same pattern for edit-site:**
```
db101-ak.eightfoldway.com → CNAME edit-site.eightfoldway.com → CNAME s4.eightfoldway.com → A 52.8.85.37
```
Change `edit-site.eightfoldway.com` → CNAME `<edit-cloudfront-domain>` and all 30 edit aliases migrate.

### DNS Changes Summary

**Public-site migration (5 records, ~60 domains affected):**

| Record | Zone | Current → | Result |
|--------|------|-----------|--------|
| s6.db101.org | db101.org | s6.eightfoldway.com → `<cf-domain>` | 15 state sites + www variants (48 records) |
| s6c.eightfoldway.com | eightfoldway.com | A 52.8.7.0 → CNAME `<cf-domain>` | hb101.org mn.hb101.org |
| s6a.eightfoldway.com | eightfoldway.com | A 52.8.7.0 → CNAME `<cf-domain>` | Alternate public alias |
| eightfoldway.com | eightfoldway.com | A 52.8.7.0 → ALIAS `<cf-domain>` | Main site |
| preview-site.db101.org | db101.org | A 52.8.7.0 → CNAME `<cf-domain>` | Preview site |

**Edit-site migration (3 records, ~35 domains affected):**

| Record | Zone | Current → | Result |
|--------|------|-----------|--------|
| edit-site.eightfoldway.com | eightfoldway.com | s4.eightfoldway.com → `<edit-cf-domain>` | 30 edit aliases |
| s4.eightfoldway.com | eightfoldway.com | A 52.8.85.37 → CNAME `<edit-cf-domain>` | Direct s4 alias |
| brk-site.eightfoldway.com | eightfoldway.com | A 52.8.85.37 → CNAME `<edit-cf-domain>` | Break/test site |

### Rollback Strategy
All changes use TTL 300s (5 min). Revert the few alias records and everything cascades back. Keep old IP targets active for 48h after migration.
