# SRI (Subresource Integrity) for External Resources

status: backlog
created: 2026-03-31
owner: jack
channel: f8-platform

## Motivation

SecurityScorecard is penalizing us heavily for missing SRI attributes on external `<script>` and `<link>` tags. SRI ensures browsers verify fetched resources against a cryptographic hash, preventing CDN compromise or MITM injection.

## Scope

All DB101 and HB101 public sites. Every `<script src>` and `<link rel="stylesheet" href>` pointing to an external origin needs an `integrity` attribute with a SHA-384 (or SHA-512) hash and `crossorigin="anonymous"`.

## What Needs SRI

### Likely candidates (audit needed)
- jQuery (CDN)
- Bootstrap CSS/JS (CDN)
- Font Awesome (CDN)
- Any other third-party CDN scripts or stylesheets
- Our own JS/CSS served from a different origin than the page

### What CANNOT have SRI
- **Google reCAPTCHA** (`api.js`) — loaded on every page site-wide; Google updates it server-side without versioning; SRI hash would break on every update. Mitigation: CSP headers restricting to `https://www.google.com/recaptcha/` and `https://www.gstatic.com/recaptcha/`. This will remain a SecurityScorecard exception — SRI is fundamentally incompatible with Google's delivery model.
- Any dynamically-generated or unversioned external scripts

## Implementation Plan

### Phase 1: Audit
- [ ] Enumerate all external `<script>` and `<link>` tags across public sites
- [ ] Identify which are CDN-hosted with stable versions (SRI-compatible)
- [ ] Identify which are dynamic/unversioned (SRI-incompatible → CSP only)

### Phase 2: Generate hashes
- [ ] For each SRI-compatible resource, generate `integrity="sha384-..."` hash
- [ ] Pin CDN URLs to specific versions (e.g. `jquery@3.6.0` not `jquery@latest`)
- [ ] Document hash per resource for future updates

### Phase 3: Implementation
- [ ] Determine where external resource tags are emitted (templates? DictEntries? hardcoded in .cs?)
- [ ] Add `integrity` and `crossorigin="anonymous"` attributes
- [ ] Consider: should this be driven by config/DictEntry so hashes can be updated without code deploy?

### Phase 4: CSP headers
- [ ] Add Content-Security-Policy headers restricting script/style sources
- [ ] Covers the resources that can't use SRI (reCAPTCHA, etc.)

### Phase 5: Verify
- [ ] Re-run SecurityScorecard scan
- [ ] Confirm SRI findings resolved

## Technical Notes

- `integrity="sha384-<base64hash>"` on `<script>` and `<link>` tags
- Must include `crossorigin="anonymous"` for cross-origin resources
- Hash generation: `openssl dgst -sha384 -binary <file> | openssl base64 -A`
- Or: `shasum -b -a 384 <file> | awk '{print $1}' | xxd -r -p | base64`
- Or fetch and pipe: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`
- If a CDN resource updates (content changes), the hash breaks and the browser blocks it — this is the intended behavior. Pin versions.

## Related

- **CSP Hardening**: `projects/f8-platform/csp-hardening.md` — must clean up `unsafe-inline`/`unsafe-eval` before we can appeal the 26 reCAPTCHA SRI findings using CSP as compensating control
- **SecurityScorecard CSVs**: `securityscorecard-sri-missing.csv`, `securityscorecard-csp-unsafe.csv` (same directory)

## Questions
- Are our CDN references already version-pinned, or do some point to `latest`?
- Where in the f8 template pipeline do external resource tags get emitted?
- Would a DictEntry-based approach for SRI hashes be worth the complexity?
- What's our current SecurityScorecard score and which specific findings reference SRI?
