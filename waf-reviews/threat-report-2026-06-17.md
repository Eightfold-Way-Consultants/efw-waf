# Threat Report — EFW / DB101 public web server (web-06 / s6)
**Date:** 2026-06-17  ·  **Analyst:** automated WAF log-harvest  ·  **Server:** web-06 `i-0c82adf476c7c5e32` (us-west-1)

> **One-line takeaway:** The freshest day shows an **escalating bot/scraper campaign** plus a **distributed, Tor-fronted credential-stuffing / account-enumeration attack on the DB101 account API (`/l2svc/*`)** — and the account-API attack sits in the one place none of our current/planned WAF rules would catch it. Routine `.env`/`.git` and WordPress scanning continues at volume and is well-covered. The single biggest "bot" IP is **our own internal pdfshot/PDF renderer**, not an attacker.

---

## 1. Scope & data provenance

| Item | Detail |
|---|---|
| Sites analyzed | All 20 **DB101 public state sites** hosted on web-06 (mn, ca, az, mi, mo, nc, ga, il, oh, ky, nj, ak, ia, co + Spanish `-es` variants + national `www/db101.org`). All are public-facing; no internal/plumbing sites were in this server's log set. |
| Days analyzed | **260613, 260614, 260615, 260616** (W3C daily logs). |
| "Today" caveat | **Today's `u_ex260617.log` was NOT available.** The only path to a live pull is `aws ssm send-command` (AWS-RunPowerShellScript) on web-06, which is blocked in this environment (auto-denied for any non-pre-approved invocation). Logs instead came from the **nightly S3 backup**, whose newest snapshot is **260616** (today's partial log isn't backed up until ~01:00 tomorrow). **260616 is used as the freshest full-day proxy**, with the 4-day trend establishing direction. Threat patterns persist day-to-day, so conclusions hold for "now." |
| Raw logs in S3 | `s3://efw.backup/iis-logs/<YYMMDD>/W3SVC<id>/u_ex<YYMMDD>.log` (nightly backup of web-06). 260616 ≈ 40.6 MiB / 151,792 requests across 20 sites. Pulled to a temp dir outside the repo for analysis; not committed. |
| Important log limitation | IIS W3C fields here are `date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status sc-bytes cs-bytes time-taken`. **No request bodies and no `cs-host`/cookies are logged.** So **POST-body SQLi / posted credentials are invisible** — body-based attacks are necessarily under-counted here. |

### Per-site volume (260616)
mn 41,149 · ca 32,171 · az 14,972 · mi 10,197 · mo 7,156 · nc 6,733 · ga 6,031 · il 5,894 · oh 4,613 · ky 4,548 · nj 4,111 · www/db101.org 3,075 · ak 2,773 · ca-es 1,964 · az-es 1,806 · ia 1,388 · nj-es 1,140 · co 1,063 · il-es 917 · co-es 91.

### 4-day trend — the situation is escalating
| Day | Total reqs | HeadlessChrome UA | Empty UA | `.env`/`.git`/`.aws` hits |
|---|---|---|---|---|
| 260613 | 79,016 | 318 | 1,964 | 441 |
| 260614 | 87,099 | 538 | 3,218 | 773 |
| 260615 | 143,505 | 5,899 | 2,403 | 519 |
| 260616 | 151,792 | 7,447 | 4,298 | 1,094 |

Total volume nearly **doubled** and headless + empty-UA + secret-file scanning all climbed sharply over the window.

---

## 2. Top threats active now (ranked)

### #1 — Distributed credential-stuffing & account-enumeration on the DB101 account API (Tor-fronted) — **NOT COVERED**
POSTs to the `/l2svc/*` account/auth API on 260616:

