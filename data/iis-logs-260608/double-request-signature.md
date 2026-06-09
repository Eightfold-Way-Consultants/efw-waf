# Estimator double-request signature (for source-code review)

Source: public-site IIS logs 2026-06-08 (`data/iis-logs-260608/`). Analysis scripts: `dbl.py`, `residue.py`.

## TL;DR
Most "doubled" log lines are **benign** — normal ASP.NET WebForms `serve (GET) + submit (POST)` plus the internal **POST-Redirect-GET** chain. **Do NOT chase those.** There is a smaller, distinct, suspicious class worth code review: the **estimator entry/bootstrap `*_index.aspx` pages are hit twice per entry**, both GET→302, same second.

## Three classes seen on /planning/ (same-second, same-stem adjacent pairs)

1. **GET→POST, different `screen=`/`u=`** (majority) — normal postback + the recently-mitigated 302 back-and-forth. Expected. Inflates request counts ~2-3x per logical step. **Ignore.**
2. **Different query, same second** — distinct concurrent steps. Expected. **Ignore.**
3. **IDENTICAL key (same time, method, stem, query, status, site), differing only in response bytes/time-taken** — the request appears to **execute twice**. **← investigate.**

## The class-3 signature (the one to investigate)
Concentrated on estimator **entry/bootstrap** pages (`b2w2_index.aspx`, `250_index.aspx`, `b2w2_mn_index.aspx`, etc.), all `GET … -> 302`, emitted twice in the same second:

```
GET /planning/b2w2_index.aspx          -> 302   scb=172 csb=713 ttk=96ms
GET /planning/b2w2_index.aspx          -> 302   scb=179 csb=743 ttk=84ms   (again, same second)
GET /planning/b2w2_index.aspx?l=b2w2   -> 302   scb=179 csb=775 ttk=10ms
GET /planning/b2w2_index.aspx?l=b2w2   -> 302   scb=222 csb=775 ttk=50ms   (again)
```

Entry frequently arrives from **Vault** ("try estimator" handoff):
```
GET /planning/b2w2_mn_index.aspx?skip=true&_vhost=https://mn.db101.org&_vret=%2Fpaths%2Fsession%2F12696%2FsingleActivity%2Factions%2Factivity%2FtryEstimatorAVY&_vsid=12696 -> 302  (twice)
```

The full entry bootstrap is a multi-302 chain: `<flow>_index.aspx` → `<flow>_index.aspx?l=<flow>` → `(S(<sessiontoken>))/<flow>_start.aspx`. The doubling is inside this entry chain (the index legs), not the step pages.

Byte deltas between the two emissions (172 vs 179; 713 vs 743) imply the two 302s carry slightly **different `Location` targets** (the redirect URL isn't in the W3C log, so confirm in code).

## Hypotheses for the code agent
- A redirect issued twice in the index/bootstrap handler — e.g. `Response.Redirect(...)` without `return`/`endResponse=false` handling, or redirect in both `Page_Init` and `Page_Load`, or an HttpModule acting on both the original and a re-entered request.
- Session-init re-entry: the cookieless-session bootstrap (`(S(...))`) re-hitting `_index.aspx` to attach `l=`/session, causing a second pass.
- The Vault "tryEstimator" handoff (`_vret`/`_vsid`) triggering an extra index hit.
- Client-side double navigation (less likely given server-side 302s).

## Scope / impact
Low absolute volume (single-digit per session) and only on entry pages → a **cleanliness/correctness** issue, not the load driver. The real /planning/ load is legitimate human step traffic. Still worth fixing to halve estimator-entry redirects.

## Where to look
`/planning/*_index.aspx` entry pages and the shared bootstrap/redirect that maps `_index.aspx` → `?l=<flow>` → `(S())/<flow>_start.aspx`, plus the Vault entry handler. Search the bp101-interface / planning entry code for the index redirect logic.
```
qmd search "index.aspx Response.Redirect l= start" 
```
