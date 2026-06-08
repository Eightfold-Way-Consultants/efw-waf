# CSP: Eliminate __doPostBack href="javascript:" from admin controls

status: backlog
owner: jack
channel: f8-platform
created: 2026-04-10

## Problem
ASP.NET admin controls render links as `href="javascript:__doPostBack('ctl61','')"`. These are in `href` attributes, not `onclick` attributes.

CSP `script-src-attr 'unsafe-inline'` does NOT cover these — `href="javascript:"` is governed by `script-src` directly. `unsafe-inline` in `script-src` would allow them but is flagged by SecurityScorecard.

Example from homepage (db101-master):
```html
<a class="styleDialogLabel" href="javascript:__doPostBack('ctl61','')">Clear Cache</a>
<a class="styleDialogLabel" href="javascript:__doPostBack('ctl63','')">Export All</a>
<a class="styleDialogLabel" href="javascript:__doPostBack('ctl67','')">Touch</a>
```

Control IDs vary per page render (ctl61, ctl63, ctl67, etc.) — cannot pre-compute hashes.

## Solutions

### Option A: onclick instead of href (preferred)
Change the ASP.NET admin control rendering to use:
```html
<a class="styleDialogLabel" href="#" onclick="__doPostBack('ctl61',''); return false;">Clear Cache</a>
```
This moves the `javascript:` URL from `href` to `onclick`, making it governed by `script-src-attr` instead of `script-src`. The existing `script-src-attr 'unsafe-inline'` in the meta tag would then cover these.

**Steps:**
1. Find the ASP.NET admin control that renders these links (likely in ContentManager.UI)
2. Change `a.href = "javascript:__doPostBack(...)"` to `a.href = "#"` + `a.setAttribute("onclick", "__doPostBack(...); return false;")`
3. Verify all admin pages still work

### Option B: Add data attribute + event listener
Change the anchor to:
```html
<a class="styleDialogLabel" href="#" data-postback="ctl61">Clear Cache</a>
```
Then add an inline `<script>` that registers click handlers for all `[data-postback]` elements. Requires adding the script block to every admin page template.

### Option C: unsafe-inline in script-src (not recommended)
Add `unsafe-inline` to `script-src` directive. This would satisfy SecurityScorecard requirements but is the least secure option.

## Discovery
These appear in `CMPage`-derived admin pages. Likely rendered by admin-specific controls in ContentManager.UI.
