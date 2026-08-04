#!/usr/bin/env python3
"""Point www.<host> Route53 records at the www-redirect CloudFront distribution (UPSERT).

CloudFormation Route53 RecordSets use CREATE and collide with the existing www.<host> -> s6
records, so the records live here instead of in the stack. UPSERT adopts the existing records
atomically (no NXDOMAIN gap, no bulk pre-delete). Run AFTER the stack is deployed.

  ACTIVE=mn.db101.org,preview-mn.db101.org,... python point-records.py [--dry-run]
  python point-records.py            # all hosts in hosts.txt

Reads the dist domain from the efw-waf-www-redirect stack output (or --dist <domain>).
"""
import os, sys, json, subprocess
from generate import load_hosts, zone_of  # same dir

REGION = "us-east-1"
STACK  = "efw-waf-www-redirect"

def dist_domain():
    for a in sys.argv:
        if a.startswith("--dist="):
            return a.split("=", 1)[1]
    out = subprocess.run(
        ["aws", "cloudformation", "describe-stacks", "--region", REGION, "--stack-name", STACK,
         "--query", "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue", "--output", "text"],
        capture_output=True, text=True)
    d = out.stdout.strip()
    if not d or d == "None":
        raise SystemExit(f"could not read DistributionDomain from stack {STACK}: {out.stderr.strip()}")
    return d

def main():
    dry = "--dry-run" in sys.argv
    all_hosts = load_hosts()
    active_env = os.environ.get("ACTIVE", "").strip()
    if active_env:
        active = set(x.strip() for x in active_env.split(",") if x.strip())
        unknown = active - set(all_hosts)
        if unknown:
            raise SystemExit(f"ACTIVE lists hosts not in hosts.txt: {sorted(unknown)}")
        hosts = [h for h in all_hosts if h in active]
    else:
        hosts = all_hosts

    dom = dist_domain()
    print(f"dist = {dom}")
    print(f"pointing {len(hosts)} www records (UPSERT):")

    by_zone = {}
    for h in hosts:
        _, zid = zone_of(h)
        by_zone.setdefault(zid, []).append(f"www.{h}")

    for zid, names in by_zone.items():
        changes = [{
            "Action": "UPSERT",
            "ResourceRecordSet": {
                "Name": n, "Type": "CNAME", "TTL": 300,
                "ResourceRecords": [{"Value": dom}],
            }} for n in names]
        batch = {"Comment": "www-redirect: point www.<host> at redirect dist", "Changes": changes}
        for n in names:
            print(f"  {n:32s} CNAME -> {dom}")
        if dry:
            continue
        r = subprocess.run(
            ["aws", "route53", "change-resource-record-sets", "--hosted-zone-id", zid,
             "--change-batch", json.dumps(batch), "--query", "ChangeInfo.Status", "--output", "text"],
            capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit(f"change failed for zone {zid}: {r.stderr.strip()}")
        print(f"  zone {zid}: {r.stdout.strip()}")
    if dry:
        print("(dry-run — no changes applied)")

if __name__ == "__main__":
    main()
