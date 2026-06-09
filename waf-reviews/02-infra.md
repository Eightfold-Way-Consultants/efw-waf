# Review Agent #2 — Infrastructure Accuracy

**Reviewer:** Figaro (AI assistant, self-performed)
**Date:** 2026-06-04 (round 7, self-performed after subagent failures)
**Scope:** AWS infrastructure verification vs plan claims
**Verdict:** ✅ **Plan's stated IPs are correct; 3 significant gaps found (WAF ACLs, ACM wildcard certs, zone count)**

> **⚠️ CORRECTION (2026-06-08, registry WHOIS):** The "18 hosted zones / 9 additional zones" finding below counts Route53 hosted zones, not live domains. WHOIS proves real scope = **5 live zones** (`db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`, `housingbenefits101.org`); the rest are unregistered or parked (orphan zones). See `04-route53.md` correction banner and `waf-cloudfront-migration.md` Decisions.

---

## 1. Verified Facts

### Origin IPs — Correct ✅
| Record | Plan says | Actual | Match |
|---|---|---|---|
| `s4.eightfoldway.com` | 52.8.85.37 | 52.8.85.37 | ✅ |
| `brk-site.eightfoldway.com` | 52.8.85.37 | 52.8.85.37 | ✅ |
| `edit-site.eightfoldway.com` | → s4 → 52.8.85.37 | CNAME→s4.eightfoldway.com→52.8.85.37 | ✅ |
| `preview2.eightfoldway.com` | → preview2-site → s4 → 52.8.85.37 | CNAME→preview2-site.eightfoldway.com→s4.eightfoldway.com→52.8.85.37 | ✅ |
| `s6.eightfoldway.com` | 52.8.7.0 | 52.8.7.0 | ✅ |
| `s6c.eightfoldway.com` | 52.8.7.0 | 52.8.7.0 | ✅ |
| `s6a.eightfoldway.com` | 52.8.7.0 | 52.8.7.0 | ✅ |
| `db101.org.` apex | 52.8.7.0 | 52.8.7.0 | ✅ |

### Phase 0 canary — Identified ✅
`preview2.eightfoldway.com` → `preview2-site.eightfoldway.com` → `s4.eightfoldway.com` → **52.8.85.37**
Chain has 3 CNAME hops. Lower TTL on `preview2.eightfoldway.com` to 60s.

---

## 2. Inaccurate / Incomplete Plan Items

