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
  - 04-route53.md — listed 18 Route53 hosted zones; **WHOIS (2026-06-08) proves only 5 are live + in scope** (see Decisions). Most "extra" zones are unregistered or parked.

## Decisions
- **Edit-site first.** Lower blast radius, single origin, no estimator live traffic.
- **CloudFront + WAF** (not ALB) — blocks at edge, caches static content, lower cost.
- **WebDeploy** routes via VPN to non-routable IPs (10.3.x.x), no public exposure — must be re-verified end-to-end after edit-site cutover.
- **NACLs** can be decommissioned once WAF is active on a stack (WAF is superset). Defer NACL removal until public-site Phase B, after one clean week of edit-site Block mode.
- **Cache bypass** — plan's list is incomplete (review 03-dynamic-paths.md). Must add: `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`. Likely missing: `/auth/*`, `/download/*`, `*.ashx`.
- **Start in Count mode**, monitor 72h before switching to Block. (Edit-site gets a slightly longer 1-week Count window before Block given the new rollout order.)
- **ACM cert required before Phase 0** — no wildcard cert in us-east-1; must request `*.eightfoldway.com` before CloudFront distribution can be created.
- **Zone scope = 5 live zones (WHOIS-verified 2026-06-08).** Registry WHOIS proves the migration touches only `db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`, `housingbenefits101.org` — all registered with AWS Route53 NS delegation. Review 04's larger zone count was inflated by **orphan hosted zones**: a Route53 zone is inert unless the domain's registrar NS points back at AWS.
  - **Unregistered** (do not exist at registry): `njdisabilitybenefits.org`, `njdisabilitybenefits.net`, `njdb101.net`, `njdb101.com`, `vb101.org`, `workbenefitsyouth.org`, `disabilitiesbenefits101.org` (typo zone). Their A-records to 52.8.7.0 resolve for nobody.
  - **Parked** (registered, NS at NameFind/GoDaddy, not Route53): `njdb101.org` — zone dead.
  - **Live but out of scope:** `disabilitybenefits101.org` (owned + Route53 but unused — leave alone); `maybeckstudio.org` (separate origin).
