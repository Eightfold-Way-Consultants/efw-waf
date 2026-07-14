# soak-mail.ps1 — generate the prod Turnstile soak report and email it to Jack's work inbox via gog.
# Intended to run daily via Windows Task Scheduler (task "EFW-SoakReport"). Self-contained: sets its
# own PATH (gog + node + aws) and unlocks the gog file keyring from C:\cowork\env. All output is the
# report HTML itself (email body). Logs to soak-mail.log next to this script.
#
# Manual run:  powershell -ExecutionPolicy Bypass -File C:\git\efw-waf\tools\soak-report\soak-mail.ps1
$ErrorActionPreference = 'Stop'
$dir = 'C:\git\efw-waf\tools\soak-report'
$log = Join-Path $dir 'soak-mail.log'
function Log($m) { "$([DateTime]::UtcNow.ToString('u'))  $m" | Tee-Object -FilePath $log -Append | Out-Null }

try {
  # gog.exe, node, aws are not guaranteed on a scheduled task's PATH — add them explicitly.
  $env:PATH = "C:\Users\jeast\bin;C:\nvm4w\nodejs;C:\Program Files\Amazon\AWSCLIV2;$env:PATH"
  $env:GOG_KEYRING_PASSWORD = (Get-Content C:\cowork\env\gog-keyring.pass -Raw).Trim()
  $H = 'C:\cowork\env\.gog'
  $out = Join-Path $dir 'soak-report-prod.html'

  # --email = inline-styled, table-based HTML that survives Gmail (no <style>/var()/grid/flex/media).
  Log "generating email report (node soak-report.js --env prod --hours 24 --email)..."
  Push-Location $dir
  & node soak-report.js --env prod --hours 24 --email --out $out 2>&1 | ForEach-Object { Log "  node: $_" }
  Pop-Location
  if (-not (Test-Path $out)) { throw "report HTML not generated: $out" }

  $date = (Get-Date).ToString('yyyy-MM-dd')
  $subj = "Turnstile soak report $date"
  Log "sending '$subj' to jeastman@eightfoldway.com via gog (eightfold)..."
  & gog --home $H --client eightfold -a jeastman@eightfoldway.com gmail send `
      --to jeastman@eightfoldway.com --subject $subj --body-html-file $out 2>&1 |
    ForEach-Object { Log "  gog: $_" }
  Log "done."
}
catch {
  Log "ERROR: $_"
  exit 1
}
