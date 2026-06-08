# Review Agent #1 — Disruption Threats to Production Sites

**Reviewer:** Figaro (AI assistant, doing own analysis)
**Date:** 2026-06-04 (round 7, self-performed after subagent failures)
**Scope:** WebDeploy, PubBot, session state, TLS, DNS rollback, WAF false positives
**Verdict:** ⚠️ **3 concrete risks, 1 missing item — all manageable with correct execution order**

---

## 1. WebDeploy / PubBot — Low Risk (but verify Phase 0)

**Finding:** WebDeploy uses MSDeploy via VPN, connecting to the IIS server's port 8172. The server (52.8.85.37) is on a non-routable 10.3.x.x IP behind the VPN — CloudFront never sees this traffic. PubBot publishes to the IIS server directly over the internal network. CloudFront in front of the public-facing HTTP/HTTPS ports (80/443) does not intercept the internal VPN path.

**Risk level:** LOW — if the CloudFront distribution is created with `Origin Protocol Policy = HTTPS Only` and the IIS server has a valid TLS cert, the connection should work. The bigger risk is the *change to the public DNS record* for the site being published to.

**Missing item in plan:** The plan says "Verify WebDeploy via VPN still works" but doesn't specify **how**. The canonical check is: publish a small file via WebDeploy to a CloudFront-fronted test URL, then verify it appears on the origin directly via VPN SSH.

**Action item for Phase 1:** Before migrating edit-site DNS, confirm `brk-site.eightfoldway.com` (which already points to 52.8.85.37) is accessible from the build server via VPN. This validates the VPN path independently of the DNS change.

---

## 2. ASP.NET Session State — Medium Risk

**Finding:** ASP.NET uses in-process session state by default, stored in the IIS worker process memory. The session cookie (`ASP.NET_SessionId`) is scoped to the application path. With CloudFront in front:
- CloudFront does NOT use sticky sessions (they must be explicitly enabled per behavior)
- Multiple CloudFront edge locations may route the same user's requests to different origin IPs (not applicable here — single origin, but relevant if Phase 5 adds an ALB)
- **If the estimator relies on server-held session state and the user hits different CF edge locations**, the session may appear "lost" if the in-process session isn't sticky across CF pop routes

**Risk level for edit-site:** LOW (single IIS server, in-process session — all CF requests for the same user+session cookie route to the same origin)
**Risk level for public-site Phase 3+:** MEDIUM — if public-site ever uses an ALB (not currently planned), sticky sessions must be enabled or session state breaks

**Recommendation:** Phase 0 smoke test should include a login → run → save cycle that exercises session state explicitly. If it works once, it will work consistently for in-process sessions.

---

## 3. TLS Compatibility — Low Risk (IIS 10 defaults to TLS 1.2+)

**Finding:** CloudFront requires minimum TLS 1.0 for client connections (outdated), but communicates to origin using TLS 1.2 or higher by default. The real question is whether the IIS server (52.8.85.37) accepts TLS 1.2 connections from CloudFront origin-facing IPs.

Modern IIS 10 on Windows Server 2019/2022 has TLS 1.2 enabled by default. However, the cipher suite configuration matters — some hardening guides disable TLS 1.0/1.1 but also restrict to specific cipher suites that CloudFront's TLS 1.2 origins support.

**Action item for Phase 0:** When creating the CloudFront distribution, specify `Origin Protocol Policy = HTTPS Only` with `Minimum Origin SSL Protocol = TLSv1.2`. Then smoke test: load a page via the CF domain, verify 200 not 525 (origin TLS error).

---

## 4. DNS Rollback Time — Well Within 5 Minutes

**Finding:** The plan lowers TTL to 60s before migration. Route53 TTL = 60s means:
- After changing DNS: new resolver queries get the new value after ≤60s
- Stale resolvers (which can legally cache up to TTL + 10%): up to ~66s
- Practical worst case: 5-10 minutes for full propagation across all resolvers
- **Realistic rollback window: 5-8 minutes** (not "instant", but well within the Phase 0 monitoring window)

**The plan's assumption of "instant rollback" is slightly optimistic.** A realistic rollback (reverting the CNAME) takes 5-8 minutes to fully propagate. This is acceptable given the 2-hour monitoring window.

**Missing item:** The plan doesn't say what "rollback" means operationally. Recommend: have the Route53 change record pre-staged so Jack can flip it with one click.

---

## 5. WAF Count→Block False Positive Risk — HIGH (edit-site-specific paths)

**Finding:** The plan lists 7 WAF rules (from the proposal). The risk is that legitimate CMS/editor traffic triggers a rule in Count mode, and when switched to Block, editors get locked out.

**Specific concern:** The malicious IPs from the April 20 scan were all Python `requests` library with specific `User-Agent` patterns. A legitimate editor session (say, a county content editor in NJ) using Chrome would not trigger these. BUT:
- If any rule blocks on path patterns like `/planning/` AND the edit-site hosts similar paths, false positives are possible
- IP rate limit rules could affect an editor legitimately if they open many estimator pages rapidly

**Recommendation:** Before Phase 2 (Count→Block), check the Count-mode WAF logs for any hits on the edit-site domain. If the only hits are from the known malicious IPs, Block is safe. If there are hits from other IPs, investigate before switching.

---

## 6. TLS Cert Gaps — HIGH for Phase 0 (must resolve before CloudFront)

**Finding (from Review Agent #4, confirmed here):** CloudFront distributions need a valid ACM certificate in **us-east-1** (CloudFront requirement). The existing ACM certs in us-east-1 are:
- `demo.hb101.org` — used by existing CF distribution
- `maybeckstudio.org` — existing CF
- `analytics.eightfoldway.com` — existing CF
- `elearning.mn.db101.org` — existing CF

**No wildcard certs exist** for `*.eightfoldway.com` or `*.db101.org`.

**Impact for Phase 0:** The plan's `cf-edit-preview` distribution needs `preview2.eightfoldway.com` (or `s4.eightfoldway.com`). The ACM cert must be issued for this exact domain — either by adding it to the existing cert or issuing a new one. CloudFront does NOT support certs from other regions.

**Action item before Phase 0:** Request a new ACM cert for `*.eightfoldway.com` (or `eightfoldway.com` + `*.eightfoldway.com`) in us-east-1, validate via DNS, then create the CF distribution using that cert.

---

## Summary Table

| Risk | Level | Mitigation |
|---|---|---|
| WebDeploy via VPN | LOW | Verify VPN path in Phase 1; don't change DNS without testing |
| ASP.NET session state | LOW (edit), MEDIUM (public ALB) | Phase 0 smoke test covers this |
| TLS compatibility | LOW | Use `Minimum Origin SSL Protocol = TLSv1.2` |
| DNS rollback time | LOW (5-8 min) | Pre-stage revert record; plan's "instant" needs correction |
| WAF Count→Block false positives | MEDIUM | Check Count logs before Phase 2 |
| ACM cert missing for new CF | HIGH | Must request before Phase 0 |

**Recommended plan changes:**
1. Add ACM cert request step before Phase 0 (HIGH priority — blocks Phase 0)
2. Add "pre-stage DNS rollback" step in Phase 0
3. Add "verify VPN path in Phase 1 before changing DNS" step
4. Change DNS rollback assumption from "instant" to "5-8 minutes"
