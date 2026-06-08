# efw-waf — WAF + CloudFront Rollout for DB101/HB101

**Project:** Protect DB101/HB101 public and edit-site IIS infrastructure with AWS WAF + CloudFront.  
**Status:** Approved 2026-04-21. Edit-site first (canary), then public-site.  
**Channel:** [#f8-platform](https://discord.com/channels/1240282868892219403/1480670862817497403)

---

## What's the Problem?

On **April 20, 2026**, our IIS logs showed **28 unique malicious IPs** scanning our sites at high volume — looking for `.env`, `.git`, AI config files, WordPress paths, and credential harvest targets. The scanners came from Azure (57%), Google Cloud (18%), and a mix of DigitalOcean, Oracle, Linode, and others.

The current defense (NACL IP-based blocking at Layer 3) is a blunt tool. **WAF + CloudFront** gives us:
- **Edge blocking** — stop bad traffic before it even reaches our infrastructure (~200+ PoPs worldwide)
- **Bot control** — identify and rate-limit non-browser automated traffic
- **Static caching** — CloudFront caches CSS/JS/images, reducing IIS load by 60-80%
- **Origin IP hiding** — CloudFront IPs only, our servers never exposed directly
- **OWASP rule set** — blocks SQL injection, path traversal, and other Layer 7 attacks

**Why CloudFront + WAF (not ALB + WAF)?** CloudFront wins on edge blocking reach, static caching, and cost. ALB only blocks in-region; CloudFront blocks at the edge.

---

## Architecture

```
Internet → CloudFront (WAF inspection) → IIS Origin (52.8.7.0 public / 52.8.85.37 edit)
```

**Key design decisions:**
- Edit-site first (lower blast radius, single origin, no live estimator traffic)
- Start all WAF rules in **Count mode** for 72h–1 week before switching to Block
- Cache bypasses for all dynamic paths: `/planning/*`, `/api/*`, `*.aspx`, `*.ashx`, `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`, `/tw/*`, `/vault/*`, etc.
- WebDeploy continues via VPN (port 8172, not proxied through CloudFront)
- NACLs can be decommissioned once WAF is active (WAF is a superset)

---

## Document Map

| File | Purpose |
|------|---------|
| **This README** | Project overview |
| [`waf-cloudfront-migration.md`](waf-cloudfront-migration.md) | **Master plan** — implementation phases, current status, decisions |
| [`waf-proposal-v2-with-cache-config.md`](waf-proposal-v2-with-cache-config.md) | Detailed proposal with cache behavior config table |
| [`waf-proposal.md`](waf-proposal.md) | Original proposal (superseded in phase order by v2) |
| [`dns-migration-plan.md`](dns-migration-plan.md) | DNS changes required for CloudFront cutover |
| [`waf-reviews/`](waf-reviews/) | Phase R review reports (infrastructure accuracy, dynamic paths, Route53) |

### CSP Hardening (Related Security Work)

These are separate but related projects — fixing Content Security Policy to remove `unsafe-inline`/`unsafe-eval`, which directly supports the WAF goal of improving SecurityScorecard posture.

| File | Purpose |
|------|---------|
| [`csp-hardening.md`](csp-hardening.md) | Phase plan — nonce-based CSP for script-src/style-src |
| [`csp-hardening-research.md`](csp-hardening-research.md) | Research on nonce implementation approaches |
| [`csp-dopostback-refactor.md`](csp-dopostback-refactor.md) | ASP.NET `__doPostBack` nonce compatibility |
| [`csp-window-open-print-refactor.md`](csp-window-open-print-refactor.md) | `window.open()` + `print()` nonce compatibility |
| [`securityscorecard-csp-unsafe.csv`](securityscorecard-csp-unsafe.csv) | Raw SecurityScorecard findings: CSP unsafe-inline/eval |
| [`securityscorecard-sri-missing.csv`](securityscorecard-sri-missing.csv) | Raw SecurityScorecard findings: missing SRI on external resources |
| [`sri-external-resources.md`](sri-external-resources.md) | SRI implementation plan for external JS |

---

## Status

**Phase R (Reviews) — ✅ Done**  
**Phase 0 (Edit-site Canary) — ⏳ Blocked on ACM cert**  
**Phase 1+ (Edit-site Full / Public-site) — Pending**

> **Phase 0 is blocked.** No wildcard ACM cert exists in `us-east-1`. Must request `*.eightfoldway.com` before CloudFront distribution can be created. Allow 30-60 min for cert issuance.

See [`waf-cloudfront-migration.md`](waf-cloudfront-migration.md) for the full phased plan with checkboxes.

---

## Cost

| Configuration | Monthly |
|--------------|---------|
| Baseline (WAF + CloudFront, Count mode) | $25-35 |
| + AWS Managed Rules Bot Control | +$10 |
| + AWS Managed Rules IP Reputation | +$5 |
| **Full stack** | **$40-50** |
| + Phase 5 NAT Gateway (origin isolation) | +$45 |

---

## Key Findings (April 2026 Investigation)

- **28 unique scanner IPs** across Azure, GCP, DigitalOcean, Oracle, Linode, Contabo
- **No `/planning/` targeting** — scanners only hit `/planning/` incidentally (1 IP, 6 requests out of 288)
- **Estimators not the target** — all scanners looking for credential/config file paths
- **NACLs are redundant** once WAF is active (WAF is a Layer 7 superset of NACL)
- **Cache hit rate concern unfounded** — `/planning/` and all dynamic paths are explicitly bypassed

---

## FAQ

**Will CloudFront caching break the estimators?**  
No — all dynamic paths are cache-bypassed. Session state uses URL params, not cookies.

**What about WebDeploy?**  
Unaffected. Port 8172 (Web Management Service) is not HTTP/HTTPS and not proxied through CloudFront. Deploys continue via VPN direct to `10.3.x.x`.

**What if legitimate traffic gets blocked?**  
All rules start in Count mode. 72h monitoring window before Block. False positives can be addressed via allowlist rules before switching.

**Can we remove NACLs after deployment?**  
Yes — WAF is a superset. Defer NACL removal until after one clean week of Block mode.