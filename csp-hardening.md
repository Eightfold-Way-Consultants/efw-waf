# CSP Hardening — Remove `unsafe-inline` and `unsafe-eval`

status: backlog
created: 2026-03-31
owner: jack
channel: f8-platform
depends-on: projects/f8-platform/sri-external-resources.md

## Motivation

SecurityScorecard deducts ~10 points for CSP containing `'unsafe-inline'` and `'unsafe-eval'` directives. Additionally, cleaning up CSP is a prerequisite for appealing the 26 reCAPTCHA SRI findings (~20 points) — we can't claim "CSP is our compensating control" while the CSP itself is flagged as permissive.

**Combined impact: ~30 SecurityScorecard points** (10 CSP + 20 SRI appeal unlocked by clean CSP).

## Scope

28 findings across two distinct CSP policies:

### DB101/HB101 Public Sites (24 findings)
- `script-src 'unsafe-inline' 'unsafe-eval'`
- `style-src 'unsafe-inline'`
- Sites: ak, az, az-es, ca, ca-es, co, co-es, db101.org, www, ga, il, il-es, ky, mi, mn, mo, nc, nj, nj-es, oh, preview-ak, preview-az, preview-az-es, preview-ca, preview-ca-es, preview-mi, preview-mn, q

### Vault Sites (4 findings)
- `script-src 'unsafe-inline' 'unsafe-eval'`
- Sites: vault.db101.org, dev-vault.db101.org (HTTP + HTTPS), staging-vault.db101.org

## Source Data

- `projects/f8-platform/securityscorecard-csp-unsafe.csv` — full findings export

## What Needs to Change

### Remove `'unsafe-inline'` from `script-src`
Replace with **nonce-based CSP**: generate a cryptographic nonce per HTTP request, add `'nonce-<value>'` to CSP header, and add `nonce="<value>"` attribute to every inline `<script>` tag.

**Affected code paths (audit needed):**
- f8 page template rendering (master pages, .aspx)
- `RegisterStartupScript` / `RegisterClientScriptBlock` calls
- Inline `onclick`, `onload`, etc. event handlers in HTML
- Any `<script>` blocks in DictEntry content or tip HTML
- Estimator inline scripts

### Remove `'unsafe-eval'` from `script-src`
Requires auditing all JS for `eval()`, `new Function()`, `setTimeout("string")` usage.

**Likely `eval` consumers (verify):**
- jQuery (historically used eval internally)
- reCAPTCHA
- Google Tag Manager
- Estimator calculation engine?
- JW Player?

### Remove `'unsafe-inline'` from `style-src`
Replace with nonce or hash for inline `<style>` blocks. Or move all inline styles to external stylesheets.

**This is often harder than script-src** because:
- CMS content frequently contains inline `style` attributes
- jQuery `.css()` calls inject inline styles
- Many components use `style="display:none"` patterns

## Implementation Plan

### Phase 1: Audit
- [ ] Enumerate all inline `<script>` blocks in f8 page output
- [ ] Enumerate all `eval()`/`new Function()` usage in JS
- [ ] Enumerate all inline `<style>` blocks and `style=` attributes
- [ ] Identify which are controlled by f8 code vs. CMS content vs. third-party

### Phase 2: Nonce Infrastructure
- [ ] Implement per-request nonce generation in f8 HTTP pipeline
- [ ] Add nonce to CSP header: `script-src 'nonce-<value>'`
- [ ] Create helper method to inject nonce into `<script>` tags
- [ ] Update `RegisterStartupScript` to include nonce

### Phase 3: Script Cleanup
- [ ] Add nonce to all f8-emitted inline `<script>` tags
- [ ] Convert inline event handlers (`onclick` etc.) to `addEventListener`
- [ ] Test `'unsafe-eval'` removal — identify what breaks
- [ ] If eval is required (jQuery/reCAPTCHA), keep `'unsafe-eval'` and document why

### Phase 4: Style Cleanup
- [ ] Assess feasibility of removing `'unsafe-inline'` from `style-src`
- [ ] If impractical (CMS content + jQuery), document as accepted risk
- [ ] If feasible, add nonce to `<style>` blocks

### Phase 5: Vault CSP
- [ ] Separate track — Vault team owns their CSP
- [ ] Relay requirements to #vault

### Phase 6: SecurityScorecard Appeal
- [ ] After CSP is clean, submit Correction for 26 reCAPTCHA SRI findings
- [ ] Use "Compensating Control" option — strict CSP as mitigation
- [ ] Batch all 26 in single submission

## Sequencing (dependency chain)

```
Vault SRI (4 findings) ──────────────────────────> immediate
CSP hardening (28 findings) ─────────────────────> this project
  └── reCAPTCHA SRI appeal (26 findings) ────────> after CSP is clean
```

## Technical Notes

- Nonce must be cryptographically random, at least 128 bits, base64-encoded
- Nonce changes every request — cannot be cached
- `'nonce-...'` in CSP makes `'unsafe-inline'` a no-op (browser ignores unsafe-inline when nonce is present)
- IIS can set CSP header via `<customHeaders>` in web.config, but nonce requires dynamic generation (HTTP module or code)
- ASP.NET: implement as `IHttpModule` that generates nonce, stores in `HttpContext.Items`, and appends CSP header in `EndRequest`

## Risk Assessment

- **High complexity**: touches every page render path
- **High regression risk**: any missed inline script = broken page
- **style-src may not be feasible**: CMS content and jQuery inject inline styles pervasively
- **`unsafe-eval` may be required**: need to verify jQuery and reCAPTCHA dependencies

## Questions
- Does jQuery 3.7.1 still require `eval()`? (Historically yes for JSONP, may not for our usage)
- Does Google Tag Manager require `unsafe-eval`?
- Can we phase this — remove `unsafe-inline` first, tackle `unsafe-eval` separately?
- Is `style-src 'unsafe-inline'` even worth fixing if the cost is too high?