### Hosted Zone Count — Dramatically Understated ❌
**Plan says:** "3 hosted zones (`db101.org`, `hb101.org`, `eightfoldway.com`)"  
**Reality:** 18 hosted zones in Route53 (per Review Agent #4). At least 9 additional zones have A records pointing to 52.8.7.0 (public-site origin) or 52.8.85.37 (edit-site origin):
- `njdisabilitybenefits.org`, `njdb101.net`, `njdb101.com`, `njdb101.org`, `njdisabilitybenefits.net`, `vets101.org`, `vb101.org`, `housingbenefits101.org`, `workbenefitsyouth.org`

**Impact:** Plan's DNS change section only covers the 3 named zones. The 9 other zones also need their A records migrated to CloudFront in Phase 3/4.

**Recommended plan change:** Add a table in Phase 3/4 listing all zones with A records to 52.8.7.0, not just "s6.db101.org and 5 remaining". The plan currently says "all 48 public-state sites + hb101.org" but the zone count gap means the DNS work is 3x larger than the plan implies.

### WAF ACLs — None Exist Yet ⚠️
**Plan says:** Attaches `edit-preview-web-acl` and `db101-public-web-acl` to CloudFront distributions  
**Reality:** `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1` returns **zero results** — no WAF Web ACLs exist in the account yet.

**Impact:** The plan's Phase 0 step "Create WAF Web ACL `edit-preview-web-acl` (Count mode, 7 rules)" is a *creation* step, not an attachment step. The WAF ACL must be created before it can be attached. The plan doesn't include the 7-rule definition — those rules must be specified as part of Phase 0.

**Recommended plan change:** Phase 0 should explicitly list the 7 WAF rules (or reference the proposal's rule definitions) before the CloudFront distribution is created. The WAF ACL creation + CloudFront creation can be done in parallel (create CF without WAF, then attach after ACL is defined).

### ACM Wildcard Certs — Missing ❌
**Plan says:** No mention of certificate requirements for CloudFront  
**Reality:** 4 ACM certs exist in us-east-1, but **no wildcard certs** for `*.db101.org`, `*.eightfoldway.com`, or `*.hb101.org`. CloudFront requires the cert to match the domain exactly.

**Phase 0 cert options:**
1. Add `preview2.eightfoldway.com` to the existing `analytics.eightfoldway.com` cert (if it's a SAN cert that supports additional names) — but this cert doesn't currently cover `eightfoldway.com` apex or wildcard
2. Request a new ACM cert for `eightfoldway.com` (apex) + `*.eightfoldway.com` (wildcard) in us-east-1
3. Use a third-party cert uploaded to IAM (not recommended — ACM auto-renewal is easier)

**Recommended plan change:** Add explicit ACM cert step to Phase 0 — "Request and validate ACM cert for `*.eightfoldway.com` in us-east-1 before creating CloudFront distribution."

---

## 3. Missing Items in Plan

### CloudFront Cache-Bypass Paths — Potentially Incomplete ⚠️
The plan lists: `/planning/*`, `/tw/*`, `/pdfreport/*`, `/l2svc/*`, `/f2svc/*`, `/ajax/*`, `/api/*`, `/chatpresence/*`, `*.aspx`

**Likely missing (check codebase before Phase 1):**
- `/auth/*` — login/logout flows
- `/download/*` — PDF/Excel exports if served via ASPX
- `/report/*` — any reporting endpoints
- `/asset/*` — static asset paths served by ASP.NET
- Any custom handler paths (*.ashx, *.asmx)

**Action item:** Before Phase 1, run `qmd search "cache-bypass OR no-cache" -c f8-contentmanager` or grep Web.config files for `<add>` directives matching path patterns. Compare against the plan's bypass list.

### Existing CloudFront Distributions — 5 Already in Use ⚠️
The plan should note that 5 CloudFront distributions already exist:
| Distribution | Domain | Origin | In Scope? |
|---|---|---|---|
| E1AVN5NXPLQH8T | elearning.mn.db101.org | S3 | No (not in plan scope) |
| E3MWRPOO6OPDTJ | images.maybeckstudio.org | S3 | No |
| E3NCZEM9Q73ECA | scripts.maybeckstudio.org | S3 | No |
| E7ED0X655XU9M | demo.hb101.org | S3 | No |
| E9TJIJRGLT6QE | analytics.eightfoldway.com | ALB | No (monitor for quota impact) |

**Quota consideration:** CloudFront has per-account limits (e.g., 200 distributions per AWS account). Adding 2 new distributions (edit-site + public-site canary) brings total to 7, well within limits. **No action needed, but plan should acknowledge this.**

---

## 4. Cost Estimate — Reasonable but Low-Side

The plan estimates $25-35/mo baseline. Current infrastructure:
- 1 WAF Web ACL (Count mode, 7 rules): ~$5/mo (WAF charges per ACL + per rule)
- 1 CloudFront distribution (edit-site, moderate traffic): ~$5-10/mo
- Route53 hosted zones (18 zones): $0.54/mo (18 × $0.025/zone/day × 30)
- Data transfer (estimated): depends on traffic

**Estimate seems reasonable.** Add $5/mo buffer for CloudWatch alarms.

---

## Summary Table

| Item | Plan says | Reality | Gap |
|---|---|---|---|
| Origin IPs | 52.8.85.37 / 52.8.7.0 | Verified correct | None |
| Hosted zones | 3 | 18 total | Plan understates by 15 zones |
| WAF ACLs | "attach" | 0 exist — must create | Plan doesn't define rules |
| ACM certs | Not mentioned | No wildcard; CF domain requires cert | Phase 0 blocked without cert |
| Existing CF distributions | Not mentioned | 5 in use | Informational only |
| Cache-bypass paths | 9 patterns | likely incomplete | Need codebase check |

**Recommended plan changes:**
1. Add ACM wildcard cert request to Phase 0 (HIGH — blocks Phase 0)
2. Expand Phase 3/4 DNS section to cover all 18 zones (not just 3 named)
3. Add WAF rule definition to Phase 0 (7 rules, from proposal)
4. Add cache-bypass completeness check to Phase 1 prep
5. Add note about existing CF distributions to plan (informational)
