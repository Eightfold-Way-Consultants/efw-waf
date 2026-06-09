import glob, re, collections, datetime, statistics
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
# gather /planning/ events per client IP: (datetime, stem, ua, ms)
ev=collections.defaultdict(list)
for f in LOGS:
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        stem,cip,ua,ttk=p[4],p[8],p[9],p[16]
        if cip=='52.8.7.0': continue          # origin self-traffic, ignore
        if not stem.lower().startswith('/planning/'): continue
        try: dt=datetime.datetime.strptime(p[0]+' '+p[1],'%Y-%m-%d %H:%M:%S')
        except: continue
        ev[cip].append((dt,stem,ua,ttk))

rows=sorted(ev.items(), key=lambda kv:-len(kv[1]))[:12]
print(f"{'IP':<16}{'reqs':>5}{'span':>8}{'med_gap':>8}{'<2s':>6}{'<1s':>6}{'distinct':>9}  signature")
for ip,evs in rows:
    evs.sort()
    times=[e[0] for e in evs]
    gaps=[(times[i+1]-times[i]).total_seconds() for i in range(len(times)-1)]
    span=(times[-1]-times[0]).total_seconds()
    med=statistics.median(gaps) if gaps else 0
    lt2=sum(1 for g in gaps if g<2)/len(gaps)*100 if gaps else 0
    lt1=sum(1 for g in gaps if g<1)/len(gaps)*100 if gaps else 0
    distinct=len(set(e[1] for e in evs))
    sig = "SPEED-RUN" if (med<2 and len(evs)>30) else ("burst" if lt2>50 else "human-ish")
    print(f"{ip:<16}{len(evs):>5}{span/60:>7.0f}m{med:>7.1f}s{lt2:>5.0f}%{lt1:>5.0f}%{distinct:>9}  {sig}")

# detailed timeline for the top 2 IPs
for ip,evs in rows[:2]:
    evs.sort()
    print(f"\n=== {ip}  first 20 /planning/ hits (gap | stem) ===")
    prev=None
    for dt,stem,ua,ttk in evs[:20]:
        g=f"{(dt-prev).total_seconds():>5.1f}s" if prev else "  ---"
        print(f"  {dt.strftime('%H:%M:%S')} {g}  {stem[:70]}")
        prev=dt
    print(f"  UA: {evs[0][2][:90]}")