| Endpoint | POSTs | Distinct IPs | Status breakdown | Read |
|---|---|---|---|---|
| `/l2svc/token` | 100 | 73 | 200×66, **400×34** | OAuth token endpoint hammered from 73 sources; 34% failures = credential/grant guessing |
| `/l2svc/api/account/register` | 39 | 18 | **409×22**, 200×17 | 409 conflict = **username enumeration**; 17 fake account creations |
| `/l2svc/api/account/profile` | 33 | 12 | 401×18, 400×15 | unauthorized profile access attempts |
| `/l2svc/api/account/forgotpassword` | 27 | 11 | **404×15**, 200×12 | 404 = **user-existence enumeration** via reset flow |
| `/l2svc/api/account/resetpassword` | 27 | 10 | 400×21, 401×6 | reset-token abuse/guessing |

- **226 account-API POSTs from 83 distinct IPs** (~2.7 req/IP) — a deliberate **slow-and-low, highly distributed** pattern engineered to stay under any per-IP rate limit.
- **~50% (112 reqs / 21 IPs) originate from Tor exit nodes / anonymizers**: the `185.220.100.0/22` and `185.220.101.0/24` Tor blocks, `171.25.193.78` (DFRI Tor), `109.71.252.97`, `104.223.84.84`, plus OVH/`45.84.107.x`. The *same* Tor IPs appear across register + forgotpassword + resetpassword doing ~3 each — one coordinated actor fanned out over Tor.
- **Why current/planned WAF misses it:** the attack targets `/l2svc/*`, **not `/planning/*`**, so the Estimator Challenge never fires. Per-IP rate limits (500 site / 300 planning per 5 min) are untouched at 2-3 req/IP. AmazonIpReputation covers *some* anonymizers but not the full Tor list. There is **no auth-specific rule and no Tor handling**. This is the clearest gap.

#### Raw evidence (260616) — the registration burst is a headless browser running our own JS

`/l2svc` is served via IIS **ARR reverse-proxy** to the logon server (query field = `X-ARR-*`; `SERVER-STATUS=` is the upstream reply). One Tor exit, `185.220.101.5`, 01:44:54 → 01:45:08 (**14 seconds**):

```
01:44:54  GET  /l2svc/api/Organizations    200   ← populate the registration org dropdown (GetOrgs)
01:44:58  POST /l2svc/api/Account/Register  200   ← account CREATED (writes a user + fires an SES email)
01:44:58  POST /l2svc/Token                 200   ← auto-login (the DoRegister→DoLogon chain in efw.logon.3.0.js)
01:45:00  GET  /l2svc/api/Role              200   ← post-login role fetch
01:45:02  POST /l2svc/api/Account/Register  409   ← retry, now "taken"
01:45:08  POST /l2svc/api/Account/Register  409   ← retry
23:33:00  POST /l2svc/Token                 400   ← returns 22h later for a credential-stuffing pass
```

**This is the key finding:** the bot executed the *exact* `efw.bundle` registration sequence — fetched `Organizations` to fill the form, registered, followed the auto-login into `/Token`, fetched `Role`. That is **not `curl`; it is a headless browser running our real JavaScript.** Empirical proof that a **silent Challenge would not stop it** (the client has a working JS engine and would solve the proof-of-work) — which is why the right control here is **CAPTCHA** (humanness), not Challenge.

The fleet, same toolkit fanned across Tor + every state site (each IP → one state, identical `200→409→409` cadence ~4–6s apart):
```
185.220.101.5   ga   ·  185.220.101.13  ky  ·  185.220.100.241 mo  ·  109.71.252.97 nc
64.190.76.14    nj   ·  45.84.107.33/.97 nj ·  185.220.100.243 oh  ·  51.38.225.46  ak  ·  147.90.234.213 oh
```

**Attack-vs-legit fingerprint** (the actionable tuning signal):

| Signal | Attack fleet | Real user |
|---|---|---|
| **User-Agent** | `Chrome/142` Mac — **frozen/stale**, identical across all nodes | `Chrome/149` Win/iPhone/Android — current, varied |
| **Referer** | bare site root `https://<state>.db101.org/` | in-flow: `/my.htm`, `/planning/(S(…))/query.aspx` |
| **Source** | Tor `185.220.100/101.x`, OVH `51.38/45.84.x`, datacenter | residential (`68.107.x`, `68.114.x`, `69.71.x`) |
| **Cadence** | 3 POSTs / ~10s, `200→409→409` | single `200` |
| **Spread** | 1 IP → 1 state, blanket across all states | one site |

