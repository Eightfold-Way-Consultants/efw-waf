# Turnstile Integration Plan — auth endpoints + reCAPTCHA-v2 replacement

**Date:** 2026-06-17 · **Goal:** Cloudflare Turnstile everywhere — protect the logon account API (`/l2svc/*` register + forgot-password) against the Tor credential-stuffing / confirmation-email-bombing campaign, AND replace the existing reCAPTCHA v2 on the feedback form with the same provider. See `threat-report-2026-06-17.md` §1 and memory `l2svc-auth-protection`.

## Why Turnstile + app-level (settled)

- **App-level enforcement is forced**, not chosen: `logon.db101.org` is internet-facing and is a *production* path (the disabilityhubmn.org embed calls it cross-origin directly). An edge/WAF CAPTCHA only covers traffic through CloudFront → it would be bypassed by the direct host and the Hub. The only universal control lives **inside the logon server**.
- **Turnstile over reCAPTCHA:** invisible/managed (accessibility — disability-benefits audience), privacy-first (no Google ad-profiling on benefit applicants; EU victims already in the data), free, and a **separate JS namespace** (`window.turnstile`) so it never collides with the Hub's own `grecaptcha` v3 instance.
- The attacker **runs a real headless browser through our JS** (proven: it executed the full Organizations→Register→Token→Role chain), so a silent proof-of-work Challenge is useless — we need a humanness test. Turnstile raises cost; combined with single-use tokens it breaks the cheap 200→409→409 burst.

## Scope of endpoints

| Endpoint | Action | Gate? | Notes |
|---|---|---|---|
| `POST /l2svc/api/Account/Register` | register | ✅ | the primary entry point; each 200 writes a user + fires SES |
| `POST /l2svc/api/Account/ForgotPassword` | forgot | ✅ | also fires SES → enumeration + email-bomb vector |
| `POST /l2svc/api/Account/RegisterProvisional` | register | ✅ | same family |
| `POST /l2svc/api/Account/SendConfirmationEmail` | resend | ✅ | fires SES |
| `POST /l2svc/Token` (login) | — | ❌ (this phase) | cross-origin hb-rts SPA consumer; defer to ATP / later |
| feedback `POST /tw/.../tasks.json` | feedback | ✅ (migrate) | replace reCAPTCHA v2 → Turnstile |

## Embedder inventory (fixed)

Sitekey domain-allowlist must list: **all our zones** (`*.db101.org`, `*.hb101.org`, `eightfoldway.com`, `vets101.org`, `housingbenefits101.org`) + **`disabilityhubmn.org`** (the only third-party embedder) + **preview hosts** (`preview2-*.db101.org`, `preview-mn.*`, etc., for rehearsal).

## CSP changes (ours = the gating one)

Two CSPs matter, and **ours is the blocker** — the Hub has none.

