# preview2-il WAF Count-mode validation plan (2026-06-17)

Goal: before flipping `WafRuleAction=Count→Block`, prove on the live `preview2-il` canary that (A) every rule **fires on the attacks it should** (visible COUNT), and (B) **realistic human/estimator traffic does NOT trip any rule** (false-positive hunt). Count mode = rules log COUNT but don't block, so all test traffic reaches origin and we read decisions back from telemetry.

## Method / harness
- **Tag synthetic traffic** so it's separable from real traffic: custom UA `EFW-WAFTEST-20260617` and/or `?waftest=<token>` on each probe.
- **Run from a known IP** (record it) so rate-based keying is predictable.
- **Observe (3 ways, increasing latency):**
  1. `aws wafv2 get-sampled-requests --scope CLOUDFRONT --web-acl-arn <preview2 acl> --rule-metric-name <RuleMetricName> --time-window ... --max-items 100` — near-real-time per-rule samples. Best for "did rule X see request Y."
  2. WAF S3 logs (`AWSLogs/.../WAFLogs/cloudfront/efw-preview2-web-acl/…`) — grep the marker; ~5 min lag; full `nonTerminatingMatchingRules`/`ruleGroupList` detail.
  3. CloudWatch `CountedRequests` per rule (`AWS/WAFV2`, dims WebACL+Rule+Region) — aggregate trend.
- **Caution:** rate-limit tests send 500+ reqs that (Count mode) all hit origin — a deliberate mini-load-test; fine on low-traffic preview2-il, run last and time-boxed.

## Safety / blacklist-avoidance (verified 2026-06-17)
No automatic persistent-blacklist vector — safe to send attack probes from our own IP:
- **WAF Count mode** can't block; rate-based rules are transient (5-min window, auto-forgotten); WAF never self-persists a blocklist.
- **`AmazonIpReputationList`** is AWS-managed threat intel, not fed by matches on our own distribution; modest volume is safe.
- **IIS Dynamic IP Restrictions on web-04**: `Web-IP-Security` not installed, deny-by-rate/concurrency disabled → origin won't auto-ban the rate burst.
- **`ScannerIpSet`**: empty, and **OpenClaw is report-only** (nightly /planning bot-scan → human-reviewed recommendations; does NOT write the IP set).
- **Do NOT use the priority-0 `AllowIpSet`** to shield the test — a terminating Allow skips the rules we want to COUNT.
- **Footprint:** OpenClaw scans *public* (web-06) logs; `preview2-il` is a *preview* site on web-04, so these tests likely won't even appear in its report. (Tag traffic `EFW-WAFTEST-20260617` regardless, for WAF/IIS log attribution.)
- **Post-test:** re-check `ScannerIpSet` is still empty before any Count→Block flip.

## Public-phase add-on — OpenClaw cross-check (do when testing a PUBLIC canary)
Because OpenClaw only sees public logs, run a tagged repeat of the bot/attack probes against a **public** canary, then read OpenClaw's next nightly /planning report. Two wins: (1) **validate OpenClaw's detector** — does it flag our synthetic bot-walking? (2) confirm our test traffic is recognized (tagged) so a reviewer doesn't manually action our IP into `ScannerIpSet`. Compare OpenClaw's verdict against what the WAF actually COUNTed for the same traffic.

