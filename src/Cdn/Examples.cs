using System.Collections.Generic;

namespace Efw.Cdn.Examples
{
    // ── Illustrative only — shows the integration points in the f8 codebase. ──

    /// <summary>How Document.ExportForPreview wires into the ambient scope.</summary>
    public class DocumentExportSketch
    {
        private readonly ICdnInvalidator _invalidator;
        private readonly SiteTier _tier; // resolved from the document/site being exported

        public DocumentExportSketch(ICdnInvalidator invalidator, SiteTier tier)
        {
            _invalidator = invalidator;
            _tier = tier;
        }

        /// <param name="relativePath">e.g. "mn/index.htm" or a directory "mn/planning".</param>
        public void ExportForPreview(string relativePath, bool isDirectory)
        {
            // EnterAuto: opens a coalesce scope only if this is the outermost call and we're
            // not under a Suppress scope. Recursive child calls just join (no-op on dispose).
            using (InvalidationScope.EnterAuto(_tier, _invalidator))
            {
                // ... existing export work; may recurse into ExportForPreview per child ...
                if (isDirectory)
                {
                    // foreach child -> ExportForPreview(childPath, ...);  // recursion
                }

                // Enroll what THIS call produced. Under Suppress => ignored. Under coalesce =>
                // buffered and collapsed (a directory's "/dir/*" subsumes the child files).
                InvalidationScope.Enroll(
                    isDirectory ? CdnPaths.ForDirectory(relativePath)
                                : CdnPaths.ForFile(relativePath));
            }
            // On dispose of the OUTERMOST scope: paths collapse to the minimal set and a
            // single InvalidateCdn fires. Single-file manual export => one file path.
            // Manual directory export => one "/dir/*". Nested calls => nothing extra.
        }
    }

    /// <summary>How PubBot brackets a whole publish run.</summary>
    public class PubBotSketch
    {
        private readonly ICdnInvalidator _invalidator;
        public PubBotSketch(ICdnInvalidator invalidator) => _invalidator = invalidator;

        public void RunPublish(string siteRoot, IEnumerable<DocumentExportSketch> docs)
        {
            using (InvalidationScope.Suppress())
            {
                // Every ExportForPreview below records nothing — no per-file invalidations.
                // foreach (var d in docs) d.ExportForPreview(...);
            }

            // One coarse invalidation for the whole published tree, after the run completes.
            _invalidator.InvalidateCdn(SiteTier.Public,
                new[] { CdnPaths.ForDirectory(siteRoot) });
        }
    }
}
