# Review: IIS Platform Accuracy vs Plan (2026-06-10)

Evidence gathered via AWS SSM Run Command (`AWS-RunPowerShellScript`), **read-only**, against both production origins. Command payloads preserved in `waf-reviews/ssm-tmp/batch*.json`.

| Server | Instance | IPs | OS |
|---|---|---|---|
| web-04 (edit/CMS + preview2 origin) | `i-0272763b46610ac1b` (efw.web.04d) | 52.8.85.37 / 10.3.0.122 | Windows Server 2022 |
| web-06 (staging + public origin) | `i-0c82adf476c7c5e32` (efw.web.06d) | 52.8.7.0 / 10.3.0.63 | Windows Server 2025 |

---

## A. Showstoppers (must fix before deploy/cutover)

### A1. `OriginDomainName` is parameterized with raw IPs — stack will not deploy
`edge.yaml` / plan param table pass `52.8.85.37` / `52.8.7.0`. CloudFront **rejects IP addresses** as origin domain names, and with `OriginProtocolPolicy: https-only` the origin cert must validate against the name.

**Resolution (verified on-server + DNS):**
- **web-04: use `s4.eightfoldway.com`** — DNS A → 52.8.85.37 exists; IIS 443 binding exists; cert `472E29CD…` covers `*.eightfoldway.com`. Ready as-is.
- **web-06: use `s6.eightfoldway.com`** — DNS A → 52.8.7.0 **already exists**, but **no IIS 443 binding for it** (all web-06 443 bindings are host-headered, no catch-all) → CloudFront's SNI handshake to `s6.eightfoldway.com` would fail today. **Pre-cutover task: add `https/*:443:s6.eightfoldway.com` binding** (cert `8CA90463…` CN=eightfoldway.com covers `*.eightfoldway.com`) to any started site — http.sys routes the actual request by the forwarded viewer `Host` header, the s6 binding only needs to satisfy SNI/TLS.

### A2. Edit-site auth: NTLM/Negotiate will not survive CloudFront; Basic is the path — but CloudFront strips `Authorization` by default
Measured per-site (batch2): **every CMS edit-site (`db101-*`, `hb101-mn`, `vets101.eightfoldway.com`, `efw2`, `db101-master`) has `windowsAuth=True (Negotiate,NTLM)` AND `basicAuth=True`, `anonymous=False`.**
- NTLM/Negotiate is connection-oriented; CloudFront multiplexes/reuses origin connections across viewers → NTLM handshakes break. Browsers will fall back to **Basic** (enabled — over TLS end-to-end, acceptable).
- **But:** CloudFront does **not forward the `Authorization` header** unless it is part of the cache key. The managed `CachingDisabled` policy carries no headers, and origin-request policies cannot carry `Authorization`. → **The CMS-tier distribution needs a custom cache policy (TTL 0/0/1) that includes `Authorization` in the cache-key headers** on every behavior edit users hit. Without this, all edit-site logins fail with an endless 401 loop on day one of the edit-cms canary.
- Expect a UX change: users who today get silent NTLM SSO will get a Basic credential prompt through CloudFront. Decide: acceptable, or keep edit-cms off CloudFront entirely (it was the "canary" tier — reconsider order).

### A3. Origin TLS certs expire ~2 months post-cutover
- web-04 serving cert `472E29CD…` (SANs: `*.db101.org`, `*.eightfoldway.com`, `*.hb101.org`, `*.vets101.org`) — **expires 2026-08-05**.
- web-06 serving cert `8CA90463…` (same 4 wildcards + 4 apexes) — **expires 2026-08-26**.
With `https-only` origin policy, an expired origin cert = total outage behind CloudFront (today an expired cert only triggers browser warnings). **Add origin-cert renewal to the runbook as a hard calendar item + alarm.**

## B. Major plan corrections

