# PubBot public-tier cache-invalidation gap — CUTOVER BLOCKER

**Date:** 2026-07-27
**Status:** FIXED — committed SVN r9074, deployed 2026-07-27. (Was: cutover blocker for the public /
web-06 / `efw-waf-edge-public` CloudFront cutover.) Behavioral confirmation on next real publish per
"Verify after fixing" below.
**Fix (2 lines):** (1) `UploadSiteJob` enrolls a coarse `/*` invalidation on its destination tier;
(2) `PubBotJob._CfTier` maps `ePreview`/`eStaging` → `"public"` (they share the public dist) so the
enroll lands. Details in "Fix (option #1)" below.

---

## Summary

Once the public tier is behind CloudFront, **a normal content publish will not clear the
public CloudFront cache for the cacheable content set** — `*.htm`, `/master_images/*`,
`/master_documents/*`, `/documents/*`, `/images/*`. Those are exactly the objects a content
publish changes. The publish job completes green, PubBot reports OK, and CloudFront keeps
serving the **old** pages until the cache TTL expires. Silent stale-prod on every publish.

This is the precise failure the invalidate-on-publish work was built to prevent — and it is
un-covered on the one tier (public) that the cutover is about. It is **latent only because public
is not yet DNS-cut-over to CloudFront**; the moment it is, this becomes live.

## Root cause — the copy seam

The invalidation design has two owners (see `cloudfront-invalidation-design-2026-06-24.md`):

- **Export side** (`Document.Export*`): owns the export-target invalidation, wraps a re-entrant
  `AsyncLocal` scope, and flushes one coarse `/*`. It *does* have correct public wiring —
  `Document.cs` `_CfTier(Disposition.Final) → "public"`, and `ExportAllForPreview(ctx, Final)`
  enrolls `public /*` (Document.cs:2674, 2689).
- **PubBot copy side**: owns invalidating copy destinations. `UploadDirectoryJob`,
  `UploadDistJob`, and `UploadFileJob` each enroll immediately (no scope on the PubBot side, so
  each fires a synchronous `CreateInvalidation` at the call site).

**The publish path takes neither public invalidation.** "Upload Final" exports to the **preview2**
disposition, then reaches the final tier by **copying `preview2 → final` via `UploadSiteJob`**:

```
export-edit-site
  export-preview-site        -> Document.Export*(Preview) : coalesced scope, ONE preview2 /*   (export side)
    upload-dist  ->preview2   -> UploadDistJob : /dist/* if bundle changed + coarse /* if pages rewritten
      upload-site preview2->final  -> UploadSiteJob : *** enrolls NOTHING ***
        upload-file web.config      -> UploadFileJob : invalidates web.config (a no-op; *.config not cached)
```

- `ExportAllForPreview(Final)` — the one method that would fire `public /*` — is **never called on
  the publish path** (final is reached by copy, not by a Final-disposition re-export).
- `UploadSiteJob` (the big whole-site tree copy) is the *only* upload job that enrolls no
  invalidation. It extends `UploadJob` directly and neither it nor the base enrolls.
- `upload-dist`'s coarse `/*`-on-rewrite fires on **its own `UpTarget` = `preview2`**, not final.

So on an "Upload Final", the public dist (`E14TU8NPRHUI0M`) receives only the `web.config`
invalidation — which is a practical no-op (IIS won't serve `*.config`; CloudFront doesn't cache it).
Nothing invalidates the changed content pages.

## Why it hasn't bitten yet — and why it hits TWO tiers, not one

- **Public** host DNS is not yet cut over (`mn.db101.org → s6.db101.org`, origin-direct); the public
  dist has an empty/unused cache, so a missing invalidation has no visible effect *yet*.
- **Preview (staging) is the same bug on the same dist.** Per the architecture, the public
  distribution's `*.db101.org` wildcard serves **both** the public (`mn.db101.org`) and staging
  (`preview-mn.db101.org`) aliases — there is no separate preview/staging distribution (only
  `edge-preview2` and `edge-public` exist; `preview2-*` is carved to the preview2 dist by
  specific-alias override, everything else `*.db101.org` lands on the public dist). So the
  whole-site copy to the `preview` tier (`dest-target="preview"` → `ePreview`) also lands on the
  public dist and will go stale-on-publish the moment `preview-*` cuts over.