## RESULTS — non-rate battery (2026-06-17, preview2-il, Count mode)
Verified via near-real-time `get-sampled-requests` + authoritative raw WAF S3 logs (parsed by args, since query-string probes share path `/`).
- **Count mode confirmed non-blocking:** every probe returned an *origin* code (404/403/405/200), zero WAF 403-blocks.
- **Track A — all rules fired (COUNT) except one:** SensitivePaths 6/6 (`.git`/`.env`/`.bak`/`.sql`/`elmah.axd`/`trace.axd`); CommonRuleSet matched XSS, GenericLFI, NoUserAgent, SizeRestrictions_BODY, RestrictedExtensions(`.bak`); KnownBadInputs matched Log4JRCE + ExploitablePaths(`.env`); Challenge-Estimator matched `/planning/`. Negative controls correct: `/ScriptResource.axd` and `/my.htm` matched nothing.
- **⚠️ FINDING — SQLi gap:** the canonical tautology `q=1' OR '1'='1` matched **no rule**. AWS CommonRuleSet `SQLi_QUERYARGUMENTS` runs at LOW sensitivity and misses tautologies. Sent 7 SQLi variants (tautology/comment/admin/UNION/DROP/SLEEP/xp_cmdshell) to characterize coverage (breakdown pending log flush). **Recommendation:** if SQLi coverage matters, add the dedicated `AWSManagedRulesSQLiRuleSet` (HIGH-sensitivity SQL DB rule group) to the ACL; app is .NET/parameterized so app-layer risk is lower, but the WAF gap is real. Decide before Count→Block.
- **Track B — ZERO false positives:** legit free-text that *looks* malicious all passed clean — `O'Brien` (apostrophe), `earnings < $2000 & rent > $800` (`<`/`>`/`&`), `select a plan or drop coverage union` (SQL words), unicode/es, Googlebot/Bingbot crawling content, `robots.txt`, checker UA. No managed-rule COUNT on any.
- **Tooling note:** `get-sampled-requests` is near-real-time but partial (sampled subset); the raw S3 logs are complete but lag ~5 min — use logs for definitive FP/coverage calls, parse with gzip+ConvertFrom-Json keyed on `httpRequest.args`.
- **Still pending:** A9/A10 rate-limit bursts (held for explicit go); B1/B6 browser estimator + fast-session (owner); SQLi-variant breakdown (poller).

