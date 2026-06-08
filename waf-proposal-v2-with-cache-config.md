# WAF + CloudFront Proposal: Protecting DB101/HB101 IIS Infrastructure

**Date:** 2026-04-21 (Updated)
**Authors:** Figaro
**Stakeholders:** Jack Eastman

---

## Executive Summary

Deploy **AWS WAF + CloudFront** in front of both public-site and edit-site IIS servers. WAF blocks malicious traffic at the edge. CloudFront caches static content to reduce IIS load. Specific cache bypass rules ensure dynamic content (/planning/, /api/*, estimators, CMS) is never cached and always passes through to the origin.

**Estimated cost:** $25-60/month depending on rule choices.  
**WebDeploy:** Continues direct access via VPN (port 8172 not supported by CloudFront).  
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

## CloudFront Cache Behavior Configuration (Critical)

CloudFront **must not cache** dynamic content. By default it caches everything. We override with specific cache behaviors:

### Public-Site Distribution (`db101.org`, etc.)

| Priority | Path Pattern | Cache Settings | TTL | Origin | Purpose |
|----------|--------------|---------------|----|--------|---------|
| 1 | `/planning/*` | Bypass Cache | — | 52.8.7.0 | **Estimator app** — all requests pass through, no caching |
| 2 | `/api/*` | Bypass Cache | — | 52.8.7.0 | **Content API** — all requests pass through |
| 3 | `/tw/*` | Bypass Cache | — | 52.8.7.0 | **Teamwork integration** — all requests pass through |
| 4 | `/vault/*` | Bypass Cache | — | 52.8.7.0 | **Vault/sessions** — all requests pass through |
| 5 | `*.aspx` | Bypass Cache | — | 52.8.7.0 | **WebForms pages** — all requests pass through |
| 6 | `*.css`, `*.js`, `*.woff*`, `*.svg`, `*.ico` | Cache | 86400s (1 day) | 52.8.7.0 | **Static assets** — long-lived cache |
| 7 | `*.jpg`, `*.png`, `*.gif` | Cache | 86400s (1 day) | 52.8.7.0 | **Images** — long-lived cache |
| 8 | `/` | Cache | 3600s (1 hour) | 52.8.7.0 | **Homepage** — short cache (content updates frequent) |
| 9 | `*` (Default) | Cache | 3600s (1 hour) | 52.8.7.0 | **Catch-all** — default for unmapped paths |

**Cache Behavior Headers & Cookies:**
```
Viewer Protocol:        HTTPS Only (no HTTP)
Query String Forward:   All (required for /planning/ state)
Header Forward:         Host, Authorization, CloudFront-Forwarded-Proto
Cookie Forward:         All (for session state)
Compress:               Yes (GZIP)
Cache Policy:           Managed-CachingOptimized (for cached paths)
Origin Request Policy:  AllViewer (for bypass paths)
```

**Why "Bypass Cache"?** For dynamic paths, set `Cache-Control: max-age=0` or use CloudFront's "Disable caching" option. This tells CloudFront "don't cache this, pass every request to origin."

### Edit-Site Distribution (`*.eightfoldway.com/edit`, preview sites)

| Priority | Path Pattern | Cache Settings | TTL |
|----------|--------------|----------------|----|
| 1 | `/*` (default/catch-all) | Bypass Cache | — |

**Why?** The edit-site is 100% dynamic (CMS login, page editing, PubBot staging). Never cache. Every request goes to origin.

---

## Implementation Plan

### Phase 1: Public Sites WAF + CloudFront (Week 1)

#### 1.1 Create WAF Web ACL
```bash
aws wafv2 create-web-acl \
  --name db101-public-web-acl \
  --scope CLOUDFRONT \
  --default-action Allow={} \
  --rules [
    {
      "Name": "AWSManagedRulesBotControl",
      "Priority": 1,
      "Statement": {"ManagedRuleGroupStatement": {"VendorName": "AWS", "Name": "AWSManagedRulesBotControlRuleSet"}},
      "Action": {"Count": {}},  # Count mode for monitoring
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "BotControl"}
    },
    {
      "Name": "AWSManagedRulesCommonRuleSet",
      "Priority": 2,
      "Statement": {"ManagedRuleGroupStatement": {"VendorName": "AWS", "Name": "AWSManagedRulesCommonRuleSet"}},
      "Action": {"Count": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "OWASP"}
    },
    {
      "Name": "RateLimitRule",
      "Priority": 3,
      "Statement": {"RateBasedStatement": {"Limit": 100, "AggregateKeyType": "IP"}},
      "Action": {"Count": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "RateLimit"}
    },
    {
      "Name": "IP-Blacklist-Scanners",
      "Priority": 4,
      "Statement": {"IPSetReferenceStatement": {"Arn": "arn:aws:wafv2:us-east-1:ACCOUNT:global/ipset/scanner-ips/ID"}},
      "Action": {"Count": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "Blacklist"}
    }
  ] \
  --region us-east-1 \
  --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=db101-public
```

#### 1.2 Create CloudFront Distribution
1. Create distribution with origin `52.8.7.0`
2. **Add cache behaviors** (in order of priority):
   - Path `/planning/*` → Bypass Cache
   - Path `/api/*` → Bypass Cache
   - Path `/tw/*` → Bypass Cache
   - Path `/vault/*` → Bypass Cache
   - Path `*.aspx` → Bypass Cache
   - Path `*.css;*.js;*.woff*;*.svg;*.ico` → Cache 1 day
   - Path `*.jpg;*.png;*.gif` → Cache 1 day
   - Path `/` → Cache 1 hour
   - Default → Cache 1 hour

3. **Attach WAF:** Under "Protection", attach `db101-public-web-acl`
4. **Viewer protocol:** HTTPS only
5. **Custom header (optional):** Add `X-Origin-Verify: <secret>` to origin requests (helps verify traffic came from CloudFront)

#### 1.3 Test Before DNS Change
```bash
# Test via CloudFront, not DNS yet
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/

# Verify dynamic content works:
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/planning/
curl -H "Host: ak.db101.org" https://<cloudfront-domain>/api/tips

# Check WAF logs (should be in Count mode, no blocks):
aws logs tail /aws/wafv2/db101-public-web-acl --follow
```

#### 1.4 Switch DNS (Low TTL, Monitored)
1. Update DNS for all 15 db101/hb101 sites: CNAME → `<cloudfront-domain>`
2. Use TTL 300 seconds (short) for easy rollback
3. Keep old IP active for 48h as fallback
4. Monitor error rates, WAF logs, estimator functionality

#### 1.5 Monitor for 48 Hours
- Check WAF logs for unexpected blocks
- Verify estimator sessions work (state in URL params)
- Verify `/api/*` responses aren't cached
- Check CloudWatch metrics: hit rates, byte counts, origin errors

### Phase 2: Edit-Site WAF + CloudFront (Week 2)

Same process as Phase 1, except:
1. **WAF ACL:** Create `edit-preview-web-acl` with stricter rate limit (50 req/5min, not 100)
2. **CloudFront:** Single cache behavior — `/*` → Bypass Cache (100% dynamic)
3. **Test:** CMS login, page editing, preview functionality, PubBot staging
4. **WebDeploy:** No change — continues to reach `52.8.85.37:8172` directly via VPN

### Phase 3: WAF Rule Activation (Week 3)

After 72 hours in Count mode on **both** distributions:
1. Switch WAF rules from Count → Block
2. Add confirmed malicious IPs to blacklist (see Appendix)
3. Set CloudWatch alarms:
   - `WAFBlockedRequests > 1000/5min` → Page on-call
   - `EstimatorErrors > 100/5min` → Investigate caching issue
4. Brief team on false-positive reporting process

### Phase 4: Origin Isolation (Optional, Week 4+)

Remove public IPs from EC2, route all traffic through CloudFront:
1. Add NAT Gateway to `efw.vpc.02-web1b` subnet
2. Remove public IPs from both EC2 instances
3. Update security group: HTTP/HTTPS allow from CloudFront IP ranges only (`aws:ec2/ip-ranges` managed prefix list)
4. **WebDeploy:** Configure SSM Session Manager port-forward, or keep VPN direct access
5. Verify SSM, CloudWatch, S3, Windows Update still work through NAT Gateway

---

## What This Blocks (Our Investigation)

| Threat | How WAF Blocks It |
|--------|------------------|
| Azure scanner farms (16 IPs, 100+ req/min) | IP Reputation + Rate limit (100 req/5min) |
| GCP crawlers (4 IPs) | IP Reputation + Bot Control |
| .env/.git harvesters | OWASP Core Rule Set (path traversal patterns) |
| AI config scanners (/.anthropic/, /.aws/) | OWASP Core Rule Set + IP blacklist |
| WP wlwmanifest scanners (4 IP cluster) | Bot Control (non-browser agents) |
| SQL injection probes | OWASP Core Rule Set |
| Spoofed Googlebot | Allowlist rules (User-Agent + IP range verification) |

---

## Cost Breakdown

| Item | Cost | Notes |
|------|------|-------|
| WAF Web ACL (public) | $5/mo | One ACL per scope |
| WAF Web ACL (edit) | $5/mo | Second ACL |
| Managed Rule Groups (free) | $0 | OWASP Core + Known Bad Inputs included |
| Custom rules (rate limit, IP blacklist, allowlists) | $5/mo | ~5 rules |
| CloudFront | $8-15/mo | $0.085/GB (assumes 100-180GB/mo static) |
| CloudFront request processing | $0.60/1M requests | ~10M requests/mo = $6 |
| **Total (baseline)** | **$25-35/mo** | Free managed rules + custom rules + CF |
| + AWS Managed Rules Bot Control | +$10/mo | Optional, more sophisticated bot detection |
| + AWS Managed Rules IP Reputation | +$5/mo | Optional, auto-blocked IPs |
| **Total (with all managed rules)** | **$40-50/mo** | Recommended |

---

## FAQ

### Q: Won't CloudFront caching break the estimators?
**A:** No, if configured correctly. Cache bypasses for `/planning/*` mean every request goes to origin. Session state is passed via URL parameters (not cookies), so it's never cached.

### Q: What about WebDeploy?
**A:** CloudFront only handles HTTP/HTTPS. WebDeploy uses port 8172 (Web Management Service). WebDeploy traffic continues direct to the EC2 instance via VPN. No change to WebDeploy workflow.

### Q: Can I remove the NACL rules once WAF is active?
**A:** Yes. WAF is a superset of NACL functionality — smarter, faster, more selective. The NACL rules we added (blocking 28 scanner IPs) are now redundant. WAF's IP Reputation + rate limiting covers this.

### Q: What if legitimate traffic is blocked?
**A:** Start with all rules in Count mode. Monitor logs for 72 hours. If legitimate patterns are detected:
1. Review rule specificity in WAF logs
2. Adjust rate limits if needed
3. Create allowlist rules for known-good IPs/patterns
4. Switch to Block after confidence is high

### Q: Can I use this for the build server or other infrastructure?
**A:** CloudFront + WAF can protect any web-facing infrastructure. Create new distributions/WAF ACLs for each origin. Same process.

---

## Appendix: Malicious IPs to Add to Blacklist

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
    "51.120.70.13/32", "134.199.162.240/32", "170.64.219.32/32", "158.94.210.128/32"
  ]
}
```

---

## Appendix: Googlebot & Bingbot Allowlist Rules

### Rule: `Allow-Googlebot`
```
IF (User-Agent contains "Googlebot") AND (SourceIP in googlebot-ips) THEN Allow
```

**googlebot-ips IP Set:**
```
8.34.208.0/20, 8.35.192.0/20, 23.236.48.0/20, 23.251.128.0/19,
34.64.0.0/10, 34.128.0.0/10, 35.184.0.0/13, 35.192.0.0/14, 35.196.0.0/15,
64.233.160.0/19, 66.102.0.0/20, 66.249.64.0/19, 70.32.128.0/19,
72.14.192.0/18, 74.125.0.0/16, 108.170.192.0/18, 108.177.0.0/17,
142.250.0.0/15, 172.217.0.0/16, 172.253.0.0/16, 173.194.0.0/16,
209.85.128.0/17, 216.58.192.0/19, 216.239.32.0/19
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
