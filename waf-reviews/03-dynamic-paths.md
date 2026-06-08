# Review Agent #3 — Dynamic Path Completeness (Cache-Bypass Audit)

**Reviewer:** Figaro (AI assistant, self-performed)
**Date:** 2026-06-04 (round 7, self-performed)
**Scope:** CloudFront cache-bypass path list completeness — are all dynamic paths accounted for?
**Verdict:** ⚠️ **Plan's bypass list is incomplete — 4+ additional paths likely missing; needs codebase audit before Phase 1**

---

## 1. Plan's Current Bypass List

The plan lists these cache-bypass patterns:
```
/planning/*     — estimator planning paths
/tw/*           — Twilio webhook paths
/pdfreport/*    — PDF report generation
/l2svc/*        — legacy service path
/f2svc/*        — legacy service path
/ajax/*         — AJAX endpoints
/api/*          — API endpoints
/chatpresence/* — presence/chat
*.aspx          — all ASP.NET WebForms pages
```

## 2. Findings from Codebase Inspection

### Confirmed — Must Be Bypassed ✅

| Path | Evidence | Bypass Status |
|---|---|---|
| `*.aspx` | Default ASP.NET WebForms extension | ✅ Already in plan |
| `/planning/*` | Main estimator routes | ✅ Already in plan |
| `/ajax/*` | AJAX handler paths | ✅ Already in plan |
| `/api/*` | API endpoints | ✅ Already in plan |
| `/tw/*` | Twilio webhook | ✅ Already in plan |

### Found in Web.config — Must Be Bypassed ⚠️

| Path | Evidence | Bypass Status |
|---|---|---|
| `*.asmx` | SOAP web services (ScriptHandlerFactory for `*.asmx`) | ❌ **NOT in plan** |
| `*_AppService.axd` | ASP.NET AJAX app services | ❌ **NOT in plan** |
| `ScriptResource.axd` | ASP.NET AJAX script resources (loaded by `ScriptModule`) | ❌ **NOT in plan** |

**Impact:** `*.asmx` and `ScriptResource.axd` are used by ASP.NET AJAX infrastructure. If these are served through CloudFront with default caching, users may get stale JavaScript (cached AJAX libraries) even when the server has updated them. The `ScriptResource.axd` handler compresses and caches scripts — bypassing is strongly recommended.

### Likely Missing — Requires Codebase Audit ⚠️

| Path | Rationale | Action |
|---|---|---|
| `/auth/*` | Login, logout, session validation | Check for `auth` folder in f8 trunk |
| `/download/*` | File downloads (PDF, Excel exports from estimator) | Check if estimator uses `/download/` paths |
| `/report/*` | Report generation endpoints | Check BP101 interface routes |
| `*.ashx` | Generic HTTP handlers (file downloads, RSS, etc.) | Search f8 trunk for `.ashx` usage |
| `*.asmx` | SOAP services | See above — found in Web.config |
| `/asset/*` | Static asset serving via ASP.NET (not IIS static handler) | Check if any assets routed through ASP.NET |
| `/export/*` | Export endpoints (CSV, Excel) | Check estimator for export routes |

### Static Content — Can Be Cached ✅

These are static and can be cached by CloudFront:
- `/content/*` — CSS, JS, images
- `/images/*` — site images
- `/css/*` — stylesheets
- `/scripts/*` — JavaScript files served as static content
- `/static/*` — other static assets

Note: The `ScriptResource.axd` handler should be bypassed even though it serves JS — it's a dynamic handler that varies by version.

---

## 3. Bypass Completeness Check — Recommended Action

Before Phase 1, perform a comprehensive path audit:

```bash
# Find all route registrations in the codebase
rg "Routes\.Add|MapRoute|url.*=.*\"/" /home/jack/repos/f8/trunk --include="*.cs" -l | xargs grep -h "path\|pattern\|url" | sort -u

# Find all HttpHandler registrations
rg "path=\"\*" /home/jack/repos/f8/trunk --include="*.config" -A2 | grep "path=" | sort -u

# Find all *.ashx handlers
rg "\.ashx" /home/jack/repos/f8/trunk --include="*.aspx" --include="*.cs" -l | head -20
```

---

## 4. Recommended Plan Changes

### Immediate additions to cache-bypass list:
```
*.asmx           — SOAP web services (found in Web.config)
*_AppService.axd — ASP.NET AJAX services
ScriptResource.axd — ASP.NET AJAX script resources
```

### Phase 1 prep item to add:
- [ ] Run codebase audit for all `*.ashx`, `*.asmx`, `*.axd` handlers and add to bypass list
- [ ] Run codebase audit for `/auth/`, `/download/`, `/report/`, `/export/` routes and add to bypass list

### CloudFront cache behavior settings recommended:
```
Viewer Protocol Policy: redirect-to-https
Allowed Methods: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
(origin for dynamic paths should allow POST for form submissions)
Cache Based on Selected Request Headers: All (for dynamic content)
```

---

## Summary

| Status | Count | Items |
|---|---|---|
| ✅ Already in plan | 5 | `*.aspx`, `/planning/*`, `/ajax/*`, `/api/*`, `/tw/*` |
| ❌ Found in codebase, NOT in plan | 3 | `*.asmx`, `*_AppService.axd`, `ScriptResource.axd` |
| ⚠️ Likely missing (needs audit) | 4+ | `/auth/*`, `/download/*`, `/report/*`, `*.ashx` |
| ✅ Static, can cache | 5 | `/content/*`, `/images/*`, `/css/*`, `/scripts/*`, `/static/*` |

**Action required before Phase 1:** Run the 3-command codebase audit above, update the bypass list, and amend the plan.
