import glob, re, collections
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
TARGET={'146.75.146.83','168.166.80.217','64.238.13.13'}
rows=collections.defaultdict(list)
for f in LOGS:
    sid=re.search(r'W3SVC(\d+)',f).group(1)
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17 or p[8] not in TARGET: continue
        if '/planning/' not in p[4].lower(): continue
        rows[p[8]].append((p[1],p[3],p[4],p[5],p[11],p[12],p[14],p[15],p[16],sid))
shown=0
for ip,evs in rows.items():
    evs.sort()
    for i in range(len(evs)-1):
        a,b=evs[i],evs[i+1]
        # same time, method, stem, query, status, sub, same site -> identical KEY
        if a[0]==b[0] and a[1]==b[1] and a[2]==b[2] and a[3]==b[3] and a[4]==b[4] and a[5]==b[5] and a[9]==b[9]:
            if (a[6],a[7],a[8])!=(b[6],b[7],b[8]):   # but bytes/timing differ
                print(f"[{ip}] W3SVC{a[9]}  IDENTICAL key, twice:")
                for x in (a,b):
                    print(f"   t={x[0]} {x[1]:4} {x[2]}{('?'+x[3]) if x[3]!='-' else ''} -> {x[4]}.{x[5]}  scb={x[6]} csb={x[7]} ttk={x[8]}ms")
                shown+=1
        if shown>=6: break
    if shown>=6: break
print("\n(residue-class examples shown:",shown,")")
