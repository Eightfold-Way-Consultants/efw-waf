# www-redirect — reflexive-`www` redirect stack

Redirects `www.<state>.db101.org` / `www.<state>.hb101.org` (public **and** preview) to the bare
host over HTTPS, e.g. `https://www.mn.db101.org/x` → `https://mn.db101.org/x`.

## Why this exists (don't delete these hosts)

DB101's audience (older / less-technical people navigating disability benefits) and our clients (whom
we tell to "test on `preview-mn.db101.org`") **reflexively prepend `www.`**. That breaks, hard:

- Our sites are `<state>.db101.org` — a **single label** under `db101.org`.
- The origin/edge cert is a **one-level wildcard** `*.db101.org`, which by RFC 6125 matches
  `mn.db101.org` but **NOT** the two-level `www.mn.db101.org`.
- Every db101 host sends **HSTS `includeSubDomains`**, which force-upgrades `www.mn.db101.org` to
  HTTPS and makes the resulting cert error **non-bypassable** — no "proceed anyway", no HTTP fallback.

Net: a user who types `www.` hits a dead "your connection is not private" wall. It's invisible in
server logs (the TLS handshake fails before any request is logged), so "no www traffic" is the bug's
**fingerprint, not** evidence nobody wants it. This stack makes those hosts work.

## How it works

A **standalone** CloudFormation stack (`efw-waf-www-redirect`, us-east-1) that owns end-to-end:

1. **ACM cert** with a SAN `www.<host>` for every host in `hosts.txt`, DNS-validated (CFN creates the
   validation records in the correct zone and waits for issuance).
2. **CloudFront distribution** whose only job is to answer those `www.<host>` aliases.
3. A generic **`strip-www` CloudFront Function** (viewer-request): `www.X` → `301 https://X` + path + query.
   Host-agnostic — one function covers every state and `-es`/`preview-` variant. No per-host logic.
4. **Route53 `www.<host>` CNAME** records → the distribution, in the db101.org + hb101.org zones.
   (These UPSERT — they adopt the pre-existing `www.<host> → s6` records and create any missing ones.)

## The template is GENERATED — edit `hosts.txt`, not the YAML

`www-redirect.yaml` is produced by `generate.py` from `hosts.txt`. **Never hand-edit the YAML.** The
single source of truth is `hosts.txt` (one host per line; `#` comments and blanks ignored).

## Add a new state (the main maintenance task)

1. Add the state's host line(s) to **`hosts.txt`** — its public host **and** its preview host, plus
   `-es` variants if the state has Spanish sites. Example for a new state `xx`:
   ```
   xx.db101.org
   xx-es.db101.org          # only if a Spanish site exists
   preview-xx.db101.org
   preview-xx-es.db101.org  # only if a Spanish preview exists
   ```
   Confirm the exact live host names first (they're the bare estimator hosts, not `www.`):
   `python C:/Users/jeast/.claude/skills/ssm-windows/run-ssm.py <estimator-walk>/resolve-entry.ps1 i-0c82adf476c7c5e32`
   lists what actually serves, or check the Route53 db101.org zone.
2. Regenerate: `python generate.py`  (rewrites `../www-redirect.yaml`).
3. Deploy: `..\deploy-stack.ps1 www-redirect`.
4. Sanity-check `git diff` on `www-redirect.yaml` — you should see exactly the new `www.xx*` SANs,
   validation options, aliases, and CNAME records, nothing else.

Removing a state is the same in reverse (delete the line, regenerate, deploy).

### What the deploy actually does when SANs change

ACM cert **SANs are immutable**, so adding/removing a host makes CloudFormation **replace** the cert:
it provisions a new cert with the new SAN set, waits for ACM to issue it, swaps the distribution's
`ViewerCertificate` to the new ARN, then deletes the old cert — **all in one `deploy-stack.ps1` run.**
The only visible effect is a CloudFront config propagation (a few minutes). This one-shot behavior is
exactly why it's a **single** stack: a split cert-stack that *exported* the ARN would hit
CloudFormation's "Export cannot be updated as it is in use" wall on every cert replacement.

## Staged rollout / canary (`ACTIVE`)

The cert SANs and CloudFront aliases always cover the **full** `hosts.txt` (so the cert issues once and
never re-issues mid-rollout), but the Route53 records can be **staged** to a subset via the `ACTIVE`
env var — point one state at the dist, test, then roll out the rest with no cert change:

```
# canary: only Minnesota's www records flip to the redirect dist (others stay on s6)
ACTIVE=mn.db101.org,preview-mn.db101.org,mn.hb101.org,preview-mn.hb101.org python generate.py
../deploy-stack.ps1 www-redirect
#   ... test https://www.mn.db101.org etc. ...
# roll out the rest (records for all hosts; cert/dist unchanged -> fast)
python generate.py
../deploy-stack.ps1 www-redirect
```
`ACTIVE` unset/empty = all hosts (the committed `www-redirect.yaml` is always the full set). `ACTIVE`
only stages the *records*; the cert already covers every host, so a canary name has a valid cert immediately.

## Hard limit: 100 hosts

The cert's SAN count = number of hosts. ACM allows a max of **100 domain names per certificate**
(quota `L-FB94F0B0`, us-east-1 — raised from the default 10 to 100 on 2026-08-03). If `hosts.txt` ever
approaches 100 entries, split into a second cert/dist before adding more.

## Scope — what belongs here and what does NOT

- **In:** `<state>.db101.org`, `preview-<state>.db101.org`, `-es` variants, for **db101.org + hb101.org**.
  Include even unmaintained (CO) / unpublished (NV) states — a confused user still deserves a redirect,
  not a cert wall.
- **Out:** single-label `www.db101.org` (a real national site, already `*.db101.org`-covered — NOT the
  double-label problem), and the `eightfoldway.com` / `vets101.org` zones.

## Files

| File | Role |
|------|------|
| `hosts.txt` | **The source of truth.** One host per line. Edit this. |
| `generate.py` | `hosts.txt` → `../www-redirect.yaml`. Run after editing hosts.txt. |
| `../www-redirect.yaml` | **Generated. Do not hand-edit.** Committed so the deploy is diff-reviewable. |
| `../params/www-redirect.json` | `[]` — the stack takes no CFN parameters. |
| `README.md` | This file. |

## First deploy notes

- **Gated on the ACM quota** being live: `aws service-quotas get-service-quota --region us-east-1
  --service-code acm --quota-code L-FB94F0B0` must return a value ≥ the host count (raised to 100).
- On first deploy the `www.<host>` records **UPSERT** off their current `→ s6` values to the dist.
  CloudFormation RecordSets use UPSERT, so this adopts them cleanly; if one ever throws "already
  exists", delete that single record and re-run. This also **detaches all `www.<host>` names from
  `s6`**, clearing a chunk of the web-06 depublicize (Phase D) s6 fan-out.
