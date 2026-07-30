# enable-catchall-cshost-logging.ps1 — add the Host header (cs-host) field to the catch-all
# site's W3C IIS log so we can see WHICH Host the direct-IP / stray scanners target.
# Self-resolving (no params) — same script runs on web-04 AND web-06.
#
# NOTE: this edits applicationHost.config (site logFile.logExtFileFlags). On web-04 that's fine.
# On web-06 it's a BUSINESS-HOURS-restricted apphost change (recycles pools -> InProc estimator
# session wipe) — run web-06 ONLY outside Mon-Fri 08:00-17:00 PT.
#
# Run: python run-ssm.py enable-catchall-cshost-logging.ps1 <instance-id> --region us-west-1

Import-Module WebAdministration -ErrorAction SilentlyContinue
$ErrorActionPreference = 'Stop'
$site = 'catchall'
$s = Get-Website -Name $site
if (-not $s) { throw "no '$site' site on this box" }

$cur = [string](Get-ItemProperty "IIS:\Sites\$site" -Name logFile.logExtFileFlags)
Write-Output "BEFORE: $cur"

if ($cur -match '(^|,)\s*Host\s*(,|$)') {
  Write-Output "Host (cs-host) already enabled — no change"
} else {
  $new = ($cur.TrimEnd(',') + ',Host')
  Set-ItemProperty "IIS:\Sites\$site" -Name logFile.logExtFileFlags -Value $new
  $after = [string](Get-ItemProperty "IIS:\Sites\$site" -Name logFile.logExtFileFlags)
  Write-Output "AFTER : $after"
  if ($after -match '(^|,)\s*Host\s*(,|$)') { Write-Output "OK: cs-host field enabled" } else { throw "FAILED to add Host flag" }
}

# cs-host appears on NEW log lines after the next flush (IIS buffers ~60s); a fresh #Fields
# header is written. Existing lines are unaffected. Verify: tail the newest W3SVC<id> log and
# look for the cs-host column populated with the request Host header.
$dir = [System.Environment]::ExpandEnvironmentVariables((Get-ItemProperty "IIS:\Sites\$site" -Name logFile).directory)
Write-Output "log dir: $(Join-Path $dir ('W3SVC{0}' -f $s.id))"
