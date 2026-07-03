# /dist Thumbprinting — Cache-Busting + SRI Plan (task #12)

**Date:** 2026-07-03
**Status:** DESIGN — agreed in discussion, not yet implemented
**Why:** `/dist` bundle URLs are stable across builds, so client fixes ride behind two caches
(CloudFront + browser). Invalidation is skippable (proven live: wrong-PubBot-button served a stale
bundle during the Turnstile debug) and never touches browser cache. Under Turnstile **Enforce**, a
stale bundle = users hard-blocked on an already-fixed client bug → **#12 gates #18**.

## Design in one paragraph

gulp emits a `manifest.json` (deterministic content thumbprint + per-file SRI hashes) into each
bundle's dist. A new PubBot job `pb:upload-dist` (extends `UploadDirectoryJob`) copies dist to
`dist/<thumbprint>/` **and** to literal `dist/` on the dest tier, then regenerates the `<head>`
dist-reference region of every exported `.htm`/`.aspx` in the site tree (byte-splice between
landmarks emitted by `beginHead_01`), then prunes old thumbprint dirs. The existing `upload-site`
job mirrors the rewritten pages + both dist forms to preview/final (and prunes its own dest).
Anything that misses the rewrite — Hub, estimator pages, virgin single-doc exports — resolves
against literal `/dist/` and degrades to "un-cache-busted," never to "broken."

## Key facts (verified 2026-07-03)

- **Reference surface is 3 forms, fleet-wide** (grep of all .htm/.aspx/.ascx/.master):
  `href="/dist/css/master.min.css"` (×50), `src="/dist/js/master.bundle.min.js"` (×49),
  `src="/dist/js/hub-vault.bundle.min.js"` (×2). 27 files incl. per-state estimator `twm.aspx`.
- **Zero runtime string-built `/dist` refs** in efw.bundle src or wider f8 JS. Miss-surface ≈ nil.
- **Pipeline nesting** (`PubBotWinService/PubBotJobs.xml`): `export-edit-site → export-preview-site
  → upload-directory(dist→preview2) → upload-site(preview2→preview/final)`. Dist lands on preview2
  first; pages + dist mirror onward together.
- **`GetDiskPath` is per-site per-tier from DB** (`ExportCase.vchrDiskPath` by siteID+phase);
  `dest="dist"` resolves to `<site-tier-path>\dist` → dist lives *inside* each site tree → rides
  `upload-site` to preview/final automatically. Rewrite-on-preview2 propagates for free.
- **`UploadSiteJob._CopyDirectory` is additive** (copy/overwrite only; no dest deletion except
  obsolete-doc kills) → stale thumbprint dirs accumulate on preview/final unless pruned there.
- **`require-sri-for` CSP is dead** (abandoned; Chrome removed it). No browser can *require*
  integrity today → a virgin page without `integrity` attrs loads fine off literal. SRI enforces
  only where present.

## Components

### A. gulp (efw.bundle)
Post-build task writes `dist/<bundle>/manifest.json`:
```json
{
  "thumbprint": "a3f9c2e81b04",
  "files": {
    "js/master.bundle.min.js": "sha384-…",
    "css/master.min.css": "sha384-…",
    "js/hub-vault.bundle.min.js": "sha384-…"
  }
}
```
- Thumbprint = first 12 hex of sha256 over the sorted per-file hashes → **deterministic**: same
  content ⇒ same thumbprint ⇒ republish causes no cache churn / no new dir.
- Per-file hashes are SRI-format (sha384) because SRI is per-file, not per-dir.

### B. beginHead_01 landmarks (per site family + template twins)
`beginHead_01` wraps its dist refs in sentinels:
```html
<!--efw:dist--><link rel="stylesheet" href="/dist/css/master.min.css"><script src="/dist/js/master.bundle.min.js"></script><!--/efw:dist-->
```
- Comments are serve-time inert; virgin pages keep working off literal.
- Patch every family's beginHead copy **and the f8-visualstudio-templates twins** (standing rule).

### C. Shared rewriter — `DistRefRewriter`
- **Primary: sentinel splice.** Find `<!--efw:dist-->…<!--/efw:dist-->`, regenerate contents from
  manifest: thumbprinted URLs + `integrity="sha384-…" crossorigin="anonymous"`. Nothing outside
  the sentinels is ever touched.
