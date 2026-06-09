import glob, re, collections, datetime, statistics
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
TOK=re.compile(r'S(?:\(|%28)([a-z0-9]{16,32})(?:\)|%29)',re.I)
sess=collections.defaultdict(list)
for f in LOGS:
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        stem,cip,ua,st=p[4],p[8],p[9],p[11]
        if cip=='52.8.7.0': continue
        if '/planning/' not in stem.lower(): continue

        m=TOK.search(stem)
        if not m: continue
        try: dt=datetime.datetime.strptime(p[0]+' '+p[1],'%Y-%m-%d %H:%M:%S')
        except: continue
        page=re.sub(r'.*?%29%29/|.*?\)\)/','',stem)        # strip the (S())/ prefix -> page name
        sess[m.group(1).lower()].append((dt,page,cip,ua))

recs=[]
for k,evs in sess.items():
    evs.sort()
    t=[e[0] for e in evs]
    span=(t[-1]-t[0]).total_seconds()
    gaps=[(t[i+1]-t[i]).total_seconds() for i in range(len(t)-1)]
    med=statistics.median(gaps) if gaps else 0
    distinct=len(set(e[1] for e in evs))
    recs.append((len(evs),distinct,span,med,evs[0][2],evs[0][3],k))
print(f"sessions keyed on (S()): {len(recs)}")

multi=[r for r in recs if r[1]>=5]      # >=5 distinct pages = a real walk
print(f"sessions with >=5 distinct pages: {len(multi)}")
print("\nspan distribution (first->last hit) for those walks:")
spans=sorted(r[2] for r in multi)
for pct in (10,25,50,75,90):
    spans_i=spans[min(len(spans)-1,int(len(spans)*pct/100))]
    print(f"  p{pct}: {spans_i/60:.1f} min")

print("\n=== FASTEST full walks (>=8 distinct pages, smallest span) ===")
multi.sort(key=lambda r:(r[2],) )
shown=0
print(f"{'reqs':>5}{'distinct':>9}{'span':>8}{'medgap':>7}  ip / ua")
for n,d,span,med,ip,ua,k in sorted([r for r in recs if r[1]>=8], key=lambda r:r[2])[:15]:
    print(f"{n:>5}{d:>9}{span:>6.0f}s{med:>6.1f}s  {ip:<15} {ua[:42]}")

print(f"\nwalks (>=5 pages) completed in < 60s: {sum(1 for r in multi if r[2]<60)}")
print(f"walks (>=5 pages) completed in < 20s: {sum(1 for r in multi if r[2]<20)}")
