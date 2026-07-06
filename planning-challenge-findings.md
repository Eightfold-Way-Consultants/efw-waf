# WAF Challenge on `/planning/*` breaks background XHR (SavedSessions) — findings

**Date:** 2026-07-06
**Author:** investigation via Claude Code (jack.eastman)
**WebACL:** `efw-preview2-web-acl` (WAFv2, scope CLOUDFRONT, us-east-1, id `4b66117a-5e82-4a33-819f-983f03708748`)
**Distribution:** `E1ZUT1S4LS09PI` (aliases `preview2-*.db101.org`, origin `s4.eightfoldway.com` = web-04 = 52.8.85.37)

---

## TL;DR

The estimator "Saved Sessions" widget silently shows **no data right after an app-pool recycle / fresh session**, then works once you start an estimator. Root cause is **not** the app, the JWT, or IIS warmup — it is the **AWS WAF `Challenge` action on `/planning/*`**.

- Rule **`Challenge-Estimator`** (priority 9) applies action **`Challenge`** to any request whose `UriPath` STARTS_WITH `/planning/`.
- AWS WAF `Challenge` returns **HTTP 202** + a JS interstitial and expects the client to acquire an `aws-waf-token` cookie by running the JS, then retry.
- A **background XHR/fetch cannot run the interstitial**, so `/planning/SavedSessions` (an AJAX call) just receives **202 + empty body** and fails silently.
- A **full-page navigation** to a `/planning/*.aspx` page *does* solve the challenge and sets `aws-waf-token`; afterward the XHR carries the cookie and returns 200. That is the "start an estimator, come back, it works" self-heal. The IIS-recycle correlation is incidental — the real trigger is a **missing/expired `aws-waf-token`** (challenge token immunity time is limited).

**Ask:** poke a narrow hole in `Challenge-Estimator` so it still challenges `/planning/*` **except** the auth-gated XHR endpoint `/planning/SavedSessions` (and optionally other AJAX/JSON handlers). Proposed scope-down JSON below.

---

## Evidence

### Origin never emits 202; CloudFront does
Same URL, same (uncookied) client:

| Path | Status | Server | Body | Marker |
|---|---|---|---|---|
| via CloudFront (`preview2-ak.db101.org`) | **202** | CloudFront | empty | `X-Cache: Error from cloudfront` |
| direct to origin (`--resolve` → 52.8.85.37, `Host: preview2-ak`) | **200** | Microsoft-IIS/10.0 | `[]` | — |

Origin returns 200 `[]` (unauthenticated → empty list, expected). The 202 is injected at the edge. `CustomErrorResponses` on the distribution = 0, no Lambda@Edge / CloudFront Functions — the 202 is the **WAF Challenge** response.

### Playwright repro (real Chromium)
| Step | Result |
|---|---|
| `GET /` (site root, not under `/planning/`) | 200, `aws-waf-token` = none |
| in-page `fetch('/planning/SavedSessions')` — no token | **202, empty** ← the bug |
| top-level nav `GET /planning/b2w2_index.aspx` | 202 interstitial → **seeds `aws-waf-token`** |
| in-page `fetch('/planning/SavedSessions')` — with token | **200, `[]`** ← fixed |