Of 39 `Register` POSTs on 260616, **34 carry the frozen `Chrome/142`** (hostile), **5 carry current `Chrome/149`** (genuine, residential, in-flow Referer). `/Token` day total: **66× 200, 34× 400** (34% auth failures = credential/grant guessing).

**Per-call cost is real:** each `Register 200` writes a DB user **and sends an SES confirmation email** (~350–650ms = the SES send). The day's fake registrations = account-table pollution + SES-reputation exposure (the recipient is attacker-chosen, so this is also a potential email-relay/abuse vector).

> **Payload visibility — NONE.** IIS W3C logs here record stem+query only: **no request bodies, no cookies, no `cs-host`.** The registered emails / guessed credentials in these POSTs are not in this dataset. Recoverable only from the **logon DB** (created-account usernames persist), the **SES send log** (recipients), the **logon server trace/ELMAH**, or a **deliberate body-capture** (WAF behind CloudFront inspects body for rules but does **not** log it by default).

### #2 — Vulnerability/recon scanner `66.175.211.202` (Linode) — **PARTIALLY covered**
Persistent (260613:162, 260615:1,006, 260616:1,008). Spoofed iPhone/`CriOS` UA + blank UA. Probes enterprise gear across mo/mi/nj/il: `/owa/` (Exchange), `/webui`, `/confluence/rest/applinks/...` (Atlassian), **`/dana-na/nc/nc_gina_ver.txt` (Pulse Secure VPN exploit path)**, Citrix-style paths. 573× 302, 413× 404 — nothing found, but this is active CVE recon. KnownBadInputs would catch *some* of these CVE payloads; the bare path probes (`/owa/`, `/webui`) would not.

### #3 — Secret-file / credential scanning (`.env`, `.aws/credentials`, `.git/config`) — **COVERED (SensitivePaths)**
1,094 hits on 260616 (up from 441). Heavy enumeration of `.env` variants (`/api/.env`, `/app/.env`, `/.env.production`, `/backend/.env`, `/.env.bak`…), `/.aws/credentials`, `/.git/config`. All returned 404 (nothing exposed). Top sources are datacenter: `15.206.92.228` (AWS Mumbai, 257× 404), `88.151.34.35` (260×), `40.124.169.176` (Azure, 210×), `192.210.193.216/219`, `45.33.100.49` (Linode), `207.241.173.38`, `143.20.97.245`. **The WAF `SensitivePaths` regex `(/\.git|/\.svn|/\.hg|/\.env|/\.aws|/\.ssh|/\.vs/|/_vti)|…` is a substring match and DOES catch every variant observed** (`/api/.env` contains `/.env`, etc.).

### #4 — UA-rotating distributed scanner block `88.151.32-34.x` — **NOT specifically covered**
685 reqs from **10 IPs** in the `88.151.3x` range, each cycling **14-22 distinct User-Agent strings** — classic evasion fingerprinting. Mix of `.env` fishing and generic probing.

### #5 — WordPress / PHP backdoor & file-upload probing — **MOSTLY covered**
~450 genuine wp/php probes (separate from ~671 *legit* Google/Chrome `.well-known/assetlinks.json` + `traffic-advice` fetches, which are NOT attacks). Examples: `/wp-login.php`, `/xmlrpc.php`, `/wp-content/plugins/hellopress/...`, `/wordpress/wp-admin/maint/`, `/cgi-bin/authlogin.cgi`, `aa.php`, `core/init.php`. Top source `132.196.99.64` (Azure, **blank UA**, 666 reqs to ky + www, 333× 404). Blank-UA probers are caught by CommonRuleSet **NoUserAgent_HEADER**; `/wp-admin` etc. would be counted by AdminProtection. Site is .NET so all 404 anyway.
- **File-upload probe:** `47.239.182.144` (Alibaba, no PTR) hit `uploadify.ashx` 70× POST → 302 and 70× GET → 404 on ca.db101.org — a deliberate **arbitrary-file-upload / webshell probe** against the legacy Uploadify handler. Not succeeding (302/404), but no rule specifically blocks it.