- **Renew `hb101.org` before cutover** — registry expiry **2026-06-23**. Live + important domain; do not front a lapsing domain with CloudFront.
- **`housingbenefits101.org` → redirect to `hb101.org`, not fronted content.** Verified 2026-06-08: the zone has no apex/www records and only `mn.`/`preview-mn.`/`preview2-mn.housingbenefits101.org` content hosts (a parallel HB101-MN brand on the same origins). Decision: collapse the whole domain to a 301 redirect to `hb101.org` — retire/redirect the `mn.*` content hosts rather than add them to the content distributions. Implement as a small **redirect distribution** — scaffolded at [`cloudformation/redirect.yaml`](cloudformation/redirect.yaml) (CloudFront Function returning `301` to `https://hb101.org` + path/query; cfn-lint clean), using the existing cert (`housingbenefits101.org` + `*.housingbenefits101.org` SANs already on it; verified present). Aliases `housingbenefits101.org` + `*.housingbenefits101.org`. Route53: apex `housingbenefits101.org` ALIAS + `www` + the `mn.*`/`preview*.*` hosts all point at the redirect distribution. This keeps it out of the content-caching stacks entirely.
- **One ACM cert covers all 5 zones** (10 SANs: apex + wildcard each) — well under the 30-SAN limit. The 2-cert concern in review 04 no longer applies. **Status: ISSUED 2026-06-08** — `arn:aws:acm:us-east-1:874922373146:certificate/d25dc33a-a3fa-4273-a14c-2b8b04ed7507`.
- **HTTP→HTTPS redirect moves to the front end (CloudFront).** `edge.yaml` sets `ViewerProtocolPolicy: redirect-to-https` on all behaviors → CloudFront 301s at the edge (no origin round-trip). The existing **on-IIS http→https redirect becomes redundant for fronted traffic** (CloudFront connects to origin HTTPS-only, so IIS never sees viewer HTTP) — keep it as defense-in-depth for direct-origin access until Phase 5 SG lockdown, then it's moot. *Host*-level www canonicalization (www.<state>.db101.org → bare host) is **out of scope** — those 2-level www hosts don't work today anyway (and aren't covered by the `*.db101.org` cert), so they're not being migrated or redirected. Content www's (`www.db101.org`, `www.eightfoldway.com`) stay as content on the public dist; `www.hb101.org`/`www.db101.org` are CNAMEs handled normally.
- **All AWS objects built as CloudFormation (IaC)** — no click-ops. WAF, CloudFront, policies, logging, alarms are version-controlled, peer-reviewable, and rollback-able as stacks. DNS cutover stays manual/staged (canary + TTL + one-click revert) and is the *only* out-of-stack step. See "Infrastructure as Code" below.

## Application changes (START EARLY — code lead time, gate cutover)

These are **application-side** changes (not AWS config) that must land **before** the relevant cutover. They have development/QA lead time, so start them now in parallel with the infra work — don't discover them at cutover.

- [ ] **`pdfreport` print server — repoint to origin-direct (do this first).** The local Puppeteer-based estimator PDF/print server currently renders by fetching the **public hostname**, which loops back to the box's own EIP (confirmed: it's the `52.8.7.0` self-traffic, ~379 `/planning/` hits in the 2026-06-08 logs). After CloudFront, that path goes through the WAF and the `/planning/` **Challenge would break PDF generation** (headless Chrome may not solve it), plus a wasteful hairpin. **Fix:** point Puppeteer at the origin directly — `https://localhost` or internal `10.3.0.63` with an explicit `Host:` header — so it never touches CloudFront/WAF. Use the **internal IP, not the public one**, so it also survives Phase 5 (origin SG locked to the CloudFront prefix list). Fallback if it can't be repointed: WAF terminating `Allow` on `52.8.7.0/32` before the Challenge (keeps the hairpin). **This gates public-site cutover (Phase 3/4).**
- [ ] **PubBot / `Document.ExportForPreview` — CloudFront invalidation (`InvalidateCdn`).** Reference scaffold in [`src/Cdn/`](src/Cdn/). Ambient suppress/coalesce scope so PubBot fires one coarse invalidation and manual exports invalidate at the outermost level. Needed before published-tier content goes behind cache (Phase 1+). See "CloudFront Invalidation".
- [ ] *(lower priority, separate)* estimator entry double-request fix — see `data/iis-logs-260608/double-request-signature.md`. Cleanup, not a cutover gate.

## Infrastructure as Code (CloudFormation)

All WAF + CloudFront objects are provisioned via CloudFormation in **us-east-1** (required for `CLOUDFRONT`-scope WAF and CloudFront). Templates live in [`cloudformation/`](cloudformation/). Two-template design: one shared base stack + one parameterized edge stack deployed **three times**.

> **Four site tiers across two origins.** Caching is driven by **SiteType (cms vs published)**, not by origin:
>
> | Tier | Example host | Origin (server) | SiteType |
> |---|---|---|---|
> | CMS edit-site | `db101-nv.eightfoldway.com` | 52.8.85.37 (s4/web-04) | `cms` — dynamic |
> | preview2 (rapid prototyping) | `preview2-nv.db101.org` | 52.8.85.37 (s4/web-04) | `published` |
> | staging | `preview-nv.db101.org` | 52.8.7.0 (s6/web-06) | `published` |
> | public | `nv.db101.org` | 52.8.7.0 (s6/web-06) | `published` |
>
> **HB101 mirrors this** in the `hb101.org`/`eightfoldway.com` zones: `hb101-mn.eightfoldway.com` (cms), `preview2-mn.hb101.org` (preview2), `preview-mn.hb101.org` (staging), `mn.hb101.org` (public). Same 3 distributions, just added to the alias lists.
>
> **vets101 is a national site** (single site, no per-state wildcard) with the same 4 tiers: `vets101.eightfoldway.com` (cms), `preview2.vets101.org` (preview2), `preview.vets101.org` (staging), `vets101.org` apex with `www.vets101.org` → apex (public). The `vets101.org` apex needs **ALIAS** conversion.
>
> Because CloudFront can't vary caching by Host within one distribution, **edit-cms and preview2 (same origin, different SiteType) need separate distributions**. Staging and public share the s6 origin *and* the published cache model, so they share **one** distribution (distinguished by alias). Net: **3 distributions**.
>
> **Host is in the static cache key** (`CachePolicyStatic`): IIS routes by Host, so `nv.db101.org/x.htm` ≠ `mn.db101.org/x.htm` at the same path. Without Host in the key, states collide and staging could leak onto public. Including Host also forwards it to the origin for IIS routing.

