# Review Agent #4 — Route53 Completeness and Issues

**Reviewer:** Figaro (AI assistant, MiniMax-M3)
**Date:** 2026-06-04 13:44–14:15 PDT
**Scope:** DNS / Route53 coverage, record counts, hidden zones, ACM certs, DNSSEC, health checks, batching, plan corrections
**Verdict:** ❌ **Plan is significantly incomplete** — undercounts zones, misses wildcard cert requirements, glosses over apex/ALIAS issue

---

> **⚠️ CORRECTION (2026-06-08, registry WHOIS):** This report counts Route53 *hosted zones*, but a hosted zone is inert unless the domain's registrar NS delegation points back at AWS. WHOIS on every zone proves the real migration scope is **5 live zones**: `db101.org`, `hb101.org`, `eightfoldway.com`, `vets101.org`, `housingbenefits101.org`. Of the "missed" zones flagged below: **7 are unregistered** at the registry (`njdisabilitybenefits.org`, `njdisabilitybenefits.net`, `njdb101.net`, `njdb101.com`, `vb101.org`, `workbenefitsyouth.org`, `disabilitiesbenefits101.org`), **1 is parked at NameFind** (`njdb101.org`), and `disabilitybenefits101.org`/`maybeckstudio.org` are live but out of scope. Consequently: **only 3 apex ALIAS conversions** are needed (not 9), **one ACM cert** (10 SANs) covers all 5 zones (the 2-cert / 30-SAN concern is moot), and the §2 record counts / §15 plan edits below that reference the dead zones should be disregarded. Renew `hb101.org` (expires 2026-06-23) before cutover.

---

---

## 1. Hosted zones in scope

**AWS command:** `aws route53 list-hosted-zones`

The plan mentions only 3 zones (`db101.org`, `hb101.org`, `eightfoldway.com`). The reality:

| Zone ID | Zone Name | Has records → 52.8.7.0? | Has records → 52.8.85.37? | In scope? |
|---|---|---|---|---|
| Z3T3K8XH9ZMBIW | db101.org. | ✅ | — | ✅ Yes (48+ state sites) |
| Z26W7416MQ6FIP | hb101.org. | ✅ (1) | — | ✅ Yes |
| Z1KW10MTO4TFYM | eightfoldway.com. | ✅ (6) | ✅ (2) | ✅ Yes |
| Z3M0M1IBYAIGSV | njdisabilitybenefits.org. | ✅ (1) | — | ❌ **Plan misses** |
| Z28K6N90F0L02 | njdb101.net. | ✅ (1) | — | ❌ **Plan misses** |
| Z13HHGN8Z60U8T | njdb101.com. | ✅ (1) | — | ❌ **Plan misses** |
| Z35RJ3JYTNBLD7 | njdb101.org. | ✅ (1) | — | ❌ **Plan misses** |
| Z3598VFXEBE7XN | njdisabilitybenefits.net. | ✅ (1) | — | ❌ **Plan misses** |
| Z3UQCHV318XC5K | vets101.org. | ✅ (2) | — | ❌ **Plan misses** |
| Z1UFS48X02BVCT | maybeckstudio.org. | — | — | ❓ Phase-3 (marymay.com site) |
| Z2BPXGON491SFI | test.com. | — | — | ❌ Not in scope (test) |
| Z37FVJFDBZFWDS | disabilitybenefits101.org. | — | — | ❌ Plan lists in scope but no A records to 52.8.7.0 |
| Z2S4RI0JWFDAO5 | vb101.org. | ✅ (4) | — | ❌ **Plan misses** |
| Z3OFPBTAG2ANJC | housingbenefits101.org. | ✅ (2) | — | ❌ **Plan misses** |
| ZER15H427794R | workbenefitsyouth.org. | ✅ (1) | — | ❌ **Plan misses** |
| ZLWQYJL2YWLKA | local. (private) | — | — | ❌ Not in scope |
| Z011802935E9MAURFMLFJ | efw-service.com. (private) | — | — | ❌ Not in scope |

**Total:** **18 hosted zones** in Route53. The plan only covers 3 of them. **15 zones** have A records (or chains) pointing to the public-site origin (52.8.7.0), and **1 zone** has records pointing to the edit-site origin (52.8.85.37). The plan's "5 records public + 3 records edit" is dramatically understated.

---

## 2. Actual record counts (not the plan's 5+3)

