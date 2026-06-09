namespace Efw.Cdn
{
    /// <summary>
    /// The four content tiers. Caching (and therefore invalidation) is driven by tier,
    /// not by origin. See waf-cloudfront-migration.md "Infrastructure as Code".
    /// </summary>
    public enum SiteTier
    {
        /// <summary>Live CMS edit-sites (db101-*/hb101-*/vets101.eightfoldway.com). Dynamic — nothing cached, invalidation is a no-op.</summary>
        Cms,

        /// <summary>Rapid-prototyping published preview sites (preview2-*). Static set cached. Maps to the preview2 distribution.</summary>
        Preview2,

        /// <summary>Published staging (preview-*) and public sites. Same origin + cache model → one distribution.</summary>
        Public
    }
}
