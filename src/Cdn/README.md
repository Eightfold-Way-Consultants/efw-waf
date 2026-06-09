# Efw.Cdn — CloudFront invalidation (reference scaffold)

Drop-in C# for the f8 trunk implementing the invalidation design in
[`../../waf-cloudfront-migration.md`](../../waf-cloudfront-migration.md) → "CloudFront Invalidation".

**Design A (no Lambda):** invalidation is a shared library call. Origin is IIS (not S3), so
there's no storage event to hook — the trigger comes from the publish/export code.

## Files
| File | Role |
|---|---|
| `SiteTier.cs` | Cms / Preview2 / Public — caching is per tier, not per origin. |
| `IDistributionResolver.cs` / `SecretsManagerDistributionResolver.cs` | tier → distribution id, read from per-tier secrets `efw-waf/dist/{tier}` (reuses existing app-server Secrets Manager access). Never hardcode ids. |
| `ICdnInvalidator.cs` / `CdnInvalidator.cs` | low-level `InvalidateCdn(tier, paths)` → one `CreateInvalidation`. Chunks at 3000 paths, fire-and-log, never throws. |
| `CdnPaths.cs` | path normalize / file / directory("/dir/*") helpers + `Collapse` (covering-set reduction). Enforces trailing-wildcard rule. |
| `InvalidationScope.cs` | **the important one** — ambient `AsyncLocal` scope: Suppress (PubBot) and Coalesce (outermost-wins). |
| `Examples.cs` | how `Document.ExportForPreview` and PubBot wire in. |

## Behavior

| Caller | Scope | Result |
|---|---|---|
| PubBot run | `InvalidationScope.Suppress()` | per-file calls record nothing; PubBot fires **one coarse** invalidation at end-of-job |
| Manual directory export | `EnterAuto` (owns coalesce) | recursive per-file calls enroll; collapse to `/dir/*`; **one** invalidation on dispose |
| Manual single-file export | `EnterAuto` (owns coalesce) | one file path on dispose |
| Nested/recursive `ExportForPreview` | `EnterAuto` (joins) | no-op on dispose |

## Wiring
- Construct `IAmazonCloudFront` against **us-east-1**.
- Grant the existing app-server IAM role `cloudfront:CreateInvalidation` + `cloudfront:GetInvalidation` on our distribution ARNs (`iam/efw.policy.cloudfront.invalidate.json`).
- The per-tier secrets `efw-waf/dist/preview2` and `efw-waf/dist/public` are created **by the edge stacks** (`SecretString: !Ref Distribution`) — no manual population. Reusing `efw.policy.secrets.read` covers reads.

## NuGet
`AWSSDK.CloudFront`, `AWSSDK.SecretsManager`, and a JSON lib (Newtonsoft or System.Text.Json — adjust `SecretsManagerDistributionResolver`).

> Reference scaffold — review namespaces/logging/DI against f8 conventions before merging. Not yet compiled in this repo.
