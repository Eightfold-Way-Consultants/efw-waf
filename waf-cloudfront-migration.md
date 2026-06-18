---
title: WAF + CloudFront — preview2 first, then public; edit tier stays direct
status: today
assignee: jack
priority: high
tags: [infrastructure, security, waf, cloudfront]
reorder: 2026-06-04
---

# WAF + CloudFront for DB101/HB101

## Summary
Deploy AWS WAF + CloudFront to block automated scanner traffic (28+ malicious IP clusters scanning for `.env`, `.git`, AI configs, WordPress paths on April 20).

**Strategic change (2026-06-11, supersedes 2026-06-04 "edit-site first"): the edit-cms tier is NOT fronted at all — preview2 leads, then public. Two distributions, not three.** The IIS-accuracy review (2026-06-10) found editors authenticate with NTLM/Negotiate, which is connection-oriented and breaks behind any L7 proxy (CloudFront and ALB both reuse origin connections across viewers); CloudFront additionally strips `Authorization` unless it's in the cache key. Fronting the edit tier would force a downgrade to Basic auth (browser password prompt — daily UX regression) for ~zero gain: the tier already 401s all anonymous traffic at IIS, and its content is dynamic (no cache value). **Decision B (2026-06-11): `edit-site.eightfoldway.com`, the `db101-*`/`hb101-*` edit names, `brk-site`, and `q.db101.org` stay DNS'd direct to web-04.** Rollout order: preview2 (low-traffic published canary on web-04) → public (web-06). Cost: web-04's 443 stays internet-open in Phase 5 (editors are distributed; surface is NTLM-gated) — partial SG lockdown only.

## Context
- Investigation: `memory/2026-04-21.md`
- Original WAF proposal (now superseded in phase order): `projects/f8-platform/waf-proposal.md`
- v2 with cache config: `projects/f8-platform/waf-proposal-v2-with-cache-config.md`
- DNS plan: `projects/f8-platform/dns-migration-plan.md`
- Review reports (round 7): `projects/f8-platform/waf-reviews/`
  - 01-disruption.md — WebDeploy, session state, TLS, DNS rollback, WAF false positives
  - 02-infra.md — Origin IPs ✅, zone count gap (18 vs 3), WAF ACLs (0 exist), ACM cert gap
  - 03-dynamic-paths.md — Cache bypass list: 3 missing paths found, 4+ likely missing
  - 04-route53.md — listed 18 Route53 hosted zones; **WHOIS (2026-06-08) proves only 5 are live + in scope** (see Decisions). Most "extra" zones are unregistered or parked.

