using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Amazon.CloudFront;          // NuGet: AWSSDK.CloudFront
using Amazon.CloudFront.Model;

namespace Efw.Cdn
{
    /// <summary>
    /// Default <see cref="ICdnInvalidator"/> — resolves the distribution and calls
    /// CloudFront CreateInvalidation. Uses the app server's existing IAM role; the role
    /// needs cloudfront:CreateInvalidation + cloudfront:GetInvalidation on our dist ARNs.
    /// </summary>
    public sealed class CdnInvalidator : ICdnInvalidator
    {
        // CloudFront hard limit: max 3000 objects per invalidation. Chunk above this.
        private const int MaxPathsPerInvalidation = 3000;

        private readonly IAmazonCloudFront _client;   // construct against us-east-1
        private readonly IDistributionResolver _resolver;
        private readonly Action<string, Exception> _log; // (message, optionalError)

        public CdnInvalidator(
            IAmazonCloudFront client,
            IDistributionResolver resolver,
            Action<string, Exception> log = null)
        {
            _client = client ?? throw new ArgumentNullException(nameof(client));
            _resolver = resolver ?? throw new ArgumentNullException(nameof(resolver));
            _log = log ?? ((m, e) => { });
        }

        public void InvalidateCdn(SiteTier tier, IReadOnlyList<string> paths)
        {
            if (paths == null || paths.Count == 0) return;

            var distId = _resolver.ResolveDistributionId(tier);
            if (string.IsNullOrEmpty(distId))
            {
                // Cms (or unmapped) tier — nothing cached, nothing to do.
                return;
            }

            var items = paths.Select(CdnPaths.Normalize).Distinct().ToList();

            try
            {
                foreach (var chunk in Chunk(items, MaxPathsPerInvalidation))
                {
                    var req = new CreateInvalidationRequest
                    {
                        DistributionId = distId,
                        InvalidationBatch = new InvalidationBatch
                        {
                            // Must be unique per call.
                            CallerReference = Guid.NewGuid().ToString("N"),
                            Paths = new Paths { Quantity = chunk.Count, Items = chunk }
                        }
                    };

                    // CreateInvalidation returns quickly (status InProgress) — we do NOT
                    // wait for the invalidation to complete. Eventually consistent.
                    var resp = _client.CreateInvalidationAsync(req, CancellationToken.None)
                                      .GetAwaiter().GetResult();

                    _log($"CDN invalidation {resp.Invalidation.Id} on {distId} ({chunk.Count} paths): "
                         + string.Join(", ", chunk.Take(10)) + (chunk.Count > 10 ? " …" : ""), null);
                }
            }
            catch (Exception ex)
            {
                // Fire-and-log: a CDN failure must never break a publish/export.
                _log($"CDN invalidation FAILED on {distId} for tier {tier}", ex);
            }
        }

        private static IEnumerable<List<string>> Chunk(List<string> items, int size)
        {
            for (var i = 0; i < items.Count; i += size)
                yield return items.GetRange(i, Math.Min(size, items.Count - i));
        }
    }
}
