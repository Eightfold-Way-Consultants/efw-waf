# CloudFront Invalidation on Publish — Design

**Date:** 2026-06-24 · **Status:** design (not yet implemented) · supersedes the sketch in memory `cloudfront-invalidation-design`.

## Context / the gap

There is **no** CloudFront invalidation anywhere in `c:\svn\f8` (verified: zero `Amazon.CloudFront` / `CreateInvalidation` / `InvalidateCdn`). Publishing a site updates the origin (IIS, web-04/web-06) but never clears CloudFront, so anything CloudFront caches serves stale until TTL (~24h). HTML pages have short/no TTL so they appeared to update; **static assets** (`/dist/js/*.bundle.min.js`, `/dist/css/*.min.css`) are long-TTL with static filenames, so they lag a full day. Exposed by the Turnstile bundle rollout (manual invalidation of dist `E1ZUT1S4LS09PI` was required).

## Two distinct surfaces (both must be handled)

1. **Content pages** — produced by `Document.Export*` (the `.htm` the CMS exports). Recursive; this is the apex-scope problem below.
2. **Static assets** — `/dist/js`, `/dist/css` (the gulp bundle + compiled CSS). **NOT produced by `Export*`** — deployed by a separate dist-copy step in the publish. The content-export invalidation will NOT cover these. This is the surface that actually failed.

## Core principle: invalidate at the APEX, never per-file

`ExportForPreview` (`Document.cs:2955`) is the **leaf** — one document. The loops are the apex:

| Apex (wrap in scope) | file:line | fans out to |
|---|---|---|
| `ExportAllForPreview` | Document.cs:2584/2597 | `_ExportDocumentsForPreview` → leaf per doc |
| `ExportDirectoryForPreview` | Document.cs:2604 | `_ExportDocumentsForPreview` → leaf per doc |
| `ExportDirectoryForAllPreviewSites` | Document.cs:2616 | per doc → `ExportForAllPreviewSites` (2809) → leaf per **site-version** |
| `ExportAllForStaging` | Document.cs (staging twin) | leaf per doc |
| `_ExportDocumentsForPreview` | Document.cs:2651 | shared loop |

Recursion/re-entrancy is real (apex → doc-loop → site-version-loop → leaf), and PubBot calls an apex once per job. Firing in the leaf would emit hundreds of invalidations per publish.

### Mechanism: ambient, re-entrant invalidation scope

`AsyncLocal<InvalidationScope>` + a `using` token. **Re-entrant: nested `BeginScope()` joins the outermost scope; only the outermost dispose fires.** This collapses apex-within-apex and apex→leaf to ONE invalidation per distribution per top-level operation.

```csharp
public static class CdnInvalidation
{
    private static readonly AsyncLocal<InvalidationScope> _current = new AsyncLocal<InvalidationScope>();

    // Open (or join) a scope. Re-entrant: inner calls return a no-op token; only the
    // outermost token fires on Dispose.
    public static IDisposable BeginScope()
    {
        if (_current.Value != null) return new InnerToken();          // join outer; fire nothing
        var scope = new InvalidationScope();
        _current.Value = scope;
        return new OuterToken(scope, () => { _current.Value = null; scope.Flush(); });
    }

    // Leaf calls this. Scope active -> enroll (no fire). No scope -> fire this one path now.
    public static void Enroll(SiteContext ctx, string urlPath)
    {
        var distId = ResolveDist(ctx);              // null for cms tier -> no-op
        if (distId == null) return;
        var scope = _current.Value;
        if (scope != null) scope.Add(distId, urlPath);
        else Flush(distId, new[] { urlPath });      // single-doc admin save: one path
    }
}
```