### Stack 1 — `efw-waf-base` (shared, deploy once)
Account-global building blocks reused by all edge stacks.

| Logical resource | CFN type | Purpose |
|---|---|---|
| `ScannerIpSet` | `AWS::WAFv2::IPSet` | 27 malicious scanner IPs from April 20 investigation |
| `GooglebotIpSet` | `AWS::WAFv2::IPSet` | Google crawler CIDRs (allowlist, two-layer verify) |
| `BingbotIpSet` | `AWS::WAFv2::IPSet` | Bing crawler CIDRs (allowlist) |
| `WafLogBucket` | `AWS::S3::Bucket` | WAF + CloudFront access logs, lifecycle expiry 90d |
| `OriginVerifySecret` | `AWS::SecretsManager::Secret` | `X-Origin-Verify` shared secret (CF → origin header) |
| `AlarmTopic` | `AWS::SNS::Topic` | CloudWatch alarm notifications |

### Stack 2 — `efw-waf-edge` (parameterized template, deploy 3×)
Deployed **three times**, same template, different parameters (HB101 follows the same tier pattern as DB101, in the `hb101.org` + `eightfoldway.com` zones):
- **`efw-waf-edge-edit-cms`** — origin 52.8.85.37, `SiteType=cms`. Aliases: `db101-*.eightfoldway.com`, `hb101-*.eightfoldway.com`, `vets101.eightfoldway.com`, **`q.db101.org`** (CMS utility, edit-tier, never cached — requires DNS decouple from the preview2-site chain) (live CMS edit-sites + CMS utility, dynamic).
- **`efw-waf-edge-preview2`** — origin 52.8.85.37, `SiteType=published`. Aliases: `preview2-*.db101.org`, `preview2-*.hb101.org`, `preview2.vets101.org` (rapid-prototyping published sites, static incl `*.htm`).
- **`efw-waf-edge-public`** — origin 52.8.7.0, `SiteType=published`. Aliases: **both** public (`nv.db101.org`…, `db101.org` apex, `www.db101.org`, `mn.hb101.org`, `hb101.org` apex, `www.hb101.org`→mn, `vets101.org` apex, `www.vets101.org`, `eightfoldway.com` apex, `www.eightfoldway.com`) **and** staging (`preview-*.db101.org`, `preview-*.hb101.org`, `preview.vets101.org`) — same origin + cache model.

### ⚠️ Alternate domain name (CNAME) constraints
CloudFront alternate domain names are not as flexible as the cert's wildcards — two rules drive how the alias lists above must actually be built:
1. **Partial-label wildcards are invalid.** `db101-*.eightfoldway.com`, `preview2-*.db101.org`, `preview-*.db101.org` are **not** valid CloudFront alternate domain names — the `*` must replace an *entire* leftmost label (`*.db101.org` is valid). So those "host families" must be **enumerated as specific hostnames** per distribution (e.g. list `preview2-nv.db101.org`, `preview2-mn.db101.org`, … individually). The ACM cert wildcard still covers them for TLS; this constraint is only about the per-distribution CNAME list. Each is bounded (~24 states × brand) and well under the 100-alias default limit.
2. **Sibling hosts split across distributions ⇒ no broad wildcard.** `preview2-nv.db101.org` (preview2 dist, s4) and `nv.db101.org` (public dist, s6) are both `<label>.db101.org`, so you **cannot** put `*.db101.org` on the public dist — it would swallow the preview2 hosts. Either enumerate specific public hosts, or rely on CloudFront's **specific-overrides-wildcard** rule (a specific `preview2-nv.db101.org` on the preview2 dist wins over `*.db101.org` on the public dist). Same applies to `*.eightfoldway.com` — it's split between edit-cms (`db101-*`, `hb101-*`, `vets101`) and public (`www`, apex), and `analytics.eightfoldway.com` is already on a *separate existing* distribution. Do **not** claim `*.eightfoldway.com` on our stacks; enumerate.

