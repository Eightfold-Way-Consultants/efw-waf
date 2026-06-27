<#
  Concurrency benchmark: OLD (cursor+temp+9 indexes) vs NEW (set-based) f8_GetDictionaryByContext.
  Hammers the proc/query from N parallel connections for a fixed duration; reports calls/sec.
  Tests the real question: does OLD collapse under 12-way concurrency (tempdb DDL/latch
  contention from every call building #tDict + 9 indexes) while NEW scales? Uses a REAL CA
  page context (site 1, node 57). Read-only.
#>
param([int]$Duration = 12, [string]$Region = 'us-west-1')

$cs = (aws secretsmanager get-secret-value --secret-id CM00-connection-string --region $Region --query SecretString --output text | ConvertFrom-Json).'connection-string-no-driver'
# enlarge pool so connections aren't the bottleneck
if ($cs -notmatch 'Max Pool Size') { $cs = $cs.TrimEnd(';') + ';Max Pool Size=60' }

$ctx = "@ip_iSiteID=1,@ip_iLanguageID=1,@ip_iPageID=13,@ip_iNodeID=57,@ip_iPageClassID=9,@ip_iPageVariantID=1"
$oldSql = "EXEC f8_GetDictionaryByContext $ctx"
$newSql = @"
;WITH ranked AS (SELECT de.iDictEntryID,
 ROW_NUMBER() OVER (PARTITION BY de.vchrName,de.vchrSlotRef ORDER BY de.iPageID DESC,de.iNodeID DESC,de.iPageClassID DESC,de.iPageVariantID DESC,de.iSiteID DESC,
   CASE WHEN ISNULL(de.iSiteVersionID,-1)=ISNULL(NULL,-1) THEN 1 ELSE 0 END DESC,
   CASE WHEN ISNULL(de.iLanguageID,-1)=ISNULL(1,-1) THEN 1 ELSE 0 END DESC) rn
 FROM DictEntry de WHERE (de.iSiteID=1 OR de.iPageClassID=9 OR de.iPageVariantID=1 OR de.iPageID=13 OR de.iNodeID=57)
   AND (de.iLanguageID IS NULL OR ISNULL(de.iLanguageID,-1)=ISNULL(1,-1))
   AND (de.iSiteVersionID IS NULL OR ISNULL(de.iSiteVersionID,-1)=ISNULL(NULL,-1)))
SELECT iDictEntryID FROM ranked WHERE rn=1
"@

$worker = {
  param($cs,$sql,$deadlineTicks)
  $deadline = [datetime]::new($deadlineTicks,[System.DateTimeKind]::Utc)
  $conn = New-Object System.Data.SqlClient.SqlConnection $cs
  $conn.Open()
  $n = 0; $lat = 0.0
  $sw = [System.Diagnostics.Stopwatch]::new()
  while ([datetime]::UtcNow -lt $deadline) {
    $c = $conn.CreateCommand(); $c.CommandText = $sql; $c.CommandTimeout = 120
    $sw.Restart(); $r = $c.ExecuteReader(); while ($r.Read()) {}; $r.Close(); $sw.Stop()
    $lat += $sw.Elapsed.TotalMilliseconds; $n++
  }
  $conn.Close()
  [pscustomobject]@{ calls = $n; totLatMs = $lat }
}

function Bench($label,$sql,$workers) {
  $pool = [runspacefactory]::CreateRunspacePool(1,$workers); $pool.Open()
  $deadline = (Get-Date).ToUniversalTime().AddSeconds($Duration)
  $hs = @()
  for ($i=0; $i -lt $workers; $i++) {
    $ps = [powershell]::Create(); $ps.RunspacePool = $pool
    [void]$ps.AddScript($worker).AddArgument($cs).AddArgument($sql).AddArgument($deadline.Ticks)
    $hs += [pscustomobject]@{ ps=$ps; async=$ps.BeginInvoke() }
  }
  $calls=0; $lat=0.0
  foreach ($h in $hs) { $res = $h.ps.EndInvoke($h.async); $calls += $res.calls; $lat += $res.totLatMs; $h.ps.Dispose() }
  $pool.Close()
  $cps = [math]::Round($calls / $Duration, 1)
  $avg = if ($calls) { [math]::Round($lat / $calls, 1) } else { 0 }
  [pscustomobject]@{ label=$label; workers=$workers; calls=$calls; cps=$cps; avg_ms=$avg }
}

"warming plan cache..."
$null = Bench 'warm-old' $oldSql 1; $null = Bench 'warm-new' $newSql 1

$results = @()
foreach ($w in 1,12) {
  $results += Bench "OLD" $oldSql $w
  $results += Bench "NEW" $newSql $w
}
"`n================ CONCURRENCY BENCH (${Duration}s each, real CA ctx) ================"
$results | Format-Table label, workers, calls, cps, avg_ms -AutoSize | Out-String -Width 100

$o1=($results|?{$_.label-eq'OLD'-and$_.workers-eq1}).cps
$o12=($results|?{$_.label-eq'OLD'-and$_.workers-eq12}).cps
$n1=($results|?{$_.label-eq'NEW'-and$_.workers-eq1}).cps
$n12=($results|?{$_.label-eq'NEW'-and$_.workers-eq12}).cps
"OLD scaling 1->12 workers : {0}x   (perfect=12x)" -f ([math]::Round($o12/$o1,1))
"NEW scaling 1->12 workers : {0}x" -f ([math]::Round($n12/$n1,1))
"throughput NEW/OLD @ 1  worker  : {0}x" -f ([math]::Round($n1/$o1,2))
"throughput NEW/OLD @ 12 workers : {0}x   <-- the number that matters for the export" -f ([math]::Round($n12/$o12,2))