## Decisions
- **Edit-cms tier NOT fronted (Decision B, 2026-06-11).** NTLM is connection-oriented → dead behind any L7 proxy (CloudFront/ALB); WAF can only attach to L7 termination, so "WAF without losing NTLM" is impossible. Tier is already auth-gated at IIS → WAF adds ~nothing; Basic-auth fallback would be a daily editor UX regression. Edit names + `q.db101.org` stay direct to web-04. Net: **2 content distributions** (preview2, public) + 1 redirect.
- **preview2 first, then public.** preview2 = lower blast radius on web-04, published cache model, validates WAF rules/caching/invalidation/DNS before any s6 (public) traffic moves. **Nothing on s6 moves until preview2 is proven** (Count → Block clean).
- **CloudFront + WAF** (not ALB) — blocks at edge, caches static content, lower cost.
- **WebDeploy** routes via VPN to non-routable IPs (10.3.x.x), no public exposure — must be re-verified end-to-end after edit-site cutover.
- **NACLs** can be decommissioned once WAF is active on a stack (WAF is superset). Defer NACL removal until public-site Phase B, after one clean week of edit-site Block mode.
- **Cache bypass** — plan's list is incomplete (review 03-dynamic-paths.md). Must add: `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`. Likely missing: `/auth/*`, `/download/*`, `*.ashx`.
- **Start in Count mode**, monitor 72h before switching to Block. (preview2 gets a longer 1-week Count window before Block — it's the validation tier.)
- **ACM cert required before Phase 0** — no wildcard cert in us-east-1; must request `*.eightfoldway.com` before CloudFront distribution can be created.
- **Zone scope = 5 live zones (WHOIS-verified 2026-06-08).** Registry WHOIS proves the migration touches only `db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`, `housingbenefits101.org` — all registered with AWS Route53 NS delegation. Review 04's larger zone count was inflated by **orphan hosted zones**: a Route53 zone is inert unless the domain's registrar NS points back at AWS.
  - **Unregistered** (do not exist at registry): `njdisabilitybenefits.org`, `njdisabilitybenefits.net`, `njdb101.net`, `njdb101.com`, `vb101.org`, `workbenefitsyouth.org`, `disabilitiesbenefits101.org` (typo zone). Their A-records to 52.8.7.0 resolve for nobody.
  - **Parked** (registered, NS at NameFind/GoDaddy, not Route53): `njdb101.org` — zone dead.
  - **Live but out of scope:** `disabilitybenefits101.org` (owned + Route53 but unused — leave alone); `maybeckstudio.org` (separate origin).
- **`hb101.org` renewal — VERIFIED OK 2026-06-11** via GoDaddy API: `renewAuto=True`, expires 2026-06-23 (all 11 domains in the account auto-renew). One-time check of the payment method in the GoDaddy UI is the only residual.
- **`housingbenefits101.org` → redirect to `hb101.org`, not fronted content.** Verified 2026-06-08: the zone has no apex/www records and only `mn.`/`preview-mn.`/`preview2-mn.housingbenefits101.org` content hosts (a parallel HB101-MN brand on the same origins). Decision: collapse the whole domain to a 301 redirect to `hb101.org` — retire/redirect the `mn.*` content hosts rather than add them to the content distributions. Implement as a small **redirect distribution** — scaffolded at [`cloudformation/redirect.yaml`](cloudformation/redirect.yaml) (CloudFront Function returning `301` to `https://hb101.org` + path/query; cfn-lint clean), using the existing cert (`housingbenefits101.org` + `*.housingbenefits101.org` SANs already on it; verified present). Aliases `housingbenefits101.org` + `*.housingbenefits101.org`. Route53: apex `housingbenefits101.org` ALIAS + `www` + the `mn.*`/`preview*.*` hosts all point at the redirect distribution. This keeps it out of the content-caching stacks entirely.
- **One ACM cert covers all 5 zones** (10 SANs: apex + wildcard each) — well under the 30-SAN limit. The 2-cert concern in review 04 no longer applies. **Status: ISSUED 2026-06-08** — `arn:aws:acm:us-east-1:874922373146:certificate/d25dc33a-a3fa-4273-a14c-2b8b04ed7507`.
- **HTTP→HTTPS redirect moves to the front end (CloudFront).** `edge.yaml` sets `ViewerProtocolPolicy: redirect-to-https` on all behaviors → CloudFront 301s at the edge (no origin round-trip). The existing **on-IIS http→https redirect becomes redundant for fronted traffic** (CloudFront connects to origin HTTPS-only, so IIS never sees viewer HTTP) — keep it as defense-in-depth for direct-origin access until Phase 5 SG lockdown, then it's moot. *Host*-level www canonicalization (www.<state>.db101.org → bare host) is **out of scope** — those 2-level www hosts don't work today anyway (and aren't covered by the `*.db101.org` cert), so they're not being migrated or redirected. Content www's (`www.db101.org`, `www.eightfoldway.com`) stay as content on the public dist; `www.hb101.org`/`www.db101.org` are CNAMEs handled normally.
- **All AWS objects built as CloudFormation (IaC)** — no click-ops. WAF, CloudFront, policies, logging, alarms are version-controlled, peer-reviewable, and rollback-able as stacks. DNS cutover stays manual/staged (canary + TTL + one-click revert) and is the *only* out-of-stack step. See "Infrastructure as Code" below.

## Application changes (START EARLY — code lead time, gate cutover)

These are **application-side** changes (not AWS config) that must land **before** the relevant cutover. They have development/QA lead time, so start them now in parallel with the infra work — don't discover them at cutover.

- [ ] **`pdfreport` print server — repoint to origin-direct (do this first).** The local Puppeteer-based estimator PDF/print server currently renders by fetching the **public hostname**, which loops back to the box's own EIP (confirmed: it's the `52.8.7.0` self-traffic, ~379 `/planning/` hits in the 2026-06-08 logs). After CloudFront, that path goes through the WAF and the `/planning/` **Challenge would break PDF generation** (headless Chrome may not solve it), plus a wasteful hairpin. **Fix:** point Puppeteer at the origin directly — `https://localhost` or internal `10.3.0.63` with an explicit `Host:` header — so it never touches CloudFront/WAF. Use the **internal IP, not the public one**, so it also survives Phase 5 (origin SG locked to the CloudFront prefix list). Fallback if it can't be repointed: WAF terminating `Allow` on `52.8.7.0/32` before the Challenge (keeps the hairpin). **This gates public-site cutover (Phase 3/4).**
  - **Proven live under preview2 Block (2026-06-17) — it's MULTIPLE server-side self-fetches, not one, and the `pd.js --host-resolver-rules` fix only covers Chrome (.NET fetches ignore it).** Each is s4 (egress `52.8.85.37`) referencing its own site by the **public hostname** → CloudFront → WAF:
    1. **Spec fetch** — `pdf/PDFJob.cs:173` `XmlDocument.Load(SpecUrl)` (default `XmlUrlResolver`, **no User-Agent**) → WAF `NoUserAgent_HEADER` block. Fix: fetch via `HttpWebRequest` to `http://127.0.0.1` with `Host` = origin host + a UA, then `Load(stream)`.
    2. **TOC page-count SOAP** — `session.ui/ReportTOC.cs` `PDFReportService.CountPages()` → `/pdfreport/PDFReportService.asmx` via `AppSettings["PDFReportServiceLocation"]` (a **per-site public-host** value) → CloudFront **403** → the TOC page renders an ASP.NET error into `report.pdf` page 1. Fix: SOAP client `Url = http://127.0.0.1/pdfreport/PDFReportService.asmx` + `GetWebRequest` override setting `req.Host` = origin host; **retire the per-site `PDFReportServiceLocation`**.
    3. **Linchpin** — `session.ui/PDFReportSpec.cs:80` builds every render/doc/TOC URL as `Request.Url.Scheme://Request.Url.Host + path`, freezing whatever host this hop arrived on into all downstream URLs. `Request.Url.Host` here is the *renderer's* fetch host (propagated, can become `127.0.0.1`) — unreliable. Fix: **capture the authoritative origin host once in the end-user request** (`PDFReportOrder` → add `_oh=<Request.Url.Host>` to the spec URL), thread it as `_oh`, and build render URLs + the SOAP `Host` from it. Connect loopback, present origin `Host` everywhere.
  - **Canonical-redirect / `nssl` mechanism — proven from s4 live config (2026-06-17):** the site `web.config` URL Rewrite rule **"EFW all supported domains: canonical HTTP to HTTPS rewrite"** 302s any HTTP request on a `db101.org|hb101.org|eightfoldway.com` host to `https://{same host}/…`. It has **two bypass conditions**: `{QUERY_STRING}` `nssl=true` (negate) **and** `{REQUEST_URI}` `/pdfreport/` (negate). Consequences for the loopback self-calls: **`/planning` self-fetches (spec, render URLs) MUST keep `nssl=true`** or IIS 302s the HTTP loopback fetch to `https://<host>` → CloudFront (re-hairpin); **the `/pdfreport` SOAP self-call is path-exempt → needs NO `nssl`** (plain `http://127.0.0.1/pdfreport/…` is served directly). `nssl` is therefore load-bearing, not vestigial. (Origin rationale unrecoverable — `nssl` dates to the 2014-08-28 SVN "Initial add" (r21); no commit message anywhere mentions it. Best-available reasoning: HTTPS enforced site-wide for security posture; `nssl` keeps same-box self-fetches on plain HTTP to dodge the forced-HTTPS bounce + the cert-mismatch of a box TLS-fetching itself. Don't re-dig.) preview2 sites have an HTTP:80 binding (loopback-HTTP works); https bindings are `sslFlags=1` (SNI). **Same rule + `nssl` on s6 → identical behavior at public cutover.**
- [ ] **PubBot / `Document.ExportForPreview` — CloudFront invalidation (`InvalidateCdn`).** Reference scaffold in [`src/Cdn/`](src/Cdn/). Ambient suppress/coalesce scope so PubBot fires one coarse invalidation and manual exports invalidate at the outermost level. Needed before published-tier content goes behind cache (Phase 1+). See "CloudFront Invalidation".
- [ ] **Client-IP handling behind CloudFront (XFF + IPv6) — consolidated.** After cutover the origin's TCP source becomes a CloudFront *edge* IP (varies per request), so every component that reads client IP must use `X-Forwarded-For` / `CloudFront-Viewer-Address` and be IPv6-safe. CloudFront is dual-stack → IPv6-heavy. Three sites, same root cause:
  1. **Estimator session IP-pinning** (`bp101-interface/session/EngineSession.cs` `CurrentIP()`/`IsValidIPRequest()`; trigger at `session.ui/ScreenPage.cs:150` → bounce to picker). Reads XFF-first, so NOT a clobber-everyone blocker (preview2 tested clean), BUT: (a) **crash** — IPv6-created session + later IPv4 request → `CreatorIP.Substring(0,-1)` ArgumentOutOfRangeException → 500 mid-walk (dual-stack/mobile network flip); (b) IPv6-current request disables the check entirely; (c) `/24` heuristic is IPv4-only; (d) takes the **first** XFF token (client-spoofable — CloudFront appends the real viewer as the **last** token, doesn't strip client XFF). Fix: prefer `CloudFront-Viewer-Address` / last XFF token; version-aware compare (IPv6 → /64 or full, never `Substring(0,-1)`); or relax/retire the echo heuristic (WAF/Challenge now carries bot defense). See memory `estimator-ip-pinning-cloudfront`. **Gates public cutover** (mobile protocol-flip → intermittent 500s).
  2. **Logon `RateLimitAttribute`** (`Logon2.2` `efw.WebAPIUtil/RateLimitAttribute.cs`) keys per-IP on the **first** XFF token. `/l2svc` is ARR-reverse-proxied (and the auth work may add CloudFront) → verify it resolves the **true viewer**, not the proxy hop (else it rate-limits the proxy = everyone), and is IPv6-aware. Ties to the Turnstile/auth plan (`waf-reviews/turnstile-integration-plan-2026-06-17.md`).
  3. **WAF rate rules** (`edge.yaml` `RateLimit`/`RateLimit-Estimator`) aggregate IPv6 per-`/128` by default → a `/64`-rotating client evades per-IP limits (Challenge backstops). Config-side; consider `/64` IPv6 aggregation. Tune in Count. (Found in A9/A10 test, 2026-06-17.)
- [ ] *(lower priority, separate)* estimator entry double-request fix — see `data/iis-logs-260608/double-request-signature.md`. Cleanup, not a cutover gate.

## Infrastructure as Code (CloudFormation)

All WAF + CloudFront objects are provisioned via CloudFormation in **us-east-1** (required for `CLOUDFRONT`-scope WAF and CloudFront). Templates live in [`cloudformation/`](cloudformation/). Two-template design: one shared base stack + one parameterized edge stack deployed **twice** (preview2, public).

> **Four site tiers across two origins — the edit-cms tier stays direct (Decision B):**
>
> | Tier | Example host | Origin (server) | Fronting |
> |---|---|---|---|
> | CMS edit-site | `db101-nv.eightfoldway.com` | s4.eightfoldway.com (web-04) | **DIRECT — never fronted** (NTLM) |
> | preview2 (rapid prototyping) | `preview2-nv.db101.org` | s4.eightfoldway.com (web-04) | `efw-waf-edge-preview2` dist |
> | staging | `preview-nv.db101.org` | s6.eightfoldway.com (web-06) | `efw-waf-edge-public` dist |
> | public | `nv.db101.org` | s6.eightfoldway.com (web-06) | `efw-waf-edge-public` dist |
>
> **HB101 mirrors this** in the `hb101.org`/`eightfoldway.com` zones: `hb101-mn.eightfoldway.com` (direct), `preview2-mn.hb101.org` (preview2), `preview-mn.hb101.org` (staging), `mn.hb101.org` (public). Same 2 distributions, just added to the alias lists.
>
> **vets101 is a national site** (single site, no per-state wildcard) with the same 4 tiers: `vets101.eightfoldway.com` (direct), `preview2.vets101.org` (preview2), `preview.vets101.org` (staging), `vets101.org` apex with `www.vets101.org` → apex (public). The `vets101.org` apex needs **ALIAS** conversion.
>
> Both fronted tiers serve **published** content (CMS exports), so they share one cache model (full static set cached, dynamic no-cache). They still need separate distributions because they sit on different origins. Staging and public share the s6 origin *and* the cache model → one distribution (distinguished by alias). Net: **2 content distributions** + the housingbenefits101 redirect distribution.
>
> **Origin FQDNs, not IPs:** CloudFront rejects raw-IP origins, and `https-only` means the origin cert must validate the name (SNI = origin domain). `OriginDomainName` = `s4.eightfoldway.com` (preview2) / `s6.eightfoldway.com` (public). These names must **never** be DNS'd at CloudFront (request loop). Pre-cutover: web-06 needs an IIS 443 binding for `s6.eightfoldway.com` (cert 8CA90463 already covers it); origin certs expire **2026-08-05 (web-04) / 2026-08-26 (web-06)** — renewal calendar item, expiry = outage under https-only.
>
> **Host is in the static cache key** (`CachePolicyStatic`): IIS routes by Host, so `nv.db101.org/x.htm` ≠ `mn.db101.org/x.htm` at the same path. Without Host in the key, states collide and staging could leak onto public. Including Host also forwards it to the origin for IIS routing.

### Stack 1 — `efw-waf-base` (shared, deploy once)
Account-global building blocks reused by all edge stacks.

| Logical resource | CFN type | Purpose |
|---|---|---|
| `ScannerIpSet` | `AWS::WAFv2::IPSet` | Manual surgical blocklist (empty seed, OpenClaw-fed) |
| `AllowIpSet` | `AWS::WAFv2::IPSet` | Fast-UNBLOCK lever (empty seed) — priority-0 terminating Allow in each ACL; add a legit /32 mid-incident for instant relief, remove after tuning |
| `WafLogBucket` | `AWS::S3::Bucket` | WAF + CloudFront access logs, lifecycle expiry 90d |
| `OriginVerifySecret` | `AWS::SecretsManager::Secret` | `X-Origin-Verify` shared secret (CF → origin header) |
| `AlarmTopic` | `AWS::SNS::Topic` | CloudWatch alarm notifications — **email-subscribed via `AlarmEmail` param** (confirm the SNS subscription email on deploy, or every alarm is silent) |

*(No Googlebot/Bingbot IP sets — verified-bot allowlist dropped, see WAF rule notes.)*

### Stack 2 — `efw-waf-edge` (parameterized template, deploy 2×)
Deployed **twice**, same template, different parameters (HB101 follows the same tier pattern as DB101, in the `hb101.org` + `eightfoldway.com` zones):
- **`efw-waf-edge-preview2`** — origin `s4.eightfoldway.com`. Aliases: explicit list — `preview2-*.db101.org`, `preview2-*.hb101.org`, `preview2.vets101.org` (rapid-prototyping published sites, static incl `*.htm`).
- **`efw-waf-edge-public`** — origin `s6.eightfoldway.com`. Aliases: **both** public (wildcards + apexes — see alias strategy below) **and** staging (`preview-*` rides the wildcards) — same origin + cache model.
- **Edit-cms names are NOT in any alias list** — `db101-*`/`hb101-*`.eightfoldway.com, `vets101.eightfoldway.com`, `edit-site`, `brk-site`, and **`q.db101.org`** stay DNS'd direct to web-04. **DNS wrinkle for `q.db101.org`:** today it CNAMEs through the `preview2-site` chain; at preview2 cutover that chain head repoints to CloudFront, so `q` must first be **decoupled — re-point it directly at `s4.eightfoldway.com`** so it keeps bypassing the cache/WAF entirely.

### ⚠️ Alternate domain name (CNAME) strategy (decided 2026-06-10)
CloudFront alias mechanics that drive the lists: wildcards replace the **whole leftmost label only** (`*.db101.org` valid, `preview2-*.db101.org` invalid); aliases are **globally unique across all CloudFront accounts**; a **specific alias overrides a wildcard** (and can move/coexist within our own account); the edge routes by SNI/Host lookup, not by distribution IP.

- **Public dist gets the wildcards + apexes:** `*.db101.org`, `db101.org`, `*.hb101.org`, `hb101.org`, `*.vets101.org`, `vets101.org`, plus explicit `www.eightfoldway.com`, `eightfoldway.com`. Staging `preview-*` names ride the wildcards automatically. (No `*.eightfoldway.com` — that zone is mostly edit/infra names that stay direct, and `analytics.eightfoldway.com` lives on a separate existing distribution.)
- **preview2 dist = explicit enumerated list** (`preview2-nv.db101.org`, …, `preview2-mn.hb101.org`, `preview2.vets101.org`): specific-overrides-wildcard carves each one out of the public dist's `*.db101.org`. Bounded (~24 states × brand), well under the 100-alias limit. **New state = one preview2 alias entry + DNS records; zero other per-site config anywhere in WAF/CloudFront.**
- **Public dist also carries explicit non-wildcard eightfoldway.com aliases** (no `*.eightfoldway.com` wildcard on our dists, so listed individually): `www.eightfoldway.com`, `eightfoldway.com` (apex/ALIAS), `preview.eightfoldway.com` (corporate staging, aspirational — alias present, origin 404s until a staging site exists), `turtles.eightfoldway.com` (kept-sentimental static page).
- `housingbenefits101.org` + `*.housingbenefits101.org` go on the **redirect** distribution, not the content dists.
- **Never alias:** `s4`/`s6`.eightfoldway.com (origin FQDNs — loop), edit-tier names, `q.db101.org`.

| Logical resource | CFN type | Purpose |
|---|---|---|
| `WebAcl` | `AWS::WAFv2::WebACL` | Bot Control, CommonRuleSet (OWASP), KnownBadInputs, rate-limit, IP blocklist, bot allowlists. Rule actions driven by `RuleAction` param (`Count`→`Block`). |
| `WebAclLogging` | `AWS::WAFv2::LoggingConfiguration` | Ships WAF logs to `WafLogBucket` |
| `CachePolicyStatic` | `AWS::CloudFront::CachePolicy` | Long-TTL caching for the static set |
| `OriginRequestPolicyDynamic` | `AWS::CloudFront::OriginRequestPolicy` | AllViewer (fwd all headers/cookies/qs) for no-cache default |
| `ResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | HSTS + security headers (ties into CSP hardening work) |
| `Distribution` | `AWS::CloudFront::Distribution` | Origin + cache behaviors, WAF attached, ACM cert, HTTPS-only, alternate domain names |
| `Alarm5xx` | `AWS::CloudWatch::Alarm` | Origin 5xx rate spike |
| `AlarmWafBlocked` | `AWS::CloudWatch::Alarm` | WAF blocked/counted-request spike |

**Cache model (fail-closed):** default behavior = `CachingDisabled`; only the static set is cached. Both fronted tiers are published (CMS exports), so one set: `/dist/*`, `*.css`, `*.js`, `*.htm`, `/master_images/*`, `/master_documents/*`, `/documents/*`, `/images/*`. (The cms/published SiteType split is gone — the edit tier isn't fronted.)

### WAF Web ACL rule set & bot strategy

Two distinct concerns, both handled in one ACL (default action Allow; rules in priority order):

| Pri | Rule | Action | Scope | Concern |
|----|------|--------|-------|---------|
| 0 | `IP-Allowlist-Override` | **Allow** (terminating) | all | fast-unblock lever — empty seed, add legit /32s mid-incident |
| 1 | `IP-Blocklist-Scanners` | Block/Count | all | known-bad IPs (empty seed, OpenClaw-fed) |
| 2 | `SensitivePaths` | Block/Count | all | block `.git`/`.env`/`*.bak`/`*.config`/`elmah.axd`/`trace.axd` — "getting lucky" net |
| 3 | `AWS-IpReputation` | managed | all | **general probes** — auto bad-actor IPs |
| 4 | `AWS-CommonRuleSet` | managed | all | **general probes** — path-traversal/SQLi/XSS (no overrides: published bodies are small; the 44KB CMS-admin ViewState is moot — edit tier not fronted) |
| 5 | `AWS-KnownBadInputs` | managed | all | **general probes** |
| 6 | `Challenge-Estimator` | **Challenge** | `/planning/*` | **estimator bot-walking (primary)** |
| 7 | `RateLimit-Estimator` | Block/Count | `/planning/*` | estimator flood backstop (300/IP/5min) |
| 8 | `RateLimit` | Block/Count | all | flood backstop (500/IP/5min — above gov-NAT reality) |
| 9 | `AWS-BotControl` (optional, paid) | managed | all | **OFF — deferred** (see below) |
*(No verified-bot allowlist — dropped: robots.txt bars `/planning/`, Challenge is `/planning`-scoped, so a UA+IP allow would be a pure spoof hole.)*

**Primary concern — bots walking estimators.** `/planning/*` is dynamic, no-cache, server-side compute (the planning engine); caching can't absorb it, so the edge WAF is the only lever. `Challenge-Estimator` issues a **silent browser proof-of-work**: real browsers solve it transparently and get a token cookie (one-time per immunity window — a counselor clicking through steps is challenged once, invisibly); headless/scripted/distributed bots fail and never reach IIS. This beats rate-limiting alone, which distributed low-per-IP bot fleets evade. `RateLimit-Estimator` is a per-IP backstop scoped to `/planning/*`.

**Secondary concern — general website probes.** Rules 2–5 + 8 are the standard probe defense (bad-path patterns, reputation, known-bad inputs, rate cap), on all tiers/paths. The continuous IP layer is `AWS-IpReputation` (auto-updating). The manual `IP-Blocklist-Scanners` set is **shipped empty** — the original 2026-04-20 /32 list was verified 0/27 still-active by 2026-06-08 (cloud scanner IPs rotate within weeks), so a static seed is false comfort. Keep the *rule* as a surgical/fast-block lever and **feed it operationally**: have the **OpenClaw nightly job push freshly-observed abusive IPs/CIDRs** into the `efw-scanner-ips` set (supports CIDR/ASN blocks for never-legit hosting nets). For a known-bad manual entry, immediate **Block** is fine (no need to Count-observe an IP you've already judged).

**"Getting lucky" / sensitive paths.** Scanners spray WordPress/PHP/Java/Python exploits, but this is .NET/IIS so they 404 (wrong stack). The .NET-relevant lucky-hits are different (exposed `.git/`, `web.config.bak` served as text, `elmah.axd`/`trace.axd` error logs, deploy artifacts). **Tested 2026-06-09: nothing currently exposed** — public site 404s all of them (`trace.axd` is 403/protected), edit site is 401/NTLM-gated. The real risk is a *future deploy* leaking one into wwwroot, so `SensitivePaths` (rule 2) blocks those patterns at the edge as belt-and-suspenders. OWASP alone doesn't catch them (a plain `GET /.git/config` isn't an "injection"). Also harden: confirm `trace.axd` disabled in prod web.config; keep deploy artifacts (`.git`, `*.bak`, `*.zip`) out of wwwroot.

**Bot Control — deferred (OFF at launch).** It costs $10/mo per ACL (×3 ACLs) + per-request fees and would false-alarm `public-url-checker`. Given the rest of the stack, its only *unique* value is catching JS-capable headless bots that solve the Challenge and still walk estimators — for which the real logs show **zero evidence**. Probes are handled by rules 1–5; content scraping is largely absorbed by the CloudFront cache; estimator bots by the Challenge. **Turn on (TARGETED) only if post-launch data shows `/planning/` origin load with non-human patterns despite the Challenge.** For the empty-UA Azure scrapers (~324/5min on content), prefer a free custom "block empty User-Agent" rule (Count first; check the checker's UA) over the paid managed group.

### Key parameters (`efw-waf-edge`)
| Parameter | preview2 | public |
|---|---|---|
| `OriginDomainName` | `s4.eightfoldway.com` | `s6.eightfoldway.com` |
| `AcmCertificateArn` | (shared cert ARN) | (same) |
| `AlternateDomainNames` (see alias strategy) | explicit: `preview2-<state>.db101.org`, `preview2-mn.hb101.org`, `preview2.vets101.org` | wildcards + apexes: `*.db101.org`, `db101.org`, `*.hb101.org`, `hb101.org`, `*.vets101.org`, `vets101.org`, `www.eightfoldway.com`, `eightfoldway.com` (staging `preview-*` rides the wildcards) |
| `RateLimit` (site-wide /IP/5min) | `500` | `500` |
| `PlanningRateLimit` (`/planning/*` /IP/5min) | `300` | `300` |
| `WafRuleAction` | `Count` → `Block` | `Count` → `Block` |
| `MinimumOriginSslProtocol` | `TLSv1.2` | `TLSv1.2` |

### What is NOT in CloudFormation (deliberate)
- **ACM cert** — already issued out-of-band; passed in as a parameter (ARN), never recreated.
- **Route53 cutover records** — the apex ALIAS / `s6`/`s4` CNAME flips stay manual + staged so the canary, 60s-TTL pre-lower, and one-click rollback work without a full stack update. (Optional later: a separate record-only stack once cutover is proven.)
- **Route53 `cf-*` terminator records** — `cf-preview2`/`cf-public`/`cf-redirect` (each → its distribution's domain) are created/maintained **manually**, deliberately NOT stack-owned, so a stack teardown or distribution replacement can't NXDOMAIN the live site records that depend on them. The stack only **outputs** the dist domain. Full rationale under "DNS terminator scheme" below.
- **Validation CNAMEs** — already in Route53, left in place for auto-renew.

### Deploy order
1. `aws cloudformation deploy --stack-name efw-waf-base --template-file cloudformation/base.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-1` (then **confirm the SNS subscription email**)
2. `... efw-waf-edge-preview2` with preview2 params (Phase 0 canary)
3. `... efw-waf-edge-public` with public params (Phase 3/4 — only after preview2 is proven)
4. Read distribution domain from each stack's `Outputs`, use it as the DNS cutover target.

## Testing & measurement — two distinct activities

Keep these separate; they answer different questions:

- **A. Configuration validation** — *one-time, per cutover.* Did we build it right? Functional active-enforcement tests + before/after performance measurement. Run during each canary, throwaway.
- **B. Ongoing uptime monitoring** — *continuous, steady-state.* Is it up right now? Owned by [`public-url-checker`](../../public-url-checker) (separate repo). This is **liveness/uptime → alarms**, NOT a latency benchmark — don't use it as the perf-measurement source.

---

## A. Configuration validation — performance measurement (before / after)

*One-time, per cutover.* Capture page load timing **before** any cutover (direct-to-origin baseline) and **after** each migration (via CloudFront), so we can prove the change helped — or catch a regression — instead of guessing. (This is config validation, not the ongoing uptime job — see §B.)

### Key pages to measure (per origin)

| Origin | Page type | Sample URL |
|---|---|---|
| Public | Homepage (cacheable) | `https://mn.db101.org/` |
| Public | Estimator / dynamic (`*.aspx`, no-cache) | `https://mn.db101.org/planning/` |
| Public | API (no-cache) | `https://mn.db101.org/api/tips` |
| Public | Static asset (cacheable) | a real asset under `/dist/` (or a `*.css` / `*.js`) |
| preview2 | Dynamic page | a `preview2` `*.aspx` page |
| preview2 | Static asset | a `*.css` under a preview2 site |

### Metrics (per URL)
- DNS lookup, TCP connect, TLS handshake, **TTFB** (time-to-first-byte), total transfer time.
- CloudFront cache result (`X-Cache: Hit/Miss from cloudfront`) and `Age` header — proves static caching works and dynamic paths are NOT cached.
- Run **10 samples per URL**, record **median + p90** (single samples are noise). Capture cold (first hit) and warm (cached) separately for cacheable URLs.

### Method
`curl` write-out timing template, no install needed:
```bash
# curl-fmt.txt
dns:    %{time_namelookup}s  connect: %{time_connect}s  tls: %{time_appconnect}s
ttfb:   %{time_starttransfer}s  total: %{time_total}s  code:%{http_code}  cache:%{header_json}
```
```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "@curl-fmt.txt\n" "https://<host>/<path>"
done
```
- **Baseline:** run against the origin directly (current DNS, pre-cutover) → save to `perf-baseline-<date>.md`.
- **After:** re-run the identical URLs once DNS points at CloudFront → save to `perf-after-<phase>.md`. For cacheable URLs, hit twice and report warm (Hit) timing.
- Compare TTFB + total (median/p90). Expect: static ↓ (edge cache), dynamic ≈ flat or slightly ↑ one extra hop (acceptable — value is WAF, not speed, on dynamic paths).

### Phase hooks
- **Before Phase 0 / Phase 3** (canary): capture origin baseline for that origin's key pages.
- **After each cutover** (Phase 0, 1, 3, 4): re-measure, append to the after-report, flag any TTFB regression > 100ms on dynamic paths for investigation before proceeding.

> §A also includes the **functional active-enforcement validation** run during each canary — full estimator walk with Challenge ON, CMS admin Save (45KB POST) under WAF Block, Host-in-cache-key isolation across two states, PDF generation, invalidation. These can't be validated in Count mode (Challenge/Block are no-ops there), so each canary needs a short supervised enforcement window. See the per-tier canary steps in the phases.

## B. Ongoing uptime monitoring — `public-url-checker` (existing, separate repo)

The hourly liveness system already exists at [`C:\git\public-url-checker`](../../public-url-checker): a Lambda **producer** queues a URL list, a **consumer** fetches each (with 60s/120s retries to suppress transient false alarms), records success/fail + `time_taken_ms` to DynamoDB → BigQuery, alarms via SNS/Twilio, and publishes a status page at `down.eightfoldway.com/checker`. It answers *"is it up?"* — it is **not** the latency benchmark for §A.

**What it monitors** (from `src/producer.mjs`): each state **homepage** `https://<state>.db101.org/`, `https://mn.hb101.org`, and API/XML endpoints on `q.db101.org` (`params.xml`, `tips.json`, `quantities_index.xml`, `events.xml`, `screens.xml`) + `rts.hb101.org/v1/enumerations`. **It does NOT hit `/planning/`** — so the estimator Challenge will not touch it.

**Migration impact / action items:**
- [x] **Scope of `q.db101.org` and `rts.hb101.org` — RESOLVED 2026-06-09:**
  - **`rts.hb101.org` = OUT of scope** — a **whole separate Fargate cluster** (behind its own ELB `hbrts-loadb-…elb.amazonaws.com`, `13.56.60.42`). Not the IIS origin; unaffected by this migration.
  - **`q.db101.org` = IN scope — CMS utility, EDIT-TIER, MUST NEVER BE CACHED.** Serves CMS utility endpoints (`params.xml`, `tips.json`, `quantities_index.xml`, `events.xml`, `screens.xml`) from the edit box (s4/web-04). **Decision B update (2026-06-11): the edit tier isn't fronted, so `q` stays DIRECT — no distribution at all.** **DNS wrinkle:** today `q.db101.org` CNAMEs to `preview2-site.db101.org` (preview2 chain) — **before preview2 cutover, decouple it: re-point `q.db101.org` directly at `s4.eightfoldway.com`** so it doesn't follow the chain into CloudFront. Zero caching guaranteed by never entering CloudFront. Watch on the uptime checker through cutover.
- [ ] **The consumer is a non-browser HTTP client.** With the current rule set it passes (clean low-rate GETs to `/` and `*.xml` — no OWASP/reputation/rate-limit hit; Challenge is `/planning`-only). **But if Bot Control is ever enabled, the checker would be flagged as a bot → false downtime.** Then allowlist the checker's egress (give the Lambda a fixed NAT EIP and `Allow` it, or have it send a known secret header). Note this in the Bot Control decision.
- [ ] **Watch the checker during every canary/cutover.** A cutover that trips the WAF or breaks routing shows up as a **downtime spike on the status page / in BigQuery** — treat that as the real-user signal, distinct from the §A validation curls. Don't flip to Block on a tier while the checker shows fresh failures.
- [ ] The status host `down.eightfoldway.com` is separate infrastructure — not in migration scope.

## CloudFront Invalidation (publish + manual export)

With CloudFront in front, the **publication process must invalidate cached objects** or editors will publish a change and not see it until the cache TTL (up to 1 day) expires. This is a hard requirement, not optional. It must fire both **automatically after a PubBot publish** and **manually per sub-tree** when a `ExportForPreview` library call is made on a file/directory (via API, CLI, or admin site).

**What actually needs invalidation:** only the **cached** paths. Per the `edge.yaml` cache model, both fronted tiers (preview2 + public) cache: `/dist/*`, `*.css`, `*.js`, `*.htm`, `/master_images/*`, `/master_documents/*`, `/documents/*`, `/images/*`. (Edit-sites aren't fronted — nothing of theirs is ever cached.)

All dynamic content (`*.aspx`, `/planning/*`, `/api/*`, `*.axd`, etc.) is served no-cache and updates instantly — **no invalidation needed for estimator/API**. Invalidation matters whenever a **publish** changes a cached static path (notably `*.htm` on published sites).

### Mechanism

There is **no special service** — invalidation is a single CloudFront API call, `CreateInvalidation(distributionId, paths[])`. The design (decided 2026-06-08) is **Design A: a shared library method**, not a Lambda. Because the origin is **IIS, not S3**, there is no S3/EventBridge event to hook — the trigger comes from the application layer.

**`InvalidateCdn(tier, paths[])`** — one method in the f8 .NET library. **`Document.ExportForPreview` must NOT call it unconditionally** — that method is the recursion leaf (PubBot calls it repeatedly; a manual directory export calls it once per file recursively), so a naive call would fire hundreds of fine-grained invalidations. Instead, invalidation is governed by an **ambient invalidation scope**.

### Coalescing & suppression (critical)
Use an ambient scope (`AsyncLocal<InvalidationScope>`, opened with a `using` block) so invalidation collapses to the **outermost** operation:

- **PubBot context → suppress.** PubBot wraps its run in a **suppress** scope. Nested `ExportForPreview` calls record nothing. PubBot issues its **own single coarse invalidation** at end-of-job (the published root / changed top-level dirs). No per-file invalidations during the run.
- **Manual directory export → coalesce to the directory.** The outermost call opens a **coalesce** scope; the recursive per-file `ExportForPreview` calls enroll under it but don't invalidate individually. On scope close, paths collapse to the minimal covering set (the directory → `/dir/*`) and **one** invalidation fires. (Invalidate at the directory level, not every file.)
- **Manual single-file export (no active scope) → invalidate that one path.** The bare call is itself the outermost operation.

So `ExportForPreview` checks the ambient scope: suppressed → no-op; coalescing → enroll path; none → invalidate the single path. `InvalidateCdn` is the low-level call the scope (or PubBot) ultimately invokes once.

Logic inside `InvalidateCdn`:
1. **Map `tier` → distribution ID** from **per-tier Secrets Manager secrets**, one owned by each edge stack: `efw-waf/dist/preview2`, `efw-waf/dist/public` (each `SecretString` is just the dist id; no secret for `cms`). Each edge stack declares its own `AWS::SecretsManager::Secret` with `Value: !Ref Distribution` — fully declarative, self-updates on rebuild, **never hardcoded**. The app servers' existing `efw.policy.secrets.read` already permits reading them, so **no new IAM**.
2. **`cms` tier → no-op** (nothing cached there).
3. **Scope the paths** to what changed:
   - Single file → `/mn/foo.htm`
   - Directory sub-tree → `/mn/dir/*` (trailing wildcard — **the `*` must be the last character**; `/*.htm` is invalid).
   - Avoid blanket `/*` (over-invalidates; first 1,000 paths/month free, then $0.005/path).
4. **Issue `CreateInvalidation`** on the mapped distribution.

**Behavioral notes:**
- Invalidation matches **path only** and ignores the cache key — invalidating `/mn/foo.htm` clears that path for **all Hosts/states** on the distribution. You cannot invalidate a single state's copy in isolation; usually fine.
- A manual `ExportForPreview` on a preview sub-tree → invalidate that sub-tree on the **preview2** distribution. A public publish → **public** distribution.
- Eventually consistent (~seconds–minutes). The publish/export flow should fire-and-log, not block hard on completion.

### IAM patch (reusable policy, matches convention)

Server roles are composed of reusable customer-managed policies named `efw.policy.<area>.<verb>` (verified: `efw.web.04.role` and `efw.web.06.role` carry `efw.policy.secrets.read`, `efw.policy.cert-updater`, …). The patch follows that pattern — **one new policy, attached to both web roles**:

- **No new secrets permission needed.** `efw.policy.secrets.read` already grants `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:*:874922373146:secret:*`, which covers reading the per-tier `efw-waf/dist/*` secrets.
- **New policy `efw.policy.cloudfront.invalidate`** ([`iam/efw.policy.cloudfront.invalidate.json`](iam/efw.policy.cloudfront.invalidate.json)) — `cloudfront:CreateInvalidation` + `GetInvalidation` + `ListInvalidations`, scoped to **our distribution ARNs only** (preview2 + public; CloudFront supports resource-level perms on `distribution/<id>`). Fill the real dist IDs from the edge-stack `DistributionId` outputs after deploy.

| Role | Server | Origin | Attach |
|---|---|---|---|
| `efw.web.04.role` | web-04 | 52.8.85.37 (edit-cms + preview2) | + `efw.policy.cloudfront.invalidate` |
| `efw.web.06.role` | web-06 | 52.8.7.0 (staging + public) | + `efw.policy.cloudfront.invalidate` |

Attach to both (publish/export code may run on either): the public dist is invalidated from wherever PubBot publishes; the preview2 dist from wherever `ExportForPreview` runs.

```bash
# Create the reusable policy (once), then attach to both web roles:
aws iam create-policy --policy-name efw.policy.cloudfront.invalidate \
  --policy-document file://iam/efw.policy.cloudfront.invalidate.json
aws iam attach-role-policy --role-name efw.web.04.role \
  --policy-arn arn:aws:iam::874922373146:policy/efw.policy.cloudfront.invalidate
aws iam attach-role-policy --role-name efw.web.06.role \
  --policy-arn arn:aws:iam::874922373146:policy/efw.policy.cloudfront.invalidate
```

> `cms` tier is a no-op in `InvalidateCdn` (the edit tier has no distribution at all — Decision B), so only the preview2 + public distribution ARNs appear in the policy.

**Long-term optimization:** versioned/fingerprinted static asset URLs (`main.abc123.css` or `?v=<build>`) make every change a new cache key — no invalidation needed for those assets at all. Adopt where the publish pipeline can stamp a version; `InvalidateCdn` then only handles `*.htm` and unversioned paths.

```bash
# What InvalidateCdn(public, [...]) issues under the hood (CLI equivalent):
DIST_ID=$(aws secretsmanager get-secret-value --secret-id efw-waf/dist/public --query SecretString --output text)
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/mn/index.htm" "/mn/planning/results.htm" "/mn/dir/*"
```

## Phases (preview2 leads; nothing on s6 moves until preview2 is proven; edit tier never moves)

### Phase -1 — Pre-cutover server & ops tasks (before any DNS change)
From the 2026-06-10 IIS-accuracy + test-plan reviews:
- [ ] **XFF logging both servers** (web-04 also missing TimeTaken/Referer/BytesSent): add `X-Forwarded-For` W3C custom log field so origin logs stay attributable once traffic arrives from CloudFront IPs. Do this BEFORE Phase 0 so before/after logs are comparable.
- [x] **Origin-FQDN dedicated 404 sites DONE 2026-06-15.** Created `s6.eightfoldway.com` site on web-06 (new) and repointed `s4.eightfoldway.com` site on web-04 (was 401 on shared wwwroot) — both now empty `C:\inetpub\_origin404`, URL-Rewrite CustomResponse 404, anonymous, http+https. https binding assigned each server's dominant win-acme cert (web-04 `472E29CD` exp 2026-08-05; web-06 `8CA90463` exp 2026-08-26) so they ride the same previous-thumbprint rebind sweep on renewal. Verified: SNI probe http=404, sslverify=0 (chain valid) on both → CloudFront origin handshake works for preview2 (s4) and public (s6). Backups `waf-origin404-s4/s6-20260615`. Cert renewal: each server's own win-acme/Let's Encrypt (DNS-01 via instance role); existing ACME-script alarms cover expiry (no new alarm needed). Stragglers `ia-es`/`nc-es` (web-06, Stopped) on expired cert — left; will be remapped manually when those sites are launched.
- [ ] **Hosts-file pin on BOTH servers**: pin the public/preview2 hostnames to `127.0.0.1` so the Puppeteer PDF/print path (`pdfnode` — runs on both boxes) renders via loopback, never via CloudFront/WAF. Gates Phase 2 (Block), not just Phase 4.
- [ ] **Decouple `q.db101.org`**: re-point directly at `s4.eightfoldway.com` (today it rides the preview2-site chain — would follow it into CloudFront).
- [x] **General stray-Host handling — RESOLVED by the origin sites (2026-06-15), no extra config.** No no-host-header catch-all IIS site, and **no CloudFront custom error** (deliberately not added — a distribution-wide 502→404 would mask genuine origin outages on real sites). Mechanism (verified, not the site itself): there is **no blank-host-header binding**; the catch-all 404 is **http.sys's built-in no-matching-site default**. CloudFront always connects with SNI = the origin FQDN (`s6.eightfoldway.com`); the dedicated site's cert makes TLS succeed, then http.sys returns a clean **404 for any unmatched Host — every zone and even foreign hosts** (tested 2026-06-15, SNI=s6: bogus.{db101,hb101,vets101,housingbenefits101,eightfoldway}→404, example.com/random.notours.net→404, while real mn.hb101.org→200 / www.hb101.org→302). Dependency chain = CloudFront-SNI=s6 → s6 cert → TLS → http.sys 404; only a lapsed s6 cert (win-acme-covered) or a non-s6 SNI (CloudFront never does that) would break it. Subdomain-takeover remains prevented by CloudFront wildcard aliases + the ACM cert. (Optional future polish: a status-*preserving* branded 5xx error page — cosmetic, not a catch-all.)
- [ ] **`planning-generic.eightfoldway.com` must return 404 for all requests** (it's a WebDeploy alias, not a website — owner, 2026-06-12). Today https returns **403**, http 404 — fix the IIS site so both are 404 (or point the host-header at the catch-all 404 site, keeping the WebDeploy binding intact).
- [ ] **Create Athena tables over the WAF/CloudFront log bucket** at base-stack deploy time (not at first incident — 30-min setup under pressure otherwise). DDL in `waf-reviews/test-diagnostics-plan-2026-06-10.md`.
- [ ] **Pre-stage DNS revert change-batches** (`waf-reviews/dns-audit/` pattern) for every record the phase touches — revert = one CLI call.
- [ ] **Origin cert renewal calendar**: web-04 cert expires **2026-08-05**, web-06 **2026-08-26**. With `https-only` origins, expiry = total outage. Renew before Phase 3/4 if cutover slips into August.

### Phase 0 — preview2 Canary (`preview2.eightfoldway.com`)

**✅ Pre-req DONE:** ACM cert ISSUED in us-east-1 (2026-06-08) covering all 5 live zones — `arn:aws:acm:us-east-1:874922373146:certificate/d25dc33a-a3fa-4273-a14c-2b8b04ed7507`. Validation CNAMEs in place.

- [x] **Pre-req:** ACM cert issued + validated in us-east-1
- [ ] **Capture origin perf baseline** for preview2 key pages → `perf-baseline-preview2-<date>.md` (see Performance Measurement)
- [ ] Deploy `efw-waf-base` stack (IP sets incl. AllowIpSet, log bucket, origin-verify secret, SNS topic) — **confirm the SNS subscription email immediately** (unconfirmed = silent alarms)
- [ ] Confirm `preview2.eightfoldway.com` chain: `preview2` → `preview2-site.eightfoldway.com` → `s4.eightfoldway.com` (3 CNAME hops onto web-04)
- [ ] Lower Route53 TTL on `preview2.eightfoldway.com` to 60s
- [ ] Deploy `efw-waf-edge-preview2` stack (`OriginDomainName=s4.eightfoldway.com`, `RateLimit=500`, `WafRuleAction=Count`, ACM cert ARN, `AlternateDomainNames=preview2.eightfoldway.com`). Static set (incl `*.htm`) cached, everything else no-cache, WAF attached in Count mode.
- [ ] Read CloudFront domain from stack `Outputs`
- [ ] Pre-stage DNS revert record (have `preview2` → `preview2-site.eightfoldway.com` revert ready to flip in one click)
- [ ] Change `preview2` DNS to point at CloudFront domain
- [ ] **Re-measure perf via CloudFront** → `perf-after-phase0.md`; compare TTFB/total vs baseline, flag dynamic-path regression > 100ms
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

### Phase 1 — preview2 Full Migration (Count mode)
- [ ] Verify `q.db101.org` was decoupled (Phase -1) — it must NOT follow the preview2-site chain into CloudFront
- [ ] Migrate all preview2 aliases: add explicit `preview2-<state>.db101.org` (×~24), `preview2-mn.hb101.org`, `preview2.vets101.org` to the stack's `AlternateDomainNames` and repoint their DNS (chain heads where possible)
- [ ] **Run codebase audit** for all `*.ashx`, `*.asmx`, `*.axd` handlers — update cache-bypass list before migrating each alias
- [ ] Verify WebDeploy via VPN still works on at least one site end-to-end (port 8172 → 10.3.x.x)
- [ ] **Verify `ExportForPreview` CloudFront invalidation** against the fronted preview2 tier: export a static change, confirm invalidation fires and fresh content serves. (PubBot/public verification happens in Phase 3/4.)
- [ ] Confirm CloudFront + WAF logs ship to `WafLogBucket` — readable via the Athena tables
- [ ] Confirm CloudWatch alarms (`Alarm5xx`, `AlarmWafBlocked`) created and the SNS subscription delivers (send a test alarm)
- [ ] If cache-bypass audit found new paths, update the `efw-waf-edge` template behaviors and redeploy (stack diff = reviewable change)
- [ ] **Hold in Count mode for a full week** monitoring for false positives, broken paths, deploy regressions

### Phase 2 — preview2 Block Activation
- [ ] **Before flipping:** review WAF Count logs **per rule name** (Athena). In particular `AWSManagedRulesCommonRuleSet` body rules (`SizeRestrictions_BODY`, `SQLi_BODY`, `CrossSiteScripting_BODY`) and the rate limits, for hits on *legitimate* traffic. For any tripping real requests, add a per-rule `RuleActionOverride` → Count in `edge.yaml` before Block. (Measure — don't pre-tune on assumption.)
- [ ] Verify the hosts-file pin (Phase -1): generate a PDF on a preview2 site with Block live — the print path must render via loopback, untouched by the Challenge
- [ ] **Supervised enforcement window** (Challenge/Block are no-ops in Count — they can only be validated live): full estimator walk with Challenge ON, static/dynamic split check, Host-key isolation across two states
- [ ] After 1 week clean in Count, flip `WafRuleAction=Block` and `cloudformation deploy` the preview2 stack (reversible by redeploying with `Count`)
- [ ] Document any WAF false-positive matches that required rule tuning

### Phase 3 — Public-site Canary (lowest-traffic alias) — **only after Phase 2 is clean**

**✅ Pre-req DONE:** the issued ACM cert already covers `db101.org` + `*.db101.org` (and the other 4 zones) — no new cert needed.
**Gate:** web-06 `s6.eightfoldway.com` 443 binding in place (Phase -1); Puppeteer/print hosts-pin verified on web-06; origin cert validity through the Count window.

- [ ] Deploy `efw-waf-edge-public` stack (`OriginDomainName=s6.eightfoldway.com`, `RateLimit=500`, `WafRuleAction=Count`, ACM cert ARN, canary-only `AlternateDomainNames` to start)
- [ ] Pick lowest-traffic public-site alias (e.g. `ak.db101.org`) as canary — needs an explicit alias entry while the wildcards aren't claimed yet
- [ ] Lower Route53 TTL to 60s
- [ ] Migrate canary DNS to the stack's CloudFront `Outputs` domain
- [ ] Smoke test: full estimator flow (login → run → save), static content, API endpoints
- [ ] Monitor 2 hours; watch public-url-checker for the canary state

### Phase 4 — Public-site Full Migration

**⚠️ DNS scope (WHOIS-verified 2026-06-08):** Public-site zones in scope: `db101.org`, `hb101.org`, `vets101.org`, `eightfoldway.com`, `housingbenefits101.org` (**5 zones**). All other zones review 04 flagged are out of scope — 7 are **unregistered** at the registry and 1 is **parked at NameFind** (`njdb101.org`). Their Route53 A-records to the origin are orphans that resolve for nobody. Do not migrate or recreate them.

**⚠️ Apex A records:** **4 real apexes** need ALIAS conversion (`db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`). `housingbenefits101.org` apex goes to the **redirect** distribution. Apex A records pointing directly at the origin need ALIAS conversion before CloudFront can front them:
1. Change A → ALIAS (Route53 auto-converts when target is CloudFront)
2. Delete the old A record
3. Safe at 60s TTL.

- [ ] Update the public stack's `AlternateDomainNames` to the wildcard strategy (`*.db101.org`, apexes, …) — the canary's explicit entry can then be dropped
- [ ] Repoint chain heads (`s6.db101.org` etc. — but NEVER `s6.eightfoldway.com` itself, that's the origin) + convert apexes → ALIAS → CloudFront domain
- [ ] Deploy the `redirect.yaml` stack for `housingbenefits101.org` + `*.housingbenefits101.org` → 301 `hb101.org`
- [ ] **Verify PubBot invalidation** end-to-end on the public tier: publish a change, confirm invalidation + fresh content
- [ ] Run 72h Count mode on public-site (watch gov-NAT IPs vs the rate limits in Athena)
- [ ] Flip `WafRuleAction=Block` and `cloudformation deploy` the public stack
- [ ] Decommission NACLs on public-site SG

### Phase 5 — Origin Isolation (partial — web-04 stays editor-reachable)
- **Outbound mail is SES — Phase 5 is mail-SAFE** (verified 2026-06-15; corrects an earlier draft "SPF egress gate" that wrongly assumed direct-from-box send). All s6 senders (PubBot, estimator ScreenPage share, PDFJob) use Amazon SES, authenticated by `dkim.amazonses.com` DKIM; SES sends from Amazon IPs, so moving box egress to a NAT Gateway does not change mail deliverability. The `ip4:52.8.7.0`/`ip4:52.8.85.37` SPF entries are vestigial pre-SES relics (optional cleanup, not a gate). Keep `mail.eightfoldway.com` resolvable (PubBot's From domain).
- [ ] Add NAT Gateway to vpc-331ad056
- [ ] **web-06**: restrict SG 80/443 to the CloudFront prefix list (`com.amazonaws.global.cloudfront.origin-facing`); can also drop its public IP if the print path uses loopback
- [ ] **web-04**: 443 must stay open to the internet — editors hit it directly via NTLM (Decision B). SG = CloudFront prefix list (for preview2) + world on 443. The direct surface is NTLM/401-gated; revisit IP-restricting if editor locations ever consolidate.
- [ ] **X-Origin-Verify enforcement at IIS** (deferred to here): require the header on fronted host-headers (preview2 sites on web-04, all sites on web-06), with a **loopback/localhost exemption** for the print path and health checks. Edit-site host-headers on web-04 are exempt (never fronted).

## Cost
- Baseline (preview2 + public stacks, Count mode): **$20-30/mo**
- With Bot Control on both: $40-50/mo
- With NAT Gateway (Phase 5): +$45/mo

## DNS terminator scheme (ACCEPTED 2026-06-16) + cutover mechanics

Every hostname terminates at exactly one **named terminator**; migration = repointing one CNAME per name, deliberately — no accidental riders.

| Terminator | Points at | Owner | Meaning |
|---|---|---|---|
| `s4.eightfoldway.com` | A 52.8.85.37 | manual (exists) | direct web-04 — edit tier, `q.db101.org`, plumbing |
| `s6.eightfoldway.com` | A 52.8.7.0 | manual (exists) | direct web-06 — dtd/schema, opted-out sites |
| `cf-preview2.eightfoldway.com` | CNAME → preview2 dist domain | **manual (new)** | fronted preview2 |
| `cf-public.eightfoldway.com` | CNAME → public dist domain | **manual (new)** | fronted public + staging |
| `cf-redirect.eightfoldway.com` | CNAME → redirect dist domain | **manual (new)** | housingbenefits101 301 |

**The `cf-*` terminators are MANUAL / external — deliberately NOT in any CloudFormation stack (decided 2026-06-16).** They are the *stable anchors* that live site records point at, so they must **outlive the stack lifecycle**. If a `cf-*` record were stack-owned, a stack **delete** or a distribution **replacement** would remove it → every `preview2-*` / public CNAME pointing at it goes **NXDOMAIN → mass outage** of everything cut over. Keeping them manual means tearing down or rebuilding an edge stack never touches DNS that live traffic depends on. The only cost — a hand-edit if a distribution's domain ever changes — is rare and happens only during a deliberate dist delete+recreate (already a hands-on event). The edge stack merely **outputs** `Distribution.DomainName`; a human sets/updates the one `cf-*` record from it. (A `DeletionPolicy: Retain` RecordSet was considered and rejected: it becomes an unmanaged orphan that conflicts on stack re-create.)

**Cutover mechanics (per tier):** once the edge stack exists, create that tier's `cf-*` record once (→ the dist's `Outputs` domain). Canary = point ONE site CNAME (e.g. `preview2.eightfoldway.com`) at `cf-preview2` at 60s TTL, with the prior record pre-staged for revert; validate; then roll the rest by pointing each `preview2-<state>` → `cf-preview2`. CloudFront routes on the **originally-queried Host/SNI** (the site name), so a `cf-*` name is **pure DNS plumbing** — it does NOT need to be a dist alias or on the cert; each *site* hostname still needs alias+cert coverage. Per-name revert = flip that site CNAME back to its origin chain (`s4`/`s6`). **Apexes can't CNAME** — they Route53-ALIAS straight at the dist, so move any apex riders (`www`/`turtles`) off the apex first.

**preview2 cutover is LEAF-BY-LEAF (decided 2026-06-16) — do NOT use the `preview2-site.db101.org` aggregator.** Flip each `preview2-<state>.db101.org` (+ `preview2.db101.org`/`master`/`co`/`co-es`, and the vets/hb101 leaves) individually → `cf-preview2`. Rationale: the aggregator `preview2-site.db101.org` is one character from **`preview2-site.eightfoldway.com`, which is the WebDeploy `MSDeployServiceURL` (port 8172) in ~30 `bp101-site.pubxml` profiles estate-wide** — a mis-flip of that name breaks publishing everywhere. So **never touch either `preview2-site.*` head**; only leaf records. `preview2-svc.db101.org` + its service leaves (pdf/session/forms) stay direct.

For the *public* tier, aggregator-style heads (`s6.db101.org` ×74 riders, `preview-site.*`, `s6c`/`s6a`) may still re-terminate at `cf-public` to move families wholesale (no WebDeploy-name collision there) — decide at Phase 3/4. Phase 5 breakage audit = "list names terminating at `s6`".

Open per-name fates feeding this (web-06 enumeration 2026-06-12):
- `dtd.eightfoldway.com` + `schema.disabilitybenefits101.org` — **RESOLVED 2026-06-15: runtime-inert, NOT a Phase 5 blocker.** SSM on web-06: the `dtd.eightfoldway.com` IIS site (Started, DefaultAppPool, anonymous) holds exactly ONE file `entity.dtd` (5.9KB, 2024-12-17). The `schema.disabilitybenefits101.org/bp101-quantities.xsd` namespace URI is an identifier (no `.xsd` exists on the box). The `http://dtd.eightfoldway.com/entity.dtd` DOCTYPE is intercepted by `f8XmlEntityResolver` (`bp101-interface/utility/f8XmlEntityResolver.cs`, compiled into `utility.dll`): `ResolveUri` → `urn:XHTMLEntities`, `GetEntity` → embedded resource `bp101.utility.entity.dtd`; returns null for all other externals. `ContentFilter.cs:136` wires that resolver; `XmlSnippet.cs:29` never sets a resolver (→ .NET 4.6+ default null = no DTD fetch). Both runtime paths = zero HTTP fetch. Physical `entity.dtd` on web-06 is a pre-.NET-4.6 leftover. → **Fate: stay direct on s6 OR retire entirely (site + 3 bindings + `dtd` DNS + `schema.*` zone), zero runtime impact, no urgency. Full web-06 Phase 5 SG lockdown is unobstructed.**
- `turtles.eightfoldway.com` — RESOLVED 2026-06-15 (SSM web-06): ancient **Microsoft FrontPage 4.0 science-fair project page** about turtles (12 files dated 2024-12-17). Zero business relevance but **KEEP (sentimental, owner 2026-06-15)**. **Fate = FRONT (Option A):** add `turtles.eightfoldway.com` as one explicit alias on the public distribution (`*.eightfoldway.com` cert covers it) and point its CNAME at the public dist instead of the eightfoldway.com apex. Static HTML → caches well, survives Phase 5 full web-06 lockdown (arrives via CloudFront). The lone fronted outlier; clears the apex rider too.
- `forms.eightfoldway.com` — RESOLVED: **no IIS site anywhere** serves this host (web-06 has none; web-04's `db101.logon3.forms` binds only host-header `db101.logon3.forms`, unrelated). Dead dangling apex-rider. Fate: **delete DNS**.
- `preview.eightfoldway.com` — CORRECTED 2026-06-15 (was wrongly "delete"): this is the **staging tier of the corporate site** (`eightfoldway.com` brand = efw[edit/web-04] → preview2.eightfoldway.com[web-04] → preview.eightfoldway.com[staging] → www/apex[public/web-06]). Verified: www+apex public site on web-06 (Started), preview2 site on web-04 (Started), but **no IIS staging site binds `preview.eightfoldway.com` on either server** (the 000). Owner 2026-06-15: corporate staging is **aspirational** (pattern-completeness; not actively published). **Fate: KEEP DNS + add explicit alias on the public dist** (staging shares public dist + s6 origin; no `*.eightfoldway.com` wildcard so explicit like www/turtles). Accept it 404s at origin until/unless a staging IIS site is created. NOT deleted.
- `bp101-dummy.{eightfoldway.com,db101.org}` — RETIRED 2026-06-15. Was the legacy engine-selector: before a Life Situation was chosen, the default `EngineLocation` appSetting pointed at `bp101-dummy.eightfoldway.com/bp101.rem` and `EngineSession.IsDetached` triggered on URL containing "dummy". Mechanism removed by repointing every planning web.config `EngineLocation`(+`_<situation>`) to the real engine farm (`db101-engine-{preview2,preview,public}.econw.com/xmlrpc/`); no config references dummy now, so the `IndexOf("dummy")` checks in EngineSession.cs are dead branches. Verified estimator entry (b2w2_mn_start.aspx → cookieless session → 200 index.htm, no dummy/detached/error) clean on all 3 tiers (mn.db101 public, preview2-mn, preview-mn) with the site Stopped. **Retired:** DNS both zones deleted (backup `deleted-records-backup-2026-06-15.json`); IIS site deleted on web-06 (config backup `waf-retire-bp101dummy-20260615`; wwwroot folder left on disk). Dead `IndexOf("dummy")` code is a harmless future cleanup.
- `mail.{db101.org,eightfoldway.com}` — RE-RESOLVED 2026-06-15 (code-verified, supersedes the brief "live direct-send identity" scare). **All f8 code on s6 sends via SES**, not direct from 52.8.7.0: PubBot (`pubbot@mail.eightfoldway.com`, SES SendEmail), estimator ScreenPage share (`noreply@db101.org`, SES SendEmail), PDFJob (`noreply@db101.org`, SES SendRawEmail) — every legacy `SmtpClient(...)` in those files is commented out. Auth rests on `*._domainkey→dkim.amazonses.com` DKIM (relaxed alignment covers the mail.eightfoldway.com subdomain). Consequences: (a) the `ip4:52.8.7.0` SPF entries (apexes + mail.*) are **vestigial** pre-SES relics, harmless, removable as hygiene; (b) **`mail.db101.org` is vestigial** — no s6 sender uses it as From → deletable with backup; (c) **KEEP `mail.eightfoldway.com` resolvable** — it's PubBot's active From domain (NXDOMAIN From = spam signal); its A/ip4-SPF aren't SES-required but leave them (zero upside, reputation downside). Also: legacy Forms.UI comment-form mailer (`form@eightfoldway.com`) still calls `SmtpClient("127.0.0.1")` but no local relay exists on s6 → that path is broken/unused (separate finding, not a migration item).
  - **UPDATE 2026-06-15: PubBot moved off `mail.eightfoldway.com`.** Both send sites (`PubBotJob.cs:257` + `PubBotJobRegistry.cs:262`) changed to `pubbot@eightfoldway.com`, built + deployed; verified live (From `pubbot@eightfoldway.com`, DKIM `d=eightfoldway.com` PASS, SPF PASS via SES `54.240.27.11`, DMARC PASS). So `mail.eightfoldway.com` now has **no live From dependency** → both `mail.eightfoldway.com` and `mail.db101.org` (A + SPF TXT) are deletable with backup. (Not yet deleted — awaiting go.)
  - **DO NOT prune DKIM CNAMEs** in these zones. They fan out across 3 accounts (main 874…, staging 368…, production 233…) and ≥2 regions — eightfoldway.com has live DKIM in main us-west-2 AND us-west-1; staging/production sign `hb101.org`. A DKIM CNAME is removable only after confirming no SES identity in ANY account/region uses its token. See memory [[ses-dkim-multi-account]].
- disabilitybenefits101.org `www`/`preview*`/`preview2*` riders — chain onto heads that get repointed → break at cutover; not on ACM cert. Fate: delete w/ backup (pending OK).

**Walkthrough COMPLETE (2026-06-15): every outlier resolves to DIRECT or DELETE — none needs fronting.** So the `cf-*` named-terminator CNAMEs are optional polish; the two real wins of the terminator idea are (a) move live apex riders off `eightfoldway.com` apex before the Phase 4 ALIAS flip (after deletions: just `www` + turtles-if-kept) and (b) the Phase 5 audit = "what terminates at s6." Deletions above need explicit owner auth + backup (dangling-audit pattern) before action — none performed yet.

## DNS Records (Key aliases)
- `preview2.eightfoldway.com` → `preview2-site.eightfoldway.com` → `s4.eightfoldway.com` (**Phase 0 canary**)
- State preview2 records: `preview2-{state}.db101.org`, `preview2.vets101.org`, `preview2-site.hb101.org` — all chain through s4 (**Phase 1**)
- `s6.db101.org` → s6.eightfoldway.com → web-06 (public-site chain head, **Phase 3+**)
- `s6c.eightfoldway.com`, `s6a.eightfoldway.com` → A web-06 (hb101/alternate public, **Phase 4**)
- **NEVER migrate** (stay direct, permanently): `s4.eightfoldway.com` + `s6.eightfoldway.com` (ORIGIN FQDNs — DNS'ing them at CloudFront = request loop), `edit-site.eightfoldway.com`, `brk-site.eightfoldway.com`, `db101-*`/`hb101-*`/`vets101.eightfoldway.com` (edit tier, Decision B), `q.db101.org` (decoupled to s4 direct, Phase -1)

## Malicious IP Summary
- 28 unique IPs across 3 ASNs (Azure 57%, GCP 18%, others 25%)
- None targeted `/planning/` specifically — all scanning for credential files
- Only 1 IP (35.202.26.185, GCP) touched `/planning/` at all (6 requests out of 288)

## Reviewer Findings (round 7 — complete)
- **Disruption threats (01-disruption.md):** WebDeploy LOW risk (VPN path); session state LOW risk for single-IIS; TLS LOW risk; DNS rollback is 5-8 min (plan says "instant" — overconfident); WAF Count→Block MEDIUM risk (check Count logs before switching); **ACM cert gap is HIGH risk (blocks Phase 0)**
- **Infrastructure accuracy (02-infra.md):** Origin IPs verified ✅; **5 live zones** (db101.org, hb101.org, eightfoldway.com, vets101.org, housingbenefits101.org — WHOIS-verified); **0 WAF ACLs exist** (must create); **no wildcard ACM certs** in us-east-1 (Phase 0 blocked, but one cert now covers all 5 zones); 5 existing CF distributions noted; cache-bypass list incomplete
- **Dynamic paths (03-dynamic-paths.md):** Plan misses `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`; likely misses `/auth/*`, `/download/*`, `*.ashx`; static paths (`/content/*`, `/images/*`) can be cached
- **Route53 (04-route53.md):** Original report counted 18 zones; **WHOIS (2026-06-08) reduces real scope to 5 live zones** — 7 of the "extra" zones are unregistered, 1 (njdb101.org) is parked at NameFind. **Only 3 apex A records need ALIAS conversion** (not 9). `preview2` chain spans the live edit-site zones via cross-zone CNAME.

## Hardening TODOs (related, outside WAF scope)
- [ ] **Redact `Cookie` (and `Authorization`) in WAF logging** (found 2026-06-16 inspecting preview2 WAF logs): WAF S3 logs currently store the **full `Cookie` header**, including the `efw_logon2` auth JWT and `wid_roles`. Add `RedactedFields` (header `cookie`, `authorization`) to the `WebAclLogging` `LoggingConfiguration` in `base.yaml`/`edge.yaml` so tokens aren't persisted in logs. Bucket is private + 90d lifecycle, but don't store auth material.
- [ ] **Purge plaintext SQL credentials from svn** (found 2026-06-10 during DNS-audit code scan): `C:\svn\f8\Logon\App.config`, `Properties\Settings.settings`/`Settings.Designer.cs`, `LogonSQL.dbml`, and `C:\svn\f8\LogonSvc\Web*.config` + `Properties\PublishProfiles\*.pubxml` carry `sa` and service-account passwords in cleartext (internal DB hosts `8F-0026`, `10.1.0.127`, `127.0.0.1`). Rotate the passwords, move connection strings to Secrets Manager (pattern already exists: `f8/edit-site/credentials`), and scrub svn history if feasible.
- [ ] CMS prod web.config: flip `<compilation debug="true">` → `false`, set `customErrors` on (found 2026-06-10, db101-mn spot-check).
- [ ] **Registrar (GoDaddy) housekeeping** — partially DONE 2026-06-11: ✅ API creds in Secrets Manager `godaddy/api` + `/godaddy` skill created; ✅ `hb101.org` auto-renew VERIFIED ON (expires 2026-06-23; all 11 domains renewAuto=True). **Remaining:** (1) one-time check the GoDaddy payment method is valid; (2) update stale registrant contacts — 6 domains still registered to "World Institute on Disability / Bryon MacDonald" (`db101.info`, `db101.org`, `disabilitybenefits101.com`, `disabilitybenefits101.org`, `vets101.com`, `vets101.org`) and `eightfoldway.com` has placeholder email `nocontactsfound@secureserver.net`. Target pattern (per hb101 domains): Eightfold Way Consultants / Jack Eastman / jeastman@eightfoldway.com. ⚠️ Registrant org/name change can trigger ICANN change-of-registrant (email confirmation + 60-day transfer lock) — sequence around any planned transfers.

## Late-project: make new-site creation WAF-aware (so new sites are born WAF-ready, not retrofitted)
- [ ] **Update the new-site instructions, site-construction templates, and site-creating scripts to reflect the WAF/CloudFront setup.** Once cutover is done, adding a new state site must account for the edge — currently nothing does. Touch-points to bake in:
  1. **CloudFront alias list** — the new hostname must be added to the tier dist's `AlternateDomainNames` (`edge.yaml` param) **and** be covered by the ACM cert. Public dist uses `*.zone` wildcards (auto-covers new subdomains); **preview2 enumerates each alias** → per-site maintenance. *Consider* moving preview2 to a wildcard alias too, to kill that maintenance (tradeoff: specific-overrides-wildcard routing). A **new zone** (not just subdomain) needs cert SANs added.
  2. **DNS** — new leaf CNAME → `cf-preview2.eightfoldway.com` (preview2) / `cf-public` (public), **short TTL (60s)**, NOT the old `preview2-site`/origin aggregator. Scripts should create it pointed at the cf-* terminator.
  3. **Per-site `web.config`** — must carry the canonical HTTP→HTTPS rewrite rule with its `nssl` + `/pdfreport/` bypass conditions (templates should include it); don't reintroduce a per-site `PDFReportServiceLocation` public-host value (retired — self-calls now loopback+origin-`Host`).
  4. **Server-side self-calls** — new sites inherit the fixed PDF pipeline (PDFJob spec fetch, ReportTOC SOAP, `PDFReportSpec` origin-host threading) so they don't hairpin through CloudFront. Ensure templates pull the fixed code, not a stale copy.
  5. **CSP / `applicationHost.config`** — server-level, inherits to the new site (no per-site action), but the runbook should note the canonical CSP fragment + the canonical-redirect rule live there.
  6. **Site-creating scripts** — whatever automates IIS site + bindings + web.config + publish should *also* register the CloudFront alias, set DNS to cf-* (short TTL), and emit a WAF-ready web.config.
  - Cross-refs: alias/cert in `cloudformation/edge.yaml` + `waf-acm-cert` memory; self-call/redirect detail in the print-server item above + `pdfreport-print-pipeline` memory; CSP in the CSP-hardening track.
