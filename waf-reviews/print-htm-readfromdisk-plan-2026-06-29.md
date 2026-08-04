# print.htm read-from-disk rework — implementation plan (2026-06-29)

Goal: eliminate the print.htm N+1 loopback render (~29 min of a full-fleet preview export)
by having menuScrape read the already-exported sibling pages from local disk instead of
re-rendering each child via a synchronous HTTP loopback. Planning only — not yet built.
Mobile-menu fix already shipped separately (menuDropdown_03, SVN r9003).

## Feasibility — CONFIRMED
The edit-site render and the preview export output are local paths on the SAME box, e.g. site 9 (AZ):
- edit/staging render host: `c:\inetpub\wwwroot\db101-az.eightfoldway.com\`
- preview export output (SiteContext.PreviewPath): `c:\inetpub\wwwroot\preview2-az.db101.org`
All 23 sites use local `c:\inetpub\wwwroot\...` (pulled from CM00). So menuScrape can open the
sibling's exported file directly. No UNC, no cross-machine hop. Fallback covers any exception.

## How the on-disk file is produced (the path to reproduce)
Writer = `Document.ExportTemplateForPreview` (ContentManager\Document.cs:3202-3228):
`oSavePath = SafePath.ConcatDiskPath(strPreviewPath, Directory.GetDirectoryPath(ctx, oDoc.NodeID))`;
`strPath = oSavePath.FullName + "\\" + oDoc.Name` (+ LargePrint variant). For Preview disposition
`strPreviewPath == ctx.PreviewPath`. Content = loopback stream through s_oPreviewFilters (only a
__VIEWSTATE strip, which sits in <form> ABOVE <!--start-core--> → discarded by the clip in both paths).
PARITY: on-disk core == loopback core EXCEPT menu hrefs (full URL on disk vs #p_<id> from _stacked) —
which the rewrite restores. Proven byte-identical otherwise by prior probes.

## Steps
1. **Extract a seam in menuScrape_01** (behavior-preserving refactor). Pull child-core acquisition
   (lines 140-173: params, ExportForPreviewStream loopback, read, clip start-core/end-core) into
   `protected virtual string _GetChildCore(MenuItemPage oItem, DocumentInfo oDoc)` (returns clipped
   core or null). _RenderMenuItem keeps wrapper div, IsEditMode bail, `<a name="p_<id>">` anchor,
   output.Write, bookkeeping. Harden: guard `IndexOf(start) >= 0` before Substring; return null on
   missing marker. Ships independently, inert.
2. **New `menuScrape_02 : menuScrape_01`** (new file, same namespace → reflection-instantiable).
   (a) Build a URL→`#p_<id>` rewrite map once per render, keyed to **ONLY the documents menuScrape
   actually stacks** — pre-walk the scraped menu tree applying `_ShouldRenderMenuItem` (Show &&
   !obsolete && exported) so the map contains exactly the items that get an `<a name="p_<id>">` anchor
   planted. key=oItem.URL (+ HtmlAttributeEncode form), value="#"+oItem.Anchor(), only Anchor().Length>0.
   CORRECTNESS (user 2026-06-29): the rewrite must apply ONLY to links whose target is in this stacked
   list. (i) prevents dangling `#p_<id>` for tree items that aren't stacked; (ii) leaves top-nav (Main3)/
   footer/body links to NON-stacked pages as full URLs (they're outside the combined doc). Because the
   map holds only stacked docs, non-stacked links simply don't match — no extra scoping needed.
   (b) Override
   _GetChildCore: resolve sibling on-disk path (Step 4, honor LargePrint); if missing/unparseable →
   `return base._GetChildCore(...)` (loopback fallback); else read, clip core, apply uniform quoted-
   attribute href replace from the map (restores #anchor for sidebar/mobile/storytelling/ANY menu),
   return. House style = string ops; HtmlAgilityPack referenced as fallback. Match on full quoted
   value `="url"` (encoded+raw, both quote styles) to avoid over-match.
3. **Per-child loopback fallback** (Step 2b) → output can never silently drop a child; PubBot
   ordering becomes a perf optimization, not a correctness requirement. Safe for all export callers.
4. **Extract shared path resolver** `Document.GetPreviewDiskPath(ctx, oDoc, strPreviewPath)` from the
   inline computation (Document.cs:3204/3210-3212). Writer + reader share one source of truth.
5. **PubBot defer pass** in `Document._ExportDocumentsForPreview` (~2723-2790): partition rows →
   Pass 1 = non-print pages (existing parallel/DOP logic unchanged), Pass 2 = `Name=="print.htm"`
   (OrdinalIgnoreCase), run SERIALLY after Pass 1 so all siblings are on disk. Keep total/completed
   continuous for the progress callback. 1-4 print.htm/site. Optional appSetting
   `PubBot.DeferredExportNames` as kill-switch. Benefits all preview entry points.
6. **Flip the slot to menuScrape_02** — per-page CONFIG change (template class string in SiteDict,
   reflection-instantiated), not code. Rollout/rollback lever: flip one site's print.htm, soak, fan
   out; revert by flipping back. Then patch the f8-visualstudio-templates scaffold (memory rule).

## Ships independently vs together
- Inert until a slot references it: Steps 1, 2, 4 — land/deploy first, zero runtime effect.
- Low-risk alone: Step 5 (reordering normal pages has no functional effect, only timing).
- Activation: Step 6, one site at a time. Speedup needs Step 5 already deployed (else fallback keeps
  output correct but no speed win).

## Risks (all mitigated)
1. Cross-machine path — verified local; fallback covers exceptions. 2. Stale/missing sibling →
   fallback. 3. Href over/under-match → exact quoted-attribute match on oItem.URL; HAP fallback;
   encode query-string `&`→`&amp;` like WriteAttribute. 4. Core-marker absence → IndexOf guard →
   fallback. 5. LargePrint/Printable export may not route through _ExportDocumentsForPreview → siblings
   absent → fallback; honor LargePrint in path; out of scope to optimize, must not regress.
   6. Task-4100 (scripts in stacked pages) pre-existing, unrelated, no new regression. 7. _print param
   irrelevant to core.

## Verification
- PARITY: capture current menuScrape_01 print.htm from preview2 disk; deploy 1-5, flip one print.htm
  to _02, re-export; diff. After normalizing the intended href→#p_<id> delta, must be identical. Assert
  every #p_<id> has a matching `<a name="p_<id>">` (no dangling); links OUTSIDE the stack stay URLs.
- WALL-TIME: use the /f8-export-monitor skill before/after; print.htm RenderTime (Document.cs:3275)
  should drop 1-2 orders of magnitude; remove the ~29-min contribution.
- FALLBACK: remove one child's on-disk file in a scratch export; confirm it still appears (loopback) +
  a warning traced.

## Critical files
- PageBuild\PageBuild.UI\PageBuild.UI.Template\menuScrape_01.cs (extract seam; menuScrape_02 beside it)
- ContentManager\Document.cs (extract GetPreviewDiskPath; defer pass in _ExportDocumentsForPreview ~2723)
- menuTextUL_01.cs:332-339,473-484 (rewrite reference); MenuItemPage.cs:135-162 (URL/Anchor source);
  Directory.cs:80-112 (GetDirectoryPath).
