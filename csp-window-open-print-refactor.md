# CSP: Refactor window.print and window.open from onclick to addEventListener

status: in-progress
owner: jack
channel: f8-platform
created: 2026-04-10

## Problem
`socialMediaBar_01.cs` renders `onclick="window.print(); return false;"` and `onclick="window.open(...)"` as inline event handler attributes. These require `script-src-attr 'unsafe-inline' 'unsafe-hashes'` in the CSP meta tag.

Goal: eliminate `unsafe-inline` from `script-src-attr` by moving to `addEventListener()` in inline `<script>` blocks, so only `script-src` with per-page hashes is needed.

## Source Location
`trunk/f8/V01.00/PageBuild/PageBuild.UI/PageBuild.UI.Template/socialMediaBar_01.cs`

The `_CreateButton` method adds onclick as an attribute:
```csharp
aButton.Attributes.Add("onclick", script);
```

## Changes Required

### Change 1: Facebook button (line ~87)
Simple `window.open(this.href, '_blank', ...)`. Refactor to data attribute + addEventListener.
```javascript
document.querySelectorAll('[data-social-action="share"]').forEach(function(el) {
    el.addEventListener('click', function(e) {
        window.open(this.href, '_blank', 'height=500,width=800,menubar=false,toolbar=false,location=false,personalbar=false,status=false,resizable=true');
        e.preventDefault();
    });
});
```

### Change 2: Print button without popup (homepage — no print article)
Uses `window.print(); return false;`.
```javascript
document.querySelectorAll('[data-social-action="print"]').forEach(function(el) {
    el.addEventListener('click', function(e) { window.print(); e.preventDefault(); });
});
```

### Change 3: Print button WITH popup article
Uses `PopupSpec.OpenWindowScript()` which generates complex jQuery-based script. **Defer this** — it's a larger refactor.

## Implementation Steps

### Step 1: _CreateButton method
Change from:
```csharp
if (script.Length > 0)
{
    aButton.Attributes.Add("onclick", script);
}
```
To:
```csharp
if (script.Length > 0)
{
    aButton.Attributes.Add("data-social-action", script);
}
```

### Step 2: Update Facebook button call
Change `"facebook", openScript` → `"facebook", "share"`

### Step 3: Update Print button call (no popup case)
Change `"print", "window.print(); return false;"` → `"print", "print"`

### Step 4: Add inline script registration
In `CreateChildControls`, at the end before `Controls.Add(tButtons)`:
```csharp
string scriptBlock = @"
document.querySelectorAll('[data-social-action=""share""]').forEach(function(el) {
    el.addEventListener('click', function(e) {
        window.open(this.href, '_blank', 'height=500,width=800,menubar=false,toolbar=false,location=false,personalbar=false,status=false,resizable=true');
        e.preventDefault();
    });
});
document.querySelectorAll('[data-social-action=""print""]').forEach(function(el) {
    el.addEventListener('click', function(e) { window.print(); e.preventDefault(); });
});
";
this.Controls.Add(new LiteralControl(scriptBlock));
```

Or use `ClientScriptManager.RegisterStartupScript`.

## Post-Refactor
The inline `<script>` block will need a SHA-256 hash added to the meta tag's `script-src` directive. Compute from the script body.

## Other Templates to Check
- `print_this_page_03.cs`, `print_this_page_04.cs`, `printAndClose_01.cs` — also have onclick handlers
