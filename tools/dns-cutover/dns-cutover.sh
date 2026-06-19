#!/usr/bin/env bash
# dns-cutover.sh — per-leaf DNS cutover + backout for the WAF/CloudFront migration.
#
# LEAF-BY-LEAF ONLY. It refuses the s4/s6/s6a/s6c/*-site/*-svc aggregators and zone apexes:
# the aggregators are machine-identity names (must keep pointing at their origin/machine), and
# apexes are ALIAS records (handled manually, can't CNAME). Each cutover is one deliberate leaf.
#
# DRY-RUN BY DEFAULT. Pass --apply to actually submit Route53 changes. Without it, the script
# prints the exact change-batch it WOULD submit and changes nothing.
#
# Usage:  dns-cutover.sh <tier> <verb> <leaf> [leaf ...] [--apply]
#   tier   preview2 | public          (-> cf-preview2 / cf-public . eightfoldway.com)
#   verb   prestage | flip | backout | finalize
#     prestage  capture each leaf's CURRENT record as a revert batch, then lower TTL 300->60
#     flip      point the leaf CNAME at cf-<tier>.eightfoldway.com (TTL 60)
#     backout   restore the leaf from its saved revert batch  <-- the undo button (one call)
#     finalize  raise the leaf TTL back to 300 (run once the tier is committed; target unchanged)
#
# Revert batches are written to / read from $REVERT_DIR (default: <scriptdir>/revert), and are
# meant to be committed for audit. `backout` REQUIRES the batch to exist — it never guesses.
#
# Examples:
#   dns-cutover.sh public prestage ak.db101.org                 # dry-run: show + save revert
#   dns-cutover.sh public prestage ak.db101.org --apply         # save revert + drop TTL to 60
#   dns-cutover.sh public flip     ak.db101.org --apply         # canary: send it through CloudFront
#   dns-cutover.sh public backout  ak.db101.org --apply         # undo
#   dns-cutover.sh preview2 finalize preview2-mn.db101.org --apply   # raise TTL back to 300

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVERT_DIR="${REVERT_DIR:-$SCRIPT_DIR/revert}"

usage(){ grep '^#' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit "${1:-0}"; }
[ $# -lt 3 ] && usage 1
case "${1:-}" in -h|--help) usage 0 ;; esac

TIER="$1"; VERB="$2"; shift 2
APPLY=0; LEAVES=()
for a in "$@"; do [ "$a" = "--apply" ] && APPLY=1 || LEAVES+=("$a"); done

case "$TIER" in
  preview2) CF="cf-preview2.eightfoldway.com" ;;
  public)   CF="cf-public.eightfoldway.com" ;;
  *) echo "ERROR: tier must be 'preview2' or 'public'"; exit 2 ;;
esac
case "$VERB" in prestage|flip|backout|finalize) ;; *) echo "ERROR: verb must be prestage|flip|backout|finalize"; exit 2 ;; esac
[ ${#LEAVES[@]} -eq 0 ] && { echo "ERROR: no leaves given"; exit 2; }

[ "$APPLY" = 1 ] && echo "*** APPLY MODE — changes WILL be submitted ***" || echo "--- DRY-RUN (no changes; pass --apply to submit) ---"

zone_of(){ echo "$1" | awk -F. '{print $(NF-1)"."$NF}'; }
zoneid_of(){ aws route53 list-hosted-zones --query "HostedZones[?Name=='$1.'].Id" --output text 2>/dev/null | sed 's#/hostedzone/##'; }
# Returns "TYPE<TAB>TTL<TAB>VALUE" for the leaf, or empty. Robust to Route53 pagination:
# the [?Name==] filter yields an empty list (no output) on non-matching pages, so we drop
# blank lines and take the single real match — instead of [0] which prints "None" per page.
get_record(){ aws route53 list-resource-record-sets --hosted-zone-id "$1" \
                --query "ResourceRecordSets[?Name=='$2.'].[Type,TTL,ResourceRecords[0].Value]" \
                --output text 2>/dev/null | awk 'NF' | head -1; }
batch(){ printf '{"Changes":[{"Action":"%s","ResourceRecordSet":{"Name":"%s.","Type":"CNAME","TTL":%s,"ResourceRecords":[{"Value":"%s"}]}}]}' "$1" "$2" "$3" "$4"; }
forbidden(){ case "$1" in s4.*|s6.*|s6a.*|s6c.*|*-site.*|*-svc.*) return 0 ;; *) return 1 ;; esac; }
submit(){ # zoneid json label
  if [ "$APPLY" = 1 ]; then
    local out; out=$(aws route53 change-resource-record-sets --hosted-zone-id "$1" --change-batch "$2" --query 'ChangeInfo.Status' --output text 2>&1) \
      && echo "    APPLIED ($out): $3" || { echo "    ERROR submitting $3: $out"; return 1; }
  else
    echo "    would submit: $2"
  fi
}

