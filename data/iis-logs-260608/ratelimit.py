import glob, re, collections, datetime
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
# per IP: count requests per tumbling 5-min window, keep the max (peak 5-min load)
def bucket(dt): 
    return dt.replace(minute=(dt.minute//5)*5, second=0, microsecond=0)
all_w=collections.defaultdict(collections.Counter)
plan_w=collections.defaultdict(collections.Counter)
ua={}
for f in LOGS:
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        stem,cip=p[4],p[8]
        if cip=='52.8.7.0': continue          # origin self / print server, handled separately
        try: dt=datetime.datetime.strptime(p[0]+' '+p[1],'%Y-%m-%d %H:%M:%S')
        except: continue
        b=bucket(dt)
        all_w[cip][b]+=1
        ua.setdefault(cip,p[9])
        if stem.lower().startswith('/planning/'): plan_w[cip][b]+=1

def peaks(wmap):
    return {ip: max(c.values()) for ip,c in wmap.items() if c}

def report(name, pk, uam):
    vals=sorted(pk.values())
    n=len(vals)
    def pct(q): return vals[min(n-1,int(n*q))]
    print(f"\n=== {name}: peak requests per IP in any 5-min window ({n} IPs) ===")
    print(f"  p50={pct(.5)}  p90={pct(.9)}  p95={pct(.95)}  p99={pct(.99)}  max={vals[-1]}")
    print(f"  IPs over 100: {sum(1 for v in vals if v>100)}   over 300: {sum(1 for v in vals if v>300)}")
    print("  top 10 IPs by peak-5min:")
    for ip,v in sorted(pk.items(), key=lambda kv:-kv[1])[:10]:
        print(f"    {ip:<16} {v:>4}/5min   {uam.get(ip,'')[:46]}")

report("SITE-WIDE (all paths)", peaks(all_w), ua)
report("/planning/ ONLY", peaks(plan_w), ua)
