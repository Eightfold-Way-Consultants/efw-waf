import glob, re, collections

LOGS = glob.glob("C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log")
FIELDS = None
tot=0; status=collections.Counter()
ip_cnt=collections.Counter(); ip_ua=collections.defaultdict(collections.Counter)
ua_cnt=collections.Counter()
plan_ip=collections.Counter(); plan_ip_ms=collections.Counter()
plan_total=0; plan_ms=0
probe_cnt=collections.Counter(); probe_ip=collections.Counter()
cls_cnt=collections.Counter(); cls_plan=collections.Counter()
ms_by_ip=collections.Counter()

PROBE=re.compile(r'(\.env|\.git|wp-login|wp-admin|wp-includes|xmlrpc\.php|/\.aws|/\.ssh|id_rsa|phpmyadmin|/vendor/|eval-stdin|/\.vscode|/actuator|/config\.|/\.docker|/owa/|/boaform|/\.well-known/.*\.php|aws-secret|/cgi-bin/|/\.DS_Store|composer\.)', re.I)

def classify(ua):
    u=ua.lower()
    if u=='-' or u=='': return 'empty-ua'
    for k in ('gptbot','ccbot','claudebot','anthropic','bytespider','amazonbot','google-extended','perplexity','ai2bot','omgili','diffbot','dataforseo','semrushbot','ahrefsbot','mj12bot','dotbot','meta-external','imagesiftbot','timpibot'):
        if k in u: return 'ai-scraper'
    for k in ('googlebot','bingbot','applebot','duckduckbot','yandex','baiduspider','slurp','petalbot','msnbot'):
        if k in u: return 'search-bot'
    for k in ('python-requests','python-urllib','curl/','wget','go-http-client','okhttp','scrapy','headlesschrome','phantomjs','libwww','httpclient','axios','node-fetch','masscan','zgrab','nmap','nikto','java/','guzzle','aiohttp','httpx'):
        if k in u: return 'tool/script'
    if 'mozilla' in u or 'applewebkit' in u: return 'browser-ua'
    return 'other'

for f in LOGS:
    for line in open(f, encoding='utf-8', errors='replace'):
        if line.startswith('#'): continue
        p=line.rstrip('\n').split(' ')
        if len(p)<17: continue
        method,stem,query,cip,ua,st,ttk = p[3],p[4],p[5],p[8],p[9],p[11],p[16]
        tot+=1; status[st]+=1; ip_cnt[cip]+=1; ua_cnt[ua]+=1
        ip_ua[cip][ua]+=1
        try: ms=int(ttk)
        except: ms=0
        ms_by_ip[cip]+=ms
        c=classify(ua); cls_cnt[c]+=1
        if stem.lower().startswith('/planning/'):
            plan_total+=1; plan_ip[cip]+=1; plan_ip_ms[cip]+=ms; plan_ms+=ms; cls_plan[c]+=1
        if PROBE.search(stem):
            probe_cnt[stem.lower()[:60]]+=1; probe_ip[cip]+=1

print(f"TOTAL requests: {tot}")
print("status:", dict(status.most_common(8)))
print(f"\n/planning/ requests: {plan_total}   total server time on /planning/: {plan_ms/1000:.0f}s ({plan_ms/60000:.1f} min)")

print("\n=== request class mix (all) ===")
for c,n in cls_cnt.most_common(): print(f"  {c:<12} {n:>7}  {100*n/tot:5.1f}%")
print("=== class mix on /planning/ ===")
for c,n in cls_plan.most_common(): print(f"  {c:<12} {n:>7}  {100*n/max(plan_total,1):5.1f}%")

print("\n=== top 15 client IPs (all requests) ===")
for ip,n in ip_cnt.most_common(15):
    topua=ip_ua[ip].most_common(1)[0][0][:55]
    print(f"  {ip:<16} {n:>6} reqs  {ms_by_ip[ip]/1000:>7.0f}s  plan={plan_ip.get(ip,0):>5}  ua={topua}")

print("\n=== top 12 IPs by /planning/ SERVER TIME (cost) ===")
for ip,ms in plan_ip_ms.most_common(12):
    topua=ip_ua[ip].most_common(1)[0][0][:50]
    print(f"  {ip:<16} {ms/1000:>7.0f}s  {plan_ip[ip]:>5} reqs  ua={topua}")

print("\n=== top 12 user-agents ===")
for ua,n in ua_cnt.most_common(12):
    print(f"  {n:>6}  [{classify(ua)}]  {ua[:75]}")

print(f"\n=== PROBE requests: {sum(probe_cnt.values())} hits from {len(probe_ip)} IPs ===")
for s,n in probe_cnt.most_common(15): print(f"  {n:>4}  {s}")
print("  top probe IPs:")
for ip,n in probe_ip.most_common(8):
    print(f"    {ip:<16} {n:>4}  ua={ip_ua[ip].most_common(1)[0][0][:50]}")