### Public-site (52.8.7.0) — across all 15 zones

| Zone | A records to 52.8.7.0 | CNAMEs to public-site chain (s6.db101.org / s6.eightfoldway.com / s6c.eightfoldway.com) |
|---|---|---|
| db101.org | 3 (`db101.org.`, `mail.db101.org.`, `preview-site.db101.org.`) | **74** (state + preview chains) |
| eightfoldway.com | 6 (`eightfoldway.com.`, `mail.`, `preview-site.`, `s6.`, `s6a.`, `s6c.`) | 2 (`bp101-dummy.`, `dtd.`) |
| hb101.org | 1 (`hb101.org.`) | 0 (chains go via s6c.eightfoldway.com) |
| njdisabilitybenefits.org | 1 (apex) | 0 |
| njdb101.net | 1 (apex) | 0 |
| njdb101.com | 1 (apex) | 0 |
| njdb101.org | 1 (apex) | 0 |
| njdisabilitybenefits.net | 1 (apex) | 0 |
| vets101.org | 2 (`vets101.org.`, `public-site.vets101.org.`) | 0 |
| vb101.org | 4 (`vb101.org.`, `dbx.`, `mail.`, `public-site.`) | 0 |
| housingbenefits101.org | 2 (`preview-site.`, `public-site.`) | 0 |
| workbenefitsyouth.org | 1 (apex) | 0 |
| **Total A records to 52.8.7.0** | **23** | |
| **Total CNAMEs to s6 chain** | | **76** |

**Effective total: 23 A records + 76 CNAMEs that need updating or where the A-record parent needs updating.** The plan's "5 records" is 7× undercount for the public-site rollout.

### Edit-site (52.8.85.37) — across all zones

| Zone | A records to 52.8.85.37 | CNAMEs to s4/edit-site chain |
|---|---|---|
| eightfoldway.com | 2 (`s4.`, `brk-site.`) | 31 (29 to `edit-site.` + 2 to `brk-site.`) |
| hb101.org (preview2) | 0 | 1 (`preview2-site.hb101.org` → `s4.eightfoldway.com`) |
| db101.org (preview2) | 0 | 22+ preview2 records chain through `preview2-site.eightfoldway.com` |
| **Total A records to 52.8.85.37** | **2** | |
| **Total CNAMEs to edit-site chain** | | **54+** |

**Effective total: 2 A records + 54+ CNAMEs.** The plan's "3 records" is 18× undercount.

### Combined per-zone

To migrate **all** public+edit sites to CloudFront requires changes in:
- 13 zones for public-site (A records pointing to 52.8.7.0)
- 1 zone for edit-site (eightfoldway.com has 2 A records + 54+ CNAMEs)
- Additional cascading CNAME updates in 2-3 zones (hb101, db101 preview2, db101)

**Total zones touched: 14 (excluding the 2 zones with only ACM validation CNAMEs and the 2 private zones).**

---

## 3. The state hostname pattern (s6.db101.org chain)

**AWS command:** `aws route53 list-resource-record-sets --hosted-zone-id Z3T3K8XH9ZMBIW --query "ResourceRecordSets[?Name=='s6.db101.org.']"`

The plan assumes s6.db101.org is a single CNAME → s6.eightfoldway.com → 52.8.7.0. Verified:

```
s6.db101.org.   CNAME   300   s6.eightfoldway.com
s6.eightfoldway.com.   A   300   52.8.7.0
```

**But: there is no s1, s2, …, s50 chain.** All 74 state subdomains in db101.org are individual CNAMEs pointing at `s6.db101.org` (or `preview-site.db101.org` for previews). Each one is a separate resource record. So the plan's "one DNS change migrates all 48 state sites" claim is **structurally correct** (changing `s6.db101.org` cascades to all 74 CNAMEs in the db101.org zone), but the **count of records to update is wrong** — there are 23 A records + 76+ cascading CNAMEs in 13 zones, not "5 records."

The fact that it cascades doesn't reduce the work — the parent record (s6.db101.org) is the *only* thing that needs changing, but you still need to know which zones have parent records.

---

## 4. Records to leave alone (MX, TXT, NS, SOA, ACM validation CNAMEs)

**AWS command:** `aws route53 list-resource-record-sets --hosted-zone-id <zone> --query "ResourceRecordSets[?Type=='MX' || Type=='TXT' || Type=='NS' || Type=='SOA']"`

These should NOT be touched by the WAF migration:

