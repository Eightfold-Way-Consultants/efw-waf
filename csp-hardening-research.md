# CSP Hardening Research: Eliminating `'unsafe-inline'` from DB101 Static Sites

**Date:** 2026-03-31  
**Author:** Figaro (security architecture research)  
**Status:** Research complete — ready for team review

---

## Executive Summary

SecurityScorecard penalizes DB101 sites for `'unsafe-inline'` in the CSP `script-src` directive. This document evaluates four approaches to eliminating it, given our unusual constraint: pages are **statically published HTML** served by IIS with no server-side processing at request time.

**Recommendation: Hash-based CSP with `'strict-dynamic'`** — compute SHA-256 hashes of each page's inline `<script>` blocks at publish time and emit the CSP as a `<meta>` tag (or generate a per-page IIS configuration). This is Google's officially recommended approach for static sites, provides real XSS mitigation, and will satisfy SecurityScorecard's scanner.

The external-JS-per-page approach (Option 2) is a strong runner-up and eliminates inline scripts entirely, but adds file-management complexity. Both are viable; hash-based CSP is lower-friction for the existing codebase.

---

## Table of Contents

1. [Background: How Our System Works](#1-background)
2. [Approach 1: Static Nonces](#2-static-nonces)
3. [Approach 2: External JS Files + SRI](#3-external-js-sri)
4. [Approach 3: Hash-Based CSP (Recommended)](#4-hash-based-csp)
5. [Approach 4: Hybrid — Hashes + External JS](#5-hybrid)
6. [Third-Party Script Analysis](#6-third-party)
7. [`style-src 'unsafe-inline'` Problem](#7-style-src)
8. [`'unsafe-eval'` Analysis](#8-unsafe-eval)
9. [SecurityScorecard-Specific Considerations](#9-securityscorecard)
10. [Final Recommendation](#10-recommendation)
11. [Implementation Sketch](#11-implementation)

---

## 1. Background: How Our System Works <a name="1-background"></a>

- ~30 public DB101 sites, thousands of pages each.
- Pages rendered to static `.html` files by the ASP.NET WebForms publish pipeline.
- IIS serves these as plain static files — **no ASP.NET pipeline runs at request time**.
- `RegisterStartupScript()` / `RegisterClientScriptBlock()` inject inline `<script>` blocks during publish.
- Each page has different inline scripts depending on template, components, and configuration.
- Pages can sit unchanged for months between republishes.
- Third-party scripts: jQuery 3.7.1 (CDN), Google reCAPTCHA, Google Tag Manager, JW Player.

**Key constraint:** We cannot generate per-request nonces because there is no server-side code running when a user requests a page. Any solution must work with static HTML.

---

## 2. Approach 1: Static Nonces <a name="2-static-nonces"></a>

### Concept
Generate a nonce during publish, bake it into both the CSP header/meta and the `<script nonce="...">` attributes. The nonce is the same for every request of that page until the next republish.

### Security Analysis: **Security Theater**

**Static nonces provide zero additional security over `'unsafe-inline'`.** Here's why:

1. **Nonces are designed to be per-request and ephemeral.** The CSP spec explicitly states: "the nonce must be different for every HTTP response, and must not be predictable" (MDN, Google CSP FAQ). A nonce baked into HTML that lives for months is definitionally predictable — it's right there in the source.

2. **The threat model collapses.** CSP nonces protect against injection attacks where an attacker can inject HTML but can't predict the nonce (because it changes every request). With a static nonce, an attacker who can inject a `<script>` tag can trivially read the nonce from any existing `<script>` tag on the same page and include it in their injected script.

3. **Invicti (formerly Netsparker) explicitly flags this** as a vulnerability: "An attacker can carry out a successful Cross-site Scripting attack by using this nonce" (Invicti vulnerability database).

4. **Google's CSP FAQ** says for static content: "Use CSP hashes instead of nonces" — they explicitly acknowledge that nonces don't work for static pages.

### SecurityScorecard Impact
A static nonce *might* fool SecurityScorecard's automated scanner (since it looks for `'unsafe-inline'` in the policy string, and a nonce-based policy omits it). But this is gaming the scanner, not fixing the vulnerability. If SecurityScorecard ever does deeper analysis (e.g., detecting identical nonces across requests), it would flag this.

### Verdict: ❌ **Do not use.** Security theater that creates a false sense of safety.

---

## 3. Approach 2: External JS Files + SRI <a name="3-external-js-sri"></a>

### Concept
During publish, extract all inline `<script>` content into a companion `.js` file (e.g., `page-name.init.js`). Reference it with `<script src="page-name.init.js" integrity="sha384-..." crossorigin="anonymous">`. SRI hash computed at publish time.

### Security Analysis: **Good, with nuances**

**Pros:**
- Completely eliminates `'unsafe-inline'` — there are no inline scripts to worry about.
- SRI ensures the external file hasn't been tampered with (protects against CDN/hosting compromise).
- Clean CSP: `script-src 'self' https://ajax.googleapis.com ...` — simple allowlist of trusted origins.
- SecurityScorecard will be happy — no `'unsafe-inline'`, no hashes to parse, clean policy.

**Cons:**
- **Doubles the number of published files.** Each HTML page gets a companion `.js` file. For thousands of pages across 30 sites, that's tens of thousands of additional files.
- **SRI + `crossorigin` requires CORS headers** if serving from a different origin. Since we're self-hosting, this is fine (`'self'`), but worth noting.
- **Execution timing changes.** External scripts load differently than inline scripts. `RegisterStartupScript` content that expects to run synchronously after the DOM element it's adjacent to may behave differently as an external async/deferred script. This needs careful testing.
- **Browser caching considerations.** If the HTML is cached but the JS file has been updated (or vice versa), the SRI hash mismatch will break the page. Since both are published together, this is mainly a concern with CDN/proxy caching.
- **`crossorigin="anonymous"` is required for SRI** even on same-origin scripts if the page might be loaded cross-origin (e.g., in iframes).

### Gotchas
- **Script context:** Inline scripts execute in document order and have access to the DOM parsed so far. An external script loaded with `src=` must be either `async`, `defer`, or blocking. To preserve the original behavior, you'd want the `<script src="...">` tag placed where the inline `<script>` was, without `async` or `defer`.
- **Multiple inline scripts per page:** If a page has multiple `<script>` blocks at different positions (common with WebForms), you either concatenate them all into one file (changing execution timing) or emit multiple files (even more files).

### Verdict: ✅ **Viable and strong.** Best option if you're willing to invest in the publish pipeline changes and thorough testing of execution timing.

---

## 4. Approach 3: Hash-Based CSP (Recommended) <a name="4-hash-based-csp"></a>

### Concept
At publish time, compute the SHA-256 hash of each inline `<script>` block's content. Emit a CSP policy listing all those hashes. The browser only executes inline scripts whose content matches a listed hash.

### How It Works (CSP Spec)

Per the CSP Level 2+ specification:
```
Content-Security-Policy: script-src 'sha256-B2yPHKaXnvFWtRChIbabYmUBFZdVfKKXHbWtWidDVF8=' 'sha256-...' 'strict-dynamic'; object-src 'none'; base-uri 'none';
```

The browser computes the SHA-256 of each inline `<script>` block and checks it against the policy. Only matching scripts execute.

### Security Analysis: **Strong — this is the right tool for the job**

1. **Google's official recommendation for static sites.** From web.dev: "Use a hash-based CSP for HTML pages served statically, or pages that need to be cached." This is *exactly* our scenario.

2. **Real security benefit.** Unlike static nonces, an attacker who injects a `<script>` tag cannot make it execute — the injected script's content would produce a different hash that isn't in the CSP policy. The attacker would need to inject a script whose SHA-256 hash is already listed in the policy (i.e., inject the exact content of an already-trusted script, which is pointless for an attack).

3. **`'strict-dynamic'` makes third-party scripts work.** When combined with `'strict-dynamic'`, any script loaded by a trusted (hashed) script is also trusted. This means your inline loader scripts can dynamically load GTM, reCAPTCHA, etc., without listing every possible script URL.

4. **Whitespace sensitivity.** The hash is computed over the exact content between `<script>` and `</script>`. Any change — even whitespace — changes the hash. Since we control the publish pipeline, this is fine: the hash and the script are generated in the same step.

### Delivery Mechanism for Static Sites

The CSP policy contains per-page hashes, so it **must be per-page**. Two options:

**Option A: `<meta>` tag (simpler)**
```html
<meta http-equiv="Content-Security-Policy" 
  content="script-src 'sha256-abc123...' 'sha256-def456...' 'strict-dynamic'; 
           object-src 'none'; base-uri 'none';">
```
- Emitted by the publish pipeline into each HTML page.
- No IIS configuration changes needed.
- **Limitation:** `<meta>` CSP cannot use `report-uri` or `report-to` directives (no violation reporting).
- **Limitation:** `<meta>` CSP cannot set `frame-ancestors` (but we can keep that in a site-wide HTTP header).

**Option B: Per-page HTTP header via IIS outbound rules**
- Publish pipeline writes a sidecar file (e.g., `page.csp.txt`) containing the CSP value.
- IIS outbound rewrite rule reads the sidecar and sets the header.
- More complex to set up, but enables `report-uri` and is what SecurityScorecard's scanner sees (HTTP headers, not `<meta>` tags).

**Option C: IIS HTTP module (custom)**
- Write a lightweight IIS native module or managed module that reads a CSP mapping file and sets per-page headers.
- Most powerful but most engineering effort.

### Verdict: ✅✅ **Strongly recommended.** Purpose-built for static sites, real security benefit, Google-endorsed, and the lowest-friction change to the existing publish pipeline.

---

## 5. Approach 4: Hybrid — Hashes + External JS <a name="5-hybrid"></a>

### Concept
Move most inline scripts to external files (Approach 2) while using hash-based CSP (Approach 3) for the small number of inline bootstrap/loader scripts that must remain inline.

### Analysis
This gives the cleanest result but is the most engineering work. If you're already investing in Approach 3 (hash-based CSP), you get the SecurityScorecard fix without needing to also externalize scripts. The hybrid is worth considering for a Phase 2 — after hash-based CSP is working, gradually move scripts to external files to reduce CSP header size.

### Verdict: ✅ **Good long-term target.** Overkill for the immediate SecurityScorecard fix.

---

## 6. Third-Party Script Analysis <a name="6-third-party"></a>

### jQuery 3.7.1

**Does it require `'unsafe-inline'`?** No, not for loading from CDN:
```html
<script src="https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
```
This is an external script — CSP just needs `https://ajax.googleapis.com` in `script-src` (or `'strict-dynamic'` if loaded by a trusted script).

**Does it require `'unsafe-eval'`?** It depends on usage:
- **Core jQuery (loading, selectors, events, DOM traversal):** No.
- **`jQuery.globalEval()`:** Yes — it calls `eval()` internally. Triggered by `$.globalEval()`, `$.getScript()` with same-origin URLs, `$.ajax({dataType: "script"})` with same-origin URLs, and `.html()` / `.append()` when the HTML contains `<script>` tags.
- **jQuery 3.x improved this** — `globalEval` in jQuery 3.x creates a `<script>` element and appends it to the DOM rather than calling `eval()` directly. This means it requires either `'unsafe-inline'` or a nonce (since it creates an inline script element), **not** `'unsafe-eval'`.

**Recommendation:** Audit DB101 pages for any use of `$.getScript()`, `$.globalEval()`, or `.html()` with `<script>` tags. If none are present (likely — the CMS publishes static HTML), jQuery 3.7.1 should work fine without either `'unsafe-eval'` or `'unsafe-inline'`. With `'strict-dynamic'`, scripts dynamically loaded by a trusted script are allowed.

### Google reCAPTCHA (v2/v3)

**Required CSP directives** (from Google's official documentation):
```
script-src: https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/
frame-src: https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/
style-src: 'unsafe-inline'  (reCAPTCHA injects inline styles — see §7)
```

- **`'unsafe-eval'`:** NOT required for standard reCAPTCHA v2/v3 usage. It was required by the old reCAPTCHA AJAX API, which is deprecated.
- **`'unsafe-inline'` for `script-src`:** NOT required if using nonce-based or `'strict-dynamic'` CSP. Google's documentation: "We recommend using the nonce-based approach documented with CSP3. Make sure to include your nonce in the reCAPTCHA api.js script tag, and we'll handle the rest."
- **`'unsafe-inline'` for `style-src`:** Still required — reCAPTCHA injects inline styles. This is a known Google issue (#107 on google/recaptcha). See §7.

**With hash-based CSP + `'strict-dynamic'`:** The reCAPTCHA loader script will be trusted (because the inline script that loads it is hashed), and `'strict-dynamic'` will trust scripts that it in turn loads. This should work without listing Google's domains explicitly in `script-src`.

### Google Tag Manager (GTM)

**GTM is the most CSP-hostile third-party script.** It dynamically loads arbitrary JavaScript based on the container configuration.

**Required CSP directives** (from Google's official documentation):
```
script-src: 'nonce-{RANDOM}' or hash + 'strict-dynamic' for the GTM snippet
            https://www.googletagmanager.com (for gtm.js)
img-src:    www.googletagmanager.com
connect-src: www.googletagmanager.com www.google.com
```

**Critical issues:**
- **Custom HTML Tags** in GTM require `'unsafe-inline'` in `script-src`.
- **Custom JavaScript Variables** in GTM require `'unsafe-eval'` in `script-src`.
- GTM supports a **nonce-aware snippet** that propagates the nonce to scripts it creates. But this requires a per-request nonce (which we can't do on static sites).

**With hash-based CSP + `'strict-dynamic'`:** The GTM loader inline script gets hashed. `'strict-dynamic'` allows `gtm.js` to load. Scripts that GTM dynamically creates via `document.createElement('script')` are also trusted under `'strict-dynamic'`. **However**, if GTM uses Custom JavaScript Variables, `'unsafe-eval'` is still needed.

**Recommendation:** Audit the GTM container for Custom HTML Tags and Custom JavaScript Variables. If possible, replace them with Custom Templates (which are CSP-compatible). If not, GTM may force `'unsafe-eval'` in the policy.

### JW Player

JW Player loads from its CDN (`cdn.jwplayer.com` or `ssl.p.jwpcdn.com`). It does not appear to require `'unsafe-eval'` for standard playback. It does inject inline styles for the player UI.

**Required CSP directives:**
```
script-src: https://cdn.jwplayer.com https://ssl.p.jwpcdn.com (or 'strict-dynamic')
media-src:  wherever your video content is hosted
style-src:  'unsafe-inline' (for player styling — see §7)
img-src:    poster images, thumbnails
connect-src: analytics endpoints, content URLs
```

---

## 7. `style-src 'unsafe-inline'` Problem <a name="7-style-src"></a>

### The Current Situation

Multiple sources inject inline styles:
1. **CMS content:** The WYSIWYG editor produces `style="..."` attributes on HTML elements.
2. **jQuery `.css()` calls:** jQuery 3.x uses the CSSOM API (`element.style.property = value`) which is CSP-compatible and does NOT require `'unsafe-inline'` in `style-src`.
3. **Google reCAPTCHA:** Injects `<style>` tags and `style=` attributes.
4. **JW Player:** Injects inline styles for the player chrome.
5. **Google Tag Manager:** May inject inline styles depending on container configuration.

### Analysis

**The industry consensus is that `'unsafe-inline'` in `style-src` is a much lower security risk than in `script-src`.** Inline styles cannot execute JavaScript (except in ancient IE with CSS expressions, which no modern browser supports). The main risk is CSS-based data exfiltration (e.g., using `background: url()` to leak data), which is a narrow attack vector.

**SecurityHeaders.com relaxed their grading in 2023:** Sites can now achieve A+ even with `'unsafe-inline'` in `style-src`.

**SecurityScorecard** flags "broad directives" but primarily focuses on `script-src`. Having `'unsafe-inline'` in `style-src` is far less impactful on the score than in `script-src`.

### Recommendation

**Keep `'unsafe-inline'` in `style-src` for now.** The cost/benefit of eliminating it is poor:
- CMS content with inline styles would need to be rewritten or have styles extracted to classes.
- reCAPTCHA and JW Player would need their inline styles hashed (which change with every version update).
- The security benefit is minimal.

If needed in the future, hash-based `style-src` can be used for CMS-injected `<style>` blocks (same technique as for scripts).

---

## 8. `'unsafe-eval'` Analysis <a name="8-unsafe-eval"></a>

| Component | Requires `'unsafe-eval'`? | Details |
|-----------|--------------------------|---------|
| jQuery 3.7.1 core | **No** | Core functionality doesn't use `eval()`. jQuery 3.x's `globalEval` creates script elements, not `eval()`. |
| jQuery `.getScript()` same-origin | **Possibly** | Same-origin `$.getScript()` uses XHR + `globalEval`. Workaround: use `crossDomain: true` flag or `import()`. |
| Google reCAPTCHA v2/v3 | **No** | Standard usage doesn't require `eval()`. |
| Google Tag Manager (base) | **No** | Base GTM snippet works without `eval()`. |
| GTM Custom JavaScript Variables | **Yes** | These are evaluated at runtime using `eval()`-like mechanisms. |
| GTM Custom HTML Tags | Depends | May need `'unsafe-inline'` (not `'unsafe-eval'`) depending on implementation. |
| JW Player | **No** | Standard playback doesn't require `eval()`. |

### Recommendation

**Avoid `'unsafe-eval'` if at all possible.** Audit the GTM container for Custom JavaScript Variables — these are the most likely source of an `'unsafe-eval'` requirement. If Custom JS Variables are in use, convert them to Custom Templates where possible.

If `'unsafe-eval'` is unavoidable due to GTM, it's still much better to have a CSP of `script-src 'sha256-...' 'strict-dynamic' 'unsafe-eval'` than `script-src 'unsafe-inline' 'unsafe-eval'`. The hash-based policy still prevents injection of new scripts.

---

## 9. SecurityScorecard-Specific Considerations <a name="9-securityscorecard"></a>

### What SecurityScorecard's Scanner Checks

Based on SecurityScorecard's public documentation:

1. **Presence of CSP header** — Missing CSP = High Severity finding.
2. **Broad directives** — Flags: `*` wildcards, `'unsafe-inline'` in `script-src`, `data:` in `script-src`.
3. **Specific string matching** — The scanner checks for the literal presence of `'unsafe-inline'` in the policy string.

### Key Behaviors

- **Hash-based CSP:** SecurityScorecard should accept `'sha256-...'` tokens. Per the CSP spec (and browser behavior), when a hash or nonce is present, `'unsafe-inline'` is ignored by the browser. However, for **backwards compatibility with CSP1 browsers**, Google recommends including `'unsafe-inline'` alongside hashes:
  ```
  script-src 'sha256-...' 'strict-dynamic' 'unsafe-inline' https:
  ```
  In CSP2+ browsers, the `'unsafe-inline'` is ignored (because hashes are present). In CSP1 browsers, the `'unsafe-inline'` allows the scripts to run. **SecurityScorecard may flag this `'unsafe-inline'` even though browsers ignore it.** If that happens, simply remove it and accept that CSP1-only browsers (very old) won't execute inline scripts.

- **`<meta>` tag vs HTTP header:** SecurityScorecard's scanner typically examines HTTP response headers. It's unclear whether it parses `<meta http-equiv="Content-Security-Policy">` tags. **Recommendation: Use HTTP headers if possible, with `<meta>` as fallback.** A minimal site-wide CSP header plus per-page `<meta>` tag should cover both.

- **Static nonces:** If SecurityScorecard sees a nonce-based policy, it currently passes. But more sophisticated scanners (Invicti, Qualys) flag static nonces. Security auditors will notice too.

### Strategy for SecurityScorecard

The safest approach for SecurityScorecard compliance:
1. Remove `'unsafe-inline'` from `script-src` entirely.
2. Use hash-based CSP (`'sha256-...'`).
3. Include `'strict-dynamic'` for third-party script support.
4. Deliver via HTTP header (preferred) or `<meta>` tag.
5. If including `'unsafe-inline'` for CSP1 fallback causes a SecurityScorecard finding, remove it (CSP1-only browsers are negligible in 2026).

---

## 10. Final Recommendation <a name="10-recommendation"></a>

### Primary: Hash-Based CSP with `'strict-dynamic'`

**Target CSP policy per page:**
```
Content-Security-Policy:
  script-src 'sha256-{HASH1}' 'sha256-{HASH2}' ... 'strict-dynamic';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  img-src 'self' data: https://www.googletagmanager.com https://www.gstatic.com https://ssl.gstatic.com;
  font-src 'self' https://fonts.gstatic.com data:;
  connect-src 'self' https://www.googletagmanager.com https://www.google.com https://www.google-analytics.com;
  frame-src https://www.google.com https://recaptcha.google.com;
  object-src 'none';
  base-uri 'none';
```

**Why this approach wins:**
1. **Real security benefit** — prevents execution of injected inline scripts.
2. **Purpose-built for static sites** — Google's official recommendation.
3. **Minimal codebase changes** — inline scripts stay inline; only the publish pipeline adds hash computation and CSP emission.
4. **`'strict-dynamic'`** handles dynamically-loaded third-party scripts (GTM, reCAPTCHA, JW Player) without needing to enumerate all their CDN domains.
5. **SecurityScorecard compliance** — no `'unsafe-inline'` in `script-src`.
6. **No file proliferation** — no companion `.js` files to manage.

### Secondary (Phase 2): Externalize Large/Common Scripts

After hash-based CSP is working, consider moving large repeated inline scripts (e.g., common initialization code) to shared external `.js` files. This reduces CSP header size and improves cacheability. Not needed for the initial SecurityScorecard fix.

---

## 11. Implementation Sketch <a name="11-implementation"></a>

### Phase 1: Publish Pipeline Changes

#### Step 1: Compute Hashes at Publish Time

In the publish pipeline (after `Page.Render()` produces the HTML but before writing to disk), add a post-processing step:

```csharp
// Pseudocode for the publish post-processor
public string AddCspHashes(string htmlContent)
{
    var doc = new HtmlAgilityPack.HtmlDocument();
    doc.LoadHtml(htmlContent);
    
    var scriptNodes = doc.DocumentNode.SelectNodes("//script[not(@src)]");
    var hashes = new List<string>();
    
    if (scriptNodes != null)
    {
        foreach (var script in scriptNodes)
        {
            string content = script.InnerHtml;
            byte[] hashBytes;
            using (var sha256 = SHA256.Create())
            {
                hashBytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(content));
            }
            string hashBase64 = Convert.ToBase64String(hashBytes);
            hashes.Add($"'sha256-{hashBase64}'");
        }
    }
    
    // Build CSP value
    string scriptSrc = string.Join(" ", hashes) + " 'strict-dynamic'";
    string cspValue = $"script-src {scriptSrc}; " +
                      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
                      "object-src 'none'; " +
                      "base-uri 'none';";
    
    // Inject <meta> tag as first child of <head>
    var head = doc.DocumentNode.SelectSingleNode("//head");
    if (head != null)
    {
        var meta = doc.CreateElement("meta");
        meta.SetAttributeValue("http-equiv", "Content-Security-Policy");
        meta.SetAttributeValue("content", cspValue);
        head.PrependChild(meta);
    }
    
    return doc.DocumentNode.OuterHtml;
}
```

**Important:** The hash must be computed over the exact text content between `<script>` and `</script>`, including leading/trailing whitespace and newlines. The browser computes the hash the same way.

#### Step 2: Handle `<meta>` Tag Placement

The `<meta http-equiv="Content-Security-Policy">` tag must appear **before any `<script>` tags** in the HTML. Place it as the first child of `<head>`.

#### Step 3: Alternative — Write Sidecar CSP File

If per-page HTTP headers are preferred over `<meta>` tags:

```csharp
// Write a .csp file alongside each .html file
string cspFilePath = Path.ChangeExtension(htmlFilePath, ".csp");
File.WriteAllText(cspFilePath, cspValue);
```

Then configure IIS to read these via an outbound rewrite rule or a lightweight HTTP module.

### Phase 2: IIS Configuration

#### Option A: `<meta>` Tag Only (Simplest)

No IIS changes needed. The CSP is in the HTML itself. Add a **site-wide** CSP header for directives that `<meta>` can't set:

```xml
<!-- web.config -->
<system.webServer>
  <httpProtocol>
    <customHeaders>
      <add name="X-Content-Type-Options" value="nosniff" />
      <add name="X-Frame-Options" value="SAMEORIGIN" />
      <!-- Site-wide CSP for frame-ancestors (can't be set in <meta>) -->
      <add name="Content-Security-Policy" 
           value="frame-ancestors 'self'" />
    </customHeaders>
  </httpProtocol>
</system.webServer>
```

**Note:** If both an HTTP header and a `<meta>` tag set CSP, the browser enforces **both** policies (intersection). The HTTP header's `frame-ancestors` applies, and the `<meta>` tag's `script-src` with hashes applies.

#### Option B: Per-Page HTTP Header via IIS Module

A lightweight IIS module could:
1. On each request for a `.html` file, check for a `.csp` sidecar file.
2. If found, read its content and set the `Content-Security-Policy` response header.
3. If not found, fall back to a default site-wide CSP.

This is more engineering but gives SecurityScorecard exactly what it wants (HTTP headers).

### Phase 3: Testing

1. **Deploy in report-only mode first:**
   ```
   Content-Security-Policy-Report-Only: script-src 'sha256-...' 'strict-dynamic'; ...
   ```
   (Note: `Report-Only` cannot be set via `<meta>` — requires HTTP header. Use the IIS module approach or a global header for testing.)

2. **Monitor CSP violation reports** to catch any scripts that weren't hashed correctly.

3. **Test critical flows:**
   - Page load with all components (estimators, reCAPTCHA, GTM, JW Player)
   - reCAPTCHA challenge completion
   - GTM tag firing
   - JW Player video playback
   - Any jQuery-dependent interactions

4. **Verify with SecurityScorecard** — request a rescan after deployment.

### Phase 4: Ongoing Maintenance

- **Every publish automatically recomputes hashes** — no manual maintenance.
- **If a page's inline scripts change, the hash changes** — this is automatic since hashing is part of the publish pipeline.
- **Third-party script updates** (jQuery, reCAPTCHA, GTM) don't affect hashes — they're loaded externally and covered by `'strict-dynamic'`.
- **New templates or components** that add inline scripts are automatically handled — their content gets hashed at publish time.

---

## Appendix A: CSP Hash Generation — Exact Algorithm

Per the CSP spec, the hash is computed as follows:

1. Take the text content between `<script>` and `</script>` (the `textContent` of the script element).
2. Encode it as UTF-8.
3. Compute SHA-256 (or SHA-384 or SHA-512).
4. Base64-encode the hash.
5. Format as `'sha256-{base64hash}'`.

**Example:**
```html
<script>alert('hello')</script>
```

The hashed content is exactly: `alert('hello')` (no leading/trailing whitespace in this example).

**Command-line verification:**
```bash
echo -n "alert('hello')" | openssl dgst -sha256 -binary | openssl base64
```

## Appendix B: CSP Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| CSP Level 2 (hashes) | 40+ | 31+ | 10+ | 15+ |
| `'strict-dynamic'` (CSP3) | 52+ | 52+ | 15.4+ | 79+ |
| SHA-256 in script-src | 40+ | 31+ | 10+ | 15+ |

All evergreen browsers support hash-based CSP and `'strict-dynamic'` as of 2026. Legacy browsers that don't support CSP will simply ignore the policy (scripts still run, just without CSP protection).

## Appendix C: Quick Reference — What Goes Where

| Concern | Solution |
|---------|----------|
| `script-src 'unsafe-inline'` | Replace with `'sha256-...'` hashes + `'strict-dynamic'` |
| `style-src 'unsafe-inline'` | Keep for now (low risk, hard to eliminate due to third parties) |
| `'unsafe-eval'` | Avoid — audit GTM for Custom JS Variables; jQuery 3.7.1 doesn't need it |
| jQuery CDN | Covered by `'strict-dynamic'` (loaded by hashed script) or explicit allowlist |
| reCAPTCHA | Covered by `'strict-dynamic'` + `frame-src` allowlist |
| GTM | Covered by `'strict-dynamic'`; audit Custom HTML/JS vars |
| JW Player | Covered by `'strict-dynamic'` or explicit CDN allowlist |
| SecurityScorecard | HTTP header preferred; `<meta>` tag as minimum viable |
| CSP violation reporting | Requires HTTP header (`report-uri`/`report-to`) — can't do via `<meta>` |
