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

## Capture & decision
- Per Track-A row: confirm the expected rule COUNTed (sampled-requests/log). A rule that does NOT fire when it should = a **gap** to fix.
- Per Track-B row: confirm **zero** SensitivePaths/SQLi/XSS/size COUNT on legit traffic, and rate stays under limits. Any COUNT on legit traffic = a **false positive** → add `RuleActionOverride→Count` / scope-down / label-exclusion before Block.
- **Deliverable:** per-rule table {fires correctly? | any FP?} → the go/no-go + the exact `edge.yaml` overrides to apply before `Count→Block`.

## Who runs what
- **Automatable now (Claude):** A1–A10 (curl probes + rate bursts, marked), B2–B5 (free-text query/body probes), B7–B9 (synthetic bursts/UAs). Read results from sampled-requests + logs.
- **Browser (owner):** B1, B6 — the real estimator walk + fast-session feel (genuine ViewState/AutosaveSession cadence, PDF). Claude correlates the WAF logs for the owner's session afterward.