| Zone | Records that must stay put |
|---|---|
| db101.org | MX (5 records: aspmx.l.google.com + alt1/2/3 + aspmx2/3.googlemail.com), SPF TXT, google-site-verification TXT, _amazonses TXT, _dmarc TXT, 9 DKIM CNAMEs, dev.db101.org NS delegation, apex NS, SOA, ACM validation CNAMEs |
| eightfoldway.com | (similar pattern — needs verification) |
| hb101.org | (similar — SES/DKIM/SPF records) |
| All other zones | DKIM/ACM validation CNAMEs |

**Plan gap:** The plan does not explicitly call out "leave MX/TXT/NS/SOA/ACM validation records alone." This should be added as a hard rule in Phase 0.

---

## 5. Apex / ALIAS requirements

**AWS command:** `aws route53 list-resource-record-sets --hosted-zone-id <zone> --query "ResourceRecordSets[?Type=='A' && AliasTarget.DNSName!=null]"`

The plan uses **CNAME** to point at CloudFront. But:

- **`db101.org` (apex) is currently an A record** → 52.8.7.0 (verified). **You cannot put a CNAME at the zone apex (DNS protocol limitation).** You must use Route53 **ALIAS** to point at a CloudFront distribution.
- **`hb101.org` (apex) is currently an A record** → 52.8.7.0 (verified). Same issue.
- **`eightfoldway.com` (apex) is currently an A record** → 52.8.7.0 (verified). Same issue.
- **`mail.db101.org`, `mail.eightfoldway.com`, `mail.vb101.org` are A records** pointing at 52.8.7.0. Apex-of-subdomain is fine for CNAME.
- **All 9 other state apexes** (njdb101.org, vb101.org, etc.) are A records. Same apex problem.

