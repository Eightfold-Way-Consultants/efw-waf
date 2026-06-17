# Dynamic / POST / API path inventory — preview2-il (2026-06-17)

Purpose: enumerate every dynamic (non-cacheable) path so (a) all are cache-bypassed at CloudFront and (b) the WAF scope/`_BODY` coverage is understood. Captured empirically with Playwright (real Chromium): homepage load, full estimator walk, feedback form, + a `/tw` probe. Harness in `waf-reviews/scripts/` (`netcap-homepage.js`, `netcap-walk.js`, `feedback-submit.js`, `tw-*.json`).

## Preview vs public caveat (important)
On **preview2**, `efw.logon2.services.js` points `logonService`/`favoritesService` at **`preview-logon.db101.org` / `preview-favorites.db101.org`** (absolute, cross-origin) — so `/l2svc` and `/f2svc` **do NOT appear same-origin on preview2**. On **public (`_final`)** they are **same-origin `/l2svc`, `/f2svc`** (ARR reverse-proxy to the logon/favorites servers). Inventory below marks which is which.

## Same-origin DYNAMIC (must be no-cache + WAF-covered)
### Estimator `/planning/*` (captured — full walk to results)
| Path | Methods (max POST body) |
|---|---|
| `/planning/(S(..))/b2w2_il_index.aspx` | GET 302 (entry→session) |
| `/planning/(S(..))/b2w2_start.aspx` | GET, POST (281B) |
| `/planning/(S(..))/query.aspx` | GET, **POST (~3.8KB)** — main wizard postback |
| `/planning/(S(..))/node.aspx` | GET 302 (flow nodes) |
| `/planning/(S(..))/confirm.aspx`, `gconf.aspx` | GET, POST (431B) |
| `/planning/(S(..))/b2w2_results.aspx` | GET 200 |
| `/planning/ScriptResource.axd` | GET |
| `/planning/SavedSessions`, `.../AutosaveSession` | POST — logged-in only (from `efw.logon.3.0.js`; not seen anon) |

### Other same-origin dynamic
- **`/pdfreport/PDFReportService.asmx`** (`/jsdebug` + SOAP) — the PDF report service (pdfshot endpoint).
- **`/tw/tasklists/{list}/tasks.json?config=`** — feedback → TWProxy (POST JSON). **reCAPTCHA-gated** (v2; headless gets an image challenge → cannot submit; bogus token → origin 403, no ticket). WAF inspects the body at the edge regardless.
- **PUBLIC only (preview2 = cross-origin):** `/l2svc/*` — `Token`, `api/Account/*` (Register, Profile, ChangePassword, ResetPassword, ForgotPassword, SendConfirmationEmail, Disable, Organizations, …), `api/Role/*`, `api/UserRole/*`, `api/RoleRequest/*`, `api/PassCode`; `/f2svc/api/Favorites`. (Consumers = the homepage account-modal suite: logon, register, forgot, resetpass, changepass, profile, confemail, confdisable, requestrole, addorg, unsubscribe.)

## Cross-origin services (separate hosts/dists)
`preview-logon.db101.org/api/Organizations` (fired every screen, ×18) · `preview-favorites` · `vault.db101.org` · (homepage also embeds a `mastodon.social` feed).

## Body-size finding (WAF 8KB inspection window)
WAF inspects ~first 8KB of a POST body. Estimator `query.aspx` postbacks maxed **~3.8KB** here → fully inspectable. **But** this modeled a MINIMAL household (0 children, 1 job). A large household / many jobs could push `query.aspx` bodies higher, and the README noted a 44KB CMS ViewState. **TODO: a max-household body-size check** to confirm `_BODY` rules still see field values on heavy sessions (else injection past 8KB is invisible). `/tw` bodies are small.

## WAF `_BODY` coverage — confirmed
Direct `/tw` POST (origin 403, no ticket; WAF inspects at edge): injection body → **AWS-Windows** (`& whoami`) + **AWS-SQLi** (`1' OR`/`union select`) COUNTed; FP body (`O'Brien`, `< $2000 & rent >`, SQL-words) → **zero** matches. So `_BODY` inspection works on real same-origin POSTs and doesn't FP on legit free text (≤8KB).

## Cache-bypass verification — DONE ✓ (2026-06-17, dist `E1ZUT1S4LS09PI`)
The preview2 dist (`edge.yaml`) is **fail-closed**: `DefaultCacheBehavior` = Managed-**CachingDisabled** + `OriginRequestPolicyDynamic` (AllViewer: cookies/headers/qs all) + all methods (GET…DELETE). Only explicit **static** patterns are cached: `*.css`, `*.js`, `/dist/*`, `*.htm`, `/master_images/*`, `/master_documents/*`, `/documents/*`, `/images/*` (CachePolicyStatic: **Host in key** → no cross-site/staging leak; QueryString in key → cache-busting; GET/HEAD only).
- **No dynamic path matches a static pattern** → all of `/planning/*` (.aspx), `ScriptResource.axd`, `/pdfreport/*.asmx`, `/tw/*` (.json), `/l2svc`,`/f2svc`, `SavedSessions`, `AutosaveSession` fall through to no-cache. (edge.yaml L440 explicitly keeps `*.axd` out of static.)
- **Empirical X-Cache (each hit twice):** static `*.js`/`*.svg`/`*.css` → Miss→**Hit** (cached ✓); dynamic `/`, `/planning/...aspx`, `/pdfreport/...asmx` → Miss→**Miss** (never cached ✓).
- **Notes:** (a) `*.htm` is cached — safe per design (CMS-published templates, client-side personalization, invalidation on publish); flag only if any `.htm` ever serves server-personalized content. (b) Homepage `/` is **not** cached (no extension → default no-cache) — correctness-safe, minor perf (every homepage hit → origin); add a `/` behavior only if perf warrants.

## TODOs
2. **Logged-in capture** to surface authenticated dynamic paths (`/f2svc` Favorites, `SavedSessions`, `AutosaveSession`, vault, and the `/l2svc` auth POSTs same-origin on public).
3. **Max-household body-size check** (8KB `_BODY` window).
