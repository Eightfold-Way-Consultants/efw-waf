# DNS Dangling-Record / Takeover Audit — 2026-06-10

Scope: all A/AAAA/CNAME records (314) in the 5 live zones (db101.org, hb101.org, eightfoldway.com, vets101.org, housingbenefits101.org). Raw dumps: `waf-reviews/dns-audit/*.json`.
Cross-referenced against owned EIPs (us-west-1: 13 incl. 52.8.85.37/52.8.7.0; us-east-1: 54.85.186.227), owned CloudFront distributions (5), owned ALBs (vault-alb, efw-analytics-alb), and live resolution.

## Architecture (healthy)
~85% of records are CNAME chains onto role names — `s6.db101.org` (74), `edit-site.eightfoldway.com` (29), `preview2-site.db101.org` (26), `s4/s6/s3/s3b/svc/brk-site/...` — all terminating at owned EIPs. These are the chain heads the migration repoints. No issues.

## Findings

### HIGH — delete now (true dangling / snatchable)
| Record | Target | Problem |
|---|---|---|
| `preview-favorites-temp.db101.org` | CNAME → `ec2-13-56-22-76.us-west-1.compute.amazonaws.com` | IP 13.56.22.76 is **not ours** (no EIP, no instance). EC2 public-DNS names follow the IP → whoever is assigned that IP in us-west-1 owns this hostname. Classic takeover vector. "temp" record left behind. |
| `logon00.eightfoldway.com` | A → `54.85.48.121` | IP not owned in any region (logon now = efw.web.03b @ 54.153.101.192). Stale A to a recyclable AWS IP. |
| `develop.pdfshot.db101.org` | CNAME → `pdfsh-LoadB-DY93VSVGX0SM…elb…` | ALB deleted (NXDOMAIN). ELB names aren't claimable by choice (random suffix) so takeover risk is low, but dead. |
| `acmetest.eightfoldway.com` | ALIAS → `nodeappalb-261929749…elb…` | ALB deleted; ALIAS resolves to nothing. |
| `staging.content.hb101.org` | ALIAS → `d3kj2y5lkzzpcd.cloudfront.net` | Resolves empty — distribution gone/disabled, not in our account. CloudFront alias-claim now requires a cert for the domain, so takeover is mitigated, but record is dead. |
| `development.image.hb101.org` | ALIAS → `dt0s0fyva5xn0.cloudfront.net` | Same — resolves empty. |

### MEDIUM — confirm intent (live but external / not in our account)
| Record | Target | Note |
|---|---|---|
| `db101-eco.eightfoldway.com` | A → 69.90.209.68 | External colo IP. Old vendor? |
| `votessvc.eightfoldway.com` | A → 173.164.212.89 | Comcast static — office endpoint? |
| `efw-content.{db101,hb101,eightfoldway}` ×3 | ALIAS → `d26hdpj7qusrbc.cloudfront.net` | Live CloudFront, **not in this account** — presumably content/rts account. Confirm owned there. |
| `production.image.hb101.org`, `staging.image.hb101.org`, `production/staging.rts-client.hb101.org`, `rts.hb101.org`, `staging.rts.hb101.org`, `down.eightfoldway.com`, `efw-content-trigger.eightfoldway.com` | live CloudFront/ALB/API-GW in other account(s) | All resolve healthy — rts/Fargate + content pipeline. Fine if that account is ours; list them in that account's inventory. |

### INFO (hygiene, no takeover risk)
- `f8-cmsdb-nr.eightfoldway.com` → A 10.3.0.125 and `f8-db.eightfoldway.com` → RDS (resolves 10.3.1.134): private addresses exposed in public DNS — information leak only; move to a private hosted zone someday.
- `svn.eightfoldway.com` → 54.85.186.227 is OUR us-east-1 EIP — fine.
- Stale ACM-validation CNAMEs (~30) and SES DKIM records — inert; prune validation records for certs that no longer exist.
- **Orphan hosted zones** (separate from these 5): `njdb101.org/.com/.net`, `njdisabilitybenefits.org/.net`, `test.com`, `joekrovoza.org`, `maybeckstudio.org`, `vb101.org`, `workbenefitsyouth.org`, `efw-service.com`, `local.`, `disabilitybenefits101.org`. Zones for unregistered domains are inert for takeover (the snatch is registering the domain itself — nothing a zone prevents), but delete the dead ones to stop paying and confusing audits. `disabilitybenefits101.org` (29 records) is still referenced by the `dtd` site binding (`schema.disabilitybenefits101.org`) — resolve that in/out decision first.

## Policy going forward ("every name terminates somewhere we control, even if 404")
1. **Post-migration, wildcard aliases make CloudFront the terminator** for any `*.db101.org`/`*.hb101.org`/`*.vets101.org`/`*.eightfoldway.com` name DNS'd at a distribution — valid TLS, our infrastructure, not snatchable. But an unbound Host reaching IIS today yields a connection reset (no catch-all binding). **Add a catch-all 404 site on both servers** (bindings without host header, 80+443, static 404 page) so any stray-but-routed name gets a clean controlled 404 instead of a reset/502.
2. **New-site/teardown checklist**: on decommission, delete the DNS record in the same change as the resource — never leave a CNAME/ALIAS to a deleted target.
3. **Re-run this audit periodically** — dumps + cross-check are scripted in this folder; candidate for the OpenClaw nightly job (diff targets vs owned-resource inventory, alert on dead resolution).
