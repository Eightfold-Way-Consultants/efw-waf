# soak-mail.ps1 — generate the prod Turnstile soak report, render it to a PDF, and email the PDF to
# Jack's work inbox via gog. Runs daily via Windows Task Scheduler (task "EFW-SoakReport").
#
# Delivery is now a PDF ATTACHMENT (not an HTML email body): the rich self-contained report renders
# identically in the browser and in the PDF via headless Chromium, so there is no more Gmail-CSS
# fidelity loss and the SVG stage-flow diagram survives intact. The email body is a one-line verdict;
# the PDF carries the full report. The retired --email table-render is gone.
#
# Self-contained: sets its own PATH (gog + node + aws + npx) and unlocks the gog file keyring from
# C:\cowork\env. Logs to soak-mail.log next to this script.
#
# Manual run:  powershell -ExecutionPolicy Bypass -File C:\git\efw-waf\tools\soak-report\soak-mail.ps1
$ErrorActionPreference = 'Stop'
$dir = 'C:\git\efw-waf\tools\soak-report'
$log = Join-Path $dir 'soak-mail.log'
function Log($m) { "$([DateTime]::UtcNow.ToString('u'))  $m" | Tee-Object -FilePath $log -Append | Out-Null }

try {
  # gog.exe, node, aws, npx are not guaranteed on a scheduled task's PATH — add them explicitly.
  $env:PATH = "C:\Users\jeast\bin;C:\nvm4w\nodejs;C:\Program Files\Amazon\AWSCLIV2;$env:PATH"
  $env:GOG_KEYRING_PASSWORD = (Get-Content C:\cowork\env\gog-keyring.pass -Raw).Trim()
  $H = 'C:\cowork\env\.gog'
  $date = (Get-Date).ToString('yyyy-MM-dd')
  $html = Join-Path $dir 'soak-report-prod.html'
  $pdf  = Join-Path $dir "soak-report-prod-$date.pdf"

  # 1. generate the single rich, self-contained HTML (no --email — that render is retired).
  Log "generating report (node soak-report.js --env prod --hours 24)..."
  Push-Location $dir
  $nodeOut = & node soak-report.js --env prod --hours 24 --out $html 2>&1
  Pop-Location
  $nodeOut | ForEach-Object { Log "  node: $_" }
  if (-not (Test-Path $html)) { throw "report HTML not generated: $html" }

  # verdict for the one-line email body (parsed from the node summary line)
  $line = ($nodeOut | Where-Object { $_ -match 'verdict=' } | Select-Object -First 1)
  $verdict = if ($line -match 'verdict=(\w+)') { $matches[1] } else { 'unknown' }
  $counts  = if ($line -match '(auth pass=.*?)\s+prevented') { $matches[1].Trim() } else { '' }
  $vMap = @{ good = 'GREEN — soak clean'; warning = 'YELLOW — watch items'; critical = 'RED — action needed'; unknown = 'report generated' }
  $vColor = @{ good = '#0ca30c'; warning = '#e08600'; critical = '#d03b3b'; unknown = '#52514e' }
  $verdictText = $vMap[$verdict]; if (-not $verdictText) { $verdictText = 'report generated' }
  $vc = $vColor[$verdict]; if (-not $vc) { $vc = '#52514e' }
  $body = "<div style='font:14px system-ui,Segoe UI,sans-serif'><b style='color:$vc'>Turnstile soak $date — $verdictText.</b><br>$counts<br><span style='color:#898781'>Full report attached (PDF). Regenerate: node soak-report.js --env prod --hours 24</span></div>"

  # 2. render the HTML to a PDF via headless Chromium (Playwright chromium is cached on the box).
  # A3-portrait is ~1123px wide, fitting the 1040px report at full width; print CSS in the report
  # keeps cards/rows whole across page breaks and preserves the colored fills. --color-scheme light
  # forces the light theme for print.
  Log "rendering PDF (npx playwright pdf --paper-format A3)..."
  if (Test-Path $pdf) { Remove-Item $pdf -Force }
  Push-Location $dir
  $uri = 'file:///' + ($html -replace '\\','/')
  & npx -y playwright@1.61.1 pdf --paper-format A3 --color-scheme light $uri $pdf 2>&1 | ForEach-Object { Log "  pdf: $_" }
  Pop-Location
  if (-not (Test-Path $pdf)) { throw "PDF not generated: $pdf" }
  Log "PDF ready: $pdf ($((Get-Item $pdf).Length) bytes)"

  # 3. email the PDF as an attachment via gog (eightfold client). Body is the one-line verdict.
  $subj = "Turnstile soak report $date"
  Log "sending '$subj' to jeastman@eightfoldway.com via gog (eightfold), attaching PDF..."
  & gog --home $H --client eightfold -a jeastman@eightfoldway.com gmail send `
      --to jeastman@eightfoldway.com --subject $subj --attach $pdf --body-html $body 2>&1 |
    ForEach-Object { Log "  gog: $_" }
  Log "done."
}
catch {
  Log "ERROR: $_"
  exit 1
}
