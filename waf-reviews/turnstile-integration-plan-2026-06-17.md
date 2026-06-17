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

## Open decisions

- One sitekey (all hosts incl. preview) vs separate prod/preview sitekeys.
- Turnstile widget mode: managed vs non-interactive vs invisible (lean: managed/interaction-only).
- Whether to also gate `/l2svc/Token` later via ATP rather than Turnstile (cross-origin SPA constraint).
