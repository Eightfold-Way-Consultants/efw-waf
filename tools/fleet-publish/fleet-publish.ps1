# fleet-publish.ps1 -- publish the DB101 + HB101 fleet through the PubBot job API, verify that the
# new client bundle actually reached each public site, and email a per-site summary.
#
# Written for the 2026-08-25 bundle + Estimator publish (svn r9118: the Turnstile beacon's
# api-blocked / api-timeout reasons and its `ms` timing). Runs unattended via Task Scheduler.
#
# WHY A BUNDLE CHECK AND NOT JUST THE JOB STATUS: on 2026-08-25 a fleet run reported eCompleteOK on
# every site while still serving the previous bundle thumbprint. A green publish is not evidence that
# the file you wanted is live. So after the uploads, each public host is fetched and its bundle is
# searched for a marker string that only exists in the new code.
#
# TEMPLATE IN THE BODY, NOT THE PATH: "Upload Preview + Final" contains a literal '+', and IIS will
# not route a path segment containing one -- raw '+' 404s, and %2B 404s too because double-escaped
# paths are refused by default. Proven against a deliberately bogus group, where "Upload Final"
# reached the handler (400, bad group) while both '+' forms died at 404 before it.
# So this script uses POST /api/pubbot/groups/{name}/jobs with {"template": "..."} (svn r9119), which
# puts the name somewhere IIS does not inspect. That matters because the combined template exports
# each site ONCE and then copies the result to both tiers; the plus-free workaround of running
# "Upload Preview" then "Upload Final" pays a second full export, and on a large state the export is
# the dominant cost of publishing.
# REQUIRES r9119 deployed to $ApiHost. Against an older build this route 404s and every site fails.
#
# Groups carry their Spanish sites, so az-es / ca-es / il-es / nj-es ride along with their parent.
# DB101-IA is Upload Final ONLY: its youth landing page and School and Work Estimator are held out of
# the public menus by page export flags, and it is published without touching its preview tier.
# DB101-NV and DB101-CO are deliberately absent (not published / not maintained).
#
# Manual run:  powershell -ExecutionPolicy Bypass -NoProfile -File .\fleet-publish.ps1
# Single site: powershell -ExecutionPolicy Bypass -NoProfile -File .\fleet-publish.ps1 -Only DB101-AK
[CmdletBinding()]
param(
  # Restrict the run to one group, for proving a change before turning it loose on the fleet.
  [string] $Only
)
$ErrorActionPreference = 'Stop'

# ---- config ----------------------------------------------------------------------------------
# Any edit host can queue any group -- the group name is in the URL, so host and site need not match.
# db101-master is the house convention for API calls that are not about one particular site, so a
# fleet-wide run does not look like it belongs to whichever state happened to be typed first.
$ApiHost   = 'https://db101-master.eightfoldway.com'
$SecretId  = 'f8/document-api/key'
$MailTo    = 'jeastman@eightfoldway.com'
# Marker present only in the r9118 turnstile code. Minifiers rename variables but keep string
# literals, so match the literal, not the surrounding names: failReason returns m ? "api-" + m : ...
$Marker    = '"api-"+'
$PollSec   = 15

