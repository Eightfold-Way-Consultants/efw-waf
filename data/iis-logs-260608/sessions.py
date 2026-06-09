import glob, re, collections, datetime, statistics
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
POLL=re.compile(r'/planning/(query|gconf|savedsessions|sessions|ajax|poll|node|confirm)',re.I)
utok=re.compile(r'(?:^|&)u=([0-9]+)')
sess=collections.defaultdict(list)
have_tok=0; no_tok=0
for f in LOGS:
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        stem,q,cip,ua,st=p[4],p[5],p[8],p[9],p[11]
        if cip=='52.8.7.0': continue
        if not stem.lower().startswith('/planning/'): continue
        if st in('302','304'): continue            # collapse redirect/cond-get noise
        m=utok.search(q)
        if m: have_tok+=1; key=m.group(1)
        else: no_tok+=1; continue
        try: dt=datetime.datetime.strptime(p[0]+' '+p[1],'%Y-%m-%d %H:%M:%S')
        except: continue
        is_step = not POLL.search(stem)
        sess[key].append((dt,stem,cip,ua,is_step))

print(f"/planning/ 200/other reqs WITH u= token: {have_tok}   without: {no_tok}   sessions: {len(sess)}")

# per session: distinct step pages, span, cadence on steps
recs=[]
for k,evs in sess.items():
    evs.sort()
    steps=[e for e in evs if e[4]]
    if len(steps)<3: continue
    st=[e[0] for e in steps]
    span=(st[-1]-st[0]).total_seconds()
    gaps=[(st[i+1]-st[i]).total_seconds() for i in range(len(st)-1)]
    med=statistics.median(gaps) if gaps else 0
    distinct=len(set(e[1] for e in steps))
    ip=evs[0][2]; ua=evs[0][3]
    recs.append((distinct,len(steps),span,med,ip,ua,k))

print(f"\nsessions with >=3 step pages: {len(recs)}")
print("\n=== FASTEST walks: >=6 distinct steps, sorted by median step gap (ascending) ===")
fast=[r for r in recs if r[0]>=6]
fast.sort(key=lambda r:(r[3],r[2]))
print(f"{'distinct':>8}{'steps':>6}{'span':>7}{'medgap':>7}  ip / ua")
for distinct,n,span,med,ip,ua,k in fast[:15]:
    print(f"{distinct:>8}{n:>6}{span:>6.0f}s{med:>6.1f}s  {ip:<15} {ua[:45]}")

# distribution of median step gaps across all multi-step sessions
meds=sorted(r[3] for r in recs)
if meds:
    print(f"\nmedian-step-gap distribution across {len(meds)} sessions:")
    for pct in (10,25,50,75,90):
        i=min(len(meds)-1,int(len(meds)*pct/100))
        print(f"  p{pct}: {meds[i]:.1f}s")
    print(f"  sessions with median step gap <2s: {sum(1 for m in meds if m<2)}  (<1s: {sum(1 for m in meds if m<1)})")