### #6 — Empty-User-Agent datacenter flood — **COVERED (NoUserAgent)**
4,298 blank-UA requests on 260616, dominated by Azure (`20.x`, `40.85.218.222`, `52.238.213.109`) and `132.196.99.64`. CommonRuleSet `NoUserAgent_HEADER` would block these outright.

### #7 — `35.156.240.123` (AWS eu-central) — content scraper of the MN hub auth surface
1,861 reqs, all to mn, `"SiteCheck"`-style UA, repeatedly fetching `/_hub3/logon.htm`, `/_hub3/my.htm`, `/_hub3/my-sessions.htm`, `hub-vault.bundle.js`. Datacenter origin scraping the Disability Hub MN logon/vault pages. Worth a ScannerIpSet entry.

### Methods & misc
GET 149,403 · POST 1,914 · HEAD 442 · **DELETE 12 · OPTIONS 10 · PUT 6 · PATCH 5**. The PUT/PATCH/DELETE are almost entirely `77.81.234.34` method-probing a single static `.htm` (WebDAV check). Negligible but noted.

### NOT a threat — flagged to prevent a false alarm
- **`52.8.7.0` is our own internal pdfshot / PDF-render service.** It is the #1 IP (7,633 reqs/day, escalating 291→491→6,040→7,633) and the source of essentially all 7,447 "HeadlessChrome" hits, but: PTR = `ec2-52-8-7-0.us-west-1.compute.amazonaws.com` (**our region**); UA = `HeadlessChrome/80.0.3987.0` + a `.NET MS Web Services Client` UA; it loads every page asset uniformly (269× each SVG), follows session-scoped `/planning/(S(...))/` URLs, and POSTs to the SOAP `pdfreport/pdfreportservice.asmx`. This is a server-side renderer generating PDF reports, not an attacker. **See the operational risk in §4.**
- **Googlebot traffic is genuine** — `66.249.79.x` forward-confirms to `*.googlebot.com`. No Googlebot spoofing detected.

### SQL injection
**Zero** SQLi detected in query strings or paths on 260616 (textbook markers: `union select`, `information_schema`, `sleep(`, `' or 1=1`, `%27 or`, `xp_cmdshell`, etc.). **Caveat:** POST bodies aren't logged, so body-borne SQLi (e.g., on `/planning/query.aspx`, `/l2svc/*`) is invisible to this dataset. Observed GET SQLi is negligible, but that does not clear the WAF gap (see §3).

---

## 3. Coverage analysis — what the WAF *would* catch vs *miss*

> Reminder: **web-06's public sites are still served direct, not behind CloudFront**, so *none* of these rules protect them today. This maps observed traffic against the edge WAF in `cloudformation/edge.yaml` as it *would* apply post-cutover.

**Note on the SQLi gap:** the task brief flagged "no SQLi rule group." As of **2026-06-17, `edge.yaml` now includes it** — Priority 6 `AWS-SQLi` (`AWSManagedRulesSQLiRuleSet`), with a comment citing today's preview2-il test (7/7 SQLi probes matched nothing without it). **Action: confirm this is deployed to the live ACL, not just in IaC.**

