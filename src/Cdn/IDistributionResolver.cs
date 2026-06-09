namespace Efw.Cdn
{
    /// <summary>
    /// Resolves a <see cref="SiteTier"/> to its CloudFront distribution id.
    /// Never hardcode ids — each edge stack owns a per-tier secret (efw-waf/dist/{tier})
    /// whose value is !Ref Distribution.
    /// </summary>
    public interface IDistributionResolver
    {
        /// <summary>Distribution id for the tier, or null if the tier is not fronted (Cms).</summary>
        string ResolveDistributionId(SiteTier tier);
    }
}
