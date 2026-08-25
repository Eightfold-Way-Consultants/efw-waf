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
# Groups carry their Spanish sites, so az-es / ca-es / il-es / nj-es ride along with their parent.
# DB101-IA is Upload Final ONLY: its youth landing page and School and Work Estimator are held out of
# the public menus by page export flags, and it is published without touching its preview tier.
# DB101-NV and DB101-CO are deliberately absent (not published / not maintained).
#
# Manual run: powershell -ExecutionPolicy Bypass -NoProfile -File C:\git\efw-waf\tools\fleet-publish\fleet-publish.ps1
$ErrorActionPreference = 'Stop'

# ---- config ----------------------------------------------------------------------------------
# Any edit host can queue any group -- the group name is in the URL, so host and site need not match.
$ApiHost   = 'https://db101-ak.eightfoldway.com'
$SecretId  = 'f8/document-api/key'
$MailTo    = 'jeastman@eightfoldway.com'
# Marker present only in the r9118 turnstile code. Minifiers rename variables but keep string
# literals, so match the literal, not the surrounding names: failReason returns m ? "api-" + m : ...
$Marker    = '"api-"+'
$PollSec   = 15

# Each entry: PubBot group, job template, and the PUBLIC host that must end up serving the marker.
$SITES = @(
  @{ Group = 'DB101-AK'; Template = 'Upload Preview + Final'; Public = 'https://ak.db101.org' }
  @{ Group = 'DB101-AZ'; Template = 'Upload Preview + Final'; Public = 'https://az.db101.org' }
  @{ Group = 'DB101-CA'; Template = 'Upload Preview + Final'; Public = 'https://ca.db101.org' }
  @{ Group = 'DB101-GA'; Template = 'Upload Preview + Final'; Public = 'https://ga.db101.org' }
  @{ Group = 'DB101-IA'; Template = 'Upload Final';           Public = 'https://ia.db101.org' }
  @{ Group = 'DB101-IL'; Template = 'Upload Preview + Final'; Public = 'https://il.db101.org' }
  @{ Group = 'DB101-KY'; Template = 'Upload Preview + Final'; Public = 'https://ky.db101.org' }
  @{ Group = 'DB101-MI'; Template = 'Upload Preview + Final'; Public = 'https://mi.db101.org' }
  @{ Group = 'DB101-MN'; Template = 'Upload Preview + Final'; Public = 'https://mn.db101.org' }
  @{ Group = 'DB101-MO'; Template = 'Upload Preview + Final'; Public = 'https://mo.db101.org' }
  @{ Group = 'DB101-NC'; Template = 'Upload Preview + Final'; Public = 'https://nc.db101.org' }
  @{ Group = 'DB101-NJ'; Template = 'Upload Preview + Final'; Public = 'https://nj.db101.org' }
  @{ Group = 'DB101-OH'; Template = 'Upload Preview + Final'; Public = 'https://oh.db101.org' }
  @{ Group = 'HB101-MN'; Template = 'Upload Preview + Final'; Public = 'https://mn.hb101.org' }
)

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
$log   = Join-Path $logDir "fleet-publish-$stamp.log"
function Log($m) { "$([DateTime]::Now.ToString('HH:mm:ss'))  $m" | Tee-Object -FilePath $log -Append | Write-Host }

# Count job-tree nodes that have not finished. The top-level Status flips to eCompleteOK the moment
# the job is dispatched (StartedAt equals CompletedAt, ItemsTotal 0), so it says nothing about the
# work. A node is done only when it has a CompletedAt, and the job is done when none lack one.
function Count-Running($node) {
  $n = 0
  if (-not $node.CompletedAt) { $n++ }
  foreach ($c in @($node.Children)) { if ($c) { $n += Count-Running $c } }
  return $n
}

# Does this public host serve a bundle containing the marker? Returns the thumbprint plus a verdict.
function Test-Bundle($base) {
  # NOT $home: PowerShell's $HOME is read-only and assigning it throws.
  $page = Invoke-WebRequest -Uri $base -UseBasicParsing -TimeoutSec 60
  $m = [regex]::Match($page.Content, '/dist/[a-f0-9]+/js/master\.bundle\.min\.js')
  if (-not $m.Success) { return @{ Ok = $false; Thumb = '(no bundle url)'; } }
  $path = $m.Value
  $thumb = ([regex]::Match($path, '/dist/([a-f0-9]+)/')).Groups[1].Value
  $js = Invoke-WebRequest -Uri ($base + $path) -UseBasicParsing -TimeoutSec 120
  return @{ Ok = $js.Content.Contains($Marker); Thumb = $thumb }
}

