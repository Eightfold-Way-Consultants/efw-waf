using System.Collections.Generic;

namespace Efw.Cdn
{
    /// <summary>
    /// Low-level primitive: map a tier to its distribution and issue one CloudFront
    /// invalidation for the given paths. Dumb on purpose — coalescing and suppression
    /// live in <see cref="InvalidationScope"/>, not here.
    /// </summary>
    public interface ICdnInvalidator
    {
        /// <summary>
        /// Issue a single CreateInvalidation for the (already-collapsed) paths.
        /// No-op for SiteTier.Cms or when paths is empty. Never throws — failures are
        /// logged; a CDN hiccup must not break a publish/export.
        /// </summary>
        void InvalidateCdn(SiteTier tier, IReadOnlyList<string> paths);
    }
}
