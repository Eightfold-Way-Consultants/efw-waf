using System;
using System.Collections.Generic;
using System.Linq;

namespace Efw.Cdn
{
    /// <summary>
    /// Path helpers for CloudFront invalidation. Two rules baked in:
    ///   1. The wildcard '*' must be the LAST character ("/a/b/*" valid, "/a/*.htm" invalid).
    ///   2. Invalidation matches path only (ignores cache key), so it clears all Host/state
    ///      variants of a path — that's expected.
    /// </summary>
    public static class CdnPaths
    {
        /// <summary>Normalize to a leading-slash, single-slash path.</summary>
        public static string Normalize(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return "/";
            var p = path.Trim().Replace('\\', '/');
            if (!p.StartsWith("/")) p = "/" + p;
            while (p.Contains("//")) p = p.Replace("//", "/");
            return p;
        }

        /// <summary>Invalidation path for a file (e.g. "/mn/index.htm").</summary>
        public static string ForFile(string relativePath) => Normalize(relativePath);

        /// <summary>Invalidation path for a directory sub-tree (trailing wildcard, e.g. "/mn/dir/*").</summary>
        public static string ForDirectory(string relativeDir)
        {
            var p = Normalize(relativeDir);
            if (!p.EndsWith("/")) p += "/";
            return p + "*";
        }

        /// <summary>
        /// Collapse an enrolled set to the minimal covering set: drop any path already
        /// covered by a directory wildcard ancestor, and dedupe. This is what turns a
        /// recursive per-file export into one "/dir/*" invalidation.
        /// </summary>
        public static IReadOnlyList<string> Collapse(IEnumerable<string> paths)
        {
            var norm = paths.Select(Normalize).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

            // Wildcard bases: "/a/b/*" -> "/a/b/"
            var wildcardBases = norm
                .Where(p => p.EndsWith("/*"))
                .Select(p => p.Substring(0, p.Length - 1)) // keep trailing slash
                .ToList();

            bool CoveredByAncestor(string p)
            {
                // The base of this entry ("/a/b/*" -> "/a/b/", "/a/b.htm" -> "/a/b.htm").
                var basePath = p.EndsWith("/*") ? p.Substring(0, p.Length - 1) : p;
                foreach (var w in wildcardBases)
                {
                    if (string.Equals(basePath, w, StringComparison.OrdinalIgnoreCase))
                        continue; // a wildcard never covers itself
                    if (basePath.StartsWith(w, StringComparison.OrdinalIgnoreCase))
                        return true;
                }
                return false;
            }

            return norm.Where(p => !CoveredByAncestor(p)).ToList();
        }
    }
}
