import glob, re, collections
LOGS=glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
TARGET={'146.75.146.83','168.166.80.217','64.238.13.13'}
rows=collections.defaultdict(list)
for f in LOGS:
    sid=re.search(r'W3SVC(\d+)',f).group(1)
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        if p[8] not in TARGET: continue
        if '/planning/' not in p[4].lower(): continue
        # (date,time,method,stem,query,status,sub,scbytes,csbytes,ttk,sid)
        rows[p[8]].append((p[1],p[3],p[4],p[5],p[11],p[12],p[14],p[15],p[16],sid))

def classify_pair(a,b):
    # a,b are tuples; index:0time1method2stem3query4status5sub6scb7csb8ttk9sid
    if a[1]!=b[1]: return f"DIFF-METHOD ({a[1]}->{b[1]})  <- normal GET/POST?"
    if a[9]!=b[9]: return f"DIFF-SITE (W3SVC{a[9]} & {b[9]})  <- multi-binding double-log"
    if a[4]!=b[4]: return f"DIFF-STATUS ({a[4]}/{b[4]})  <- redirect/condget"
    if a[3]!=b[3]: return "DIFF-QUERY  <- different request"
    if (a[6],a[7],a[8])!=(b[6],b[7],b[8]): return "IDENTICAL key, diff bytes/timing  <- re-exec?"
    return "FULLY IDENTICAL  <- true duplicate"

for ip,evs in rows.items():
    evs.sort()
    print(f"\n===== {ip}: {len(evs)} /planning/ lines =====")
    # find consecutive same-time same-stem pairs
    sigs=collections.Counter(); examples={}
    for i in range(len(evs)-1):
        a,b=evs[i],evs[i+1]
        if a[0]==b[0] and a[2]==b[2]:          # same second, same stem
            c=classify_pair(a,b); sigs[c]+=1
            if c not in examples: examples[c]=(a,b)
    for c,n in sigs.most_common():
        print(f"  {n:>4}  {c}")
    # show one raw example of the dominant signature
    if examples:
        c0=sigs.most_common(1)[0][0]; a,b=examples[c0]
        print(f"  example [{c0}]:")
        for x in (a,b):
            print(f"     t={x[0]} {x[1]:4} {x[2]}{('?'+x[3]) if x[3]!='-' else ''} -> {x[4]}.{x[5]}  scb={x[6]} csb={x[7]} ttk={x[8]}ms  W3SVC{x[9]}")