# Each entry: PubBot group, the job templates to run IN ORDER, and the PUBLIC host that must end up
# serving the marker.
$SITES = @(
  @{ Group = 'DB101-AK'; Templates = @('Upload Preview + Final'); Public = 'https://ak.db101.org' }
  @{ Group = 'DB101-AZ'; Templates = @('Upload Preview + Final'); Public = 'https://az.db101.org' }
  @{ Group = 'DB101-CA'; Templates = @('Upload Preview + Final'); Public = 'https://ca.db101.org' }
  @{ Group = 'DB101-GA'; Templates = @('Upload Preview + Final'); Public = 'https://ga.db101.org' }
  @{ Group = 'DB101-IA'; Templates = @('Upload Final');           Public = 'https://ia.db101.org' }
  @{ Group = 'DB101-IL'; Templates = @('Upload Preview + Final'); Public = 'https://il.db101.org' }
  @{ Group = 'DB101-KY'; Templates = @('Upload Preview + Final'); Public = 'https://ky.db101.org' }
  @{ Group = 'DB101-MI'; Templates = @('Upload Preview + Final'); Public = 'https://mi.db101.org' }
  @{ Group = 'DB101-MN'; Templates = @('Upload Preview + Final'); Public = 'https://mn.db101.org' }
  @{ Group = 'DB101-MO'; Templates = @('Upload Preview + Final'); Public = 'https://mo.db101.org' }
  @{ Group = 'DB101-NC'; Templates = @('Upload Preview + Final'); Public = 'https://nc.db101.org' }
  @{ Group = 'DB101-NJ'; Templates = @('Upload Preview + Final'); Public = 'https://nj.db101.org' }
  @{ Group = 'DB101-OH'; Templates = @('Upload Preview + Final'); Public = 'https://oh.db101.org' }
  @{ Group = 'HB101-MN'; Templates = @('Upload Preview + Final'); Public = 'https://mn.hb101.org' }
)
if ($Only) {
  $SITES = @($SITES | Where-Object { $_.Group -eq $Only })
  if ($SITES.Count -eq 0) { throw "no such group: $Only" }
}

# ---- setup -----------------------------------------------------------------------------------
# A scheduled task does not inherit an interactive PATH, and aws.exe is how the API key is read.
$env:PATH = "C:\Users\jeast\bin;C:\nvm4w\nodejs;C:\Program Files\Amazon\AWSCLIV2;$env:PATH"
# Credentials are NOT baked into this script. The task runs as jeast and reads the standard profile;
# these two are pinned so a profile quirk cannot silently redirect the lookup. Paths, not secrets.
$env:AWS_SHARED_CREDENTIALS_FILE = 'C:\Users\jeast\.aws\credentials'
$env:AWS_DEFAULT_REGION = 'us-west-1'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$logDir = 'C:\temp\fleet-publish'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$stamp = (Get-Date).ToString('yyyy-MM-dd_HHmm')
$log   = Join-Path $logDir "fleet-publish-$stamp$(if ($Only) { "-$Only" }).log"
# Explicit ASCII: Tee-Object/Out-File default to UTF-16 here, which made the first run's log
# unreadable as spaced-out garbage in every ordinary text tool.
function Log($m) {
  $line = "$([DateTime]::Now.ToString('HH:mm:ss'))  $m"
  Write-Host $line
  $line | Out-File -FilePath $log -Append -Encoding ascii
}

# Count job-tree nodes that have not finished. The top-level Status flips to eCompleteOK the moment
# the job is dispatched (StartedAt equals CompletedAt, ItemsTotal 0), so it says nothing about the
# work. A node is done only when it has a CompletedAt, and the job is done when none lack one.
function Count-Running($node) {
  $n = 0
  if (-not $node.CompletedAt) { $n++ }
  foreach ($c in @($node.Children)) { if ($c) { $n += Count-Running $c } }
  return $n
}

# Collect every ErrorMessage in the tree, not just the root's.
function Get-TreeErrors($node) {
  $errs = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push($node)
  while ($stack.Count -gt 0) {
    $n = $stack.Pop()
    if ($n.ErrorMessage) { $errs += $n.ErrorMessage }
    foreach ($c in @($n.Children)) { if ($c) { $stack.Push($c) } }
  }
  return ($errs | Select-Object -Unique) -join '; '
}

# Does this public host serve a bundle containing the marker? Returns the thumbprint plus a verdict.
function Test-Bundle($base) {
  # NOT $home: PowerShell's $HOME is read-only and assigning it throws.
  $page = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 60
  $m = [regex]::Match($page.Content, '/dist/[a-f0-9]+/js/master\.bundle\.min\.js')
  if (-not $m.Success) { return @{ Ok = $false; Thumb = '(no bundle url)' } }
  $thumb = ([regex]::Match($m.Value, '/dist/([a-f0-9]+)/')).Groups[1].Value
  $js = Invoke-WebRequest -Uri ($base + $m.Value) -UseBasicParsing -TimeoutSec 120
  return @{ Ok = $js.Content.Contains($Marker); Thumb = $thumb }
}