$results = @()
try {
  Log "fleet publish starting -- $($SITES.Count) groups"

  $key = (aws secretsmanager get-secret-value --secret-id $SecretId --region us-west-1 --query SecretString --output text | ConvertFrom-Json).api_key
  if (-not $key) { throw "could not read api_key from secret $SecretId" }
  $headers = @{ 'X-API-Key' = $key }

  # ---- 1. queue every group up front ----------------------------------------------------------
  # PubBot drains its own queue; the 2026-08-25T01:05Z run queued all 14 at one instant and finished
  # in 30 minutes wall clock. Queueing up front keeps that shape instead of serializing by hand.
  foreach ($s in $SITES) {
    # Spaces are escaped; the literal '+' in "Upload Preview + Final" is legal in a path segment.
    $tmpl = $s.Template -replace ' ', '%20'
    $url = "$ApiHost/api/pubbot/groups/$($s.Group)/jobs/$tmpl"
    # IIS answers a bodyless POST with 411 Length Required, so send an explicit empty JSON body.
    $resp = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 120
    $s.JobId = $resp.jobId
    $s.Queued = Get-Date
    Log "queued $($s.Group) [$($s.Template)] job $($s.JobId)"
  }

  # ---- 2. poll each job to real completion -----------------------------------------------------
  $pending = [System.Collections.ArrayList]@($SITES)
  while ($pending.Count -gt 0) {
    Start-Sleep -Seconds $PollSec
    foreach ($s in @($pending)) {
      $job = (Invoke-RestMethod -Uri "$ApiHost/api/pubbot/jobs/$($s.JobId)" -Headers $headers -TimeoutSec 120).job
      $running = Count-Running $job
      if ($running -eq 0) {
        $s.Finished = Get-Date
        $s.Minutes = [math]::Round(($s.Finished - $s.Queued).TotalMinutes, 1)
        $s.Status = $job.Status
        # Surface any error text carried anywhere in the tree, not just at the root.
        $errs = @()
        $stack = New-Object System.Collections.Stack
        $stack.Push($job)
        while ($stack.Count -gt 0) {
          $n = $stack.Pop()
          if ($n.ErrorMessage) { $errs += $n.ErrorMessage }
          foreach ($c in @($n.Children)) { if ($c) { $stack.Push($c) } }
        }
        $s.Errors = ($errs | Select-Object -Unique) -join '; '
        Log "done  $($s.Group)  $($s.Status)  $($s.Minutes) min$(if($s.Errors){" ERRORS: $($s.Errors)"})"
        $pending.Remove($s)
      }
    }
    if ($pending.Count -gt 0) { Log "waiting on: $(($pending | ForEach-Object { $_.Group }) -join ', ')" }
  }
  Log "all jobs finished"

  # ---- 3. verify the bundle actually landed on each public site --------------------------------
  # One re-check after a pause: the upload invalidates CloudFront, and an edge that has not settled
  # can still hand back the previous HTML for a few seconds. This is cache settling, not a retry loop.
  foreach ($s in $SITES) {
    $v = Test-Bundle $s.Public
    if (-not $v.Ok) {
      Start-Sleep -Seconds 60
      $v = Test-Bundle $s.Public
    }
    $s.BundleOk = $v.Ok
    $s.Thumb = $v.Thumb
    Log "verify $($s.Group)  $($s.Public)  dist/$($v.Thumb)  marker=$(if($v.Ok){'PRESENT'}else{'ABSENT'})"
  }

  $results = $SITES
}
catch {
  Log "ERROR: $_"
  $results = $SITES
}

# ---- 4. email the summary ----------------------------------------------------------------------
# ASCII only in everything that reaches the mail body. A non-ASCII character in a .ps1 read as CP1252
# is what silently broke the daily soak mail for a month in 2026.
try {
  $env:GOG_KEYRING_PASSWORD = (Get-Content C:\cowork\env\gog-keyring.pass -Raw).Trim()
  $H = 'C:\cowork\env\.gog'
  $date = (Get-Date).ToString('yyyy-MM-dd')

  $bad = @($results | Where-Object { $_.Status -ne 'eCompleteOK' -or -not $_.BundleOk -or $_.Errors })
  $verdict = if ($bad.Count -eq 0) { "GREEN -- $($results.Count) sites published, new bundle live on all" }
             else { "RED -- $($bad.Count) of $($results.Count) sites need a look" }
  $vc = if ($bad.Count -eq 0) { '#0ca30c' } else { '#d03b3b' }

  $rows = ($results | ForEach-Object {
    $jobCell = if ($_.Status) { $_.Status } else { 'NOT FINISHED' }
    $bundleCell = if ($_.BundleOk) { 'new bundle' } else { 'OLD BUNDLE' }
    $rowColor = if ($_.Status -eq 'eCompleteOK' -and $_.BundleOk -and -not $_.Errors) { '#52514e' } else { '#d03b3b' }
    "<tr style='color:$rowColor'><td>$($_.Group)</td><td>$($_.Template)</td><td>$jobCell</td><td align='right'>$($_.Minutes)</td><td>$bundleCell</td><td>dist/$($_.Thumb)</td><td>$($_.Errors)</td></tr>"
  }) -join "`n"

  $body = @"
<div style='font:14px system-ui,Segoe UI,sans-serif'>
<b style='color:$vc'>Fleet publish $date -- $verdict.</b>
<p style='color:#52514e'>Bundle + Estimator publish (svn r9118: Turnstile beacon api-blocked / api-timeout reasons and ms timing).
The "bundle" column is a fetch of each public site's master.bundle.min.js checking for code that exists only in r9118.
A site can report eCompleteOK and still serve the old file, so that column, not the job status, is the one that says the publish did its job.</p>
<table cellpadding='5' cellspacing='0' style='font:13px system-ui,Segoe UI,sans-serif;border-collapse:collapse'>
<tr style='text-align:left;color:#898781'><th>group</th><th>template</th><th>job</th><th>min</th><th>bundle</th><th>thumbprint</th><th>errors</th></tr>
$rows
</table>
<p style='color:#898781'>Log: $log</p>
</div>
"@

  $subj = "Fleet publish $date -- $(if ($bad.Count -eq 0) { 'all green' } else { "$($bad.Count) need a look" })"
  Log "emailing '$subj' to $MailTo via gog"
  & gog --home $H --client eightfold -a $MailTo gmail send --to $MailTo --subject $subj --body-html $body 2>&1 |
    ForEach-Object { Log "  gog: $_" }
  Log "done."
}
catch {
  Log "ERROR sending mail: $_"
  exit 1
}