**Net:** `AlternateDomainNames` is supplied per deploy as an explicit, enumerated list (the template takes a `CommaDelimitedList`). The `*`-family notation in this doc is shorthand for "all hosts in that family," not a literal CloudFront alias.

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

**Cache model (fail-closed):** default behavior = `CachingDisabled`; only the static set is cached.
- **Universal static** (all SiteTypes, incl edit-cms): `/dist/*`, `*.css`, `*.js`.
- **Published-only static** (`SiteType=published` → preview2 + public): `*.htm`, `/master_images/*`, `/master_documents/*`, `/documents/*`, `/images/*`. Omitted on edit-cms (authored content → always fresh).

### WAF Web ACL rule set & bot strategy

Two distinct concerns, both handled in one ACL (default action Allow; rules in priority order):

| Pri | Rule | Action | Scope | Concern |
|----|------|--------|-------|---------|
| 1 | `IP-Blocklist-Scanners` | Block/Count | all | known-bad IPs (empty seed, OpenClaw-fed) |
| 2 | `SensitivePaths` | Block/Count | all | block `.git`/`.env`/`*.bak`/`*.config`/`elmah.axd`/`trace.axd` — "getting lucky" net |
| 3 | `AWS-IpReputation` | managed | all | **general probes** — auto bad-actor IPs |
| 4 | `AWS-CommonRuleSet` | managed | all | **general probes** — path-traversal/SQLi/XSS (CMS tier overrides `SizeRestrictions_BODY`) |
| 5 | `AWS-KnownBadInputs` | managed | all | **general probes** |
| 6 | `Challenge-Estimator` | **Challenge** | `/planning/*`, published tiers | **estimator bot-walking (primary)** |
| 7 | `RateLimit-Estimator` | Block/Count | `/planning/*`, published tiers | estimator flood backstop (300/IP/5min) |
| 8 | `RateLimit` | Block/Count | all | flood backstop (500/IP/5min — above gov-NAT reality) |
| 9 | `AWS-BotControl` (optional, paid) | managed | all | **OFF — deferred** (see below) |
*(No verified-bot allowlist — dropped: robots.txt bars `/planning/`, Challenge is `/planning`-scoped, so a UA+IP allow would be a pure spoof hole.)*

**Primary concern — bots walking estimators.** `/planning/*` is dynamic, no-cache, server-side compute (the planning engine); caching can't absorb it, so the edge WAF is the only lever. `Challenge-Estimator` issues a **silent browser proof-of-work**: real browsers solve it transparently and get a token cookie (one-time per immunity window — a counselor clicking through steps is challenged once, invisibly); headless/scripted/distributed bots fail and never reach IIS. This beats rate-limiting alone, which distributed low-per-IP bot fleets evade. `RateLimit-Estimator` is a per-IP backstop scoped to `/planning/*`.

**Secondary concern — general website probes.** Rules 2–5 + 8 are the standard probe defense (bad-path patterns, reputation, known-bad inputs, rate cap), on all tiers/paths. The continuous IP layer is `AWS-IpReputation` (auto-updating). The manual `IP-Blocklist-Scanners` set is **shipped empty** — the original 2026-04-20 /32 list was verified 0/27 still-active by 2026-06-08 (cloud scanner IPs rotate within weeks), so a static seed is false comfort. Keep the *rule* as a surgical/fast-block lever and **feed it operationally**: have the **OpenClaw nightly job push freshly-observed abusive IPs/CIDRs** into the `efw-scanner-ips` set (supports CIDR/ASN blocks for never-legit hosting nets). For a known-bad manual entry, immediate **Block** is fine (no need to Count-observe an IP you've already judged).

**"Getting lucky" / sensitive paths.** Scanners spray WordPress/PHP/Java/Python exploits, but this is .NET/IIS so they 404 (wrong stack). The .NET-relevant lucky-hits are different (exposed `.git/`, `web.config.bak` served as text, `elmah.axd`/`trace.axd` error logs, deploy artifacts). **Tested 2026-06-09: nothing currently exposed** — public site 404s all of them (`trace.axd` is 403/protected), edit site is 401/NTLM-gated. The real risk is a *future deploy* leaking one into wwwroot, so `SensitivePaths` (rule 2) blocks those patterns at the edge as belt-and-suspenders. OWASP alone doesn't catch them (a plain `GET /.git/config` isn't an "injection"). Also harden: confirm `trace.axd` disabled in prod web.config; keep deploy artifacts (`.git`, `*.bak`, `*.zip`) out of wwwroot.