- **Second defect — the tier→dist key is mismapped.** `_CfTier(ePreview)` returns `"preview"` and
  `_CfTier(eStaging)` returns `"staging"` (PubBotJob.cs:81-82) — **neither is a distribution.** Both
  tiers ride the public dist, so both must resolve to `"public"`. Even once `UploadSiteJob` enrolls,
  a `preview` publish would look up a non-existent dist and silently no-op. `eFinal→"public"` is
  already correct.
- **Fingerprinting is NOT a mitigation.** Fingerprinted `/dist/{thumbprint}/` dirs are immutable by
  name, so they never need clearing — orthogonal to content-page staleness. It does not rescue
  `*.htm`/images/documents.

## Fix (option #1 — chosen) — TWO lines

1. **`UploadSiteJob._RunJob()` enrolls** the destination invalidation the sibling copy jobs already
   have: a coarse `/*` on the destination tier, at the end of the method (after
   `_RetryFailedCopies()` and the obsolete-kill so it covers copies *and* deletions), guarded by
   `!DryRun`. Add a `protected _EnrollDestInvalidation()` mirroring `UploadDirectoryJob`'s, enrolling
   `_CfTier(UpTarget)` + `CloudFrontInvalidation.FULL`.
2. **`PubBotJob._CfTier`: `ePreview` and `eStaging` → `"public"`** (they share the public dist), so
   the enroll actually lands. Without this, a `preview`/`final` whole-site publish invalidates
   nothing — the same bug, relocated from "no code" to "wrong dist key."

- Coarse `/*` is correct: a whole-site copy touched arbitrary content across the tree, and
  invalidation is path-only (clears the path for all hosts on the dist) — same rationale as the
  export-side `ExportAllForPreview` FULL. (Narrowing this is future work — see below.)
- Since the PubBot side opens no scope, this fires immediately when the upload-site job runs, before
  the chained `web.config` config-fixup job — fine (invalidation = "next fetch refetches from
  origin"; the fixup only touches uncached `web.config`).
- Path-only invalidation on the shared dist means a `preview-*` staging publish also clears the
  matching paths from the **public** hosts' cache (correctness-safe refill; staging churns public's
  cache). Accepted for now; the per-site precision options below remove it.

### Options considered and rejected

- **#2 — route final publish through `ExportAllForPreview(Final)`** so the export-side `public /*`
  fires. Rejected: changes the publish model from copy to re-export (heavier, re-renders instead of
  copying the already-rendered preview2 tree).
- **#3 — wrap the PubBot job group in one `BeginScope`** to coalesce per-job enrolls. Rejected — and
  it **does not even work as described**: PubBot jobs run on separate queue-worker threads, and the
  scope is an `AsyncLocal`, which does not span threads, so a scope opened in one job is invisible to
  its siblings. Real fleet-coalescing would need a run-level dedup keyed off `GroupName`, not
  `BeginScope`. Out of scope for the fix; a possible later efficiency pass (the several identical
  `/*` calls in a fleet publish are redundant — any one clears the dist — but they are cheap and
  fire-and-log, so not urgent).

## Per-site invalidation precision (future work — NOT part of the fix)

Coarse `/*` on the shared dist over-invalidates: one site's publish refills every site's matching
paths. Correctness-safe and cheap, but imprecise. Options if precision is ever wanted, best-first:

- **Invalidation by Cache Tag** (AWS launched 2026-05-04) — purpose-built for per-object purge on a
  shared multi-tenant distribution. Origin returns a header (default `x-amz-meta-cache-tag`) with
  comma-separated tags; IIS/web-06 stamps `site:{state}` (it knows the site from the binding/Host);
  purge with `create-invalidation --paths "#site:mn"` clears only that site's objects regardless of
  path, `<5s` p95, ≤50 tags/object, 256 chars each. No dist sprawl, no Lambda@Edge. **Verify before
  betting:** pricing, region/dist-type support/GA, and the warm-cache caveat (only objects fetched
  *after* tagging is enabled carry the tag). This is the clean end state.