$key = $null
$headers = $null

# Queue one template for one group. Returns immediately -- polling happens later, across all sites.
# Failures are returned, never thrown: one site's error must not cancel the others, which is exactly
# what happened on the 2026-08-25 18:30 run when the first bad POST aborted the whole fleet.
function Start-PubBotJob($group, $template) {
  $r = @{ Template = $template; Status = 'NOT QUEUED'; Minutes = 0; Errors = ''; Queued = Get-Date }
  try {
    # Template goes in the BODY (r9119). The path form cannot carry "Upload Preview + Final" at all;
    # see the header note.
    $payload = @{ template = $template } | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Uri "$ApiHost/api/pubbot/groups/$group/jobs" -Method Post `
              -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 120
    $r.JobId = $resp.jobId
    Log "  queued $group [$template] job $($r.JobId)"
  }
  catch {
    $r.Status = 'FAILED'
    $r.Errors = "$_"
    Log "  FAILED to queue $group [$template]: $_"
  }
  return $r
}

try {
  Log "fleet publish starting -- $($SITES.Count) group(s)$(if ($Only) { " (single group: $Only)" })"
  $key = (aws secretsmanager get-secret-value --secret-id $SecretId --region us-west-1 --query SecretString --output text | ConvertFrom-Json).api_key
  if (-not $key) { throw "could not read api_key from secret $SecretId" }
  $headers = @{ 'X-API-Key' = $key }

  # ---- 1. queue every group up front -----------------------------------------------------------
  # PubBot runs group jobs CONCURRENTLY, so the fleet's wall clock is the slowest single site, not
  # the sum. The 2026-08-25T01:05Z run queued all 14 at one instant and finished in 30.1 min, which
  # is DB101-MN's own 25 min and HB101-MN's own 30.1 overlapping -- not a queue draining one at a
  # time. Publishing serially would turn that 30 minutes into roughly four hours.
  foreach ($s in $SITES) {
    $s.Job = Start-PubBotJob $s.Group $s.Templates[0]
  }

  # ---- 2. poll them all to real completion -----------------------------------------------------
  $pending = [System.Collections.ArrayList]@($SITES | Where-Object { $_.Job.JobId })
  while ($pending.Count -gt 0) {
    Start-Sleep -Seconds $PollSec
    foreach ($s in @($pending)) {
      try {
        $job = (Invoke-RestMethod -Uri "$ApiHost/api/pubbot/jobs/$($s.Job.JobId)" -Headers $headers -TimeoutSec 120).job
        if ((Count-Running $job) -eq 0) {
          $s.Job.Status = $job.Status
          $s.Job.Errors = Get-TreeErrors $job
          $s.Job.Minutes = [math]::Round(((Get-Date) - $s.Job.Queued).TotalMinutes, 1)
          Log "done  $($s.Group)  $($s.Job.Status)  $($s.Job.Minutes) min$(if ($s.Job.Errors) { " ERRORS: $($s.Job.Errors)" })"
          $pending.Remove($s)
        }
      }
      catch {
        # A poll that fails is a poll, not a publish: log and try again next tick rather than
        # declaring the site failed.
        Log "  poll error on $($s.Group): $_"
      }
    }
    if ($pending.Count -gt 0) { Log "waiting on: $(($pending | ForEach-Object { $_.Group }) -join ', ')" }
  }
  Log "all jobs finished"

  foreach ($s in $SITES) {
    $s.Status = $s.Job.Status
    $s.Minutes = $s.Job.Minutes
    $s.Errors = $s.Job.Errors
  }

  # ---- 2. verify the bundle actually landed on each public site --------------------------------
  # One re-check after a pause: the upload invalidates CloudFront, and an edge that has not settled
  # can still hand back the previous HTML for a few seconds. This is cache settling, not a retry loop.
  foreach ($s in $SITES) {
    try {
      $v = Test-Bundle $s.Public
      if (-not $v.Ok) { Start-Sleep -Seconds 60; $v = Test-Bundle $s.Public }
      $s.BundleOk = $v.Ok
      $s.Thumb = $v.Thumb
    }
    catch {
      $s.BundleOk = $false
      $s.Thumb = "(check failed: $_)"
    }
    Log "verify $($s.Group)  $($s.Public)  dist/$($s.Thumb)  marker=$(if ($s.BundleOk) { 'PRESENT' } else { 'ABSENT' })"
  }
}
catch {
  Log "ERROR: $_"
}

# ---- 3. email the summary ----------------------------------------------------------------------
# ASCII only in everything that reaches the mail body. A non-ASCII character in a .ps1 read as CP1252
# is what silently broke the daily soak mail for a month in 2026.
try {
  $env:GOG_KEYRING_PASSWORD = (Get-Content C:\cowork\env\gog-keyring.pass -Raw).Trim()
  $H = 'C:\cowork\env\.gog'
  $date = (Get-Date).ToString('yyyy-MM-dd')
  $scope = if ($Only) { " ($Only only)" } else { '' }

  $bad = @($SITES | Where-Object { $_.Status -ne 'eCompleteOK' -or -not $_.BundleOk })
  $verdict = if ($bad.Count -eq 0) { "GREEN -- $($SITES.Count) site(s) published, new bundle live on all" }
             else { "RED -- $($bad.Count) of $($SITES.Count) site(s) need a look" }
  $vc = if ($bad.Count -eq 0) { '#0ca30c' } else { '#d03b3b' }

  $rows = ($SITES | ForEach-Object {
    $jobCell = if ($_.Status) { $_.Status } else { 'NOT RUN' }
    $bundleCell = if ($_.BundleOk) { 'new bundle' } else { 'OLD BUNDLE' }
    $rowColor = if ($_.Status -eq 'eCompleteOK' -and $_.BundleOk) { '#52514e' } else { '#d03b3b' }
    $tmplCell = ($_.Templates -join ' + ')
    "<tr style='color:$rowColor'><td>$($_.Group)</td><td>$tmplCell</td><td>$jobCell</td><td align='right'>$($_.Minutes)</td><td>$bundleCell</td><td>dist/$($_.Thumb)</td><td>$($_.Errors)</td></tr>"
  }) -join "`n"

  $body = @"
<div style='font:14px system-ui,Segoe UI,sans-serif'>
<b style='color:$vc'>Fleet publish $date$scope -- $verdict.</b>
<p style='color:#52514e'>Bundle + Estimator publish (svn r9118: Turnstile beacon api-blocked / api-timeout reasons and ms timing).
The "bundle" column is a fetch of each public site's master.bundle.min.js checking for code that exists only in r9118.
A site can report eCompleteOK and still serve the old file, so that column, not the job status, is the one that says the publish did its job.</p>
<table cellpadding='5' cellspacing='0' style='font:13px system-ui,Segoe UI,sans-serif;border-collapse:collapse'>
<tr style='text-align:left;color:#898781'><th>group</th><th>templates</th><th>jobs</th><th>min</th><th>bundle</th><th>thumbprint</th><th>errors</th></tr>
$rows
</table>
<p style='color:#898781'>Log: $log</p>
</div>
"@

  $subj = "Fleet publish $date$scope -- $(if ($bad.Count -eq 0) { 'all green' } else { "$($bad.Count) need a look" })"
  Log "emailing '$subj' to $MailTo via gog"
  & gog --home $H --client eightfold -a $MailTo gmail send --to $MailTo --subject $subj --body-html $body 2>&1 |
    ForEach-Object { Log "  gog: $_" }
  Log "done."
}
catch {
  Log "ERROR sending mail: $_"
  exit 1
}