(The `[]` in the last step is just because Playwright wasn't logged in; the 202→200 flip is the point.)

### The rule
```
[9] Challenge-Estimator   action = Challenge
    ByteMatch: UriPath STARTS_WITH  "L3BsYW5uaW5nLw==" (base64) = "/planning/"
[10] RateLimit-Estimator  action = Block   Rate 1000 / 300s / IP,  scope-down UriPath STARTS_WITH "/planning/"
```
DefaultAction = Allow. Other rules: IP allow/block lists, `SensitivePaths` (regex Block), AWS managed groups (IpReputation, CommonRuleSet, KnownBadInputs, SQLi, Windows, AdminProtection).

---

## Affected endpoint inventory (everything under `/planning/` is challenged)

### Custom handlers registered in site `Web.config` (`<handlers>`)
| Endpoint | Handler type | States | Verb(s) | Status |
|---|---|---|---|---|
| `/planning/SavedSessions` | `bp101.session.ui.SavedSessionHandler` | **all 26** | GET (list), DELETE (remove), OPTIONS preflight (`verb="*"`) | **LIVE — the real victim.** XHR from the Vault "Recent Sessions" widget (`savedsessionarea`/`sslist`). GET, DELETE and CORS preflight all challenged. |
| `/planning/tw` | `bp101.session.ui.TeamworkAPIProxyHandler` | ca-es only | `*` | **DEAD.** Type does not exist in source (type-load 500 if hit). Live Teamwork proxy is `efw.twproxy` at site-root `/tw` vdir (outside `/planning/`, so not challenged). **Removed** in bp101-sites r9024. |
| `*.ashx` (SimpleHandlerFactory) | `System.Web.UI.SimpleHandlerFactory` | mn only | GET,HEAD,POST,… | Registration only; see `.ashx` files below. |

### `.ashx` WebHandlers physically present under `/planning/`
| File | Class | States (count) | Shape | WAF impact |
|---|---|---|---|---|
| `FlowNode.ashx` | `bp101.session.FlowNodeHandler` | ak, az, ca, co, il, il-es, ky, master, mi, mn, mo, nj, nj-es, oh, vets101 (**15**) | returns `text/xml`; feeds the flow-diagram viz (`flow.htm`) | XHR GET → would 202 if called without a token. Dev/documentation tool — low stakes. |
| `BP101Banner.ashx` | `BP101Banner` (inline) | ca, ca-es, mi (**3**) | returns `image/gif`; picks a banner by referrer/life/state | `<img src>` GET → an image request can't solve the JS challenge either. In practice the img loads inside a `/planning/` page that has already solved the challenge, so usually OK. Low stakes. |
| `UserData.ashx` | `bp101.session.UserDataHandler` | mn only (**1**) | **cross-origin POST** (`Access-Control-Allow-Origin: *`); accepts `{lifeSituation, userdata}`, stashes it, returns a `/planning/sessions.aspx` restore URL | Would be an **unfixable** victim (cross-origin caller has no `aws-waf-token` and can't do a same-site solve; preflight OPTIONS also challenged). **BUT no caller found** anywhere — not in bp101-sites, bp101-interface, or the Vault tree (`c:\svn\vault`, trunk + branches). Committed 2015–2016, untouched since. Treat as **orphaned/legacy**; verify zero prod hits, then retire. |

Not affected: `PDFReportService.asmx` lives at `/pdfreport/`, and the real Teamwork proxy at `/tw` — both outside `/planning/`, so `Challenge-Estimator` does not touch them.

### Who calls SavedSessions
The DB101 site frontend is built from the **Vault** tree (`c:\svn\vault`). Its "Recent Sessions" personal module (`personalModule savedsessionarea` / `ul.sslist`) AJAX-calls `/planning/SavedSessions`, and it launches estimators via full-page `/planning/sessions.aspx?screen=session_list&token=…` links. So: Vault renders the widget → its background `SavedSessions` fetch is WAF-202'd until a Vault estimator link (top-level `/planning/` nav) solves the challenge and seeds the token.

---

## Proposed fix — narrow scope-down on `Challenge-Estimator`

Keep `Challenge` on all of `/planning/*` **except** `/planning/SavedSessions`. That endpoint is auth-gated (JWT) and still covered by `RateLimit-Estimator` (1000/300s/IP), so the security loss is minimal, and it repairs the GET/DELETE/OPTIONS-preflight XHR that cannot solve the JS challenge.

Replace the rule's `Statement` (currently a single `ByteMatchStatement`) with an `AndStatement` of the original match AND a `NotStatement` exempting the endpoint:

```json
{
  "AndStatement": {
    "Statements": [
      {
        "ByteMatchStatement": {
          "SearchString": "/planning/",
          "FieldToMatch": { "UriPath": {} },
          "TextTransformations": [ { "Priority": 0, "Type": "NONE" } ],
          "PositionalConstraint": "STARTS_WITH"
        }
      },
      {
        "NotStatement": {
          "Statement": {
            "ByteMatchStatement": {
              "SearchString": "/planning/savedsessions",
              "FieldToMatch": { "UriPath": {} },
              "TextTransformations": [ { "Priority": 0, "Type": "LOWERCASE" } ],
              "PositionalConstraint": "STARTS_WITH"
            }
          }
        }
      }
    ]
  }
}
```
(`SearchString` values are base64-encoded when sent through the WAFv2 API/CLI. `LOWERCASE` transform makes the exemption case-insensitive; `UriPath` excludes the query string, so the `?max=&_=` cache-buster is irrelevant.)

**Optional wider hole** — if `FlowNode.ashx` (flow viz) is expected to work via XHR, add it to the `NotStatement` (e.g. an `OrStatement` of the exempt paths). `UserData.ashx` should **not** get a hole — retire it instead. `BP101Banner.ashx` needs no hole (loads inside already-solved pages).

**Alternative (keeps bot protection on the endpoint):** front the site with the AWS WAF application-integration JS SDK so the browser proactively acquires `aws-waf-token` before firing `/planning/` AJAX (including from the root pages that host the widget). More work, no path exemptions. Does **not** help cross-origin callers.

---

## Side cleanups already done
- **bp101-sites r9024** — removed the dead `/planning/tw` handler line from `planning-ca-es/Web.config`.

## Suggested follow-ups (not done)
- **`/planning/UserData.ashx` confirmed dead** — web-06 `mn.db101.org` (site id 28) IIS logs, 565 files spanning 2024-12-20 → 2026-07-06 (~18.5 months): **0 hits**. Combined with zero callers in bp101-sites/bp101-interface/vault, it is safe to remove the file + its `planning-mn.csproj` `Content Include`. (Edit-site web-04 has request logging disabled, but a cross-origin integration would hit the public site, which shows nothing.)
- `SavedSessionHandler` returns `"[]"` (200) identically for "not logged in" and "zero sessions" — consider returning 401 on `!IsLoggedIn()` so a cold/expired-auth state is distinguishable from an empty list (separate from the WAF issue).