- **Narrow `/*` → `/{state}/*`** — the cheap interim, off the existing URL structure. The bulk of a
  DB101 site's content is path-prefixed by state (`/mn/…`), and only that state's hosts even have
  `/{state}/*` objects cached, so a state publish enrolling `/{state}/*` (plus a small fixed shared
  set) is near-per-site with **zero new infrastructure**. The export side already walks per-document,
  so the state prefix is in hand. Residue that isn't state-prefixed — `/master_images`,
  `/master_documents`, `/documents`, `/images`, glossary `/g`, `/dist` — is either shared-by-nature
  (a change legitimately affects all sites) or fingerprinted (`/dist`, never purged).
- **Host-in-cache-key path** (rewrite URI to `/§/{host}/…` so the path namespace distinguishes
  sites) — **rejected.** AWS docs: the cache key is based on the *original viewer request*, and a
  function that rewrites the URI requires invalidating *both* URIs; plus stripping before origin
  needs Lambda@Edge. Cache tags obsolete this.
- **Per-site distributions** — clean isolation, but dozens of dists + alias/cert sprawl. The "heavy"
  option; not worth it given cache tags exist.

## Post-publication cache warming (considered — DEPRIORITIZED, with a carve-out)

Idea: after publish + invalidation, request every exported URL through the public CloudFront
hostname so the edge refills from origin and end-users rarely hit a cold miss. Composes correctly
(publish → invalidate → wait for the invalidation to reach **Completed**, gating on the `GetInvalidation`
id PubBot already logs, else the warm re-caches stale → warm). But as a **blanket every-URL pass its
ROI here is low**, for two structural reasons:

- **Edge locality.** A warmer running from one place primes only the POP that serves *its* requests.
  CloudFront has hundreds of POPs; a user in Minneapolis hits the Minneapolis edge, which a us-west
  warm pass never touched → they still cold-miss. Warming the edges users actually hit needs
  distributed warmers near the (per-state concentrated) audience — a project, not a PubBot pass.
- **The cached objects are cheap.** CloudFront caches static exported files (`.htm`, images,
  documents); a cold miss is one sub-second origin file-serve, once, per object/POP/first-visitor.
  A blanket pass is tens of thousands of synthetic requests per fleet publish (~4000 objects/site ×
  13+ states) re-loading the origin you just taxed with the export — to shave that one-time latency.
  And the genuinely slow surface, `/planning/*` (the estimator), is **not cached**, so warming can't
  touch it.

**Carve-out — the version worth keeping:** prime only the **hot set** (each state's homepage + top
landing pages), post-cutover, gated on invalidation-Completed. Small, high-traffic, worth priming;
small enough that edge-locality matters less; and it blunts the coarse-`/*` cross-site refill for the
pages everyone lands on. "Every exported URL" is overkill; "the 5–10 pages everyone lands on" is
defensible. Even so, natural first-visitor warming usually suffices for static content, so this is
optional polish, not a requirement. Per-site *invalidation* precision (cache tags / `/{state}/*`)
attacks the root concern more directly than warming does.

## Verify after fixing

- A public publish (once cut over) fires a `CreateInvalidation` on `E14TU8NPRHUI0M` covering the
  content pages — check the `CloudFrontInvalidation` trace line (`invalidated E14TU8NPRHUI0M: /* -> <id>`).
- Change a `.htm` page, publish, confirm the edge serves the new bytes without waiting for TTL.
- Confirm a `preview` (staging) publish now enrolls against the **public** dist (post `_CfTier` fix),
  not a phantom `"preview"` tier.
- Confirm dry-run enrolls nothing.

## Related

- `cloudformation/README.md` (deploy order, DNS cutover model), `efw-waf-cfn-deploy-tooling`.
- Memory: `pubbot-dist-copy-invalidation`, `cloudfront-invalidation-design`, `site-tier-architecture`.
