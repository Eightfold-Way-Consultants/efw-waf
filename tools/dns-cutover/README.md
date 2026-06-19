# dns-cutover — per-leaf DNS cutover + backout

`dns-cutover.sh` flips one hostname (leaf) at a time between its **origin chain** and the
**`cf-<tier>` CloudFront terminator**, with a pre-staged one-call backout. Leaf-by-leaf is
deliberate: the `s4`/`s6`/`s6a`/`s6c`/`*-site`/`*-svc` aggregators are **machine-identity**
names and must keep pointing at their origin — the script refuses them (and refuses apexes,
which are ALIAS records). See the DNS terminator scheme in `../../waf-cloudfront-migration.md`.

**Dry-run by default** — prints the exact Route53 change-batch it would submit and changes
nothing. Add `--apply` to submit.

## Verbs
| Verb | Does | When |
|---|---|---|
| `prestage` | save the leaf's CURRENT record as a revert batch (`revert/<leaf>.json`), then lower TTL 300→60 | before cutting a tier over |
| `flip` | point the leaf CNAME at `cf-<tier>.eightfoldway.com` (TTL 60) | the cutover |
| `backout` | restore the leaf from its saved revert batch — the undo button, one call | if the edge misbehaves |
| `finalize` | raise the leaf TTL back to 300 (target unchanged) | once the tier is committed/soaked |

## Typical flow (public canary, then the rest)
```bash
./dns-cutover.sh public prestage ak.db101.org --apply     # save revert + drop TTL
./dns-cutover.sh public flip     ak.db101.org --apply     # canary through CloudFront
# ...validate (curl, WAF logs, public-url-checker)...  if bad:
./dns-cutover.sh public backout  ak.db101.org --apply     # instant restore to origin
# good -> roll the rest:
./dns-cutover.sh public prestage nv.db101.org mn.db101.org ... --apply
./dns-cutover.sh public flip     nv.db101.org mn.db101.org ... --apply
# after the soak proves clean:
./dns-cutover.sh public finalize nv.db101.org mn.db101.org ... --apply
```

## Notes
- **Revert batches in `revert/` are committed** for audit — `backout` requires the batch to
  exist and never guesses an origin target.
- `prestage` refuses a leaf that already points at a `cf-*` terminator (it would otherwise
  capture the wrong revert target).
- preview2 is already flipped (TTL still 60). Its revert batches were captured at the original
  cutover; use `finalize` here to raise its TTLs back to 300 when the soak is declared done.
- Apexes (`db101.org`, `hb101.org`, `vets101.org`, `eightfoldway.com`) are ALIAS-flipped by hand.
