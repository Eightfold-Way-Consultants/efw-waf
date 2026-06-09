import glob, re, collections, datetime, statistics
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
POLL=re.compile(r'/planning/(query|gconf|savedsessions|sessions|ajax|poll)',re.I)
raw=collections.defaultdict(list); seen=set(); dupes=0
for f in LOGS:
    sid=re.search(r'W3SVC(\d+)',f).group(1)
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        stem,q,cip,ua=p[4],p[5],p[8],p[9]
        if cip=='52.8.7.0': continue
        if not stem.lower().startswith('/planning/'): continue
        key=(p[0],p[1],cip,stem,q,sid)
        if key in seen: dupes+=1; continue
        seen.add(key)
        try: dt=datetime.datetime.strptime(p[0]+' '+p[1],'%Y-%m-%d %H:%M:%S')
        except: continue
        is_step = not POLL.search(stem)
        raw[cip].append((dt,stem,ua,is_step))
print(f"exact-duplicate /planning/ lines skipped: {dupes}")

rows=sorted(raw.items(), key=lambda kv:-len(kv[1]))[:12]
print(f"\n{'IP':<16}{'all':>5}{'steps':>6}{'distinct':>9}{'stepspan':>9}{'med_step_gap':>13}  verdict")
for ip,evs in rows:
    steps=sorted([e for e in evs if e[3]])
    st=[e[0] for e in steps]
    gaps=[(st[i+1]-st[i]).total_seconds() for i in range(len(st)-1)]
    med=statistics.median(gaps) if gaps else 0
    span=(st[-1]-st[0]).total_seconds()/60 if len(st)>1 else 0
    distinct=len(set(e[1] for e in steps))
    # speed-run = many distinct step pages advancing fast & steadily
    fast=sum(1 for g in gaps if g<3)/len(gaps)*100 if gaps else 0
    verdict = "SPEED-RUN?" if (len(st)>25 and med<3 and distinct>6) else ("bursty" if fast>60 else "human-paced")
    print(f"{ip:<16}{len(evs):>5}{len(steps):>6}{distinct:>9}{span:>8.0f}m{med:>11.1f}s  {verdict}  (<3s {fast:.0f}%)")

for ip,evs in rows[:3]:
    steps=sorted([e for e in evs if e[3]])
    print(f"\n=== {ip}  STEP-page cadence (poll/dupes stripped) — first 18 ===")
    prev=None
    for dt,stem,ua,_ in steps[:18]:
        g=f"{(dt-prev).total_seconds():>6.0f}s" if prev else "   ---"
        print(f"  {dt.strftime('%H:%M:%S')} {g}  {stem}")
        prev=dt