- **Leaf enroll points** (the things that write/delete a published file): `ExportForPreview` (2955), `ExportDocument`, `ExportDocumentFromUrl`, `ExportTemplateForPreview`, and `DeleteDiskDocument` (obsolete docs — invalidate the deleted path too). Each computes the site-relative URL path it wrote and calls `CdnInvalidation.Enroll(ctx, path)`.
- **Apex wrap**: each apex method body in `using (CdnInvalidation.BeginScope())`. Because `BeginScope` is re-entrant, it is also safe (and recommended) to wrap the **outermost callers** so the whole operation collapses to one flush:
  - PubBot job (`ExportPreviewSiteJob` / `ExportEditSiteJob`) — wrap the job.
  - CLI `V01.00/ExportForPreview/ExportForPreview.cs` — wrap `Main`.
  - API `DocumentApiHandler.ExportDirectory` — wrap the export call.
  - Single-doc admin saves (`DocumentDetailControl`, `PageWizard`, `CreateCMDocumentControl`) — **no scope**: the lone `ExportForPreview`/`ExportForStaging` → `Enroll` fires that one path immediately.

### Responsibility split (two owners, two flush points)

A publish job is **render-once-to-preview2, then fan-out copies to other destinations**. Ownership:

- **Library `Document.Export*` owns the preview2 (export-target) invalidation.** The scope lives entirely inside the export call tree; the outermost export flush fires the export-target dist. Self-contained — same behavior for PubBot, admin save, CLI, API. Flushes when the export operation returns.
- **PubBot owns the copy invalidations** — it invalidates each destination *wherever the copy went*, resolving the dest dist from each copy job's `UploadTarget`/`SiteID`. PubBot wraps its copy phase in a scope and flushes one invalidation per destination dist at the end.

No cross-cutting whole-job scope. Both owners use the same `CloudFrontInvalidation` (scope buckets by `distId`, Flush emits one `CreateInvalidation` per dist), just in their own region of the job. `Enroll(distId, path | FULL)`: the library passes the **export-target** tier's dist (preview2); PubBot passes each **copy-destination** tier's dist.

### Coalescing (per-dist, on outermost Flush)

For each dist bucket:
- If any `FULL` marker present → fire **`/*`** (a full-site export touched everything).
- Else group enrolled paths by top directory, collapse siblings to `/{dir}/*` (CloudFront wildcard must be the **trailing** char; `/*.htm` is invalid); past a threshold fall back to `/*`.
- A CloudFront invalidation matches **path only, ignoring the cache key** → on a shared dist (preview2 serves all preview2 sites) it clears that path for **all** hosts. Per-host invalidation is impossible; the over-invalidation is unavoidable and acceptable (cache refills) on the low-traffic edit dist.
- **Cost:** a wildcard counts as **one path**; first 1000 paths/mo free, then $0.005/path; max 3000 paths/invalidation. `/*` = 1 path (cheapest, broadest).

### Scope-by-operation summary

| Operation | Enrolls | Dist | Flushed scope |
|---|---|---|---|
| Single-doc save | exact path | source tier | that path |
| Directory export | `/{dir}/*` | source tier | `/{dir}/*` |
| Full-site export (PubBot step 1) | `FULL` | **preview2** | `/*` |
| Directory copy to a destination (PubBot step 2..N) | `/{copieddir}/*` | **destination tier** | `/{copieddir}/*` per dest dist |
| `/dist` copy (UploadDirectoryJob) | `/dist/*` | destination tier | `/dist/*` |

## host/tier → distribution map

Never hardcode. **Per-tier Secrets Manager secrets**, each owned by its edge stack (declared in `edge.yaml` under `Condition: IsPublished`, `SecretString = !Ref Distribution`):
- `efw-waf/dist/preview2` → preview2 dist (e.g. `E1ZUT1S4LS09PI`, s4 origin)
- `efw-waf/dist/public` → public+staging dist (s6 origin)
- cms tier → **no-op** (no CDN)

`ResolveDist(ctx)` maps the `SiteContext` disposition/tier to a secret: Staging/edit → preview2 dist; Final/public → public dist; Preview → preview2 dist. App servers' existing `efw.policy.secrets.read` covers the lookup.

## Static assets (`/dist`) — the surface that failed

`Export*` does not touch `/dist`. The bundle/CSS reach a site through **PubBot copy jobs** — the exact places to instrument:

| Job | file | copy | enroll on success (non-DryRun) |
|---|---|---|---|
| `UploadDirectoryJob` | PubBot/UploadDirectoryJob.cs:68 | `SafeFile.CopyDirectory(src, dest)` — this is how `/dist` ships | `"/" + slashify(SubstituteVariables(DestPath)) + "/*"` → e.g. DestPath `dist` ⇒ `/dist/*`, `dist\js` ⇒ `/dist/js/*` |
| `UploadFileJob` | PubBot/UploadFileJob.cs:37 | `SafeFile.Copy(src, dest)` — single file ("Deploy Config") | `"/" + slashify(dest-relative)` (single path) |

`DestPath` is already **site-relative** to the upload root (`strExpandedDestPath = Path.Combine(GetDiskPath(UpTarget), DestPath)`), so the URL path is just `"/" + DestPath` with `\`→`/` (there's already a `_DeRoot` helper). The tier→dist comes from `UpTarget`/`SiteID` on the job — so **`ResolveDist` must accept the tier from either a `SiteContext` (content export) or an `UploadTarget` (upload job).** These jobs run inside the PubBot job group, so their enrollments coalesce into the job's single flush.

- **Short term:** add the enroll call at the end of `_RunJob` in `UploadDirectoryJob` + `UploadFileJob` (only when not `DryRun` and the copy succeeded). Wrap the PubBot job group in the outer scope so dir + config-file copies collapse to one flush per dist.
- **Long term (preferred):** **fingerprint/version the asset URLs** (`master.<hash>.bundle.min.js` or `?v=<build>`), emitted by `beginHead_01.cs` (currently hardcodes `/dist/js/master.bundle.min.js:368` and `/dist/css/master.min.css:369`). Immutable URLs ⇒ **no invalidation ever needed** for assets, and no stale-bundle risk on the Hub — removes the coordination hazard the Turnstile rollout hit.

## IAM

One new customer-managed policy `efw.policy.cloudfront.invalidate` (`cloudfront:CreateInvalidation/GetInvalidation/ListInvalidations` scoped to the preview2 + public dist ARNs), attached to `efw.web.04.role` + `efw.web.06.role`. JSON at `iam/efw.policy.cloudfront.invalidate.json`. No new secrets perm (existing `efw.policy.secrets.read` covers the dist-id reads).

## Behavior / edge cases

- **Fire-and-log, non-blocking:** never fail a publish because invalidation errored; log and continue (eventually consistent, ~secs–mins).
- **Deletes:** `DeleteDiskDocument` enrolls the removed path so the CDN stops serving it.
- **cms tier:** `ResolveDist` returns null → `Enroll` is a no-op (no CDN in front).
- **Exceptions inside the loop:** the existing per-doc try/catch must not abort the scope; enroll only on successful write.
- **Async/threads:** `AsyncLocal` flows across `await`; if any apex spins work onto other threads without flowing context, those enrollments would miss the scope — keep export synchronous within the scope (it is today).

## Implementation checklist

1. `CdnInvalidation` class (scope, Enroll, ResolveDist, Flush, coalesce) — new file in the f8 library.
2. Leaf enroll calls in `ExportForPreview` / `ExportDocument` / `ExportDocumentFromUrl` / `ExportTemplateForPreview` / `DeleteDiskDocument` (compute URL path from the destination).
3. `using (BeginScope())` in the 4 apex methods + `_ExportDocumentsForPreview`.
4. Outer scope in PubBot jobs, CLI `Main`, API `ExportDirectory`.
5. Dist-deploy hook for `/dist/*` (short term) and/or asset fingerprinting in `beginHead_01.cs` (long term).
6. `efw-waf/dist/preview2` + `efw-waf/dist/public` secrets in `edge.yaml`; `efw.policy.cloudfront.invalidate` on both web roles.
7. Tests: single-doc save → 1 path; directory publish → 1 coalesced flush; full-site publish → `/*`; PubBot job → exactly one flush per dist.

## Open questions

- Disposition → dist mapping: confirm Preview vs Final vs Staging each map to the correct distribution (preview2 vs public).
- Coalesce threshold (when to fall back from `/{dir}/*` lists to `/*`).
- Do we want asset fingerprinting now (kills the whole static-asset invalidation problem) vs the `/dist/*` deploy hook as a stopgap.
