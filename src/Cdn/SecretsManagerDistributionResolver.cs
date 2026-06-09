using System;
using System.Collections.Concurrent;
using System.Threading;
using Amazon.SecretsManager;            // NuGet: AWSSDK.SecretsManager
using Amazon.SecretsManager.Model;

namespace Efw.Cdn
{
    /// <summary>
    /// Resolves tier → distribution id from per-tier Secrets Manager secrets, reusing the
    /// app servers' existing Secrets Manager read access (efw.policy.secrets.read) — no new IAM.
    ///
    /// Each edge CloudFormation stack owns one secret holding just its distribution id:
    ///   efw-waf/dist/preview2  ->  "E1AAAA..."
    ///   efw-waf/dist/public    ->  "E2BBBB..."
    /// (No secret for the cms tier — invalidation there is a no-op.)
    ///
    /// Cached per tier in-process; the id changes only when a distribution is rebuilt.
    /// </summary>
    public sealed class SecretsManagerDistributionResolver : IDistributionResolver
    {
        private readonly IAmazonSecretsManager _client;
        private readonly string _prefix;
        private readonly ConcurrentDictionary<SiteTier, string> _cache =
            new ConcurrentDictionary<SiteTier, string>();

        public SecretsManagerDistributionResolver(
            IAmazonSecretsManager client, string secretPrefix = "efw-waf/dist/")
        {
            _client = client ?? throw new ArgumentNullException(nameof(client));
            _prefix = secretPrefix;
        }

        public string ResolveDistributionId(SiteTier tier)
        {
            if (tier == SiteTier.Cms) return null; // not fronted — caller no-ops

            return _cache.GetOrAdd(tier, t =>
            {
                var secretId = _prefix + t.ToString().ToLowerInvariant(); // efw-waf/dist/preview2 | /public
                var resp = _client.GetSecretValueAsync(
                    new GetSecretValueRequest { SecretId = secretId },
                    CancellationToken.None).GetAwaiter().GetResult();
                return resp.SecretString?.Trim();
            });
        }

        /// <summary>Drop the cache for a tier (call if its distribution was rebuilt mid-process).</summary>
        public void Invalidate(SiteTier tier) => _cache.TryRemove(tier, out _);
    }
}
