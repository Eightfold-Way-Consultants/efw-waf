<#
.SYNOPSIS
  Profile f8-db-01 around a publication/export run via RDS Performance Insights.

.DESCRIPTION
  The app login (CM00) is least-privilege and cannot read server DMVs (no VIEW SERVER
  STATE), and there is no admin credential in Secrets Manager. So this profiler uses
  Performance Insights, which the RDS agent populates server-side. PI must be enabled
  (it is, 7-day retention).

  Usage:
    .\profile-export.ps1 -Mode before -Tag ca-preview   # stamps start time
    <run a SOLO export so the window is attributable>
    .\profile-export.ps1 -Mode after  -Tag ca-preview   # reads PI for the window

  'after' prints DB load (Average Active Sessions) for the window, sliced by:
    - wait event   -> the bottleneck CLASS (CPU vs IO vs lock vs network)
    - top SQL      -> the offending statements (redundant re-loads show as high load
                      on trivial statements)
    - top user/host/application

  DB load (AAS) interpretation: AAS ~= average number of sessions actively running.
  AAS > vCPU count (2) sustained = the DB is the bottleneck for that window.
#>
param(
  [Parameter(Mandatory)][ValidateSet('before','after')][string]$Mode,
  [string]$Tag = 'export',
  [string]$OutDir = (Join-Path $env:TEMP 'f8-db-profile'),
  [string]$Region = 'us-west-1',
  [string]$ResourceId = 'db-T5OSRJLZ2P6IYCGFP4CLK3V3LQ',
  [int]$TopN = 15,
  [int]$Period = 60
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$stamp = Join-Path $OutDir "$Tag.window.json"

function U([datetime]$d){ $d.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

if ($Mode -eq 'before') {
  @{ start = (U (Get-Date)) } | ConvertTo-Json | Set-Content $stamp -Encoding UTF8
  "BEFORE: window start = $((Get-Content $stamp -Raw | ConvertFrom-Json).start)"
  "  Run the SOLO export now. When done: .\profile-export.ps1 -Mode after -Tag $Tag"
  return
}

if (-not (Test-Path $stamp)) { throw "No window stamp at $stamp - run -Mode before first." }
$start = (Get-Content $stamp -Raw | ConvertFrom-Json).start
$end   = U (Get-Date)
"================ PI PROFILE: $Tag ================"
"window: $start  ->  $end   (period ${Period}s)"

# group-by helper -> describe-dimension-keys, returns top dimension values by avg DB load
function Top-Dim($group, $label) {
  $gb = @{ Group = $group; Limit = $TopN } | ConvertTo-Json -Compress
  $gbFile = Join-Path $OutDir "_gb.json"; $gb | Set-Content $gbFile -Encoding ascii
  $json = aws pi describe-dimension-keys --service-type RDS --identifier $ResourceId `
            --start-time $start --end-time $end --metric db.load.avg `
            --group-by "file://$gbFile" --region $Region --output json 2>&1
  if ($LASTEXITCODE -ne 0) { "  [$label] PI error: $json"; return }
  $o = $json | ConvertFrom-Json
  "`n############ DB LOAD by $label (avg active sessions) ############"
  if (-not $o.Keys -or $o.Keys.Count -eq 0) { "  (no data - load too low or window too short)"; return }
  $rows = foreach ($k in $o.Keys) {
    $dim = $k.Dimensions
    $name = $dim.'db.wait_event.name'
    if (-not $name) { $name = $dim.'db.sql_tokenized.statement' }
    if (-not $name) { $name = $dim.'db.user.name' }
    if (-not $name) { $name = $dim.'db.host.name' }
    if (-not $name) { $name = $dim.'db.application.name' }
    if (-not $name) { $name = ($dim.PSObject.Properties | Select-Object -First 1).Value }
    [pscustomobject]@{ load = [math]::Round([double]$k.Total,3); who = ($name -replace '\s+',' ').Trim() }
  }
  $rows | Sort-Object load -Descending | ForEach-Object {
    $w = $_.who; if ($w.Length -gt 150) { $w = $w.Substring(0,150)+'...' }
    "{0,7}  {1}" -f $_.load, $w
  }
}

# overall load time series (sliced by wait event) to see the bottleneck class + peak
$mqFile = Join-Path $OutDir "_mq.json"
'[{"Metric":"db.load.avg","GroupBy":{"Group":"db.wait_event","Limit":7}}]' | Set-Content $mqFile -Encoding ascii
$series = aws pi get-resource-metrics --service-type RDS --identifier $ResourceId `
            --start-time $start --end-time $end --period-in-seconds $Period `
            --metric-queries "file://$mqFile" --region $Region --output json 2>&1
if ($LASTEXITCODE -eq 0) {
  $s = $series | ConvertFrom-Json
  "`n############ peak DB load over window ############"
  $peak = 0.0
  foreach ($mq in $s.MetricList) {
    if (-not $mq.Key.Dimensions) {
      foreach ($d in $mq.DataPoints) { if ($d.Value -and [double]$d.Value -gt $peak) { $peak = [double]$d.Value } }
    }
  }
  "peak AAS = {0}   (vCPU=2; sustained AAS>2 => DB is the bottleneck)" -f ([math]::Round($peak,2))
} else { "  metric series error: $series" }

Top-Dim 'db.wait_event'   'WAIT EVENT (bottleneck class)'
Top-Dim 'db.sql_tokenized' 'TOP SQL'
Top-Dim 'db.user'         'USER'
Top-Dim 'db.host'         'HOST'
"`n(Full interactive view: RDS console -> Performance Insights -> f8-db-01, set the window above.)"