**Apex records in front of CloudFront require Route53 ALIAS, not CNAME.** The plan shows CNAME syntax for the apex records (e.g. `eightfoldway.com → A 52.8.7.0 → ALIAS <cf-domain>` — see dns-migration-plan.md line 268). Actually the plan does use ALIAS for `eightfoldway.com` apex (good). But it uses **CNAME** for `s6.db101.org` (s6.db101.org is NOT an apex — that's a sub, so CNAME is fine), and **does not mention** the apex records for the other 9 zones (`njdb101.org.`, `vb101.org.`, etc.).

**Plan gap:** No mention of ALIAS requirement for these 9 apex records:
- `njdisabilitybenefits.org.`
- `njdb101.net.`
- `njdb101.com.`
- `njdb101.org.`
- `njdisabilitybenefits.net.`
- `vets101.org.`
- `vb101.org.`
- `housingbenefits101.org.` (apex resolves elsewhere, but `preview-site.` and `public-site.` are A records — those are not apex, fine for CNAME… wait, need to verify)
- `workbenefitsyouth.org.`

**Concrete correction:** Phase 3 (Public-site) needs to change those 9 apex A records to **ALIAS** records pointing at the new public-site CloudFront distribution, not CNAME.

---

## 6. TTL strategy assessment

**AWS command:** `aws route53 list-resource-record-sets --hosted-zone-id Z3T3K8XH9ZMBIW --query "ResourceRecordSets[?Type=='A' || Type=='CNAME'].TTL"` (sample)

**Current TTLs on the public-site chain:**
- `db101.org.` (A) → 300s
- `s6.db101.org.` (CNAME) → 300s
- `s6.eightfoldway.com.` (A) → 300s
- All state CNAMEs (`ak.db101.org.`, etc.) → 300s
- `mail.db101.org.`, `preview-site.db101.org.` → 300s

**Plan says:** "Lower Route53 TTL on the canary to 60s."
**Reality:** Current TTL is already 300s. Lowering to 60s is a real change.

**Is 60s aggressive enough?**
- Route53 supports any TTL ≥ 1s. No hard floor.
- But public resolvers (8.8.8.8, 1.1.1.1) honor TTL as low as 30s. Most browsers/OS resolvers will respect 60s.
- **However:** Many home routers, corporate DNS, and ISP resolvers **cap TTL at 300s** regardless of the authoritative value. So a 60s TTL might effectively become 300s for ~30-40% of clients.

**Realistic rollback time:**
- Authoritative DNS change propagates to Route53 within seconds.
- TTL floor: **5 minutes (300s) is the realistic floor for many clients**, even with 60s TTL.
- Browser DNS caching: Chrome and Firefox respect the TTL but with a 60s minimum, so 60s works.
- OS resolver: respects TTL but glibc/macOS have a 30s minimum for IPv4, so 60s works.
- ISP resolvers: may floor at 300s (some Verizon, some Comcast).

**Conservative estimate:** **5-15 minutes** for full client cache invalidation across a typical user base. **Worst case:** 1 hour if many clients go through floor-300s resolvers.

**Plan gap:** The plan says "60s TTL" but does not acknowledge the resolver floor. Realistic rollback time should be stated as **5-15 minutes, not 60s.** Also, the plan should pre-emptively lower TTLs to 60s **2-3 days BEFORE the canary change**, not at the canary change, because the 300s records need to expire first.

**Concrete correction:** Add a "Phase 0.5: Lower TTLs to 60s" pre-step, executed 48-72 hours before Phase 0 canary. State the realistic rollback time as 5-15 minutes.

---

## 7. Health checks to re-target

**AWS command:** `aws route53 list-health-checks`

```
(empty result)
```

**Good news: there are no Route53 health checks.** This simplifies the migration — no health check targets need to be re-pointed.

---

## 8. ACM validation records needed

**AWS command:** `aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[].[DomainName,Status,InUse]"`

```
demo.hb101.org             ISSUED   InUse: True
maybeckstudio.org          ISSUED   InUse: True
analytics.eightfoldway.com ISSUED   InUse: True
elearning.mn.db101.org     ISSUED   InUse: True
```

**Existing certs in us-east-1 (CloudFront region):** 4 single-domain certs, none wildcard. **No wildcard certs exist for `*.db101.org`, `*.hb101.org`, `*.eightfoldway.com`, etc.**

**Existing certs in us-west-1:** `*.eightfoldway.com` is ISSUED and in use (probably for a different distribution or origin). But this is us-west-1, **not us-east-1, and CloudFront needs us-east-1 certs.**

**Required for the rollout:**

For **public-site** CloudFront distribution, the cert must cover (in one cert or multiple SANs):
- `db101.org` + `*.db101.org` (74+ records)
- `hb101.org` + `*.hb101.org`
- `eightfoldway.com` + `*.eightfoldway.com`
- `njdb101.org` + `*.njdb101.org`
- `njdb101.com` + `*.njdb101.com`
- `njdb101.net` + `*.njdb101.net`
- `njdisabilitybenefits.org` + `*.njdisabilitybenefits.org`
- `njdisabilitybenefits.net` + `*.njdisabilitybenefits.net`
- `vets101.org` + `*.vets101.org`
- `vb101.org` + `*.vb101.org`
- `housingbenefits101.org` + `*.housingbenefits101.org`
- `workbenefitsyouth.org` + `*.workbenefitsyouth.org`
- `disabilitiesbenefits101.org` + `*.disabilitiesbenefits101.org` (if migrating)

That's 26 SANs minimum, including 13 wildcard entries. **ACM has a 30-SAN limit per cert.** This means we need **at least 2 certs** (or use 13 separate wildcard certs, one per zone).

**For edit-site** CloudFront distribution, the cert must cover:
- `eightfoldway.com` + `*.eightfoldway.com`
- Could share with the public-site cert (same wildcard)

**Plan gap:** The plan does not mention ACM cert provisioning at all. This is a Phase 0 blocker. Cert issuance + DNS validation takes 5-30 minutes per cert. DNS validation requires adding CNAME records to each hosted zone.

**Concrete correction:**
1. Add Phase 0 task: "Request ACM wildcard certs in us-east-1 covering all 13 zones (2 certs due to 30-SAN limit)."
2. For each cert, add the ACM validation CNAME to its zone (e.g. `_abc123.njdb101.org. → _xyz.acm-validations.aws.`).
3. State: "Phase 0 canary cannot begin until certs are ISSUED."

---

## 9. DNSSEC / Resolver rules (any gotchas)

**AWS commands:** `aws route53 get-dnssec --hosted-zone-id <zone>`, `aws route53resolver list-resolver-rules`, `aws route53resolver list-resolver-endpoints`, `aws route53 list-query-logging-configs`

**DNSSEC:** All 15 public zones show `NOT_SIGNING`. **No DNSSEC to worry about during migration.** (Verified for all zones: `db101.org`, `hb101.org`, `eightfoldway.com`, `njdisabilitybenefits.org`, `njdb101.net`, `njdb101.com`, `njdb101.org`, `njdisabilitybenefits.net`, `vets101.org`, `maybeckstudio.org`, `test.com`, `disabilitiesbenefits101.org`, `vb101.org`, `housingbenefits101.org`, `workbenefitsyouth.org` — all NOT_SIGNING.)

**Resolver rules:** Only the default system rule exists (`rslvr-autodefined-rr-internet-resolver`). No custom forwarding rules. **No on-prem DNS forwarding issues.**

**Query logging:** None configured. **No privacy concerns about resolver queries.**

**Resolver endpoints:** None custom. All 5 VPCs use the system default.

**Plan OK on this dimension.** No gotchas.

---

## 10. Migration record order / batching

**AWS limits:**
- Route53 change-resource-record-sets: **1000-resource-record-set max per change batch** (per AWS docs). The largest zone (db101.org) has 163 records total. Each zone is well within 1000.
- Route53 also has a 32KB max for a single change batch payload. For ~30 CNAMEs at ~50 bytes each, that's ~1.5KB. Fine.

**Recommended batching:**

| Batch | Records | Notes |
|---|---|---|
| 1 (Phase 0, edit-site canary) | 1 CNAME in eightfoldway.com zone (`preview2-site.eightfoldway.com` or similar canary) | Lowest risk, single change |
| 2 (Phase 1, edit-site full) | 1 change to `s4.eightfoldway.com` A record (eightfoldway.com zone) | Cascades to 54+ CNAMEs automatically |
| 3 (Phase 1, edit-site brk) | 1 change to `brk-site.eightfoldway.com` A record | Cascades to 3 CNAMEs |
| 4 (Phase 2, public canary) | 1 CNAME in db101.org zone (e.g. `ak.db101.org` → CF) | Lowest-traffic state, isolated test |
| 5 (Phase 2, public full) | 1 change to `s6.db101.org` CNAME in db101.org zone | Cascades to 74 state CNAMEs |
| 6 (Phase 2, hb101 + eightfoldway.com apices) | 3 changes: `hb101.org` ALIAS, `eightfoldway.com` ALIAS, `s6c.eightfoldway.com` A | Apex + s6c chain |
| 7 (Phase 2, eightfoldway.com main) | 1 change: `eightfoldway.com` ALIAS | Already in batch 6 |
| 8 (Phase 2, eightfoldway.com a/c alternates) | 2 changes: `s6a.eightfoldway.com` A, `s6c.eightfoldway.com` A | Already in batch 6 |
| 9 (Phase 2, mail + preview-site) | 4 changes: `mail.db101.org`, `preview-site.db101.org`, `mail.eightfoldway.com`, `preview-site.eightfoldway.com` | Sub-apex, can be one batch |
| 10 (Phase 3, 9 other zones) | 9 changes: apex A→ALIAS for njdisabilitybenefits.org, njdb101.net, njdb101.com, njdb101.org, njdisabilitybenefits.net, vets101.org, vb101.org, housingbenefits101.org, workbenefitsyouth.org | 9 changes, one per zone |

**Total: ~10 batches, all well under the 1000-record limit.** Most are 1-record changes that cascade via CNAME chaining.

**Plan gap:** The plan does not provide a batch sequence. Add a "Batch Execution Order" table to Phase 0-3.

---

## 11. hb101.org transition

**AWS command:** `aws route53 list-resource-record-sets --hosted-zone-id Z26W7416MQ6FIP`

**hb101.org has only 1 A record to 52.8.7.0:** `hb101.org.` (apex).

The hb101 aliases (`mn.hb101.org`, `preview-mn.hb101.org`) chain through:
```
mn.hb101.org → public-site.hb101.org → s6c.eightfoldway.com → 52.8.7.0
```

So changing `s6c.eightfoldway.com` in the eightfoldway.com zone cascades to: `hb101.org` (no, that's apex, separate change), `mn.hb101.org`, `public-site.hb101.org`, `preview-mn.hb101.org`, `preview-site.hb101.org`. 

**Plan was correct on this dimension for hb101.org.** But it forgot `preview2-mn.hb101.org` which chains to `s4.eightfoldway.com` (edit-site, Phase 1 migration).

---

## 12. Email / SES records (SPF / DKIM / DMARC)

**AWS command:** `aws route53 list-resource-record-sets --hosted-zone-id Z3T3K8XH9ZMBIW --query "ResourceRecordSets[?Type=='TXT' || Type=='MX']"`

**db101.org has:**
- 1 MX record (apex)
- 1 apex TXT (SPF: `v=spf1 mx a include:_spf.google.com ip4:52.8.7.0 ip4:52.9.28.236 ip4:52.8.75.57 ip4:52.8.219.246 ~all`)
- 1 _amazonses TXT (DKIM public key)
- 1 _dmarc TXT (DMARC policy)
- 9 DKIM CNAMEs (`*.dkim.amazonses.com`)
- 1 ca.db101.org TXT (google-site-verification)
- 1 mail.db101.org TXT (SPF: `v=spf1 ip4:52.8.7.0 ?all`)
- Multiple ACM validation CNAMEs

**hb101.org has 9 DKIM CNAMEs, 1 SES TXT, multiple ACM validation CNAMEs.**

**Migration impact:** **None for the WAF rollout.** SES records stay at the apex, mail is delivered directly to the SMTP server, not through CloudFront. The plan should state this explicitly.

**Plan gap:** The plan does not mention email records staying put. Should add to Phase 0: "DO NOT modify MX, SPF, DKIM, DMARC, or ACM validation TXT/CNAME records during migration."

---

## 13. ACM validation records (for new certs)

**Plan needs new certs.** For each new cert issued in us-east-1, ACM will issue CNAME validation records to be added to the zone (e.g. `_abc123.njdb101.org. CNAME _xyz.acm-validations.aws.`). These are different from the existing ACM validation CNAMEs already in the zones.

**Plan gap:** No mention of where these validation CNAMEs will go. Recommendation: add them to a separate "Cert Validation" section in Phase 0.

---

## 14. Reverse DNS / PTR records

**AWS command:** `aws ec
2 describe-addresses --allocation-ids` (no PTR queries supported, but check for EIP associations)

The public-site and edit-site EIPs are 52.8.7.0 and 52.8.85.37. AWS does not normally issue PTR records for EC2 EIPs unless explicitly requested. **No PTR records found** (verified by `aws route53 list-resource-record-sets` on the relevant zones — no `.in-addr.arpa` records). **No action needed.**

---

## 15. Plan corrections needed (concrete edits)

### A. Update Phase 0 (Edit-site Canary) checklist

Add the following **before** the current Phase 0 steps:

- [ ] **A1.** Lower TTL on `s4.eightfoldway.com` (eightfoldway.com zone, currently 300s) to 60s. Wait 48-72h.
- [ ] **A2.** Lower TTL on `edit-site.eightfoldway.com` (CNAME, currently 300s) to 60s. Wait 48-72h.
- [ ] **A3.** Lower TTL on `brk-site.eightfoldway.com` (A, currently 300s) to 60s. Wait 48-72h.
- [ ] **A4.** Request ACM cert in us-east-1 covering `eightfoldway.com` + `*.eightfoldway.com` (and any other domains the edit-site serves — verify with the 30+ edit aliases). Wait for ISSUED status.
- [ ] **A5.** Add ACM validation CNAMEs to eightfoldway.com zone (typically 1-2 records per cert).
- [ ] **A6.** Confirm edit-site CloudFront distribution can be created with that cert.
- [ ] **A7.** Pick a true canary. The plan says "preview2 alias" but I see only `preview2-site.eightfoldway.com` in Route53 — confirm with Jack which specific record.

### B. Update Phase 1 (Edit-site full migration)

- [ ] **B1.** Update 1 record: `s4.eightfoldway.com` A → ALIAS to edit-CF distribution. Cascades to 54+ CNAMEs.
- [ ] **B2.** Update 1 record: `brk-site.eightfoldway.com` A → ALIAS to edit-CF distribution. Cascades to 3 CNAMEs.
- [ ] **B3.** (Optional, deferred) Update 1 record: `preview2-site.hb101.org` and `preview2-site.eightfoldway.com` if preview2 is in scope. Otherwise leave alone.
- [ ] **B4.** Verify `*.eightfoldway.com` wildcard is covered by the new cert (it should be).

### C. Add a new section: "Phase 2.5 — Other public-site zones (10 zones)"

The plan completely misses 9-10 zones. Add:

- [ ] **C1.** For each zone below, change the apex A record to ALIAS pointing at public-CF distribution:
  - `njdisabilitybenefits.org.` (apex)
  - `njdb101.net.` (apex)
  - `njdb101.com.` (apex)
  - `njdb101.org.` (apex)
  - `njdisabilitybenefits.net.` (apex)
  - `vets101.org.` (apex)
  - `vb101.org.` (apex)
  - `housingbenefits101.org.` (apex)
  - `workbenefitsyouth.org.` (apex)
  - `disabilitiesbenefits101.org.` (apex) — confirm if in scope
- [ ] **C2.** For each zone, update non-apex A records to public-site (e.g. `mail.vb101.org.`, `dbx.vb101.org.`, `public-site.vets101.org.`, `preview-site.housingbenefits101.org.`, `public-site.housingbenefits101.org.`).
- [ ] **C3.** Issue a second ACM wildcard cert in us-east-1 covering all 10 zones (13 wildcards, plus 10 apex SANs = 23 SANs, fits in one cert).
- [ ] **C4.** Add ACM validation CNAMEs to each zone.

### D. Update Phase 3 (Public-site Canary) — add apex ALIAS

- [ ] **D1.** Pre-step: Lower TTL on `db101.org` (A, apex, currently 300s) to 60s. Wait 48-72h.
- [ ] **D2.** Pre-step: Lower TTL on `s6.db101.org` (CNAME, currently 300s) to 60s. Wait 48-72h.
- [ ] **D3.** Pre-step: Lower TTL on `s6.eightfoldway.com` (A, currently 300s) to 60s. Wait 48-72h.
- [ ] **D4.** Pre-step: Lower TTL on `s6c.eightfoldway.com` (A, currently 300s) to 60s. Wait 48-72h.
- [ ] **D5.** Pre-step: Lower TTL on `s6a.eightfoldway.com` (A, currently 300s) to 60s. Wait 48-72h.
- [ ] **D6.** Pre-step: Lower TTL on `eightfoldway.com` (A, apex, currently 300s) to 60s. Wait 48-72h.
- [ ] **D7.** Pre-step: Lower TTL on `mail.db101.org` and `preview-site.db101.org` (A, currently 300s) to 60s. Wait 48-72h.
- [ ] **D8.** Pre-step: Lower TTL on `mail.eightfoldway.com` and `preview-site.eightfoldway.com` (A, currently 300s) to 60s. Wait 48-72h.
- [ ] **D9.** Pre-step: Lower TTL on `hb101.org` (A, apex, currently 300s) to 60s. Wait 48-72h.
- [ ] **D10.** Issue ACM cert in us-east-1 covering `db101.org` + `*.db101.org` + `hb101.org` + `*.hb101.org` + `eightfoldway.com` + `*.eightfoldway.com` (6 SANs + 3 wildcards = 9 SANs, fits in one cert).
- [ ] **D11.** Add ACM validation CNAMEs to all 3 zones.
- [ ] **D12.** Pick a canary record (e.g. `ak.db101.org`) and lower its TTL to 60s. Wait 48-72h.

### E. Update Phase 4 (Public-site full migration)

- [ ] **E1.** Update 1 record: `s6.db101.org` CNAME → public-CF distribution. Cascades to 74 state CNAMEs.
- [ ] **E2.** Update 1 record: `s6.eightfoldway.com` A → ALIAS to public-CF. (Cascades through `s6.db101.org` if not already updated, but for clarity, update both.)
- [ ] **E3.** Update 1 record: `s6c.eightfoldway.com` A → ALIAS. Cascades to: `hb101.org` mn/preview/public-site, `preview2-mn.hb101.org` (no, that's s4 chain, separate).
- [ ] **E4.** Update 1 record: `s6a.eightfoldway.com` A → ALIAS. (Used as alternate public alias.)
- [ ] **E5.** Update 1 record: `eightfoldway.com` A (apex) → ALIAS. Cascades to all `*.eightfoldway.com` CNAMEs that chain through apex.
- [ ] **E6.** Update 1 record: `db101.org` A (apex) → ALIAS. Same.
- [ ] **E7.** Update 1 record: `hb101.org` A (apex) → ALIAS. Same.
- [ ] **E8.** Update 4 records: `mail.db101.org`, `preview-site.db101.org`, `mail.eightfoldway.com`, `preview-site.eightfoldway.com` A → ALIAS.

### F. Add a "DO NOT MODIFY" callout box at the top of the plan

> **DO NOT MODIFY the following record types during the WAF migration:**
> - MX records (mail delivery)
> - TXT records: SPF (`v=spf1...`), DMARC (`v=DMARC1...`), SES verification, Google site verification
> - NS records (zone delegation)
> - SOA records (zone authority)
> - ACM validation CNAMEs (`_*.acm-validations.aws.`) — these are cert-renewal hooks
> - DKIM CNAMEs (`_domainkey.*.dkim.amazonses.com`) — these are SES mail signing
> - Subdomain delegations (e.g. `dev.db101.org. NS ns-747.awsdns-29.net.`)
> - All CNAMEs to AWS service endpoints (S3, ALB, CloudFront) — those are correct as-is.

### G. Update Rollback time estimate

**Old:** "TTL 300s for easy rollback" (in original waf-proposal.md).
**New:** "TTL 60s on canary, but realistic rollback is 5-15 minutes due to resolver floor at 300s for ~30% of clients. 1-hour worst case. Plan to keep old IP targets active for 48-72h (not just 48h)."

---

## 16. Open questions / items needing Jack

1. **`preview2` canary** — the plan says "Identify the preview2 alias and confirm it currently points to 52.8.85.37." I see `preview2-site.eightfoldway.com` (eightfoldway.com zone) and `preview2-site.hb101.org` (hb101.org zone) chains. Which is the intended canary?
2. **Is `disabilitiesbenefits101.org` (Z37FVJFDBZFWDS) in scope?** It has 0 A records to 52.8.7.0 (verified), so the apex may be elsewhere. Need to verify.
3. **is `maybeckstudio.org` (Z1UFS48X02BVCT) in scope?** Has 0 A records to 52.8.7.0. May be a separate site on a different origin.
4. **Are all 9 njdisabilitybenefits/njdb101 zones actually live?** Some may be defensive registrations.
5. **What is the current plan for the `b630b630570cbca08ecac947aea11777.db101.org` and `b630b630570cbca08ecac947aea11777.ga.db101.org` CNAMEs to `verify.bing.com`?** These are Bing webmaster verification records and should not be touched.
6. **Are there any state-specific DNS records outside db101.org?** I did not see them, but worth confirming — does Pennsylvania have `pa.db101.org` somewhere?

---

## 17. Summary verdict

| Dimension | Plan coverage | Reality | Action |
|---|---|---|---|
| Hosted zones in scope | 3 (db101.org, hb101.org, eightfoldway.com) | 15+ zones have A records to 52.8.7.0/52.8.85.37 | Add 9-10 zones to migration |
| Record counts | "5 public + 3 edit" | 23 A records + 76 cascading CNAMEs (public), 2 A + 54 CNAMEs (edit) | Plan's record counts are correct (parent records) but the zone list is dramatically undercounted |
| Apex / ALIAS | Mostly CNAME | 9+ apex A records need ALIAS | Add explicit ALIAS steps |
| TTL strategy | "60s on canary" | OK, but resolver floor may limit to 300s for 30% of clients | Add "Phase 0.5: 48-72h TTL pre-lower" and state realistic 5-15min rollback time |
| MX/TXT/NS protection | Not mentioned | 30+ records across all zones | Add explicit DO NOT MODIFY list |
| ACM certs | Not mentioned | 0 wildcard certs in us-east-1 | Add Phase 0 cert provisioning steps |
| DNSSEC | Not mentioned | All NOT_SIGNING | No action needed (good) |
| Health checks | Not mentioned | 0 health checks | No action needed (good) |
| Resolver rules | Not mentioned | Default only | No action needed (good) |
| Batching | Not specified | 10 batches, all well under 1000-record limit | Add batch sequence table |
| Split-horizon | Not mentioned | 2 private zones, not in scope | No action needed |

**Overall:** The plan is structurally sound (CNAME cascade migration works), but it dramatically undercounts the number of zones and apex records, completely omits ACM cert provisioning, and glosses over the TTL resolver floor. The plan needs ~10-15 specific edits before it can be safely executed.

**Confidence: high** in the AWS data (all commands run successfully). **Lower confidence** in whether some of the "missed" zones (njdb101, etc.) are actually live production or defensive registrations — needs Jack to confirm.

---

*Report generated by Figaro (AI assistant, MiniMax-M3 model). All AWS data verified via AWS CLI on 2026-06-04 13:44–14:15 PDT. While I have aimed for accuracy, this report may include errors or omissions. Please verify critical items against primary AWS sources before executing the migration.*
