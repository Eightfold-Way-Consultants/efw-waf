# Remove web-06's public IP — Phase 5 via CloudFront VPC origins

**Date:** 2026-07-28
**Goal:** web-06 (`i-0c82adf476c7c5e32`) ends with **no public-facing IP**. Release EIP
`52.8.7.0` (`eipalloc-b5c725d0`). Every consumer of that address must be re-terminated first —
viewer traffic through CloudFront, CloudFront's own origin fetch over a private path, and any
residual direct caller onto the VPC.
**Status:** PLAN. Not started. This is the long-planned Phase 5 (`waf-cloudfront-migration.md:431`,
`dns-migration-plan.md:667`, `waf-proposal-v2:181`) with the mechanism finally specified: **VPC
origins**, not "SG-lock a still-public IP."

---

## Confirmed facts (verified 2026-07-28)

- **web-06 = one EIP** `52.8.7.0`, one ENI, private `10.3.0.63`, us-west-1, account 874922373146
  (same account as the CloudFront stacks).
- **Origin cert renewal survives IP removal.** win-acme validates via **Route53 DNS-01 using the
  instance IAM role** (`efw.policy.cert-updater`; Route53 plugin DLL on-box; scripts in git
  `Eightfold-Way-Consultants/cert-updater` = `C:\git\cert-updater`). No port-80/public inbound in
  the renewal loop. One multi-SAN wildcard cert covers `*.eightfoldway.com` (⊃ `s6.eightfoldway.com`)
  + `*.db101.org` + `*.hb101.org` + `*.vets101.org` + apexes, bound to IIS 443 in `LocalMachine\My`.
- **VPC origins fits:** supports EC2-direct in a private subnet; same-account + same-region; native
  CloudFormation (`AWS::CloudFront::VpcOrigin` + distribution `VpcOriginConfig`); CloudFront requires
  a trusted-CA origin cert (met — LE). CloudFront creates a service-managed ENI in the subnet
  (needs ≥1 free IPv4 + an IGW in the VPC). IPv4-only origin leg (fine — `10.3.0.63`).
- **Print path already loopback-pinned** (pdfnode/pdfreport hosts-MAP → 127.0.0.1) → never needs the
  public IP or CloudFront. WebDeploy already via VPN.

## Mechanism decision: EC2-direct VPC origin

CloudFront → service-managed ENI → `10.3.0.63:443` (web-06 IIS), origin cert = the existing LE
wildcard, `X-Origin-Verify` retained as defense-in-depth (belt-and-suspenders once the origin is
unreachable except via the ENI).

- **Rejected: internal ALB + ACM.** Its only real advantage was offloading cert renewal to ACM — but
  renewal is already Route53-automated with no public dependency, so the ALB buys only health-checks
  / future HA that web-06 (a single box) doesn't use today. Revisit only if web-06 becomes multi-instance.
- **Rejected: SG-lock the public IP to the CloudFront prefix list.** That is the pre-VPC-origins
  method the old docs assumed; it keeps a public IP → fails the stated goal.

## Everything that lands on `52.8.7.0` (must all move first)

**A. Viewer hosts** (91-record enumeration in session 2026-07-28):
- Content → `cf-public` (wildcards): ~23 state leaves (`mn`…`-es`) CNAME→s6, `public-site.db101.org`,
  `public-site.hb101.org`, `www.db101.org`, `www.eightfoldway.com`, `public-site.vets101.org`.
- Apexes `db101.org`/`hb101.org` → **`cf-redirect`** (staged flips, NOT cf-public). `vets101`/
  `eightfoldway` apexes already cut over.
- Staging tier: 27 `preview-*` leaves + `preview-site.*` (A).
- Service/misc: `svc.db101.org`, `dtd.eightfoldway.com` (dtd = runtime-inert, can retire — see
  `waf-cloudfront-migration.md:461`), `turtles.eightfoldway.com` (front as explicit alias).
- `www.*`: `www.db101.org`, `www.eightfoldway.com`, and many `www.<state>.db101.org` /
  `www.preview-*.db101.org` — bounces; route to the **redirect** dist, not cf-public.

**B. Origin anchors (the box itself):** `s6.eightfoldway.com` (A), `s6a` (A), `s6c` (A),
`s6.db101.org`→s6. These stop being viewer-reachable; CloudFront reaches the origin via the VPC
origin instead. Keep `s6*` names resolving to the **private** IP (or internal) for cert SNI + any
private tooling, but they must no longer resolve to a public IP.