for leaf in "${LEAVES[@]}"; do
  echo ">> $VERB $leaf"
  if forbidden "$leaf"; then echo "    REFUSE: aggregator/origin-identity name — leaves only"; continue; fi
  zone=$(zone_of "$leaf")
  if [ "$leaf" = "$zone" ]; then echo "    REFUSE: apex — use Route53 ALIAS manually, can't CNAME"; continue; fi
  zid=$(zoneid_of "$zone")
  [ -z "$zid" ] && { echo "    ERROR: no hosted zone for $zone"; continue; }
  rec=$(get_record "$zid" "$leaf")
  if [ -z "$rec" ]; then type="None"; ttl=""; val=""; else
    type=$(printf '%s' "$rec" | cut -f1); ttl=$(printf '%s' "$rec" | cut -f2); val=$(printf '%s' "$rec" | cut -f3); fi

  case "$VERB" in
    prestage)
      { [ "$type" = "None" ] || [ -z "$type" ]; } && { echo "    ERROR: no record found"; continue; }
      [ "$type" != "CNAME" ] && { echo "    REFUSE: type $type (CNAME leaves only)"; continue; }
      case "$val" in cf-*) echo "    REFUSE: already points at $val — prestage is for pre-flip leaves (revert would be wrong)"; continue ;; esac
      mkdir -p "$REVERT_DIR"
      batch UPSERT "$leaf" "$ttl" "$val" > "$REVERT_DIR/$leaf.json"
      echo "    saved revert -> revert/$leaf.json (restores $val, TTL $ttl)"
      submit "$zid" "$(batch UPSERT "$leaf" 60 "$val")" "lower TTL 300->60 (target unchanged: $val)"
      ;;
    flip)
      [ "$type" != "CNAME" ] && [ "$type" != "None" ] && { echo "    REFUSE: type $type"; continue; }
      [ -f "$REVERT_DIR/$leaf.json" ] || echo "    WARN: no revert batch saved yet (run prestage first for a safe backout)"
      submit "$zid" "$(batch UPSERT "$leaf" 60 "$CF")" "flip -> $CF (TTL 60)"
      ;;
    backout)
      [ -f "$REVERT_DIR/$leaf.json" ] || { echo "    REFUSE: no revert batch at revert/$leaf.json (nothing to restore to)"; continue; }
      submit "$zid" "$(cat "$REVERT_DIR/$leaf.json")" "restore from revert/$leaf.json"
      ;;
    finalize)
      { [ "$type" = "None" ] || [ -z "$type" ]; } && { echo "    ERROR: no record found"; continue; }
      [ "$type" != "CNAME" ] && { echo "    REFUSE: type $type"; continue; }
      [ "$ttl" = "300" ] && { echo "    already TTL 300 (no change)"; continue; }
      submit "$zid" "$(batch UPSERT "$leaf" 300 "$val")" "raise TTL ->300 (target unchanged: $val)"
      ;;
  esac
done
