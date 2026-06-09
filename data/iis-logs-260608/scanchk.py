import glob, collections
SCAN=set("""104.28.228.78 23.101.4.52 34.71.208.184 38.76.194.177 208.84.101.224
62.171.160.12 158.94.210.128 140.245.114.136 78.142.18.40 35.202.26.185
132.196.3.209 74.248.131.114 135.225.35.148 136.118.167.180 172.190.142.176
172.213.242.226 20.82.177.137 66.175.211.202 4.231.224.223 20.251.55.245
52.178.176.146 172.161.6.233 20.203.199.44 74.248.99.208 51.120.70.13
134.199.162.240 170.64.219.32""".split())
hits=collections.Counter()
for f in glob.glob(r"C:/git/efw-waf/data/iis-logs-260608/W3SVC*/u_ex260608.log"):
    for line in open(f,encoding='utf-8',errors='replace'):
        if line.startswith('#'): continue
        p=line.split(' ')
        if len(p)>8 and p[8] in SCAN: hits[p[8]]+=1
print(f"April-20 scanner IPs in blocklist: {len(SCAN)}")
print(f"How many appear in June-8 logs: {len(hits)}")
for ip,n in hits.most_common(): print(f"   {ip}  {n} hits")
if not hits: print("   (none — every IP in the static list is absent from current traffic)")
