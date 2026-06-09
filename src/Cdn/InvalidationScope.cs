using System;
using System.Collections.Generic;
using System.Threading;

namespace Efw.Cdn
{
    /// <summary>
    /// Ambient invalidation control for the publish/export pipeline. Collapses invalidation
    /// to the OUTERMOST operation and lets PubBot suppress fine-grained per-file calls.
    ///
    /// Why this exists: <c>Document.ExportForPreview</c> is the recursion leaf — PubBot calls
    /// it repeatedly, and a manual directory export calls it once per file recursively.
    /// Invalidating inside it unconditionally would fire hundreds of invalidations.
    ///
    /// Usage:
    ///   • PubBot run:               using (InvalidationScope.Suppress()) { ...export loop... }
    ///                               then PubBot issues ONE coarse InvalidateCdn at end-of-job.
    ///   • ExportForPreview (any):   using (var s = InvalidationScope.EnterAuto(tier, invalidator))
    ///                               { ...export (may recurse)...; InvalidationScope.Enroll(path); }
    ///       - outermost manual call owns a coalesce scope → collapses + fires once on dispose
    ///       - recursive/nested calls join the existing scope → no-op on dispose
    ///       - under a Suppress scope → Enroll is a no-op
    ///
    /// AsyncLocal so it flows across awaits; a lock guards the path list against parallel recursion.
    /// </summary>
    public sealed class InvalidationScope : IDisposable
    {
        private enum Mode { Coalesce, Suppress }

        private static readonly AsyncLocal<InvalidationScope> _current = new AsyncLocal<InvalidationScope>();

        private readonly Mode _mode;
        private readonly SiteTier _tier;
        private readonly ICdnInvalidator _invalidator;
        private readonly InvalidationScope _previous;
        private readonly bool _owns;            // true only for the scope that set _current here
        private readonly List<string> _paths;   // coalesce buffer (owner only)
        private readonly object _gate = new object();
        private bool _disposed;

        private InvalidationScope(Mode mode, SiteTier tier, ICdnInvalidator invalidator, bool owns)
        {
            _mode = mode;
            _tier = tier;
            _invalidator = invalidator;
            _previous = _current.Value;
            _owns = owns;
            _paths = owns && mode == Mode.Coalesce ? new List<string>() : null;
        }

        /// <summary>
        /// Suppress all enrollment for the duration (PubBot). Nested ExportForPreview calls
        /// record nothing; the caller is responsible for its own coarse invalidation.
        /// </summary>
        public static IDisposable Suppress()
        {
            var scope = new InvalidationScope(Mode.Suppress, default, null, owns: true);
            _current.Value = scope;
            return scope;
        }

        /// <summary>
        /// Open a coalescing scope if none is active and we're not suppressed; otherwise
        /// JOIN the active scope (the returned handle is a no-op on dispose). The outermost
        /// owner collapses the enrolled paths and fires exactly one invalidation on dispose.
        /// </summary>
        public static IDisposable EnterAuto(SiteTier tier, ICdnInvalidator invalidator)
        {
            var current = _current.Value;
            if (current != null)
            {
                // Already inside a scope (suppress or coalesce) — join it, own nothing.
                return new InvalidationScope(current._mode, tier, invalidator, owns: false);
            }

            var scope = new InvalidationScope(Mode.Coalesce, tier, invalidator, owns: true);
            _current.Value = scope;
            return scope;
        }

        /// <summary>
        /// Enroll a path (from ExportForPreview). Suppressed → ignored. Coalescing → buffered
        /// on the owner. No active scope → invalidate immediately (defensive; EnterAuto normally
        /// guarantees a scope).
        /// </summary>
        public static void Enroll(string path)
        {
            var current = _current.Value;
            if (current == null) return;             // no scope: nothing buffered (caller chose not to EnterAuto)
            if (current._mode == Mode.Suppress) return;

            // Walk to the owning coalesce scope (the one holding the buffer).
            var owner = current;
            while (owner != null && owner._paths == null) owner = owner._previous;
            if (owner == null) return;

            lock (owner._gate) owner._paths.Add(path);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            // Joined (non-owning) handles never touched _current and never fire.
            if (!_owns) return;

            _current.Value = _previous;

            if (_mode != Mode.Coalesce) return;     // Suppress owner: nothing to fire

            List<string> snapshot;
            lock (_gate) snapshot = new List<string>(_paths);
            if (snapshot.Count == 0) return;

            var collapsed = CdnPaths.Collapse(snapshot);
            _invalidator?.InvalidateCdn(_tier, collapsed);
        }
    }
}