- **Fallback: anchored-literal patterns** (transition, until fleet re-exports with landmarks):
  `(src|href)=(["'])/dist/(js/master\.bundle\.min\.js|css/master\.min\.css|js/hub-vault\.bundle\.min\.js)\2`
  — quote-aware, case-insensitive, attribute-prefixed. Retire after one full publication cycle.
- **Byte-level I/O**: targets are pure ASCII; read bytes, splice, write bytes. No text decode
  round-trip → no encoding/normalization opinions; output is byte-identical outside the splice.
  (This is why NOT DOM: XML parse dies on browser-tolerant markup — cf. the 14-month ContentFilter
  `&` saga — and aspx `<% %>`; lenient HTML5 DOM serialization normalizes the whole document.)
- **Idempotent** (regeneration overwrites own output; patterns can't match rewritten refs).
- **Tripwire**: malformed sentinels (one marker, nesting) → skip file + log loudly. Unsure = leave
  alone = literal net.
- **SRI only on thumbprinted refs, never literal** (mutable bytes under a fixed hash = outage).

### D. PubBot `pb:upload-dist` (extends UploadDirectoryJob)
Ordered steps (order is a correctness guarantee):
1. Read manifest from expanded src.
2. Copy src → `dest/dist/<thumbprint>/` (skip if dir already exists — deterministic thumbprint).
3. Rewrite site tree on dest (DistRefRewriter over `.htm`/`.aspx`).
4. Copy src → literal `dest/dist/` **last, manifest.json very last** → no reader (browser or
   fixup) can see a manifest whose thumbprint dir isn't on disk yet. Race-safe.
5. Prune `dest/dist/` children matching `^[0-9a-f]{12}$` (regex-guard: literal `js/`,`css/`,`data/`
   can never match) beyond keep-last-3 by mtime.
6. CloudFront invalidation: keep today's enroll for the literal path; thumbprint dirs need none.

XML: swap `pb:upload-directory` → `pb:upload-dist` on the **preview2** lines of both group
templates (Vanilla + DB101). Staging/edit lines stay plain `upload-directory` (literal only —
no CloudFront on that tier, quick bundle tests work untouched).

### E. UploadSiteJob prune hook
Additive copy → after `_CopyDirectory`, call shared `_PruneThumbprints(dest\dist)` (same
guarded regex + keep-3) so preview/final don't accumulate a dir per publish.

### F. Single-doc/directory export fixup (the "virgin page" case)
Quick exports via /admin or page-properties UI drop virgin pages (plain literal refs) on preview2.
- **Today: harmless** — resolves via literal; overwritten at next full publish; and no browser can
  require SRI (see key facts). Degraded, never broken.
- **Fixup anyway** (consistency + preemptive): export-for-preview in these contexts gets an extra
  argument that triggers DistRefRewriter on the emitted file(s), **reading the DEST TIER's own
  `dist/manifest.json`** — NOT webroot's (webroot may hold a newer unpublished bundle). Tier-local
  manifest ⇒ fixup can only write thumbprints that exist on that tier. Manifest absent ⇒ skip ⇒
  literal net. Combined with D-step-4 write ordering, race-safe against concurrent publish.

## Tier/case matrix

| Path | Behavior |
|---|---|
| Full publish → preview2/preview/final | thumbprinted + SRI (rewrite propagates via upload-site) |
| Quick bundle test → edit/staging | literal, untouched workflow, no rewrite, no CloudFront |
| Quick bundle test → preview2 | full pipeline: thumbprint + rewrite ("Bob's your uncle") |
| Single-doc export → preview2 | fixup from tier-local manifest; else literal until next publish |
| Hub (disabilityhubmn.org) | literal `hub-vault.bundle.min.js` from mn.db101.org — **contractual: db101-mn must always dual-copy**; accepted un-cache-busted for now |
| Estimator twm.aspx (VS-deployed, outside PubBot) | literal net |
| Anything missed/unsure | untouched → literal net (works, un-busted) |

Robustness ladder: **sentinel-splice → anchored-pattern fallback → untouched-on-literal.**
Every page lands on a rung; every rung serves.

## Consequences
- Browser + CloudFront cache busted deterministically on every content change → **Enforce
  prerequisite (#18 gate) satisfied**.
- `/dist` CloudFront invalidation becomes redundant for thumbprinted refs (kept for literal).
- SRI lands as a bonus on all rewritten refs.
- Dual copy fleet-wide (disk is cheap); only db101-mn is contractual (Hub).

## Extension: SRI for third-party statics (scorecard-driven, separate phase)

SecurityScorecard flags missing SRI on external scripts. Policy splits on **mutability**, not
ownership (inventoried 2026-07-03):

| Class | Examples found | SRI? | Action |
|---|---|---|---|
| Version-pinned, immutable | jQuery 1.10.x / jQuery-UI 1.10.x from code.jquery.com + ajax.googleapis.com — incl. **public** estimator pages (bp101-sites/planning-*) | **Yes** | Hash is a constant → bake `integrity=` + `crossorigin` into scaffolding source directly (publisher-supplied hashes; **no gulp/manifest needed**). Better: **vendor into /dist** → automatic thumbprint+SRI via this plan's pipeline + removes third-party availability dependency. |
| Rolling/evergreen | Turnstile `api.js`, Facebook SDK, JW Player player scripts, gtag-style loaders | **Never** | Provider redeploys freely → hash mismatch = browser refuses execution = their deploy breaks us. **Worst case: SRI'd Turnstile api.js under Enforce = fleet-wide login lockout on a Cloudflare deploy.** Documented exception; residual scorecard ding accepted or eliminated by removal. |
| Dead refs | Twitter `count.js` (API long gone), `jquery-ui.googlecode.com` (host shut down) | n/a | Delete, don't hash. |

Notes:
- Gulp manifest stays scoped to **our** /dist assets; third-party mutability never enters the
  sentinel region.
- Scorecard sees only public pages → prioritize bp101-sites/planning-* + exported site pages;
  EditSites refs are not exposed.
- Per-file decision (pin+hash vs vendor vs delete) at implementation time; vendoring preferred
  where licensing allows (jQuery: MIT — allows).

## Documentation updates (ship with the change, same commit set)

**`c:\git\f8-system-documentation`** (primary):
- **`2.d.f8 Bundle.md`** — new gulp manifest task: `dist/<bundle>/manifest.json` format
  (thumbprint derivation = 12-hex sha256 over sorted per-file sha384s; determinism guarantee),
  and that the manifest is a publish-time contract consumed by PubBot — not served content.
- **`3.Editing and Publishing Process.md`** — the big one: `pb:upload-dist` job (dual copy,
  rewrite, prune, write ordering), the tier matrix (edit=literal / preview2=rewritten /
  preview+final=inherit via upload-site), keep-3 pruning + the additive-copy rationale, and the
  three quick-turnaround cases incl. the virgin single-doc export fixup (tier-local manifest).
- **`2.a.f8 Template Structure.md`** — the `beginHead_01` landmark contract:
  `<!--efw:dist-->…<!--/efw:dist-->` sentinels, what rewrites them, and an explicit **do not
  "clean up" these comments** warning (they look like cruft in view-source; removing them
  silently degrades that page to pattern-fallback/literal).
- **`How To/Publish a Public Website.md`** — operator verification: how to confirm the
  thumbprint landed (view-source shows `/dist/<tp>/…` + `integrity=`), how to read
  `dist/manifest.json` on a tier, stale-bundle troubleshooting decision tree (literal vs
  thumbprinted ref = which cache story applies).
- **`How To/Clone an Estimator.md`** — one line: estimator `twm.aspx` `/dist` refs are literal
  **by design** (VS-deployed, outside PubBot rewrite); do not hand-thumbprint them.

**Other repos:**
- **`f8-visualstudio-templates`** — beginHead twins get the landmarks (standing patch-the-template
  rule); note the sentinel contract in the template comment itself.
- **`efw.bundle`** — gulpfile header comment on the manifest task (what consumes it, determinism).
- **`PubBotWinService/PubBotJobs.xml`** — inline XML comment at the `pb:upload-dist` swap
  explaining why preview2 lines differ from staging lines.
- **`efw-waf/waf-reviews/turnstile-integration-plan-2026-06-17.md`** — cross-ref: #12 design
  landed here; Enforce gate satisfied by this mechanism.

## Implementation order
1. gulp manifest task (inert everywhere).
2. beginHead_01 landmarks per family + template twins (inert — comments).
3. DistRefRewriter + tests (idempotency, sentinel tripwires, byte-preservation on nasty fixtures).
4. `pb:upload-dist` + UploadSiteJob prune hook + jobs XML swap (preview2 lines only).
5. Validate on one site (HB101-MN or a small DB101) end-to-end incl. quick-turnaround cases 1–3.
6. Single-doc export fixup argument.
7. Fleet publication; after one full cycle, retire pattern-fallback tier.