## Track A12 — estimator-walk bot simulation (THE PRIMARY THREAT — not yet run)
The whole reason for `Challenge-Estimator` + the `/planning` rate limit. A scraper walking the estimator burns origin **and** the ECO engine (each step = no-cache dynamic compute over the VPC peering). My earlier tests only did ONE validation walk + one `/planning` GET — they did NOT establish a session and hammer/crawl it. To run:
- **A12a single-session crawl:** GET `b2w2_il_index.aspx` → capture the cookieless session `(S(...))` + cookies → walk the wizard (GET/POST successive screens within that session to results). Measure: requests-per-full-walk, that **every** `/planning/*` hit is `Challenge-Estimator` COUNT, and how close one walk gets to the limits.
- **A12b hammer / replay:** repeat entry+walk N times rapidly from one IP → drive `RateLimit-Estimator` (300/IP/5min on /planning) and `RateLimit` (500/IP/5min). Confirm those rules COUNT on the overage. **Bound N + time-box — this runs real ECO engine compute per step; hold the heavy run for explicit go (like A9/A10).**
- **A12c distributed-evasion (note):** a low-per-IP distributed fleet *evades* the rate limits but the **Challenge** stops it (can't solve proof-of-work) — the Challenge's whole raison d'être; hard to simulate without many source IPs.
- **Count-mode caveat:** Challenge is a no-op in Count, so a curl/headless bot CAN walk now → use that to MEASURE footprint. The **Block flip** is what actually stops it (bot Challenged at entry → no session); verify the STOP in a supervised Block window on preview2-il.
- **Compare to legit (B6):** a real counselor's fast walk generates similar `/planning` volume — the Challenge distinguishes by browser-PoW, not request pattern. Measure requests-per-legit-walk to confirm a fast (or gov-NAT-shared) legit session doesn't trip the 300/500 limits.

## Post-deployment evaluation (after adding SQLi + Windows + AdminProtection, 2026-06-17)
Stack updated: `efw-waf-edge-preview2` now carries `AWS-SQLi`(pri6), `AWS-Windows`(pri7), `AWS-AdminProtection`(pri8, **pinned Count**), 1448 WCU, in-place Modify. Eval steps:
1. **SQLi fires — DONE ✓:** re-ran 7 variants → all match `AWS-SQLi#SQLi_QUERYARGUMENTS` (COUNT), incl. the previously-missed tautology. Gap closed.
2. **Windows fires — TODO:** send Windows cmd/PowerShell-injection probes (e.g. `?x=cmd.exe /c dir`, `?p=powershell -enc <b64>`, `& dir`) → expect `AWS-Windows` COUNT. Confirm via sampled-requests/logs.
3. **No NEW false positives — TODO:** re-run the Track B FP battery (B2–B5 free text incl. apostrophes/`<>&`/SQL-words/unicode, crawler UAs) and confirm **none** now match `AWS-SQLi`/`AWS-Windows`/`AWS-AdminProtection`. (Windows + SQLi groups can FP on legit content; verify.)
4. **AdminProtection Count review (the gate for promoting it) — TODO:** let it run in Count over real preview2-il traffic for a window (≥ a few days, or correlate with the threat-report harvest), then pull `AWS-AdminProtection` `CountedRequests` + sampled-requests. Inspect every match: is it a *legit* path that merely looks admin-ish (e.g. a counselor/admin-labeled but public URL), or a genuine admin-probe? 
   - **If zero / only genuine probes →** promote AdminProtection from pinned `Count` to the `IsBlock` toggle (`OverrideAction: !If [IsBlock,{None:{}},{Count:{}}]`) so it enforces with the others.
   - **If it flags legit paths →** keep it pinned `Count`, or add per-rule `RuleActionOverride`/scope-down exclusions for those paths, then re-review.
5. **Per-rule Count monitoring:** watch CloudWatch `CountedRequests` for AWS-SQLi / AWS-Windows / AWS-AdminProtection across the Count window for legit-traffic hits before any Block flip.
6. **Go/no-go update:** Count→Block requires — SQLi/Windows confirmed firing + no new FPs (steps 2–3); AdminProtection either promoted (passed review) or left pinned-Count; plus the original gates (rate tests, browser fast-session).

## Track A — deliberately trigger (each should COUNT; would Block when flipped)
| # | Rule (pri) | Probe | Expected match | Negative control |
|---|---|---|---|---|
| A1 | SensitivePaths (2) | GET `/.git/config`, `/.env`, `/x.bak`, `/x.sql`, `/elmah.axd`, `/trace.axd` | `SensitivePaths` COUNT (origin 404) | `/ScriptResource.axd`, `/WebResource.axd`, real `*.axd` must NOT match |
| A2 | CommonRuleSet SQLi (4) | `/?q=1%27%20OR%201=1`; POST body `UNION SELECT` | `SQLi_QUERYARGUMENTS` / `SQLi_BODY` | — |
| A3 | CommonRuleSet XSS (4) | `/?q=<script>alert(1)</script>` | `CrossSiteScripting_QUERYARGUMENTS` | — |
| A4 | CommonRuleSet LFI/traversal (4) | `/?file=../../../../etc/passwd` | `GenericLFI_QUERYARGUMENTS` | — |
| A5 | CommonRuleSet UA (4) | empty `User-Agent` | `NoUserAgent_HEADER` | normal UA must NOT match |
| A6 | CommonRuleSet size (4) | POST body >8KB | `SizeRestrictions_BODY` | **FP watch — see B** |
| A7 | KnownBadInputs (5) | `/?x=${jndi:ldap://x}`; `Host: localhost` | `Log4JRCE` / `Host_localhost` | — |
| A8 | Challenge-Estimator (6) | GET `/planning/anything` | `Challenge-Estimator` COUNT (confirmed 6-16) | `/my.htm`, `/` must NOT match (non-/planning) |
| A9 | RateLimit-Estimator (7) | >300 GET `/planning/*` from 1 IP <5min | `RateLimit-Estimator` COUNT on overage | — |
| A10 | RateLimit (8) | >500 GET any path from 1 IP <5min | `RateLimit` COUNT on overage | — |
| A11 | IpReputation (3) / Blocklist (1) | can't synthesize bad-rep IP | n/a | optionally add test IP to `ScannerIpSet`, confirm Block path, remove |

## Track B — legitimate behavior that must NOT trigger (false-positive hunt)
The high-value risks given this ruleset are **OWASP body/query rules on free text** and **rate limits on shared NATs / fast sessions**.
| # | Scenario | Risk rule | Notes |
|---|---|---|---|
| B1 | **Full estimator walk** (browser): start→household (several members)→income (several jobs)→scenarios→results→save→**PDF** | `SizeRestrictions_BODY`, `SQLi_BODY`, `XSS_BODY` on large `__VIEWSTATE`/`AutosaveSession` POSTs | published ViewState measured ~3KB, but large households/results screens unmeasured (CMS admin was 44KB) |
| B2 | Free text with apostrophes: name/address `O'Brien`, `D'Angelo` | SQLi (the `'`) | classic FP source |
| B3 | Free text with `< > &`: e.g. "earnings < $2000 & rent > $800"; comment form with HTML-ish text | XSS | |
| B4 | Free text containing SQL-ish words: "select a plan", "drop coverage", "union", "or" | SQLi | |
| B5 | Smart quotes / accented (es site) / unicode in inputs | SQLi/XSS body | run on `preview2-il` es flow too |
| B6 | **Fast counselor session**: speed-click 20+ screens + frequent `AutosaveSession` POSTs | RateLimit-Estimator (300), RateLimit (500) | measure requests-per-full-session; multiply by gov-NAT concurrency |
| B7 | **Shared-NAT burst**: mixed legit traffic from one IP approaching the measured 185/5min gov reality | rate limits | confirm legit office volume stays < 300/500 |
| B8 | Browser asset fan-out (HTTP/2/3 parallel CSS/JS/img) | RateLimit | counts toward 500 |
| B9 | public-url-checker UA (non-browser GET) on homepage/API | managed/bot | confirm not flagged (doesn't hit /planning) |
| B10 | **Search-crawler simulation we WANT to allow**: GET `/`, content pages, `/sitemap.xml`, `/robots.txt` with UA `Googlebot/2.1 (+http://www.google.com/bot.html)` and `Bingbot/2.0` | Challenge / managed / BotControl | Expect 200, **no Challenge, no COUNT** (content is not `/planning`-scoped) → crawlers index freely, SEO safe. Controls: (a) confirm `robots.txt` Disallows `/planning/` so compliant crawlers never reach the Challenge; (b) a *spoofed* Googlebot-UA hit to `/planning/` SHOULD Challenge-COUNT — correct, not an FP (we don't trust UA; no verified-bot allowlist by design). Note: UA-only test (no IP/rDNS verification exists). |

## Capture & decision
- Per Track-A row: confirm the expected rule COUNTed (sampled-requests/log). A rule that does NOT fire when it should = a **gap** to fix.
- Per Track-B row: confirm **zero** SensitivePaths/SQLi/XSS/size COUNT on legit traffic, and rate stays under limits. Any COUNT on legit traffic = a **false positive** → add `RuleActionOverride→Count` / scope-down / label-exclusion before Block.
- **Deliverable:** per-rule table {fires correctly? | any FP?} → the go/no-go + the exact `edge.yaml` overrides to apply before `Count→Block`.

## Who runs what
- **Automatable now (Claude):** A1–A10 (curl probes + rate bursts, marked), B2–B5 (free-text query/body probes), B7–B9 (synthetic bursts/UAs). Read results from sampled-requests + logs.
- **Browser (owner):** B1, B6 — the real estimator walk + fast-session feel (genuine ViewState/AutosaveSession cadence, PDF). Claude correlates the WAF logs for the owner's session afterward.
