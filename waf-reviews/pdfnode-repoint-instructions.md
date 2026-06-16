# pdfnode repoint — make the PDF renderer hit the local origin (CloudFront cutover gate)

**Goal:** repoint the estimator PDF renderer (Puppeteer/pdfnode) at the local origin so it survives the CloudFront/WAF cutover. Gates the public-site cutover (Phase 3/4).

## Background
- The estimator generates PDFs with Puppeteer (headless Chrome). Source: `c:\svn\f8\bp101-interface\pdfnode\pdf.js`; deployed to `c:\inetpub\wwwroot\pdfnode\` on **both** origin servers:
  - web-04 `i-0272763b46610ac1b` = s4 / preview2
  - web-06 `i-0c82adf476c7c5e32` = s6 / public
  - (us-west-1, reachable via SSM `AWS-RunPowerShellScript`)
- `pdf.js` renders `doc.url`, which is built from `Request.Url.Host` (`PDFReportSpec.cs:80`, `EngineSession.cs:6304`) — i.e. the **public hostname**, e.g. `https://mn.db101.org/planning/…`.
- Today that loopbacks via the EIP. **After CloudFront goes live those fetches would egress to CloudFront → WAF and hit the `/planning/` Challenge, which blocks headless Chrome → PDF generation breaks.** We need the renderer to reach the local origin instead, *without* changing the URLs.

## The fix (one-line, in `pdf.js`)
Add `--host-resolver-rules` to the Puppeteer launch so Chrome connects to `127.0.0.1` while keeping SNI + Host = the public hostname (local IIS already has valid certs for these names → TLS passes and IIS routes correctly).

Current:
```js
browser = await puppeteer.launch({
    args: ['--disable-crashpad']
});
```
Change to:
```js
browser = await puppeteer.launch({
    args: [
        '--disable-crashpad',
        '--host-resolver-rules=' +
            'MAP *.db101.org 127.0.0.1,' +
            'MAP *.hb101.org 127.0.0.1,' +
            'MAP *.vets101.org 127.0.0.1,' +
            'MAP *.eightfoldway.com 127.0.0.1,' +
            'MAP *.housingbenefits101.org 127.0.0.1'
    ]
});
```

## Critical caveats
- **Scope MAP to our zones only — NEVER `MAP *`.** Report pages load Google Analytics, reCAPTCHA, and Google Fonts; those must keep resolving to the internet (pdf.js waits for `load`). Mapping only our zones sends our content to the local origin and leaves Google/3rd-party untouched.
- **Use `127.0.0.1`** (not the public IP or an internal LAN IP): pdfnode runs *on* the origin box, so loopback = local IIS. Never leaves the machine → also survives Phase 5 (origin SG locked to the CloudFront prefix list).
- **Do NOT** use the system hosts file (it repoints the whole box's resolution, not just the renderer).
- **Do NOT** change `Request.Url.Host` URL generation (touches shared `UrlUtil.MakeAbsolute`, higher risk).

## Test before relying on it (web-06, via SSM or RDP)
1. Origin sanity (already passed once):
   ```
   curl.exe -s -o NUL -w "%{http_code} ssl=%{ssl_verify_result}" --resolve mn.db101.org:443:127.0.0.1 https://mn.db101.org/planning/b2w2_mn_start.aspx
   ```
   Expect a 2xx/3xx and `ssl=0` (valid cert on loopback).
2. Real render with the new args on the box:
   ```
   node c:\inetpub\wwwroot\pdfnode\pdf.js https://mn.db101.org/planning/<a real report URL> C:\temp\test.pdf
   ```
   Confirm a valid PDF, no Challenge interstitial, no timeout.

## Deploy
- Edit in the svn working copy (`c:\svn\f8\bp101-interface\pdfnode\pdf.js`), commit.
- Push to `c:\inetpub\wwwroot\pdfnode\pdf.js` on **both** web-04 and web-06 (each server's renders use its own tier's hostnames; the wildcard rules cover all).

## Why this approach
`--host-resolver-rules` is Chrome's equivalent of `curl --resolve`: it remaps the connection IP while leaving SNI + Host = the original hostname. Proven equivalent by the curl `--resolve` test above (Host=mn.db101.org → 200, sslverify=0 on loopback). It's scoped to the render Chrome only, wildcards mean zero per-site maintenance, it's one line, and it leaves URL generation untouched.

See memory `pdfreport-print-pipeline` for the full pipeline study.