**Our sites (REQUIRED, prerequisite of client rollout).** Canonical CSP lives at `G:\Shared drives\B101\8. Reference\Technical Notes\Content-Security-Policy.config` (an IIS `<httpProtocol><customHeaders>` fragment), hand-copied into each **server's `applicationHost.config`** (server-level — it already inherits to all sites on the box; no per-site duplication). Host-allowlist model: `default-src 'self'`, no `strict-dynamic`, `'unsafe-inline'/'unsafe-eval'` still present (CSP-hardening project removing them). It **does** have a `frame-src` (lists `*.google.com` → covers reCAPTCHA's iframe) and a `connect-src`. Turnstile additions:
- `script-src`: add `https://challenges.cloudflare.com` (today's `*.google.com`/`gstatic` cover reCAPTCHA, not CF). Host-allowlist (no `strict-dynamic`) still checks the src host even though the bundle injects the tag.
- `frame-src`: add `https://challenges.cloudflare.com` (the widget renders in an iframe; current list has `*.google.com` but not CF).
- `connect-src`: add `https://challenges.cloudflare.com` (defensive).

Note: retiring reCAPTCHA (Phase D) won't shrink the CSP much — `*.google.com`/`gstatic` are shared with Analytics/YouTube. **Coordinate with the CSP-hardening (nonce) work**; external src-allowlisted scripts are unaffected by `unsafe-inline` removal, so Turnstile is compatible with the nonce migration. If that work adopts `strict-dynamic`, bundle-injected scripts (incl. Turnstile) become auto-trusted and `script-src` no longer needs per-vendor edits (`frame-src` still would). This change must land **before/with** Phase B or Turnstile breaks on our own sites.

### CSP management — current process & proposed improvement

**Current:** one canonical fragment on a Google shared drive (outside source control), hand-pasted into each **server's `applicationHost.config`**. Already server-level (no per-site duplication) — but the canonical isn't versioned, and the copy is manual: no review, no audit, no drift detection, and a forgotten server silently runs a stale policy.

**Proposed direction — spin out a dedicated `efw-csp` git project** (structured source-of-truth + generators + deploy/drift), rather than bolt CSP onto efw-waf. **Must be multi-target** — CSP is emitted from at least two surfaces with two divergent policies today:
- **IIS sites** (db101/hb101): `applicationHost.config` `<httpProtocol><customHeaders>`; canonical on a shared drive, hand-pasted per server.
- **Vault** (`vault.db101.org`, Node): Express middleware `server/dal/contentSecurityPolicy.js` reading `server/dal/contentSecurityPolicy.json` (a monolithic header string per key), deployed with the app. Also sets HSTS + X-Content-Type-Options.
- Likely more (Favorites, logon server, rts) — **inventory all CSP emitters** as task 0.

Design:
- `policy/base.json` + per-target overlays (`targets/iis-sites.json`, `targets/vault.json`, …) — structured directive→source arrays **with per-source rationale/date** (surfaces & rationalizes the existing IIS↔Vault drift; kills "why is this host here?").
- Renderers: `Build-CspFragment.ps1` → IIS `customHeaders` fragment; `Build-VaultCsp` → the `contentSecurityPolicy.json` Vault already imports (minimal change to Vault). Same source → multiple formats.
- `deploy/Deploy-Csp.ps1` for IIS (SSM `AWS-RunPowerShellScript`, **backup applicationHost.config first**) + `deploy/servers.json`; Vault picks up its JSON via its own deploy pipeline. `deploy/Test-CspDrift.ps1` fetches each surface's live header vs rendered canonical → drift report (pairs with `public-url-checker`).
- `test/*.Tests.ps1` (Pester) + CI lint/render on PR.
- **End-state (with CSP-hardening):** per-request **nonce** — IIS via a shared **HttpModule**, Vault via its middleware — both reading the same structured source; `strict-dynamic` then ends per-vendor `script-src` edits.

**Turnstile across targets:** IIS sites definitely need `challenges.cloudflare.com` in `script-src`+`frame-src`+`connect-src`. Vault: auth runs in the *outer* hub-vault bundle, not the Vault iframe app, so Vault likely does NOT need it — **confirm whether the feedback form (or any Turnstile UI) renders inside the Vault iframe**; if so, add CF origins to `targets/vault.json` too.

The Turnstile CSP edit is small enough to ship under today's manual process now, **or** make `efw-csp` the vehicle for it (cleaner; gates Turnstile on the new repo). Open: CSP-only vs all origin security headers; SSM vs WebDeploy for IIS.

**disabilityhubmn.org (third party).** No CSP today → works as-is. Give the operator the directive to add `https://challenges.cloudflare.com` to `script-src` + `frame-src` IF they ever introduce a CSP. Removing our reCAPTCHA from feedback does not touch their own reCAPTCHA (separate).

## Client integration

We control all the markup, including on the Hub (the bundle runtime-fetches `_hub3/logon.htm` from mn.db101.org). One code path everywhere:

1. **Script load — self-bootstrap from the bundle.** On first need, inject `<script async defer src="https://challenges.cloudflare.com/turnstile/v0/api.js">` if not already present. (Self-injection is mandatory for the Hub — we have no header access there. Doing it in the bundle for *all* sites keeps one path and removes the CMS `window._rcv2` dependency.)
2. **Container.** Add `<div class="cf-turnstile-slot">` to: the register modal + forgot-password modal in `_hub3/logon.htm` (Hub) and the equivalent logon dialog partials served on our sites; and the feedback dialog (replacing the `.grecaptcha` div).
3. **Explicit render** (modals are injected at runtime): `turnstile.render(el, { sitekey, action, callback, 'error-callback', appearance: 'interaction-only' })`. Gate the submit button until the success callback fires.
4. **Attach token.** On submit, `turnstile.getResponse(widgetId)` → send to server. Mirror the existing feedback contract: `validationToken=<token>`, `validationType='t'` (Turnstile), where `'c'` = legacy reCAPTCHA.
   - `efw.logon.3.0.js`: add token to `DoRegister`/`DoRegisterProvisional`/`DoForgotPassword`/`DoConfEmail` request bodies. (The `DoRegister→DoLogon` chain is unaffected — `/Token` is not gated.)
   - `efw.feedback.js`: replace `grecaptcha.getResponse/reset` with `turnstile.getResponse/reset`; send `validationType='t'`.
5. **Single-use/reset.** Turnstile tokens are one-time, ~300 s TTL → `turnstile.reset()` after each submit/failure so retries re-solve.

## Server integration (siteverify)

Shared verifier: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`(token), `remoteip`(optional). Validate: `success==true` AND `hostname ∈ allowlist` AND (optional) `action` matches AND fresh. Two homes:

- **Logon server** (`Logon2.2` `AccountController`) — NEW. Add a verify step at the top of `Register`/`RegisterProvisional`/`ForgotPassword`/`SendConfirmationEmail`; reject (400/403, non-enumerable message) on failure. This single change covers the `/l2svc` proxy, the direct `logon.db101.org`, AND the Hub. Keep the existing `[RateLimit]` attributes as defense-in-depth.
- **TWProxy** (feedback) — MODIFY. It already verifies reCAPTCHA for `validationType='c'`; add a `'t'` branch calling Turnstile siteverify. Support both during overlap, then drop `'c'`.

**Secret storage:** do NOT repeat the `twconfig.json` plaintext-secret pattern. Put the Turnstile **secret in Secrets Manager** (logon server already uses the AWS SDK; `SecretsHelper.cs` exists). This also lets us start retiring the reCAPTCHA secrets currently committed in `TWProxy/s3/twconfig.json` (separate hardening item).

## Rollout order (must not lock users out)

Server-requires-token-before-clients-send = outage. Sequence:

1. **Phase A — server soft/log-only.** Deploy logon-server + TWProxy verify in observe mode: if a token is present, verify and **log** the result (success, hostname, action); if absent/invalid, **allow** but log. Measures real solve rates, catches integration/allowlist bugs, breaks nobody. Rehearse on **preview2** (→ `preview-logon.db101.org`; needs the secret + preview hosts in the sitekey allowlist).
2. **Phase B — ship clients (CSP first).** (a) Deploy the **CSP additions to all our sites** (`script-src` + new `frame-src` + `connect-src` for `challenges.cloudflare.com`) — this MUST precede or accompany the widget or Turnstile is blocked on our own sites by `default-src 'self'`. (b) Update `_hub3/logon.htm` + logon/feedback partials + the bundle (render + attach token). Republish to all sites via PubBot; the Hub auto-picks-up (it fetches `_hub3` + `hub-vault.bundle.js` from mn.db101.org). **Version/cache-bust the bundle** so the Hub doesn't serve a stale copy. Wait for propagation.
3. **Phase C — server enforce.** Flip to reject missing/invalid tokens. Keep an **emergency bypass flag** (config/secret) and the rate-limit + IP-allowlist levers.
4. **Phase D — retire reCAPTCHA.** Once feedback runs on `'t'` for the full client population, drop the `'c'` branch, remove reCAPTCHA `api.js`/`window._rcv2` from the CMS header, strip grecaptcha code from `efw.feedback.js`, delete reCAPTCHA secrets.

## Edge cases / risks

- **Auto-login chain:** `Register`(gated) → `/Token`(not gated). Token is consumed by Register; the chained login proceeds. ✓
- **pdfshot/Puppeteer:** Turnstile loads only on auth/feedback modals, never `/planning/*` → PDF rendering unaffected. `challenges.cloudflare.com` is not `*.db101.org`, so the pdf.js `host-resolver-rules` MAP leaves it resolving to the internet. ✓
- **Accessibility:** use Turnstile managed/`interaction-only`; provide a visible retry path if the widget errors (network/CSP).
- **Hub CSP:** none today; give the operator the `challenges.cloudflare.com` directive as a just-in-case. Removing our reCAPTCHA from feedback does not touch the Hub's own reCAPTCHA (separate).
- **Hostname allowlist completeness:** confirmed against 260616 (one day, web-06). Widen the log window before locking the sitekey, so a dormant embedder isn't missed.

## Key created (2026-06-22)

- CF account `73aee1d5a522fc26fc3c29ef05f54be7`; widget `efw-logon-prod`, mode `managed`, region world.
- **Sitekey (public):** `0x4AAAAAADpQvSZcQHVTZJYj` — goes in client render.
- **Secret:** AWS Secrets Manager `turnstile/prod` (us-west-1, acct 874922373146). CF API token in `cloudflare/api`.
- Domains: db101.org, disabilityhubmn.org, eightfoldway.com, hb101.org, vets101.org.
- preview2 reuses this key/secret (one-key decision).

## Decisions (settled 2026-06-22)

- **Sitekey: ONE prod key, apex allowlist.** Allowlist `db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`, `disabilityhubmn.org`. NOT `housingbenefits101.org` — it's a 301 redirect distribution (lands on hb101 before any form renders), so no widget ever executes there; siteverify `hostname` is always hb101/db101. Domain entries cover subdomains, so all `preview-*` and `preview2-*` hosts (both are subdomains of the prod zones) ride along automatically — no separate preview key. No blast-radius loss (preview = our own subdomains). Prod-vs-preview separation is recovered downstream from the `hostname` field, not from a sitekey split (see Analytics layer).
- **Widget mode: managed + `appearance: 'interaction-only'`.** CF escalates to an interactive challenge only when a session looks suspicious — the gate the proven headless-browser attacker actually has to pass — while staying invisible/low-friction for the disability-benefits audience.
- **Login (`/l2svc/Token`): NOT gated this phase.** Defer to ATP or a later Turnstile pass. Cross-origin hb-rts SPA consumes `/Token` directly and would break without also shipping the widget; the current campaign hits Register/ForgotPassword (account creation + email-bomb), not login; login is already per-IP rate-limited.

## Analytics layer (logon server) — design & build

**Decision: do NOT rely on log-scraping alone for Turnstile measurement.** Phase A's siteverify logs (success/hostname/action) are necessary but insufficient — log-grep is fragile (mtime lag, rotation, unstructured), can't drive alarms, and won't survive as the ongoing operational view. Design and build a first-class analytics layer in/around the logon server.

Requirements:
- **Structured emission, not log lines.** Every verify writes a typed record: timestamp, endpoint/action, `hostname`, `success`, CF error-codes, token-present?, outcome join (200/409/SES-fired), client IP / XFF. Queryable surface (Athena table over structured S3, or a metrics store) — not a `grep` target.
- **Prod-vs-preview separation downstream.** Recovered from `hostname` (`preview%` filter) + the per-env `action` suffix (`register` vs `register-preview`). This is *why* one sitekey is sufficient — the analytics layer owns the split, the sitekey does not.
- **Solve-rate + abuse dashboard.** Real solve rate, challenge-escalation rate, failure clustering by IP/ASN/hostname, SES-fire rate per accepted token — to confirm the 200→409→409 burst is broken and to watch for regression.
- **Alarmable.** Drive CloudWatch alarms (e.g. solve-rate collapse = integration/CSP breakage; failure spike = renewed campaign), unlike the Count-mode alarm-silence gap noted in `test-diagnostics-plan`.
- Pairs with the broader diagnostics IaC (`cloudformation/diagnostics.yaml`, Athena/Glue over WAF+CloudFront logs) — extend that pattern to logon-server auth events rather than standing up a separate silo.

## Analytics emission — decided 2026-06-22

- **Phase A operational record = CloudWatch metrics** via `PutMetricData` (AWSSDK.CloudWatch already referenced in Logon2.2, zero new deps). Low-cardinality dims `Endpoint` / `Result`(pass|fail|absent) / `Env` → solve-rate + failure-spike alarms immediately. This is the "not log-grep" answer.
- **Forensics = structured JSON line** (hostname, action, token-present, CF error-codes, outcome, IP/XFF) emitted alongside — carries the per-host detail metrics can't hold.
- **SKIP SQL** — auth DB is wrong home: write-load spikes during the exact attack window, not natively alarmable, retention/PII next to credentials. `LogonEvents` table stays for durable account events, not bot-scan telemetry.
- **Durable forensic sink still open** — ship the JSON line to Athena (extend `diagnostics.yaml` Glue pattern) vs add AWSSDK.CloudWatchLogs + PutLogEvents to a dedicated log group. Decided in the broader analytics-layer task; does NOT block Phase A (metrics measure meanwhile).

## Per-site client reporting (efw-analytics) — design 2026-06-22

Paying clients need **per-site** reports, not fleet. The `efw-analytics` repo's per-site pattern (`uptime-site-report.js`) maps `property → check_url` (`PROPERTY_TO_URL`) then filters `WHERE check_url = …`; the hostname join key is stored **per-row** in BigQuery.

**Turnstile analog:** siteverify returns a per-row `hostname` = the document the widget ran on. That is the per-site key. Per-site report = `WHERE hostname IN (<client's host family>)`.

**This decides the durable sink = Athena.** Per-site needs per-row hostname. Low-cardinality CloudWatch metrics (Endpoint/Result only) cannot do per-site; adding `Hostname` as a metric dimension is high-cardinality $$ and still lacks error-code/IP detail. Athena over the forensic JSON line (hostname a typed column) gives per-site + error-codes + IP and reuses `cloudformation/diagnostics.yaml`. Metrics demote to ops-alarms/fleet only. **Prerequisite:** per-site reports produce no data until the forensic `TURNSTILE` line is shipped to S3 + a Glue table exists — sequence after the metrics/Report-A work.

**Attribution catch: `hostname` = where the widget ran, NOT which client owns it.**
- **Hub embed** renders the widget in disabilityhubmn.org's own page → `hostname = disabilityhubmn.org`, not mn.db101.org. **Resolved (2026-06-22): Hub => db101-mn**, consistent with how the org already attributes the Hub elsewhere (e.g. the Vault activity report). Folded into `mn.db101.org`'s public family; keep a `viaHub` label in the report for transparency, but it counts toward MN.
- **Edit-site hosts** — editors log into the CMS at `db101-{state}[-es].eightfoldway.com` (and `hb101-mn.eightfoldway.com`); the logon dialog MUST work there, so the widget runs and reports `hostname = db101-ca.eightfoldway.com`. These are **staff/editing** context → `internal` family (excluded from the paid client report, kept for QA), same treatment as preview/preview2. eightfoldway.com is therefore NOT marketing-only.
- **preview/preview2** hosts are internal rehearsal — excluded from the client-facing report, kept queryable for QA.
- **Non-client edit hosts** (no paying site behind them) — `db101-master.eightfoldway.com` (national/master template), `db101-eco.eightfoldway.com` (ECONorthwest engine context), `db101-nv[-es].eightfoldway.com` (Nevada, not published) — excluded entirely; no client report.
- **vets101.org** — moribund / not supported (2026-06-22). Stays in the sitekey allowlist (widget won't break if hit) but gets **no per-site report**.
- **`-es` siblings** (az-es, ca-es, co-es, il-es, nj-es) are the same client — folded into the state's public family (with a language split available in the report).

So the map is **site → host *family* (1:many)**, richer than uptime's 1:1.

### Draft site → host-family map (Turnstile equivalent of PROPERTY_TO_URL)

Bare hostnames as siteverify returns them. `public` = rolls into the paid report; `internal` = preview/edit, QA-only, excluded; `viaHub` = third-party embedder attributed as a separate line.

**Derivation rule for `internal`** (so the arrays below stay short): each state's `internal` family = `preview-{state}[-es].db101.org` + `preview2-{state}[-es].db101.org` + **`db101-{state}[-es].eightfoldway.com`** (the edit-site host editors log into). `hb101-mn.eightfoldway.com` for the hb101 family. Excluded non-client edit hosts: `db101-master`, `db101-eco`, `db101-nv[-es]`.

```js
const SITE_HOST_FAMILY = {
  // internal arrays show the eightfoldway edit host explicitly for mn/ca as worked examples; the rest follow the derivation rule above.
  'mn.db101.org': { public:['mn.db101.org','disabilityhubmn.org'], internal:['preview-mn.db101.org','preview2-mn.db101.org','db101-mn.eightfoldway.com'], viaHub:['disabilityhubmn.org'] },  // Hub => db101-mn (matches Vault activity report); viaHub kept as a report label, counts toward MN
  'az.db101.org': { public:['az.db101.org','az-es.db101.org'], internal:['preview-az.db101.org','preview-az-es.db101.org','preview2-az.db101.org','preview2-az-es.db101.org'] },
  'ca.db101.org': { public:['ca.db101.org','ca-es.db101.org'], internal:['preview-ca.db101.org','preview-ca-es.db101.org','preview2-ca.db101.org','preview2-ca-es.db101.org','db101-ca.eightfoldway.com','db101-ca-es.eightfoldway.com'] },
  'co.db101.org': { public:['co.db101.org','co-es.db101.org'], internal:['preview-co.db101.org','preview-co-es.db101.org','preview2-co.db101.org','preview2-co-es.db101.org'] },  // CO not actively maintained (per estimator census) — keep mapped, may be zero-traffic
  'il.db101.org': { public:['il.db101.org','il-es.db101.org'], internal:['preview-il.db101.org','preview-il-es.db101.org','preview2-il.db101.org','preview2-il-es.db101.org'] },
  'nj.db101.org': { public:['nj.db101.org','nj-es.db101.org'], internal:['preview-nj.db101.org','preview-nj-es.db101.org','preview2-nj.db101.org','preview2-nj-es.db101.org'] },
  'ak.db101.org': { public:['ak.db101.org'], internal:['preview-ak.db101.org','preview2-ak.db101.org'] },
  'ga.db101.org': { public:['ga.db101.org'], internal:['preview-ga.db101.org','preview2-ga.db101.org'] },
  'ia.db101.org': { public:['ia.db101.org'], internal:['preview-ia.db101.org','preview2-ia.db101.org'] },
  'ky.db101.org': { public:['ky.db101.org'], internal:['preview-ky.db101.org','preview2-ky.db101.org'] },
  'mi.db101.org': { public:['mi.db101.org'], internal:['preview-mi.db101.org','preview2-mi.db101.org'] },
  'mo.db101.org': { public:['mo.db101.org'], internal:['preview-mo.db101.org','preview2-mo.db101.org'] },
  'nc.db101.org': { public:['nc.db101.org'], internal:['preview-nc.db101.org','preview2-nc.db101.org'] },
  'oh.db101.org': { public:['oh.db101.org'], internal:['preview-oh.db101.org','preview2-oh.db101.org'] },
  'www.db101.org':{ public:['www.db101.org','db101.org'], internal:['preview-www.db101.org'] },
  'mn.hb101.org': { public:['mn.hb101.org'], internal:['preview-mn.hb101.org','preview2-mn.hb101.org'] },  // hb101 family grows as states launch
};
```

Open on the map:
- ~~Hub attribution~~ — RESOLVED: Hub => db101-mn (folded into MN public, `viaHub` label retained), matching the Vault activity report.
- ~~eightfoldway.com / vets101.org marketing-only?~~ — RESOLVED: `eightfoldway.com` = edit-site hosts (`db101-{state}.eightfoldway.com`), mapped to each state's `internal` family (must work, excluded from paid report). `vets101.org` = moribund/unsupported, no report.
- `-es`: folded into the state public family with an in-report language split (recommended) vs separate sites.
- Validate every host against real `hostname` values once Phase A logging runs (widen the window so a dormant embedder isn't missed) before locking the map.

## Open decisions

- Durable forensic sink for the structured line — **leaning Athena** (per-site reporting forces it; reuses `diagnostics.yaml`). Confirm + build the S3 ship + Glue table.
- Map opens above (Hub line, eightfoldway/vets101 inclusion, -es split).
