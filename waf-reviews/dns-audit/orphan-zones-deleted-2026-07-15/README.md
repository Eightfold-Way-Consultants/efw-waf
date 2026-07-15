# Orphan Route53 hosted zones deleted 2026-07-15

Eight orphaned public hosted zones were deleted from Route53 (account 874922373146)
after confirming — via public NS delegation, registry **RDAP**, and the **GoDaddy API**
(our Eightfold Way registrar account) — that none has a live registry delegation pointing
at our zone. Each `<zone>.json` here is the full `list-resource-record-sets` dump taken
immediately before deletion (the archive/restore source).

## Deleted (8)

| Zone | RDAP registry | GoDaddy (our acct) | Public NS | Why safe to delete |
|---|---|---|---|---|
| vb101.org | 404 not-found | CANCELLED, exp 2018-01 | NXDOMAIN | was ours, lapsed 2018 → dropped; zone was our own dead cruft |
| njdisabilitybenefits.org | 404 | not in acct | NXDOMAIN | unregistered; orphan zone |
| njdisabilitybenefits.net | 404 | not in acct | NXDOMAIN | unregistered; orphan zone |
| njdb101.net | 404 | not in acct | NXDOMAIN | unregistered; orphan zone |
| njdb101.com | 404 | not in acct | NXDOMAIN | unregistered; orphan zone |
| njdb101.org | REGISTERED (GoDaddy, exp 2027, all-locked) | NOT in our acct | NameFind (parking) | we lost it — a domainer holds + parks it; our zone was inert, its live delegation is at NameFind, untouched by deleting our zone |
| joekrovoza.org | 404 | UPDATED_OWNERSHIP, exp 2013 | NXDOMAIN | personal domain, gone 2013; orphan zone |
| workbenefitsyouth.org | 404 | CANCELLED, exp 2022-11 | NXDOMAIN | was ours, lapsed 2022 → dropped; orphan zone |

All A-records in these zones pointed at the old origin `52.8.7.0` (or GoDaddy parking
`173.201.98.128` for joekrovoza); CNAMEs chained onto `eightfoldway.com` origins. No
takeover exposure — the targets are ours and the domains don't resolve.

## Kept (NOT deleted)

- **test.com** — REGISTERED to Network Solutions since 1997 (not ours); its Route53 zone
  is **retained as our own scratch/testing zone** (owner decision 2026-07-15). Not archived here.
- **maybeckstudio.org**, **disabilitybenefits101.org** — live, delegated to AWS (ours);
  left in place.

## Restore procedure

A deleted zone is recreated with a NEW NS delegation (the old NS set is gone), but every
domain above is unregistered or delegated elsewhere, so NS delegation is moot — restore is
only meaningful if the domain is re-registered and pointed back at Route53.

```powershell
# 1. recreate the hosted zone (yields a fresh NS set)
$z = aws route53 create-hosted-zone --name <zone> --caller-reference "restore-<zone>-$(Get-Date -Format yyyyMMddHHmmss)" | ConvertFrom-Json
$id = $z.HostedZone.Id
# 2. UPSERT every non-(apex NS/SOA) record from <zone>.json (see delete-stack.ps1 pattern:
#    build a change-batch of Action=UPSERT from the archived ResourceRecordSets, BOM-free file)
```