### B1. Site inventory is ~10× the plan's hostname model
Plan models 4 tiers × {mn.db101, mn.hb101, vets101}. Reality (batch1):
- **web-04: 71 sites** — CMS edit + preview2 pairs for **states ak, az, az-es, ca, ca-es, co, co-es, ga, ia, ia-es, il, il-es, ky, mi, mn, mo, nc, nc-es, nj, nj-es, nv, nv-es, oh** + master + national, **plus non-pattern sites**: `s4.eightfoldway.com`, `planning-generic.eightfoldway.com` (https), `pdfreport.eightfoldway.com`, `pdfnode.eightfoldway.com`, `twproxy.eightfoldway.com`, `design.`, `dtd.`, `ck.`, `efw.eightfoldway.com` (efw2, NTLM-gated), `q.db101.org`, `db101.logon3.forms`, `logs` (:2000), `bp101-dummy`.
- **web-06: 60 sites** — preview/public pairs for the same states (note: **no `nv.db101.org` public site** — NV not launched; `ia-es`/`nc-es` public sites Stopped), apex+www bindings live on `www.db101.org` (binds `db101.org`), `www.eightfoldway.com` (binds `eightfoldway.com`), `mn.hb101.org` (binds `www.hb101.org` + `hb101.org`), `www.vets101.org` (binds `vets101.org`). Plus `turtles.eightfoldway.com`, `dtd.eightfoldway.com` (binds **`schema.disabilitybenefits101.org`** — contradicts "not using disabilitybenefits101.org"), `bp101-dummy`, `logs` (:2000 localhost).

**Consequences:**
1. CloudFront distribution `Aliases` lists, DNS cutover list, and the ACM cert SAN check must be driven by this real inventory, not the 5-zone examples. (Wildcards in the issued cert cover the patterns; apexes covered.)
2. Decide explicitly which non-pattern sites go behind CloudFront, stay direct, or stay internal: `planning-generic`, `pdfreport`/`pdfnode` (http-only, internal plumbing — keep OFF CloudFront), `twproxy`, `design`, `dtd`/`schema.disabilitybenefits101.org`, `turtles`, `ck`, `efw`, `logs`.
3. Per-state DNS swing = ~46 public/preview records + ~46 preview2/edit records, not ~12.

### B2. WAF estimator scope misses per-state planning apps (preview2 tier)
Distinct IIS app paths (batch8): web-04 has **`/az/planning`, `/ca/planning`, `/ky/planning`, `/nj/planning`** in addition to `/planning` (web-06 public has only `/planning`, `/pdfreport`, `/tw`). The Challenge + PlanningRateLimit `ByteMatch UriPath STARTS_WITH /planning/` misses `/{state}/planning/` on the preview2 distribution. Public tier is unaffected today, but the pattern exists in the codebase — **change scope to a regex (`^(/[a-z]{2}(-es)?)?/planning/`) or add a second ByteMatch (CONTAINS `/planning/`)** so both tiers and future layouts are covered.

### B3. IIS logs will lose client IPs at cutover; web-04 logs are also missing key fields
Batch6: all sites log W3C fields **without X-Forwarded-For** (no custom fields anywhere). Post-CloudFront, `c-ip` = CloudFront edge IP → all per-IP analysis (the basis of our rate-limit tuning) goes blind. Also **web-04 lacks `TimeTaken`, `Referer`, `BytesSent`** (web-06 has them).
**Pre-cutover task (both servers):** add custom log field `X-Forwarded-For` (and `CloudFront-Viewer-Address` optionally); add TimeTaken/Referer on web-04. This is a config-only change, do it during a quiet window — it's also a prerequisite for "diagnose quickly."

### B4. No Cache-Control emitted on static content
Batch5: server default `clientCache=NoControl` (both servers; a handful of CMS sites override to DisableCache/maxAge-0 — fine for edit tier). Public static (`/dist/`, images, `.htm`) ships with **no Cache-Control** today:
- CloudFront edge caching still works (cache-policy TTLs govern) — confirm `CachePolicyStatic` default TTL is deliberate, since origin gives no guidance.
- Browsers will continue to re-request everything → the "60-80% IIS load reduction" claim holds, but page-load wins for repeat visitors need **Cache-Control added via the ResponseHeadersPolicy** (or IIS clientCache on published tiers) — cheap, high-value addition.