**Bot Control — deferred (OFF at launch).** It costs $10/mo per ACL (×3 ACLs) + per-request fees and would false-alarm `public-url-checker`. Given the rest of the stack, its only *unique* value is catching JS-capable headless bots that solve the Challenge and still walk estimators — for which the real logs show **zero evidence**. Probes are handled by rules 1–5; content scraping is largely absorbed by the CloudFront cache; estimator bots by the Challenge. **Turn on (TARGETED) only if post-launch data shows `/planning/` origin load with non-human patterns despite the Challenge.** For the empty-UA Azure scrapers (~324/5min on content), prefer a free custom "block empty User-Agent" rule (Count first; check the checker's UA) over the paid managed group.

### Key parameters (`efw-waf-edge`)
| Parameter | edit-cms | preview2 | public |
|---|---|---|---|
| `OriginDomainName` | `52.8.85.37` | `52.8.85.37` | `52.8.7.0` |
| `SiteType` | `cms` | `published` | `published` |
| `AcmCertificateArn` | (shared cert ARN) | (same) | (same) |
| `AlternateDomainNames` (enumerated — see constraints) | `db101-<state>.eightfoldway.com`, `hb101-mn.eightfoldway.com`, `vets101.eightfoldway.com`, `q.db101.org` (CMS utility, never-cache) | `preview2-<state>.db101.org`, `preview2-mn.hb101.org`, `preview2.vets101.org` | public + staging: state `*.db101.org` hosts, apexes (`db101.org`/`hb101.org`/`eightfoldway.com`/`vets101.org`), `www.db101.org`, `www.hb101.org`, `www.eightfoldway.com`, `www.vets101.org`, `mn.hb101.org`, `preview-<state>.db101.org`, `preview-mn.hb101.org`, `preview.vets101.org` |
| `RateLimit` (site-wide /IP/5min) | `500` (NTLM-gated; moot) | `500` | `500` |
| `PlanningRateLimit` (`/planning/*` /IP/5min) | n/a (cms) | `300` | `300` |
| `WafRuleAction` | `Count` → `Block` | `Count` → `Block` | `Count` → `Block` |
| `MinimumOriginSslProtocol` | `TLSv1.2` | `TLSv1.2` | `TLSv1.2` |

*(`Challenge-Estimator` + `RateLimit-Estimator` are auto-included on `published` tiers only; the CMS tier auto-overrides `SizeRestrictions_BODY`.)*

### What is NOT in CloudFormation (deliberate)
- **ACM cert** — already issued out-of-band; passed in as a parameter (ARN), never recreated.
- **Route53 cutover records** — the apex ALIAS / `s6`/`s4` CNAME flips stay manual + staged so the canary, 60s-TTL pre-lower, and one-click rollback work without a full stack update. (Optional later: a separate record-only stack once cutover is proven.)
- **Validation CNAMEs** — already in Route53, left in place for auto-renew.

### Deploy order
1. `aws cloudformation deploy --stack-name efw-waf-base --template-file cloudformation/base.yaml --capabilities CAPABILITY_NAMED_IAM --region us-east-1`
2. `... efw-waf-edge-preview2` with preview2 params (Phase 0 canary)
3. `... efw-waf-edge-edit-cms` with edit-cms params (Phase 1)
4. `... efw-waf-edge-public` with public params (Phase 3/4)
5. Read distribution domain from each stack's `Outputs`, use it as the DNS cutover target.

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
| Edit | CMS dynamic page | a `preview2` `*.aspx` page |
| Edit | Static asset | a `*.css` under the edit-site |

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
  - **`q.db101.org` = IN scope — CMS utility, EDIT-TIER, MUST NEVER BE CACHED.** Serves CMS utility endpoints (`params.xml`, `tips.json`, `quantities_index.xml`, `events.xml`, `screens.xml`) from the edit box (`s4`/52.8.85.37). **Belongs on the `edit-cms` distribution** (`SiteType=cms` → no published-static caching; no Challenge), **not** preview2 (which caches `*.htm`/static). **DNS wrinkle:** today `q.db101.org` CNAMEs to `preview2-site.db101.org` (preview2 chain) — at cutover its record **must be decoupled from the preview2-site chain and pointed at the `edit-cms` distribution** so it lands on the no-cache edit tier. (Caveat: even edit-cms caches the *universal* static set `/dist`/`*.css`/`*.js`; q serves only `*.xml`/`*.json` so that never bites — but if q must guarantee zero caching of *anything*, give it a dedicated all-no-cache distribution.) Watch on the uptime checker through cutover.
- [ ] **The consumer is a non-browser HTTP client.** With the current rule set it passes (clean low-rate GETs to `/` and `*.xml` — no OWASP/reputation/rate-limit hit; Challenge is `/planning`-only). **But if Bot Control is ever enabled, the checker would be flagged as a bot → false downtime.** Then allowlist the checker's egress (give the Lambda a fixed NAT EIP and `Allow` it, or have it send a known secret header). Note this in the Bot Control decision.
- [ ] **Watch the checker during every canary/cutover.** A cutover that trips the WAF or breaks routing shows up as a **downtime spike on the status page / in BigQuery** — treat that as the real-user signal, distinct from the §A validation curls. Don't flip to Block on a tier while the checker shows fresh failures.
- [ ] The status host `down.eightfoldway.com` is separate infrastructure — not in migration scope.

## CloudFront Invalidation (publish + manual export)

With CloudFront in front, the **publication process must invalidate cached objects** or editors will publish a change and not see it until the cache TTL (up to 1 day) expires. This is a hard requirement, not optional. It must fire both **automatically after a PubBot publish** and **manually per sub-tree** when a `ExportForPreview` library call is made on a file/directory (via API, CLI, or admin site).

**What actually needs invalidation:** only the **cached** paths. Per the `edge.yaml` cache model:
- `/dist/*`, `*.css`, `*.js` — cached on **all** SiteTypes (incl. live CMS edit-sites).
- `*.htm`, `/master_images/*`, `/master_documents/*`, `/documents/*`, `/images/*` — cached on **published** sites (preview2 + public); omitted on live CMS edit-sites (being authored → always fresh).

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

> `cms` tier is a no-op in `InvalidateCdn`, so the edit-cms distribution ARN is intentionally omitted from the policy. Add it only if CMS-tier static invalidation is ever enabled.

**Long-term optimization:** versioned/fingerprinted static asset URLs (`main.abc123.css` or `?v=<build>`) make every change a new cache key — no invalidation needed for those assets at all. Adopt where the publish pipeline can stamp a version; `InvalidateCdn` then only handles `*.htm` and unversioned paths.

```bash
# What InvalidateCdn(public, [...]) issues under the hood (CLI equivalent):
DIST_ID=$(aws secretsmanager get-secret-value --secret-id efw-waf/dist/public --query SecretString --output text)
aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
  --paths "/mn/index.htm" "/mn/planning/results.htm" "/mn/dir/*"
```

## Phases (reordered — edit-site leads)

### Phase 0 — Edit-site Canary (preview2 first)

**✅ Pre-req DONE:** ACM cert ISSUED in us-east-1 (2026-06-08) covering all 5 live zones — `arn:aws:acm:us-east-1:874922373146:certificate/d25dc33a-a3fa-4273-a14c-2b8b04ed7507`. Validation CNAMEs in place.

- [x] **Pre-req:** ACM cert issued + validated in us-east-1
- [ ] **Capture origin perf baseline** for edit-site key pages → `perf-baseline-edit-<date>.md` (see Performance Measurement)
- [ ] Deploy `efw-waf-base` stack (IP sets, log bucket, origin-verify secret, SNS topic)
- [ ] Confirm `preview2.eightfoldway.com` chain: `preview2` → `preview2-site.eightfoldway.com` → `s4.eightfoldway.com` → **52.8.85.37** (3 CNAME hops, all pointing to edit-site)
- [ ] Lower Route53 TTL on `preview2.eightfoldway.com` to 60s
- [ ] Deploy `efw-waf-edge-preview2` stack (`OriginDomainName=52.8.85.37`, `SiteType=published`, `RateLimit=50`, `WafRuleAction=Count`, ACM cert ARN, `AlternateDomainNames=preview2.eightfoldway.com`). preview2 is published → static set (incl `*.htm`) cached, everything else no-cache, WAF attached in Count mode. Creates the Web ACL + CloudFront distribution.
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

### Phase 1 — Edit-site Full Migration (Count mode)
- [ ] Migrate remaining edit-site aliases to CloudFront: `edit-site.eightfoldway.com`, `s4.eightfoldway.com`, `brk-site.eightfoldway.com`, and all 30+ state previews
- [ ] **Run codebase audit** for all `*.ashx`, `*.asmx`, `*.axd` handlers — update cache-bypass list before migrating each alias
- [ ] Verify WebDeploy via VPN still works on at least one site end-to-end (port 8172 → 10.3.x.x)
- [ ] Verify CMS publish flow (PubBot) still works against the CloudFront-fronted site
- [ ] **Verify PubBot CloudFront invalidation:** publish a static-asset change, confirm the invalidation fires and the new asset is served (not the cached old one). See "CloudFront Invalidation on Publish".
- [ ] Confirm scanner-ips IP set populated (in `efw-waf-base` template) and referenced by the Web ACL
- [ ] Confirm CloudFront + WAF logs ship to `WafLogBucket` (provisioned by `efw-waf-base`) — readable, lifecycle applied
- [ ] Confirm CloudWatch alarms (`Alarm5xx`, `AlarmWafBlocked`) created by the edge stack and wired to `AlarmTopic`
- [ ] If cache-bypass audit found new paths, update the `efw-waf-edge` template behaviors and `cloudformation deploy` (stack diff = reviewable change)
- [ ] **Hold in Count mode for a full week** monitoring for false positives, broken paths, deploy regressions

### Phase 2 — Edit-site Block Activation
- [ ] **Before flipping:** review WAF Count logs **per rule name**. In particular the `AWSManagedRulesCommonRuleSet` body rules (`SizeRestrictions_BODY`, `SQLi_BODY`, `CrossSiteScripting_BODY`) and rate-limit, for hits on *legitimate* traffic. For any tripping real requests, add a per-rule `RuleActionOverride` → Count in `edge.yaml` before Block. (Measure — don't pre-tune on assumption.)
  - **Already applied (measured 2026-06-09):** CMS admin `__VIEWSTATE` is ~45KB (vs ~3KB for the published estimator), so the CMS tier (`SiteType=cms`) overrides `SizeRestrictions_BODY` → Count — otherwise OWASP would block CMS admin postbacks. Published tiers keep the rule active. Still watch `SQLi_BODY`/`XSS_BODY` on the CMS tier in Count (WAF inspects the first 8KB of the base64 ViewState).
- [ ] After 1 week clean in Count, flip `WafRuleAction=Block` param and `cloudformation deploy` the edit edge stack (Count → Block via stack update, fully reversible by redeploying with `Count`)
- [ ] Document any WAF false-positive matches that required rule tuning
- [ ] Confirm NACLs on the edit-site SG/SG are still in place as defense-in-depth
- [ ] Lock down: security group on 52.8.85.37 restricts 80/443 to CloudFront prefix list (still optional — see Phase 5)

### Phase 3 — Public-site Canary (lowest-traffic alias)

**✅ Pre-req DONE:** the issued ACM cert already covers `db101.org` + `*.db101.org` (and the other 4 zones) — no new cert needed.

- [ ] Deploy `efw-waf-edge-public` stack with public-site params (`OriginDomainName=52.8.7.0`, `RateLimit=100`, `WafRuleAction=Count`, ACM cert ARN, public `AlternateDomainNames`). Creates `db101-public-web-acl` + `cf-public-canary` distribution.
- [ ] Pick lowest-traffic public-site alias (e.g. `ak.db101.org`) as canary
- [ ] Lower Route53 TTL to 60s
- [ ] Migrate canary DNS to the stack's CloudFront `Outputs` domain
- [ ] Smoke test: full estimator flow (login → run → save), static content, API endpoints
- [ ] Monitor 2 hours

### Phase 4 — Public-site Full Migration

**⚠️ DNS scope (WHOIS-verified 2026-06-08):** Public-site zones in scope: `db101.org`, `hb101.org`, `vets101.org`, `eightfoldway.com`, `housingbenefits101.org` (**5 zones**). All other zones review 04 flagged are out of scope — 7 are **unregistered** at the registry (`njdisabilitybenefits.org`, `njdisabilitybenefits.net`, `njdb101.net`, `njdb101.com`, `vb101.org`, `workbenefitsyouth.org`, `disabilitiesbenefits101.org`) and 1 is **parked at NameFind** (`njdb101.org`). Their Route53 A-records to 52.8.7.0 are orphans that resolve for nobody. Do not migrate or recreate them.

**⚠️ Apex A records:** **4 real apexes** need ALIAS conversion (`db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`) — review 04's "9 apex conversions" counted dead/unregistered zones. `vets101.org` is the canonical national public host (`www.vets101.org` → apex), so its apex must be ALIAS'd. `housingbenefits101.org` reaches the origin via non-apex records (CNAME-safe) — verify before cutover. Apex A records pointing directly to 52.8.7.0 need ALIAS conversion before CloudFront can front them:
1. Change A → ALIAS (Route53 auto-converts when target is CloudFront)
2. Delete the old A record
3. Safe at 60s TTL.

- [ ] Migrate `s6.db101.org` and remaining aliases → all 48 public-state sites + hb101.org + vets101.org
- [ ] Convert apex A records for in-scope zones → ALIAS → CloudFront domain
- [ ] Run 72h Count mode on public-site
- [ ] Flip `WafRuleAction=Block` and `cloudformation deploy` the public edge stack
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
- **Infrastructure accuracy (02-infra.md):** Origin IPs verified ✅; **5 live zones** (db101.org, hb101.org, eightfoldway.com, vets101.org, housingbenefits101.org — WHOIS-verified); **0 WAF ACLs exist** (must create); **no wildcard ACM certs** in us-east-1 (Phase 0 blocked, but one cert now covers all 5 zones); 5 existing CF distributions noted; cache-bypass list incomplete
- **Dynamic paths (03-dynamic-paths.md):** Plan misses `*.asmx`, `*_AppService.axd`, `ScriptResource.axd`; likely misses `/auth/*`, `/download/*`, `*.ashx`; static paths (`/content/*`, `/images/*`) can be cached
- **Route53 (04-route53.md):** Original report counted 18 zones; **WHOIS (2026-06-08) reduces real scope to 5 live zones** — 7 of the "extra" zones are unregistered, 1 (njdb101.org) is parked at NameFind. **Only 3 apex A records need ALIAS conversion** (not 9). `preview2` chain spans the live edit-site zones via cross-zone CNAME.

## Hardening TODOs (related, outside WAF scope)
- [ ] **Purge plaintext SQL credentials from svn** (found 2026-06-10 during DNS-audit code scan): `C:\svn\f8\Logon\App.config`, `Properties\Settings.settings`/`Settings.Designer.cs`, `LogonSQL.dbml`, and `C:\svn\f8\LogonSvc\Web*.config` + `Properties\PublishProfiles\*.pubxml` carry `sa` and service-account passwords in cleartext (internal DB hosts `8F-0026`, `10.1.0.127`, `127.0.0.1`). Rotate the passwords, move connection strings to Secrets Manager (pattern already exists: `f8/edit-site/credentials`), and scrub svn history if feasible.
- [ ] CMS prod web.config: flip `<compilation debug="true">` → `false`, set `customErrors` on (found 2026-06-10, db101-mn spot-check).
- [ ] **Registrar (GoDaddy) housekeeping**: set up API creds (developer.godaddy.com → Secrets Manager `godaddy/api`) + a `/godaddy` skill for expiry/auto-renew monitoring. Verify `hb101.org` auto-renew is actually ON (expires 2026-06-23; believed auto-renewing — confirm, don't assume). Update stale WID owner contacts on some domain records.