| Observed activity (260616) | WAF rule that would catch it | Verdict |
|---|---|---|
| `.env`/`.aws`/`.git` fishing — 1,094 | SensitivePaths (P2, substring regex) | ✅ Caught |
| Empty-UA flood — 4,298 | CommonRuleSet `NoUserAgent_HEADER` (P4) | ✅ Caught |
| WordPress/PHP probes — ~450 | NoUserAgent (blank-UA ones) + AdminProtection (P8, **Count-only**) | 🟡 Mostly; admin rule not blocking yet |
| Vuln-scanner CVE payloads (Confluence/Pulse) — `66.175.211.202` | KnownBadInputs (P5) for known CVE sigs | 🟡 Partial — bare path probes pass |
| Query-string XSS/LFI/RFI/SSRF | CommonRuleSet (P4) | ✅ (none observed today) |
| SQLi (incl. POST body) | AWS-SQLi (P6) — **newly added** | ✅ *once deployed*; was the gap |
| `/planning/*` non-browser bots | Challenge-Estimator (P9) | ✅ for non-JS clients |
| `uploadify.ashx` upload probe — `47.239.182.144` | none by name (CommonRuleSet only if payload matches) | ❌ Miss |
| **Tor account-API credential-stuffing/enumeration — 226 POSTs/83 IPs** | **none** (not `/planning`, under rate limits, Tor partly evades IpReputation) | ❌ **Miss — top gap** |
| App-layer enumeration via 409/404 responses on register/forgotpassword | none (response-based, WAF can't see) | ❌ Miss (app-layer) |
| Distributed UA-rotating block `88.151.3x` | IpReputation *maybe* | 🟡 Weak |

**Rate limits caught nothing today.** Max `/planning` burst from any single IP was ~75 / 5 min (limit 300); the site-wide limit (500/5 min) was exceeded only by **our own pdfshot** (peak **1,012/5 min**). Consistent with the prior 260608 finding: real `/planning` volume is human/NAT-paced — the **Challenge**, not rate-limiting, is the effective estimator control, and the credential-stuffing deliberately stays far under both limits.

---

## 4. Recommendations (prioritized)

**P0 — Pre-cutover blockers (do before web-06 goes behind CloudFront):**
1. **Allowlist the pdfshot renderer before enabling Challenge/rate-limits.** `52.8.7.0` (our PDF service) would otherwise be (a) **Challenged on every `/planning/` render** (it's headless, can't solve proof-of-work reliably) and (b) **blocked by the 500/5-min site rate limit** (it peaks at 1,012/5 min). Add its egress /32 to `IP-Allowlist-Override` (P0) or exclude internal origins. Verify the exact current egress IP(s) — this address may rotate.
2. **Confirm `AWS-SQLi` (P6) is live**, not just in `edge.yaml`. Closes the documented SQLi gap.

**P1 — Close the account-API gap (the top miss):**
3. **Add WAF protection for `/l2svc/api/account/*`, `/l2svc/token`, and login/logon POSTs**, since the Challenge (scoped to `/planning/*`) does not cover them:
   - A **Challenge or CAPTCHA on the account/auth endpoints** is the strongest move — it breaks scripted Tor clients without burdening real browser logins.
   - Add a **tight rate-based rule keyed to these paths** (e.g. ≤ ~20 / 5 min / IP). Won't stop the distributed Tor fan-out alone, but raises the floor.
   - Because ~50% of the abuse is Tor: **add an anonymizer/Tor block** — either enable `AWSManagedRulesAnonymousIpList` (managed group; covers Tor/VPN/hosting) scoped to auth+POST, or seed an IP set from the public Tor exit list. Recommend Anonymous-IP list in **Count** first, scoped to `/l2svc/*`, then promote.
4. **App-layer (out of WAF scope but worth a ticket):** make `register`/`forgotpassword` responses non-enumerable (uniform response whether or not the account exists) and add lockout/backoff on `/l2svc/token`.

**P2 — Seed `ScannerIpSet` (P1 blocklist; all datacenter, low residential collateral):**
   - `66.175.211.202` (Linode — OWA/Confluence/Pulse VPN recon)
   - `47.239.182.144` (Alibaba — uploadify upload probe)
   - `88.151.32.0/22`-region block (`88.151.32-34.x` — UA-rotating scanner, 10 IPs)
   - `132.196.99.64`, `40.124.169.176` (Azure — wp/php + `.env`)
   - `15.206.92.228` (AWS Mumbai), `45.33.100.49` (Linode), `192.210.193.216/219`, `207.241.173.38`, `143.20.97.245` (`.env`/`.git` scanners)
   - `35.156.240.123` (AWS eu — MN hub scraper)
   *(SensitivePaths already blocks the `.env` set; these entries add value for the bare-path/recon traffic those scanners also send.)*

**P3 — Tuning / visibility:**
5. **Promote `AWS-AdminProtection` (P8) from Count→Block** after a false-positive review — the wp-admin/phpmyadmin probes would be caught.
6. **Stand up Athena over the WAF logs** (`s3://aws-waf-logs-efw-874922373146`, live since 2026-06-16) so Challenge/Count outcomes are queryable — currently a diagnosability blind spot (per prior review). 
7. Re-run this harvest **after web-06 is behind CloudFront** to measure real Challenge solve-rates and confirm the account-API rule catches the Tor campaign.

---

## Appendix A — Methodology & queries

- **Access:** local AWS CLI (account `874922373146`). SSM `send-command` to web-06 is unavailable here (auto-denied), so the planned server→S3 push could not be triggered; instead the existing **nightly IIS backup** at `s3://efw.backup/iis-logs/` was used (it already serves the intended purpose). Newest snapshot = 260616.
- **Retrieval:** `aws s3 cp s3://efw.backup/iis-logs/<day>/ <tempdir>/<day>/ --recursive` for 260613-260616 into a temp dir outside the repo (raw logs kept out of git; ~200 MB total).
- **W3SVC→site mapping:** derived empirically by tallying `cs(Referer)` netlocs per `W3SVC<id>` (no `cs-host` field exists). Cross-checked against the committed `data/iis-logs-260608/` set (identical W3SVC ids).
- **Analysis:** Python (`python -c`) streaming each W3C log once per pass, splitting on space (IIS `+`-encodes spaces in UA/Referer/query, so field splitting is safe), URL-decoding `cs-uri-stem`+`cs-uri-query` for injection matching.
- **Signal definitions:**
  - *SQLi/XSS/LFI/Log4j/SSRF:* substring match on the URL-decoded, lowercased stem+query against curated marker lists (`union select`, `information_schema`, `sleep(`, `' or `, `%27`, `<script`, `../`, `${jndi:`, `169.254.169.254`, …).
  - *Sensitive paths:* the live WAF regex tokens (`/.git`, `/.env`, `/.aws`, …).
  - *Scanner UAs:* `curl`, `python-requests`, `go-http`, `sqlmap`, `nikto`, `scrapy`, `httpx`, `headlesschrome`, blank, etc.
  - *Rate:* per-IP counts bucketed into 5-minute slots (`HH` + `floor(MM/5)`), compared to the 500-site / 300-planning per-5-min limits.
  - *Account abuse:* POSTs to `/l2svc/api/account/*` and `/l2svc/token`, with status breakdown (409/404/401/400 → enumeration/auth-fail signals) and Tor/anon source-range tagging.
  - *Source attribution:* PowerShell `Resolve-DnsName -Type PTR` reverse-DNS spot checks on the top IPs (AWS/Linode/Alibaba/Google confirmed; Googlebot forward-confirmed).
- **WAF rule reference:** `cloudformation/edge.yaml` (rule priorities 0-12) and `base.yaml` (IP sets).

## Appendix B — Key indicators (for ScannerIpSet / watchlist)
```
# Tor / anon account-API abuse (Challenge or Anonymous-IP-list these on /l2svc/*)
185.220.100.0/22  185.220.101.0/24  171.25.193.78  109.71.252.97  104.223.84.84  45.84.107.0/24
# Recon / scanners (ScannerIpSet candidates — datacenter)
66.175.211.202   47.239.182.144   132.196.99.64   40.124.169.176   15.206.92.228
45.33.100.49     192.210.193.216  192.210.193.219 207.241.173.38   143.20.97.245
88.151.32.0/22   35.156.240.123
# Internal — ALLOWLIST, do not block
52.8.7.0  (pdfshot / PDF renderer, ec2 us-west-1)
```