**C. Non-routing / non-CloudFront consumers — AUDITED 2026-07-28, ALL CLEAR:**
- **Outbound mail — nothing sends from `52.8.7.0`.** web-06 has NO mail service (no SMTP svc, nothing
  on :25, no IIS SMTP). Only mail config = **YAF forums** (`\<site>\forums\mail.config`) -> `mail.eightfoldway.com:25`, and the
  **forums are FULLY OBSOLETE (Jack 2026-07-28)** — dead config, sends nothing (and `mail.eightfoldway.com`
  resolves to Cloudflare `2606:4700:4700::1111` anyway, not a mail server). MX for all domains = Google
  (aspmx.l.google.com). => releasing the EIP breaks no mail. The `ip4:52.8.7.0` SPF entries (db101.org,
  eightfoldway.com, mail.vets101.org) are **stale — clean up as tidy-up.** The obsolete forums + their
  `\forums\` trees are a separate removable cleanup.
- **Direct server-to-server callers — all already on the PRIVATE path.** PubBot publish reaches web-06
  by SMB on the private IP (`C:\s6d.eightfoldway.com` on web-04 = symlink -> `\\10.3.0.63\wwwroot`,
  live `:445` conn). Build server -> web-06 via hosts entry `10.3.0.63 s6.eightfoldway.com`. WebDeploy
  -> `10.3.0.63:8172`. NO app code hardcodes `52.8.7.0`/`s6` (repo sweep = docs only). All survive EIP removal.
- **Uptime monitor** (public-url-checker) hits the **public hostnames** -> rides CloudFront after
  cutover (Jack confirmed). No direct-IP dependency.
- **Net: Phase C is essentially empty** — only tidy-up = strip `ip4:52.8.7.0` from the 3 SPF records.

## Apex / www / bounce handling — ALREADY DESIGNED (do not re-open)

Per the settled division of labor (`edge-redirect-cutover-design`, redirect stack BUILT+DEPLOYED
2026-07-21): **`edge` = real sites (wildcards), `redirect` = all bounce/collapse.** So:

- **No apex work in `edge-public`.** Its alias set stays wildcards-only
  (`*.db101.org,*.hb101.org,*.vets101.org,www.eightfoldway.com`), which already serves every real
  subdomain incl. `preview-*` and the canonical `www.db101.org`/`mn.hb101.org` targets.
- **Apexes → `efw-waf-redirect`** (`E62IHCKTGN48T`), already built. `vets101.org` + `eightfoldway.com`
  apexes cut over + verified 2026-07-21. **`db101.org` + `hb101.org` apex flips are staged and
  pending** (aliases declared, `cf-redirect.<zone>` ALIAS in place, inert until the A→ALIAS flip) —
  moving them off `52.8.7.0` = execute those two staged flips, NOT an edge-public change.
- **`www.<state>.db101.org` (multi-label) = dead** (don't resolve to a working site today, not
  cert-covered). Depublicize action = **delete** them (dns-dangling cleanup), not route them. A
  pattern www-strip on the edge function is a separate, optional later TODO.
- **`turtles.eightfoldway.com`** = front as one explicit alias on `edge-public` (design decision:
  keep, static, rides CloudFront). **`dtd.eightfoldway.com`** = runtime-inert → retire or leave
  private. **`svc.db101.org`** = confirm what it fronts (service aggregator) before moving.
- **Content www already handled:** `www.db101.org` rides the `*.db101.org` wildcard; `www.eightfoldway.com`
  is an explicit edge-public alias.

## Phased plan (each phase independently revertible)

**Phase A — viewer cutover to CloudFront** (biggest, DNS-only, reversible per-record)
1. `edge-public` alias set is already correct (wildcards); only touch = add `turtles.eightfoldway.com`
   as one explicit alias (+ cert SAN check). Public dist stays `WafRuleAction=Count`.
2. Pre-lower TTLs (60s) on the records being flipped.
3. Canary: flip `preview-ak` (just republished) → `cf-public`; homepage 200 via CloudFront; then fan
   out the staging leaves, then the public state leaves + `www.db101.org` (all ride the `*.db101.org`
   wildcard — zero-config CNAME → `cf-public`). Content `www.eightfoldway.com` likewise.
4. Apexes (`db101.org`, `hb101.org`): execute the **already-staged redirect-stack flips** (A/AAAA →
   ALIAS → `cf-redirect.<zone>`) — redirect stack's job, not edge-public. (`vets101`/`eightfoldway`
   already done.)
5. Dead multi-label `www.<state>.db101.org`: **delete** (dns-dangling cleanup), don't route.
6. Soak in **Count** — Athena `efw-diagnostics` count-mode would-block; watch `SizeRestrictions_BODY`
   8KB + AdminProtection. (Public-tier WAF Count→Block is a separate decision, can precede or follow
   IP removal.)
   - Revert: point the record back at `s6` (works only while the EIP still exists — Phase A revert
     must precede Phase D).

**Phase B — repoint CloudFront origin to a VPC origin** (IaC — IMPLEMENTED 2026-07-28, canary on
preview2 first, then public)

*Verified pre-reqs:* us-west-1 VPC origins **supported except AZ `usw1-az2`** — web-04 (`10.3.0.122`)
and web-06 (`10.3.0.63`) are both `usw1-az3` (OK), and share subnet `subnet-260ee27f` (243 free IPs)
+ SG `sg-06348763`. Origin cert stays valid: CloudFront validates against the Origin domain **or**
the forwarded viewer Host, both wildcard-covered (AWS 502-doc); we keep `DomainName: s4/s6.eightfoldway.com`.

*IaC (done, uncommitted):*
- `edge.yaml` — params `OriginInstanceArn` + `TargetOrigin` (public|vpc); conditions `HasVpcOrigin`,
  `UseVpcOrigin`; resource `IisVpcOrigin` (`AWS::CloudFront::VpcOrigin`, https-only/TLSv1.2/ipv4);
  second origin `iis-vpc-origin` (`VpcOriginConfig`, same DomainName, X-Origin-Verify kept); all 9
  behaviors `TargetOriginId: !If [UseVpcOrigin, iis-vpc-origin, iis-origin]`. Two-origins-with-flip.
- `origin-sg.yaml` (**us-west-1**, new stack `efw-waf-origin-sg`, in the deploy manifest) — an
  `AWS::EC2::SecurityGroupIngress` on `sg-06348763` allowing 443 from the service-managed
  `CloudFront-VPCOrigins-Service-SG` (Option 2, tight). Separate stack because the SG is a us-west-1
  resource and `edge.yaml` is us-east-1.
- `params/edge-preview2.json` — `OriginInstanceArn`=web-04 ARN, `TargetOrigin=public` (create the
  VPC origin inert first). `params/origin-sg.json` — `sg-06348763` + a `REPLACE_WITH_` service-SG id.

*Staged deploy (per tier; preview2 = canary):*
1. `deploy-stack.ps1 edge-preview2` (TargetOrigin=**public**) → **creates the VpcOrigin** (ENI
   provisions ~15 min), behaviors stay on the public origin → **zero serving change**.
2. Read the auto-created service SG id, fill `params/origin-sg.json`, `deploy-stack.ps1 origin-sg`
   → opens origin `:443` from the ENI.
3. **Flip:** `TargetOrigin=vpc`, redeploy the edge stack → behaviors target the VPC origin.
4. **Validate:** sites 200 via CloudFront, estimator walks, PDF renders, cert OK, no 502.
   - **Rollback:** `TargetOrigin=public`, redeploy (one param).
5. Repeat 1-4 for `edge-public` once preview2 is proven.

Note: VPC-origining **preview2 does NOT remove web-04's public IP** — web-04 still hosts the
un-fronted edit-cms tier (`db101-*.eightfoldway.com`, `q.db101.org`) and keeps its EIP + world-443.
It's a routing/validation win; the actual EIP removal is web-06 only (Phase D). `s4/s6.eightfoldway.com`
A-records stop being used for CloudFront **routing** once on the VPC origin (name still used as the
SNI/cert anchor); the `s6` A-record → 52.8.7.0 becomes a Phase-D cleanup, `s4` stays (edit-cms).

**Phase C — retire residual public dependencies** (RESOLVE the OPEN items)
1. Mail: confirm/clean SPF; move any direct-from-box mail to SES/relay.
2. Audit + repoint any server-to-server / health-check / monitoring caller to `10.3.0.63` over
   VPN/peering.
3. Confirm WebDeploy is VPN-only; keep `s6*` names resolving private for tooling.

**Phase C1 — catch-all 404 origin site (RE-INSTATED from dns-dangling-audit Policy #1; PHASE-D PREREQ).**
This was **dns-audit/dns-dangling-audit-2026-06-10.md:36 Policy #1** and **was never built** (confirmed
live 2026-07-29: web-06 has NO blank-hostheader binding, no Default Web Site, every 443 binding =
`sslFlags=1` Require-SNI; old probe `ssm-tmp/batch29-catchall.json` logged the same). It fell out of this
plan on 2026-07-28 — restoring it here. **Why it matters:** with the wildcard `*.db101.org` CloudFront
alias-claim in place (see below), an unbound-but-wildcard-matched Host (any stray `foo.db101.org` DNS'd at
cf-public) is forwarded to web-06, which has no site for it → **Require-SNI TLS reset → CloudFront 502**
(exactly what `preview-master`/`preview-site.*` do). A catch-all site turns that into a clean controlled
**404**. It is defense-in-depth / clean behavior, **NOT** the primary capture gate.
- **Build on BOTH web-06 and web-04** (audit said "both servers"): one IIS site, `physicalPath` = a tiny
  static root serving a 404 page; bindings `*:80:` (blank host) + `*:443:` (blank host) with the existing
  LE wildcard cert bound and **Require-SNI OFF** on the 443 catch-all (so it actually catches unmatched
  SNI — a Require-SNI catch-all would still reset). Lowest IIS site precedence so it never shadows a real
  host-header site.
- **Verify:** `curl --resolve <bogus>.db101.org:443:<origin>` → 404 (not reset); every real host still 200;
  no real site regressed. Then via CloudFront a stray wildcard name → 404, not 502.
- **NAMES THE CATCH-ALL WOULD CATCH (enumerated 2026-07-29):**
  - *web-06:* `preview-master.db101.org`, `preview-site.db101.org`, `preview-site.hb101.org` (unbound routing
    anchors — currently reset→502; `s6.eightfoldway.com` itself is ALSO unbound on web-06 → reset).
  - *web-04:* `edit-site.eightfoldway.com` (CNAME hub for the 24 `db101-<state>` edit sites — those are bound by
    their OWN host headers; the hub name is not), `preview2-site.eightfoldway.com`, `preview2-site.hb101.org`
    (routing hubs), `brk-site.eightfoldway.com` (direct A→52.8.85.37; no host-header binding found, BUT it is
    the documented **"break/test site"** — the build-server VPN-path validation target, `waf-reviews/01-disruption.md:18` —
    with **3 live inbound CNAMEs** `design`/`remote`/`rpc.eightfoldway.com`, classified **NEVER-migrate / stay
    direct to web-04** in `waf-cloudfront-migration.md:478`. NOT dead, NOT a deletion candidate; likely served
    over the existing `pubbot *:80:` blank binding on HTTP. A `:443` catch-all would answer its unmatched-SNI hits
    cleanly, but do NOT retire brk-site or its 3 CNAMEs). BOUND on web-04 (NOT caught): `s4.eightfoldway.com`,
    `q.db101.org`, all `db101-*` edit sites.
- **WEB-04 WRINKLES (must resolve in the C1 design):**
  1. web-04 has a blank-host binding **`pubbot | *:80:`**, but the **pubbot site is `Stopped`** (verified
     2026-07-29) — it's not a web app, it's the **WebDeploy/msdeploy target for the PubBot installer** (content
     dir = `Installer/`+`ServiceFiles/`+`Deploy-PubBot.ps1`, pushed via WMSVC on `:8172`; msdeploy targets by
     site-name + physicalPath, NOT via any HTTP binding). So the `*:80:` blank binding is **inert** (stopped site
     doesn't listen → today unmatched HTTP Host on web-04 gets http.sys 404/reset, NOT pubbot) and **unneeded**.
     CLEAN FIX: **remove pubbot's `*:80:` blank binding** (IIS enforces binding uniqueness even for a stopped
     site, so it must be deleted, not merely left) → frees blank `:80`+`:443` for the catch-all 404 site. Does
     not affect msdeploy (site stays, just loses an unused binding). Better than moving pubbot or `:443`-only.
  2. **web-04 KEEPS its public EIP** (hosts un-fronted edit-cms; not depublicized) → `52.8.85.37` stays directly
     internet-reachable with any Host. The catch-all matters MORE here than web-06 (direct-to-IP bogus-Host probing);
     web-04's catch-all is independent of the web-06 EIP release and can be done anytime.

**PRIMARY ANTI-CAPTURE DEFENSE — VERIFIED IN PLACE 2026-07-29 (separate from the catch-all).** edge-public
(E14TU8NPRHUI0M) holds wildcard aliases `*.db101.org`, `*.hb101.org`, `*.vets101.org` (+ `www.eightfoldway.com`),
and we hold the matching wildcard ACM cert → **no external AWS account can claim any `x.db101.org`/`x.hb101.org`/
`x.vets101.org` as a CloudFront alias.** So web-06 depublicization opens NO capture hole at the CloudFront layer.
**GAP logged:** `*.eightfoldway.com` is NOT wildcard-claimed (only `www.` + apex via cf-redirect) — arbitrary
`sub.eightfoldway.com` names are not CF-alias-claimed. Not a viewer surface in this cutover; track separately.

**Phase D — release the EIP** (PREREQ: Phase C1 catch-all 404 site built + verified)
1. Remove the public origin from `edge.yaml` (VPC origin is now sole origin); redeploy.
2. Lower web-06 SG: drop world 80/443; keep CloudFront-VPCOrigins SG + VPN CIDRs + SSM.
3. Disassociate + release `eipalloc-b5c725d0`. web-06 now private-only.
   - **Rollback model changes here:** the "flip DNS back to `s6`" lever is now dead (no public IP).
     Post-D revert = re-add a public origin to CloudFront (or re-allocate an EIP), not DNS. So do NOT
     enter Phase D until Phase A/B are fully soaked and all DNS-revert paths are retired
     (integrated-review **L34**).

## Verify (end state)

- No Route53 record resolves to `52.8.7.0` (re-run the session's s6/IP enumeration → empty).
- All sites 200 via CloudFront; PDF/print still renders (loopback); cert alarms green
  (`CertDaysRemaining`/`CertHeartbeat`); `edge-public` origin = VPC origin only.
- web-06 SG: no world 80/443; reachable only via CloudFront ENI + VPN + SSM.

## Decisions — ALL RESOLVED 2026-07-28
1. Outbound mail from `52.8.7.0` — **stale SPF** (no mail dependency; audit ALL CLEAR above).
2. Direct-caller audit — **all callers already private** (audit ALL CLEAR above).
3. Public-tier WAF **stays `Count`** through the depublicize (Block is a separate, later decision).
4. Sequencing — **STAGED, preview sites first.** Cut the `preview-*` staging leaves to `cf-public`
   (Phase A) and soak before touching public leaves / origin / EIP.
5. Phase B origin — **two origins with flip**: define both `iis-origin-public` (s6) + the VPC origin,
   point behaviors at the VPC origin, keep the public one as a one-parameter `TargetOriginId` rollback
   during validation; delete it at Phase D.

## Execution order (agreed)
Phase A **preview leaves first** (→ cf-public, Count soak) → Phase A public leaves + apex flips →
Phase B (add VPC origin, flip behaviors, validate) → Phase C tidy-up (strip stale SPF) →
**Phase C1 (build catch-all 404 site on web-06 + web-04 — Phase-D prereq)** →
Phase D (drop public origin + world 80/443, release EIP).

## Phase A status (2026-07-29)
- **Staging fan-out DONE:** all 23 db101 state leaves (az..oh incl `-es` + `master`) + `preview-site.db101.org`
  (was A→52.8.7.0, swapped to CNAME) + `preview-site.hb101.org` flipped CNAME→`cf-public`; `preview-mn.hb101.org`
  rides `preview-site.hb101.org`. Route53 INSYNC both zones; re-enumeration = ZERO preview-* on s6/52.8.7.0.
  Left untouched: `preview-favorites`/`preview-logon` (s3 service tier, not web-06).
- **Verified:** state leaves (mn/ca/oh/az/nc-es + hb101-mn) homepage + deep content `.htm` = 200 via CloudFront;
  `/planning` = 302 (session mint OK). Bare `/<state>/` = 403 (IIS no-default-doc; SAME on known-good canary
  preview-ak → baseline, not a regression).
- **502 anchors (expected, NOT regressions):** `preview-master.db101.org`, `preview-site.db101.org`,
  `preview-site.hb101.org` → 502 via CloudFront because web-06 has NO IIS binding for those Hosts (disk dir for
  preview-master EXISTS w/ 1024 files but was never IIS-bound; Jack: no-binding is fine — the real master site is
  `db101-master.eightfoldway.com` on web-04/edit-cms, cloned from for new sites). These are CNAME routing anchors,
  not viewer hosts. They 502 (not 404) purely because **Phase C1 catch-all is not built yet** — building it flips
  them to a clean 404. Optional cosmetic tidy-up: `preview-master`/`preview-site.db101.org` now have zero
  dependents (state leaves CNAME straight to cf-public) → deletable dead records; `preview-site.hb101.org` STAYS
  (live CNAME hop for `preview-mn.hb101.org`).