### B5. HTTP→HTTPS redirect is NOT in IIS config
Batch4: URL Rewrite + ARR installed on both, but **zero global rules, zero site-level rewrite rules, no httpRedirect**. The existing canonical redirect must live in app code (or doesn't exist uniformly). Implications: (1) moving redirect to CloudFront (`redirect-to-https`) is safe — nothing in IIS to un-wire; (2) verify app-level redirect logic doesn't loop when it sees `CloudFront-Forwarded-Proto`/`X-Forwarded-Proto https` on port-80 origin traffic — **plan already sets origin protocol https-only, so origin sees 443; no loop risk. Confirmed fine.** (3) X-Origin-Verify enforcement via URL Rewrite is greenfield — no rule conflicts.

## C. Confirmed assumptions
- **Host-header routing**: every site is host-header bound (no IP-based sites) → `Host` in static cache key is correct and mandatory. ✔
- **One shared wildcard cert per server on 443** → single origin TLS story. ✔
- **WMSvc running on both** (WebDeploy unaffected). ✔
- **Compression on** (static+dynamic, both) — keep CloudFront `Compress: true`; origin already gzips, CloudFront will pass/normalize. ✔
- **Request filtering**: defaults (hiddenSegments standard 8, maxAllowedContentLength 30MB, maxUrl 4096, maxQueryString 2048). No IIS IP restrictions (`allowUnlisted=True`, 0 entries) — NACL is the only IP layer today, as plan stated. ✔
- **CMS uploads**: `maxRequestLength=20480` (20MB) on CMS app → confirms CMS-tier SizeRestrictions_BODY→Count override; published tiers spot-checked clean. ✔
- **`/tw` app exists on both** (plan's `/tw/*` bypass justified). `/_hub`, `/_hub3`, `/admin` exist on web-04 (CMS tier = no-cache default behavior, covered). ✔
- **trace.axd**: `<trace enabled="false" … localOnly="true">` on CMS. ✔

## D. Puppeteer print server — resolved mechanics + recommendation
- Renderer = headless Chromium under **`c:\inetpub\wwwroot\pdfnode`** (web-06), spawned per-job by the .NET `/pdfreport` app (`pdfreport4` / `pdfreport4-preview` dirs): `node pdf.js [srcurl] [destpdf]`; `page.goto(srcurl)`. The IIS sites named `pdfnode*`/`pdfreport4*` on web-06 are **Stopped** — rendering runs as child processes of the per-site `/pdfreport` app, not as a service.
- `srcurl` is constructed by the .NET app per request → it renders the **public hostname**, looping back via the EIP today; after cutover it would hairpin through CloudFront and hit the `/planning/` Challenge.
- **Recommended fix (config-only, no code change): hosts-file entries on web-06 pinning the rendered public/preview hostnames → 127.0.0.1.** Chrome then fetches on-box; TLS still validates (same cert is bound locally); survives the Phase-5 SG lockdown; X-Origin-Verify exemption unnecessary for this path (traffic never leaves the box, IIS sees it as local). Alternative (code): make pdfreport build `srcurl` from a config key. Keep the WAF `Allow 52.8.7.0/32` fallback OFF unless hosts-pinning proves problematic.
- web-04 also has `pdfreport`/`pdfnode` **Started** sites (`pdfreport.eightfoldway.com`, `pdfnode.eightfoldway.com`, http-only) + per-site `/pdfreport` apps → preview2 PDF rendering happens on web-04 too; apply the same hosts-pinning there for preview2/edit hostnames.

## E. Hardening notes (non-blocking)
- **CMS web.config: `<compilation debug="true">` + `<customErrors mode="Off">` in production** (db101-mn spot-check). Behind NTLM/Basic gate, so exposure is to authenticated users, but: debug=true disables ASP.NET timeouts/batching and leaks stack traces. Recommend flipping at next deploy.
- Stopped sites `ia-es`/`nc-es` (web-06) bind an **expired** cert (`9F747ED1…`, exp 2026-03-15) — harmless while stopped; rebind if ever restarted.
- `logs` site on port 2000: web-06 binds localhost (good); **web-04 binds `*:2000` with no host header** — confirm SG blocks 2000 publicly.
- web-04 auth probe threw 4 COM errors (`0x8007000D`) for one site's config (likely `efw.tile`/stopped site with malformed config) — cosmetic, but appcmd/PowerShell config reads on that site fail; worth a look someday.

## F. Raw inventory pointers
Full site/binding dumps captured in this session's SSM outputs (re-runnable via `ssm-tmp/batch1-sites.json`):
- web-04: 71 sites (66 started). All 443 bindings → cert `472E29CD61F94BDEF2580B5F7B584600F4D2E104`.
- web-06: 60 sites (50 started). All 443 bindings → cert `8CA90463E84ED58C01F4C33F03BE5CC9B916C500` except 2 stopped `-es` sites.
