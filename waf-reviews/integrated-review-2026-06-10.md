# Integrated Review — WAF + CloudFront Migration (2026-06-10)

Integrates `review-iis-accuracy-2026-06-10.md` (IIS/server facts, "IIS review") and
`test-diagnostics-plan-2026-06-10.md` ("test plan") against the master plan
(`waf-cloudfront-migration.md`), `README.md`, and `cloudformation/{base,edge,redirect}.yaml`.
This is the working punch list. Where the two new documents disagree, the IIS review's
**measured server facts win** (gathered read-only via SSM on 2026-06-10).

Verdict key: **CONFIRMED** (evidence supports it) / **REFUTED** (evidence contradicts it) /
**MODIFIED** (directionally right, materially wrong in detail) / **UNTESTED** (no evidence either way yet).

---

## 1. Assumption ledger

### 1.1 Scope, zones, certs

| # | Assumption (where) | Verdict | Evidence |
|---|---|---|---|
| L1 | Zone scope = 5 live zones; `disabilitybenefits101.org` "unused — leave alone" (plan Decisions; README Key Findings) | **MODIFIED** | IIS review B1: `dtd.eightfoldway.com` on web-06 **binds `schema.disabilitybenefits101.org`** — the domain IS in use. 5-zone DNS scope still holds, but the "unused" decision is wrong and `schema.*` needs an explicit in/out call (§3d). |
| L2 | One ACM cert (10 SANs) covers everything fronted (plan Decisions; edge.yaml default cert ARN) | **MODIFIED** | Cert covers the 5 zones' apex+wildcard — confirmed for all *pattern* hosts. But it does **not** cover `schema.disabilitybenefits101.org`; if that host (or any other non-pattern host outside the 5 zones) is fronted, the cert must be reissued or that host stays direct. |
| L3 | `hb101.org` renewal before cutover (expires 2026-06-23) (plan Decisions; test plan P-1 gate) | **CONFIRMED** (still open) | Both reviews carry it; registry fact unchanged. 13 days out as of today — do it now. |
| L4 | `housingbenefits101.org` → 301 redirect distribution, cert SANs present (plan Decisions; redirect.yaml) | **UNTESTED** | No new contradicting facts; web-06 inventory didn't surface `*.housingbenefits101.org` bindings as blockers. Redirect stack remains valid; verify the `mn.*` retirement against real bindings before Phase 4. |
| L5 | Origin TLS is a non-issue ("IIS must serve TLS here", edge.yaml param; one wildcard cert per server) | **REFUTED → hard new risk** | IIS review A3: web-04 cert expires **2026-08-05**, web-06 **2026-08-26** — ~2 months post-cutover. With `OriginProtocolPolicy: https-only`, expiry = total outage (today it's just a browser warning). One-shared-wildcard-cert-per-server itself: CONFIRMED (§C). |

### 1.2 Origins and tier model

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| L6 | `OriginDomainName` = raw IPs `52.8.85.37` / `52.8.7.0` (edge.yaml param description + plan param table + test plan fixed-names table) | **REFUTED — showstopper** | IIS review A1: CloudFront rejects IP origin domains; stack won't deploy. Use **`s4.eightfoldway.com`** (ready) / **`s6.eightfoldway.com`** (DNS exists; **no IIS 443 binding — pre-cutover task**, SNI handshake fails today). |
| L7 | `s4.eightfoldway.com` is a Phase-1 alias to migrate to CloudFront (plan Phase 1: "Migrate … `s4.eightfoldway.com`"); `s6.db101.org` migrated in Phase 4 | **REFUTED (new conflict created by the A1 fix)** | Once s4/s6 hostnames ARE the origin domain names, their DNS must keep pointing at the EIPs forever. Re-pointing `s4.eightfoldway.com` (or the `s6.*` chain heads) at CloudFront creates an **origin-fetch loop**. Remove them from every alias/cutover list; mark them "infrastructure names — never migrate". |
| L8 | 4 tiers × 2 origins × 3 distributions; example hosts mn/nv/vets (plan tier table; README) | **MODIFIED** | Tier *model* confirmed (host-header routing universal, §C). But inventory is ~10× the examples: **~23 states × tiers ≈ 131 sites**, web-04: 71, web-06: 60 (B1). `nv.db101.org` public **does not exist**; `ia-es`/`nc-es` public **stopped**; apex bindings live on the `www.*` sites. All alias lists, DNS swing lists (~46+46 records, not ~12), and smoke-test host lists must be generated from the real inventory dump (ssm-tmp/batch1). |
| L9 | Hosts fall cleanly into the 4-tier pattern (implicit everywhere) | **REFUTED for ~10 hosts** | Non-pattern sites need explicit in/out decisions: `planning-generic`, `pdfreport`/`pdfnode` (keep OFF CF — internal plumbing, http-only), `twproxy`, `design`, `dtd`/`schema.disabilitybenefits101.org`, `turtles`, `ck`, `efw` (NTLM-gated), `q.db101.org` (decided: edit tier), `logs` (:2000). See §3d. |
| L10 | Host-header routing → `Host` must be in static cache key (plan; edge.yaml CachePolicyStatic comment) | **CONFIRMED** | IIS review §C: every site host-header bound, no IP-based sites. Mandatory and correct. |

### 1.3 Cache behaviors and cache-key design

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| L11 | Default behavior = managed `CachingDisabled` + AllViewer origin-request policy is safe for ALL tiers (edge.yaml DefaultCacheBehavior) | **REFUTED for edit-cms** | IIS review A2: edit sites have anon OFF, NTLM+Negotiate+Basic ON. NTLM dies behind CloudFront (connection-oriented vs. multiplexed origin connections). Basic works **only if `Authorization` is in a cache-policy cache key** — `CachingDisabled` carries no headers, and origin-request policies *cannot* carry `Authorization`. As templated, day-one edit-cms = **endless 401 loop**. Published tiers (anon on): CONFIRMED fine. |
| L12 | Universal static (`/dist/*`, `*.css`, `*.js`) cacheable on edit-cms too (plan cache model; edge.yaml unconditional static behaviors) | **REFUTED for edit-cms** | Same A2 fact: anon is off on edit sites, so even CSS/JS requests need `Authorization`. `CachePolicyStatic` whitelists only `Host` → static fetches on edit-cms 401. Either add `Authorization` to a cms-variant static policy (caches per-credential) or — simpler, recommended — **cache nothing on the cms tier** (plan itself says edit-site cache value ≈ 0). |
| L13 | Published-only static set (`*.htm`, `/master_images/*`, `/master_documents/*`, `/documents/*`, `/images/*`) correct (edge.yaml IsPublished behaviors) | **CONFIRMED / UNTESTED** | No contradicting server facts; `/tw`, `/pdfreport` confirmed dynamic apps that correctly fall through to no-cache default (§C). Validate Miss/Hit per test plan P-1/Phase 0. |
| L14 | Origin sends sane caching headers; CloudFront TTLs just layer on top (implicit; CachePolicyStatic DefaultTTL 86400) | **MODIFIED** | B4: origin emits **NO Cache-Control** (`clientCache=NoControl` both servers). Edge caching still works (policy TTLs govern — confirm 86400 default is deliberate since origin gives zero guidance), but **browser** caching stays absent → "60-80% IIS load reduction" holds at the edge, repeat-visitor page-load wins do NOT, until Cache-Control is added (ResponseHeadersPolicy custom header on static behaviors, or IIS clientCache on published tiers). |
| L15 | Compression: CloudFront `Compress: true` + origin gzip coexist (edge.yaml) | **CONFIRMED** | §C: static+dynamic compression on both servers; pass/normalize is fine. |
| L16 | Query-string-in-key for `?v=` busting (CachePolicyStatic) | **UNTESTED** | No new facts; validate in Phase 0. |
| L17 | HTTP→HTTPS redirect moves to CloudFront; on-IIS redirect "becomes redundant" (plan Decisions) | **CONFIRMED (better than assumed)** | B5: **no IIS rewrite/httpRedirect exists at all** — nothing to un-wire, no loop risk (origin sees 443 only). The plan's "keep IIS redirect as defense-in-depth" line is moot — there isn't one; direct-origin HTTP today relies on app-level redirect or nothing (note for Phase 5 posture). |
| L18 | `*.axd` dynamic handlers correctly fall through to no-cache (edge.yaml note; plan bypass list) | **CONFIRMED** | §C: `/tw`, `/_hub`, `/_hub3`, `/admin` apps confirmed; request-filtering defaults; no surprises. Codebase `*.ashx/*.asmx` audit still pending (UNTESTED) per plan Phase 1. |
| L19 | CMS uploads ≤ CloudFront/WAF body limits; `SizeRestrictions_BODY`→Count override needed on cms only (edge.yaml rule 4 comment) | **CONFIRMED** | §C: CMS `maxRequestLength=20480` (20MB), request filtering 30MB; published bodies small (measured 2026-06-09). Override design stands. |

### 1.4 WAF rules — scope and data basis

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| L20 | Estimator surface = `STARTS_WITH /planning/` on published tiers (edge.yaml rules 6+7; plan rule table; README) | **REFUTED for preview2 / future-fragile for public** | B2: web-04 has **`/az/planning`, `/ca/planning`, `/ky/planning`, `/nj/planning`** apps → preview2 Challenge + PlanningRateLimit miss them. Public (web-06) only has `/planning` *today*, but the per-state layout exists in the codebase. Fix: `RegexMatchStatement` `^(/[a-z]{2}(-es)?)?/planning/` (or second ByteMatch CONTAINS `/planning/`) on **both** rules. |
| L21 | Rate-limit values (500 site-wide / 300 planning) grounded in per-IP log analysis, tunable post-cutover from logs (edge.yaml param docs; README; memory iis-log-findings) | **MODIFIED** | Pre-cutover basis CONFIRMED (gov-NAT peak ~185/5min). But post-cutover: per-IP **WAF/CF logs** carry true client IP (fine), while **IIS-side** per-IP analysis goes blind — B3: no X-Forwarded-For logging anywhere; web-04 also missing TimeTaken/Referer/BytesSent. Tuning that needs origin-side correlation (time-taken per IP, the 2026-06-08-style baselining) dies unless XFF logging lands pre-cutover. |
| L22 | Challenge: real browsers pass silently; headless/scripted bots fail (plan rule 6; README "centerpiece") | **UNTESTED — and we now *depend* on headless failing while running our own headless renderer** | Solve behavior is only measurable in the Phase 4b/2 enforcement windows (test plan §2.4). New wrinkle: the Puppeteer print server (headless Chromium, web-06 AND web-04) is exactly the client class Challenge exists to stop — it now **bypasses via hosts-file pin** (never reaches CloudFront), which is correct, but means (a) the pin is a standing prerequisite, not a one-time fix, and (b) the proposed CloudWatch Synthetics estimator canary (test plan §5.2) is also headless Chrome and may fail Challenge → needs the secret-header scope-down exemption. |
| L23 | Challenge NOT applied to edit-cms because "NTLM-authed, low volume" (edge.yaml rule 6 comment) | **MODIFIED** | Conclusion stands (no Challenge on cms), rationale changes: the gate is now **Basic** (NTLM dead through CF). Update comment text; the auth gate argument still holds. |
| L24 | Site-wide RateLimit moot on edit-cms "NTLM-gated" (edge.yaml RateLimit param description, plan param table) | **MODIFIED** | Same: Basic-gated through CF. Still gated, still moot-ish; wording only. |
| L25 | `SensitivePaths` regex safe — nothing legit ends `.config/.bak/.sql` etc. (edge.yaml rule 2; tested 2026-06-09 nothing exposed) | **CONFIRMED so far** | §C request-filtering defaults; nothing exposed. Watch Count-mode example URIs per test plan §2.4 across the **full 131-site inventory** (the 2026-06-09 probe covered the pattern sites only). |
| L26 | Scanner IP set ships empty, OpenClaw-fed (base.yaml; plan) | **CONFIRMED** | Unchanged by new facts. |
| L27 | No verified-bot allowlist needed; robots.txt bars `/planning/` (edge.yaml note; README) | **CONFIRMED** | Unchanged; test plan Phase 3 smoke verifies robots.txt intact. |
| L28 | Bot Control deferred (plan; README) | **CONFIRMED** | No new evidence of JS-capable estimator bots. Re-check post-launch per plan. |
| L29 | WAF rules apply identically to staging hosts (staging shares the public dist/ACL) | **UNTESTED — newly material** | Staging `preview-*` gets the `/planning/` Challenge at Block. Any non-browser internal consumer of staging estimators (QA scripts, PubBot verification, content-review tooling) breaks. No evidence either way — must be answered before Phase 4b. |

### 1.5 Auth, canary order, rollout sequence

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| L30 | Edit-site-first is the SAFER canary order ("lower blast radius, no estimator traffic", plan Summary + Decisions; README) | **REFUTED in part — order analysis below** | The premise "edit tier is the low-risk tier" inverts under A2: edit-cms is now the tier with (1) a known day-one breakage (401 loop) absent a custom policy, (2) an unavoidable **UX change** for every editor (silent NTLM SSO → Basic credential prompt), (3) the least cache benefit, and (4) an open should-we-even decision. **preview2 (Phase 0) is unaffected** — it's published/anonymous on web-04 and keeps every canary property the plan wanted (low traffic, s4 origin, validates WAF+cache+DNS+WebDeploy). Recommended order: **preview2 → public canary/full → edit-cms last (or never)**. Public-first-before-edit is now safer than edit-before-public because public has *no auth coupling at all*, while edit-cms concentrates the only refuted-auth path. |
| L31 | `q.db101.org` rides the edit-cms distribution (plan Decisions, resolved 2026-06-09) | **MODIFIED (consequence of L30)** | q serves the hourly checker unauthenticated → it is anonymous-enabled, unlike the edit sites. If edit-cms is deferred/dropped, q needs a new home: leave on its current direct chain, or front it on the preview2 dist (it serves only `*.xml`/`*.json` — never matches the static set; plan already noted this caveat). Decide with §3d. |
| L32 | DNS cutover: ~12 records, staged, 60s TTL, 5–8 min revert (plan; test plan §3h/§4) | **MODIFIED** | Mechanics CONFIRMED (test plan's revert batches + INSYNC timing are right). Volume REFUTED: ~92 records across 23 states (B1). Pre-stage rule (snapshot + revert batch per zone, committed) becomes a script-generated artifact, not hand-written. Phase 4's "48 public-state sites" and the checker's "18 state homepages" counts are both stale. |
| L33 | WebDeploy via VPN unaffected (plan; README FAQ) | **CONFIRMED** | §C: WMSvc running both servers; port 8172 path untouched. Re-verify per phase as planned. |
| L34 | Origin-bypass fallback ("editors fall back to direct origin — works") and Phase-5 SG lock sequencing (test plan §4; plan Phase 5) | **CONFIRMED, with a new dependency** | Still valid — and now also required by the **hosts-pin** (local render traffic must keep working under SG lock; it does, it never leaves the box — A1/§D). Do not lock the SG until all DNS-revert paths are retired AND X-Origin-Verify enforcement design is settled (L35). |
| L35 | X-Origin-Verify: CF injects header; IIS "can require it" via URL Rewrite (base.yaml secret; edge.yaml OriginCustomHeaders) | **MODIFIED — localhost exemption now REQUIRED, enforcement must be deferred** | B5: URL Rewrite enforcement is greenfield (no rule conflicts) — good. But the hosts-pin makes Puppeteer traffic arrive at IIS **locally without the header**; WebDeploy/VPN and direct-origin rollback traffic also lack it. So the enforcement rule MUST exempt loopback/internal (`REMOTE_ADDR` 127.0.0.1, 10.3.0.0/x, the box's own IPs), and enforcement must stay OFF until Phase 5 (it would break every DNS-rollback lever in test plan §4). Yes — the localhost exemption is *more* needed than before, not less. |
| L36 | Print-server fix = code repoint to `https://localhost`/`10.3.0.63` + explicit `Host:` header (plan App-changes item 1; test plan Phase 3 hard gate wording) | **MODIFIED — better fix found** | IIS review §D: renderer is per-job headless Chromium spawned by per-site `/pdfreport` .NET apps (`node pdf.js [srcurl] [destpdf]`), srcurl = public hostname. Recommended fix is **config-only hosts-file pin** (public hostnames → 127.0.0.1): TLS still validates (same cert bound locally), survives SG lockdown, no code change, no `ignoreHTTPSErrors`. **New scope:** web-04 also renders (pdfreport/pdfnode Started) → pin preview2/edit hostnames on web-04 too → **the gate moves earlier: it gates preview2 Block (Phase 2), not just public (Phase 3/4b)**. Keep the `Allow 52.8.7.0/32` WAF fallback OFF (templated, not improvised) unless pinning fails. |
| L37 | Phase ordering in the test plan (P-1 → 0 preview2 → 1 edit-cms → 2 edit Block → 3/4 public → 4b) | **MODIFIED** | P-1 and Phase 0 stand as-is. Phase 1/2 (edit-cms) must move after public or be dropped, pending §3d decisions (see L30). Phase numbering/text in both docs needs the re-order. |

### 1.6 Invalidation, monitoring, cost

| # | Assumption | Verdict | Evidence |
|---|---|---|---|
| L38 | InvalidateCdn design: shared library, ambient scope, per-tier secret, no-op for cms, existing IAM covers secret reads (plan CloudFront Invalidation; edge.yaml DistIdSecret) | **CONFIRMED, scale note** | Nothing in the new facts contradicts the design. Scale: 23 states × publishes → watch the 1,000 free paths/month (test plan §5.3 item 7 already covers). cms no-op stays correct under L12's "cache nothing on cms" recommendation — *more* correct, actually. |
| L39 | Alarms: 2 templated alarms suffice for rollout; SNS topic wired (edge.yaml; base.yaml) | **MODIFIED** | Test plan §5.1: topic has **no subscriptions** (silent pager); no Count-mode tripwire; no 4xx/cache-floor/origin-latency/challenge-pass alarms. Adopt the §5.1 PROPOSED set + subscribe the owner. Add (new, from A3): **origin-cert-expiry alarm/calendar**. |
| L40 | public-url-checker is the live regression detector post-cutover (plan §B) | **MODIFIED** | Still true for homepages + q. Gaps per test plan §5.2 (no /planning/, no vets101/apex/staging/static probe; liveness-only) — and the inventory correction means its host list should be reconciled against the **real** public site list (no `nv.db101.org`; verify all 23 states present). |
| L41 | Cost: $25–35/mo baseline (plan Cost; README $40–50 "full stack") | **MODIFIED — recompute** | Fixed WAF floor alone: 3 ACLs × $5 + ~6 billable rules × $1 × 3 ACLs ≈ **$33/mo** before request fees ($0.60/M WAF), CloudFront requests/data transfer at the *real* 131-site volume, S3 log storage, invalidations, and the §5.1 monitoring subscription. Baseline is realistically **$40–70/mo**; README and plan disagree with each other today and both predate the real inventory. Not a blocker — but re-estimate before the owner sees the first bill. |
| L42 | Perf measurement plan (§A curls, baseline/after) | **CONFIRMED, one fix** | Method stands. web-04 IIS logs lack TimeTaken (B3) → origin-side perf baselining for edit/preview2 must come from the curl harness only, or after the logging fix. |
| L43 | "NACLs can be decommissioned once WAF is active (WAF is a superset)" (plan Decisions; README FAQ) | **MODIFIED** | Only a superset **for fronted hosts**. The non-pattern/direct sites (twproxy, design, logs:2000 — web-04 binds `*:2000` no host header, §E — etc.) keep only NACL/SG protection. NACL removal must wait for the §3d in/out list, and the SG must be confirmed to block :2000 publicly regardless. |
| L44 | CMS prod hardening fine as-is (implicit) | **REFUTED (non-blocking)** | §E: CMS web.config has `debug=true` + `customErrors Off` in production; stopped `-es` sites bind an expired cert. Fix at next deploy; rebind if restarted. |

---

## 2. Conflicts between the two reviews

The test plan was written against the *plan's* model of the servers; the IIS review measured the servers. Five concrete collisions:

1. **NTLM through CloudFront.** Test plan Phase 1 smoke expects `401 NTLM challenge … auth passes through`, functional test #1 is "NTLM/Negotiate auth into /admin/ through CloudFront", and §3(e).5 treats an NTLM 401 loop as a diagnosable edge case. IIS review A2 says NTLM **cannot** work through CloudFront — the 401 loop is the *default outcome*, not an anomaly. Every edit-cms test must be rewritten around **Basic**: `curl -u` smoke (a bare `curl -sI` 401 only proves the gate exists, not that login works), browser functional test = Basic prompt → edit → save, and §3(e).5 inverts ("NTLM loop = expected unless the custom Authorization cache policy is deployed").
2. **Phase order.** Test plan §1 hard-codes "preview2 canary leads, then edit-cms, then public." Phase 0 survives untouched (preview2 = anonymous published tier). But "Phase 1 edit-cms next" now front-loads the only tier with a known auth breakage + UX change. Either re-sequence (preview2 → public → edit-cms) or gate Phase 1 on the §3d edit-tier decision + custom policy deploy. The plan doc's whole "edit-site first" Decision needs the same rewrite.
3. **Origins listed as raw IPs.** Test plan fixed-names table ("Origins: web-04 52.8.85.37…"), T2 `--resolve` recipes, §3(g) `openssl s_client -connect 52.8.7.0:443`, dns-revert examples (`A 52.8.7.0`). All the *curl/diagnostic* uses remain valid (they bypass CloudFront on purpose). But the table implies the IPs are also the CloudFront origin config — they can't be (A1). Annotate: origin *domain names* are `s4/s6.eightfoldway.com`; IPs remain correct for direct-origin testing and DNS reverts.
4. **Print-server gate: mechanism, scope, and timing.** Test plan Phase 3 entry gate describes the code repoint ("Puppeteer fetches https://localhost / 10.3.0.63 with explicit Host header") and places the gate only before public canary. IIS review §D replaces the mechanism (hosts-file pin) and **widens the scope to web-04** (preview2/edit rendering) → a second, *earlier* gate is missing: verify web-04 pinning **before Phase 2** (preview2/edit Block flip). The verification method (IIS log `c-ip` = 127.0.0.1) survives; §3(f) and §2.4's "if 52.8.7.0 shows up in RateLimit, the repoint regressed" stay valid (extend to watching 52.8.85.37 on the preview2 ACL).
5. **Estimator path scope in smoke tests.** Test plan smokes only ever hit `/planning/` (Phases 0/3/4/4b, `smoke-host.ps1 -Planning`). B2's per-state apps mean Block-mode verification must also hit `/az/planning/` (etc.) on preview2 — both as a *negative* test pre-fix (proves the gap) and a *positive* test post-regex-fix (proves coverage). Add a path list parameter to `smoke-host.ps1`.

Smaller frictions: test plan Phase 1 edit-cms static smoke (`/dist/<asset>.css … Hit on 2nd fetch`) is impossible unauthenticated under anon-off (and goes away entirely if cms caches nothing per L12); §5.3 item 5 compares post-cutover `/planning/` load to the 2026-06-08 IIS baseline — fine via CF logs, but any IIS-side per-IP comparison needs the B3 XFF fix; checker/"18 state homepages" counts vs. the 23-state inventory.

---

## 3. Unified change list (priority order)

### (a) Template changes — blockers first

**A. `edge.yaml` — `OriginDomainName` (P0, deploy-blocker).**
- Param description: replace "e.g. 52.8.85.37 for edit, 52.8.7.0 for public" with "FQDN — CloudFront rejects IPs. web-04 = `s4.eightfoldway.com`, web-06 = `s6.eightfoldway.com`. These DNS names must permanently point at the EIPs (never migrate them to CloudFront — origin loop)."
- Optionally add `AllowedPattern` rejecting bare IPs.
- Update the plan's Key-parameters table and the test plan's fixed-names table to match.

**B. `edge.yaml` — CMS auth-carrying cache policy (P0, blocks edit-cms tier only).**
- New resource `CachePolicyCmsAuth` (`Condition: IsCms`): `MinTTL: 0, DefaultTTL: 0, MaxTTL: 1`; cache-key headers whitelist `[Authorization, Host]`; cookies `all`; query strings `all`. (Cache policies CAN carry Authorization; origin-request policies cannot; managed CachingDisabled cannot.)
- `DefaultCacheBehavior.CachePolicyId: !If [IsCms, !Ref CachePolicyCmsAuth, '4135ea2d-…' (CachingDisabled)]`.
- Universal static behaviors (`*.css`, `*.js`, `/dist/*`): wrap in `!If [IsPublished, …, !Ref AWS::NoValue]` — i.e., **no caching at all on the cms tier** (anon off makes shared static caching wrong; edit-site cache value ≈ 0 per the plan itself). This also strengthens the q.db101.org "never cache anything" guarantee and keeps the InvalidateCdn cms no-op exactly right.
- Update rule-6/param comments: "NTLM-authed" → "Basic-authed through CloudFront (NTLM does not survive CF)".

**C. `edge.yaml` — planning scope regex (P0 for preview2, cheap insurance for public).**
- Rules `Challenge-Estimator` (6) and `RateLimit-Estimator` (7): replace `ByteMatchStatement {UriPath, STARTS_WITH, /planning/}` with `RegexMatchStatement {UriPath, RegexString: '^(/[a-z]{2}(-es)?)?/planning/'}` (keep the LOWERCASE transform). Covers `/planning/`, `/az/planning/`, `/nc-es/planning/`, future layouts.

**D. `edge.yaml` — emergency Allow IP set (P1).** Adopt test plan §3(a)'s PROPOSED `AllowIpSet` in `base.yaml` + a priority-0 terminating Allow rule referencing it in `edge.yaml` (ships empty). Pre-built "let this user through" lever; also the templated home for the `52.8.7.0/32` print-server fallback if hosts-pinning ever fails.

**E. `edge.yaml` — Cache-Control for browsers (P2).** `ResponseHeadersPolicy`: add `CustomHeadersConfig` emitting `Cache-Control: public, max-age=3600` (tune) — but ONLY on a static-behavior variant policy (split into `ResponseHeadersPolicyStatic` / `…Dynamic`); never let dynamic/auth responses inherit it. Origin emits nothing (B4), so this is the only browser-caching lever without touching IIS.

**F. `edge.yaml`/`monitoring` — alarms (P2).** Add test plan §5.1's PROPOSED set (4xx, cache-hit floor, origin latency, challenge-pass metric-math, rate-limit-block, Count-mode tripwire) + an SNS subscription for the owner (out-of-template or a parameter). New: a scheduled origin-cert-expiry check (even a calendar entry + the §6 `origin-tls-check.sh` in a weekly cron beats nothing).

**G. Alias lists (P1, parameter values not template).** Regenerate every `AlternateDomainNames` list from the batch1 inventory: drop `nv.db101.org` (doesn't exist), drop stopped `ia-es`/`nc-es` public, **remove `s4.eightfoldway.com` / `s6.*` chain heads** (L7), exclude all §3d-undecided non-pattern hosts until decided. Check the 100-alias default limit on the public dist (~23 states × {public+staging} × {db101 families incl -es} + apexes + www — count it; request a limit raise if near).

### (b) Plan-doc changes

1. **Rewrite "edit-site first" Decision + phase order** (L30/L37): preview2 canary stays Phase 0; edit-cms moves after public (or out of scope); renumber phases in both the plan and the test plan; carry the NTLM→Basic rationale.
2. **Add A2/A3/B1–B5 facts** to the plan: origin domain names, edit auth model, cert expiries, real inventory pointer, per-state planning apps, no-XFF, no-Cache-Control, no-IIS-redirect.
3. **Fix internal inconsistencies:** Phase 0 bullet says `RateLimit=50`, Phase 3 says `RateLimit=100` — both contradict the decided 500 (and the edge.yaml default). Phase 4 "48 public-state sites" → real count. README "Phase 0 blocked on ACM cert" → stale (cert ISSUED 2026-06-08); README cost table ≠ plan cost section — reconcile per L41.
4. **`s4`/`s6` = infrastructure names, never cut over** — add to Decisions and DNS Records section; remove `s4.eightfoldway.com` from Phase 1 migration list.
5. **Print-server section:** replace code-repoint with hosts-pin as primary (keep code fix as alternative), add web-04 scope, move the gate to "before any published-tier Block flip" (Phase 2 AND 4b).
6. **X-Origin-Verify:** document the loopback/internal exemption + enforcement deferred to Phase 5 (L35).
7. **Test plan edits:** Phase 1 smoke/functional → Basic auth (`curl -u`, browser Basic prompt); add web-04 print gate to Phase 2 entry; add per-state planning paths to Phase 0/2 smokes + `smoke-host.ps1`; annotate origin-IP table; reconcile host counts; note §3(e).5 inversion.
8. **README:** architecture diagram origin labels (s4/s6 names), edit-tier auth note, Challenge caveat (own headless renderer bypasses via hosts-pin; Synthetics canary needs exemption).

### (c) Pre-cutover server tasks (orderable today, all config-only)

| # | Task | Gates | Detail |
|---|---|---|---|
| S1 | **web-06: add `https/*:443:s6.eightfoldway.com` IIS binding** (cert `8CA90463…`) | public stack deploy + all (T1) testing against web-06 | Binding only needs to satisfy SNI/TLS; http.sys routes by forwarded viewer Host (A1). |
| S2 | **Both servers: add `X-Forwarded-For` custom W3C log field** (+ `CloudFront-Viewer-Address` optional); **web-04: add TimeTaken/Referer/BytesSent** | Phase 0 (do before any traffic moves) | B3. Quiet-window config change; prerequisite for every per-IP diagnosis post-cutover. |
| S3 | **hosts-file pins**: web-06 → public+staging hostnames → 127.0.0.1; **web-04 → preview2 + edit hostnames → 127.0.0.1** | Phase 2 (web-04) and Phase 4b (web-06) Block flips | §D. Verify per test plan: render a PDF, confirm IIS log `c-ip` = 127.0.0.1. Document the pin list next to the DNS cutover list (they must track each other as states are added). |
| S4 | **Origin-cert renewal calendar + alarm**: web-04 `472E29CD…` exp **2026-08-05**, web-06 `8CA90463…` exp **2026-08-26**; confirm `efw.policy.cert-updater` flow re-binds IIS 443 (incl. the new s6 binding) | Standing; first renewal lands mid-rollout | A3. With https-only origins, expiry = outage, and browsers will never warn you again. |
| S5 | **X-Origin-Verify URL Rewrite rule** (built, deployed DISABLED or log-only): require header, exempt `REMOTE_ADDR` loopback/10.3.0.0/x | Phase 5 | B5 (greenfield, no conflicts) + L35. |
| S6 | **Hardening batch (non-gating):** CMS `debug=false`/`customErrors RemoteOnly`; confirm SG blocks :2000 on web-04 (`*:2000` no host header); rebind expired cert if `ia-es`/`nc-es` ever restart; look at the web-04 COM-error site config | next deploy window | §E. |
| S7 | **Renew `hb101.org`** (registry expiry **2026-06-23** — 13 days) | any hb101 cutover | Plan decision, still open. |

### (d) Open decisions for the owner

| # | Decision | Options / lean |
|---|---|---|
| D1 | **Edit tier behind CloudFront at all?** NTLM SSO → Basic prompt is a real UX regression for every editor; WAF value on a fully auth-gated, low-traffic tier is modest; cache value ≈ 0. | (i) Front it with the Authorization cache policy + Basic (accept prompt); (ii) keep edit-cms direct-to-origin permanently (skip the 3rd distribution — saves ~$10+/mo and the whole A2 class of risk; origin stays exposed for that hostname family, NACL/SG remain its shield); (iii) front it later, after public proves the platform. **Lean: (ii) or (iii) — decide before building anything for Phase 1.** |
| D2 | **Canary order** (consequence of D1): preview2 → public → edit-cms-or-never. Sign off on the inversion of the plan's headline strategy. |
| D3 | **Non-pattern site in/out list** (B1): `planning-generic` (in? it's an estimator surface), `pdfreport`/`pdfnode` (OUT — internal, http-only), `twproxy`, `design`, `dtd`/**`schema.disabilitybenefits101.org`** (cert gap! L2), `turtles`, `ck`, `efw` (NTLM — same A2 problem as edit tier), `logs` (:2000 — OUT, SG-only), `q.db101.org` (re-home per L31 if D1 ≠ front-it). Every "out" host is a reason NACLs can't be fully decommissioned (L43). |
| D4 | **Staging behind Challenge** (L29): inventory whatever automated/internal tooling walks `preview-*` estimators before Phase 4b; exempt via the secret-header pattern if needed. |
| D5 | **`hb101.org` renewal** — approve/do now (S7). |
| D6 | **Cache-Control max-age** for browsers (E above) and confirm the 86400 edge DefaultTTL is intentional given origin emits nothing (L14). |
| D7 | **Cost re-baseline** (L41) — accept ~$40–70/mo baseline before first bill surprise. |

---

## 4. Risk register delta (new risks from today's facts)

| # | New risk | Detection (tie to test plan) | Mitigation |
|---|---|---|---|
| R1 | **Origin cert expires under https-only → total outage** (web-04 2026-08-05, web-06 2026-08-26) — silent, since browsers no longer see the origin cert | §3(g) decision tree (502s); §6 `origin-tls-check.sh` run weekly/cron; `efw-<env>-cf-5xx` alarm fires when it's already down | S4: calendar + cert-updater verification + pre-expiry alarm. Renew BEFORE Phase 4 if possible so the first renewal isn't performed mid-incident. |
| R2 | **Edit-cms 401 loop on day one** (Authorization stripped by CachingDisabled) | Phase 1 smoke (`curl -u` must succeed through (T1) BEFORE DNS); §3(e) | Template change B; or D1 keeps edit tier off CF entirely. |
| R3 | **s6 SNI handshake failure** — public stack deploys but every (T1) test 502s confusingly | P-1 smoke `curl -sI https://$CF/` + (T1) per-host; §3(g) openssl with `-servername s6.eightfoldway.com` | S1 before deploying the public stack; add an explicit "openssl to s4/s6 names" check to P-1 entry criteria. |
| R4 | **Origin loop if s4/s6 ever get cut over to CloudFront** (latent — A1 fix created it) | Hard to detect live (recursive 502s/timeouts); prevent, don't detect | L7: mark s4/s6 + chain heads as never-migrate in the DNS plan; exclude from all alias/cutover lists; comment in edge.yaml param. |
| R5 | **preview2 per-state estimators unprotected** (`/az/planning` etc. miss the Challenge/rate-limit) — silent coverage gap, not an outage | Negative smoke: `curl /az/planning/` on preview2 in Block must return 202/challenge post-fix; Athena Q1 on preview2 ACL showing zero matches for state paths = gap still open | Template change C (regex). |
| R6 | **Per-IP forensics go blind at cutover** (no XFF in IIS logs) — every §3 decision tree that touches origin logs degrades | First (f)/(g) incident post-cutover where IIS log `c-ip` is all CloudFront edges | S2 before Phase 0. WAF/CF logs (Athena §2.2) carry true client IP in the meantime — but only for traffic that traverses CF. |
| R7 | **hosts-pin drift**: new state launched → public DNS added but pin list not updated → that state's PDFs hairpin through CF and break at Challenge | §3(f) tree; §2.4 RateLimit watch for `52.8.7.0`/`52.8.85.37` self-traffic; PDF step in every phase's functional suite | Couple the pin list to the DNS cutover checklist (S3); keep the templated AllowIpSet fallback (D) ready but OFF. |
| R8 | **X-Origin-Verify enforcement breaks rollback + local renders** if enabled naively | Direct-origin (T2) curls start failing with the rewrite rule's status; PDF failures with local `c-ip` | L35/S5: exemptions + defer enforcement to Phase 5; test plan §4 already forbids SG-lock before rollback retirement — extend that rule to header enforcement. |
| R9 | **Synthetics estimator canary (headless Chrome) fails the Challenge** → permanent false alarm, or worse, gets exempted so broadly it becomes a bypass | Phase 4b enforcement window — explicitly verify the canary passes (test plan §5.2) | Secret-header scope-down (NOT statement) exactly as test plan proposes; secret in Secrets Manager. |
| R10 | **Editor Basic-auth UX revolt** (silent SSO → prompt) — adoption/rollback pressure mid-rollout, not technical | Editor reports during Phase 1 week; §3(e) | D1 decided up front, editors pre-briefed; password manager guidance; rollback = DNS revert (edit tier keeps direct-origin fallback until Phase 5). |
| R11 | **Cert/coverage gap for `schema.disabilitybenefits101.org`** if dtd is fronted without noticing it's outside the 5 zones | CloudFront refuses the alias without a covering cert (fails at deploy — good) ; risk is *deciding* to front it late | D3 now; reissue cert with the extra SAN only if "in". |
| R12 | **NACL decommission overexposes never-fronted hosts** (twproxy, design, :2000, stopped sites) | External port-scan after decommission; §E SG check | L43: gate NACL removal on the D3 in/out list; verify SG on :2000 regardless. |

---

*Sources: waf-reviews/review-iis-accuracy-2026-06-10.md; waf-reviews/test-diagnostics-plan-2026-06-10.md; waf-cloudfront-migration.md; README.md; cloudformation/{base,edge,redirect}.yaml. Server evidence re-runnable via waf-reviews/ssm-tmp/batch*.json.*
