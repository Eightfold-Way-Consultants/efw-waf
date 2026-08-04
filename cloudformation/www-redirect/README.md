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

A **standalone** CloudFormation stack (`efw-waf-www-redirect`, us-east-1) owns the infra:

1. **ACM cert** with a SAN `www.<host>` for every host, DNS-validated (CFN creates the validation
   records in the correct zone and waits for issuance).
2. **CloudFront distribution** whose only job is to answer those `www.<host>` aliases.
3. A generic **`strip-www` CloudFront Function** (viewer-request): `www.X` → `301 https://X` + path + query.
   Host-agnostic — one function covers every state and `-es`/`preview-` variant. No per-host logic.

The **Route53 `www.<host>` records are NOT in the stack** — CloudFormation Route53 RecordSets use CREATE
(not UPSERT) and collide with the pre-existing `www.<host> → s6` records. Instead **`point-records.py`**
UPSERTs `www.<host>` CNAME → the dist, which adopts the existing `→ s6` records atomically (no NXDOMAIN
gap, no bulk pre-delete). So a full apply is two steps: **`deploy-stack.ps1 www-redirect`** (cert+dist+fn),
then **`python point-records.py`** (the records). Both read the same `hosts.txt` (and honor `ACTIVE`).

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
3. Deploy the infra (replaces the cert with the new SAN set): `..\deploy-stack.ps1 www-redirect`.
4. Point the new records at the dist: `python point-records.py`  (UPSERTs `www.xx*` → the dist).
5. Sanity-check: `git diff` on `www-redirect.yaml` shows exactly the new `www.xx*` SANs/validation/aliases;
   `curl -sI https://www.xx.db101.org/` returns `301 → https://xx.db101.org/` with a valid cert.

Removing a state is the same in reverse (delete the line, regenerate, deploy; optionally delete the record).

### What the deploy actually does when SANs change

ACM cert **SANs are immutable**, so adding/removing a host makes CloudFormation **replace** the cert:
it provisions a new cert with the new SAN set, waits for ACM to issue it, swaps the distribution's
`ViewerCertificate` to the new ARN, then deletes the old cert — **all in one `deploy-stack.ps1` run.**
The only visible effect is a CloudFront config propagation (a few minutes). This one-shot behavior is
exactly why it's a **single** stack: a split cert-stack that *exported* the ARN would hit
CloudFormation's "Export cannot be updated as it is in use" wall on every cert replacement.

## Staged rollout / canary (`ACTIVE`)

`ACTIVE=<comma-list>` scopes the **whole** operation (cert SANs + aliases + which records get pointed) to
a subset, so a canary uses a **small cert** that stays under the ACM SAN limit — the canary needs no quota
increase. `ACTIVE` unset/empty = all hosts (the committed `www-redirect.yaml` is always the full 48).

```
# canary: MN only -> a 4-SAN cert (under the default limit of 10, so no quota needed)
ACTIVE=mn.db101.org,preview-mn.db101.org,mn.hb101.org,preview-mn.hb101.org python generate.py
../deploy-stack.ps1 www-redirect          # cert(4)+dist+function
ACTIVE=mn.db101.org,preview-mn.db101.org,mn.hb101.org,preview-mn.hb101.org python point-records.py
#   ... test https://www.mn.db101.org etc. (301 -> https://mn.db101.org, valid cert) ...
# full rollout (needs the ACM 100-SAN quota LIVE): cert REPLACED 4 -> 48, then point all records
python generate.py
../deploy-stack.ps1 www-redirect
python point-records.py
```
Because `ACTIVE` scopes the cert too, going canary→full **replaces** the cert (4→48 SANs) — one extra
issuance, but it lets the canary run today while the full-set quota is still pending.

## Hard limit: 100 hosts

The cert's SAN count = number of hosts. ACM's default is **10 domain names per certificate** (quota
`L-FB94F0B0`, us-east-1); the max on request is **100**. The full 48-host set therefore needs the quota
raised to ≥48 — a request to 100 is in flight (case `178580749300490`) but as of 2026-08-04 **not yet
applied** (still enforcing 10). Until it applies, only subsets ≤10 (via `ACTIVE`) can deploy. If `hosts.txt`
ever approaches 100, split into a second cert/dist. Check: `aws service-quotas get-service-quota
--region us-east-1 --service-code acm --quota-code L-FB94F0B0 --query 'Quota.Value'`.

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
| `generate.py` | `hosts.txt` (+ `ACTIVE`) → `../www-redirect.yaml` (cert+dist+function). |
| `point-records.py` | UPSERTs `www.<host>` CNAME → the dist (records live here, NOT in the stack). Run after deploy. |
| `../www-redirect.yaml` | **Generated. Do not hand-edit.** Committed (full set) so the deploy is diff-reviewable. |
| `../params/www-redirect.json` | `[]` — the stack takes no CFN parameters. |
| `README.md` | This file. |

## First deploy notes

- **Full set gated on the ACM quota** being live (see "Hard limit" above): the 48-SAN cert fails until
  `get-service-quota … L-FB94F0B0` returns ≥48. Canary subsets ≤10 (via `ACTIVE`) deploy today.
- `point-records.py` **UPSERTs** the `www.<host>` records off their current `→ s6` values to the dist —
  adopts existing ones and creates missing ones, atomically, with no NXDOMAIN gap. This also **detaches
  those `www.<host>` names from `s6`**, clearing a chunk of the web-06 depublicize (Phase D) s6 fan-out.
- **Status (2026-08-04):** MN canary is DEPLOYED + verified end-to-end (4-SAN cert `…03bf8da9`, dist
  `d18sfe9ai3g3ci.cloudfront.net`); the other 44 hosts await the quota.
