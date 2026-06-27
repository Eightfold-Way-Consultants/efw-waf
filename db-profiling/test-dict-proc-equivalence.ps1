<#
  Equivalence + perf test for the f8_GetDictionaryByContext rewrite.
  Runs the LIVE proc and the REWRITE logic (inline) over a random sample of REAL contexts
  (distinct param tuples drawn from DictEntry, plus one site-only context per site) and diffs.

  Per context:
    - exact match     : identical set of iDictEntryID
    - tie-break only  : id sets differ but the consumer projection
                        (vchrName, vchrSlotRef, iValueType, vchrValue, iValue) multiset is
                        identical -> equivalent for callers (data had exact-priority ties)
    - REAL DIFF       : consumer projection differs -> investigate, do NOT deploy

  Read-only. Does not create the new proc; runs the rewrite as inline parameterized SQL.
#>
param([int]$Sample = 200, [string]$Region = 'us-west-1')
$ErrorActionPreference = 'Stop'

$cs = (aws secretsmanager get-secret-value --secret-id CM00-connection-string --region $Region --query SecretString --output text | ConvertFrom-Json).'connection-string-no-driver'
$conn = New-Object System.Data.SqlClient.SqlConnection $cs
$conn.Open()

$newSql = @"
;WITH ranked AS (
  SELECT de.iDictEntryID, de.vchrSlotRef, de.vchrName, de.iValueType, de.vchrValue, de.iValue,
         ROW_NUMBER() OVER (
           PARTITION BY de.vchrName, de.vchrSlotRef
           ORDER BY de.iPageID DESC, de.iNodeID DESC, de.iPageClassID DESC, de.iPageVariantID DESC, de.iSiteID DESC,
                    CASE WHEN ISNULL(de.iSiteVersionID,-1)=ISNULL(@ip_iSiteVersionID,-1) THEN 1 ELSE 0 END DESC,
                    CASE WHEN ISNULL(de.iLanguageID,-1)=ISNULL(@ip_iLanguageID,-1)       THEN 1 ELSE 0 END DESC
         ) rn
  FROM DictEntry de
  WHERE (de.iSiteID=@ip_iSiteID OR de.iPageClassID=@ip_iPageClassID OR de.iPageVariantID=@ip_iPageVariantID
         OR de.iPageID=@ip_iPageID OR de.iNodeID=@ip_iNodeID)
    AND (de.iLanguageID IS NULL OR (ISNULL(de.iLanguageID,-1)=ISNULL(@ip_iLanguageID,-1)))
    AND (de.iSiteVersionID IS NULL OR (ISNULL(de.iSiteVersionID,-1)=ISNULL(@ip_iSiteVersionID,-1)))
)
SELECT iDictEntryID, vchrSlotRef, vchrName, iValueType, vchrValue, iValue FROM ranked WHERE rn=1
"@

function New-Cmd($text,$isProc) {
  $c = $conn.CreateCommand(); $c.CommandText = $text; $c.CommandTimeout = 180
  if ($isProc) { $c.CommandType = 'StoredProcedure' }
  foreach ($p in 'iSiteID','iPageClassID','iPageVariantID','iLanguageID','iSiteVersionID','iPageID','iNodeID') {
    [void]$c.Parameters.Add("@ip_$p",[System.Data.SqlDbType]::Int)
  }
  $c
}
function Set-Ctx($cmd,$ctx) {
  foreach ($p in 'iSiteID','iPageClassID','iPageVariantID','iLanguageID','iSiteVersionID','iPageID','iNodeID') {
    $v = $ctx.$p
    $cmd.Parameters["@ip_$p"].Value = if ($null -eq $v) { [DBNull]::Value } else { [int]$v }
  }
}
function Run($cmd) {
  $dt = New-Object System.Data.DataTable
  $da = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
  [void]$da.Fill($dt); $dt
}

# --- build sample contexts ---
$ctxs = New-Object System.Collections.Generic.List[object]
$siteCmd = $conn.CreateCommand(); $siteCmd.CommandText = "SELECT DISTINCT iSiteID FROM DictEntry ORDER BY iSiteID"
$sdt = Run $siteCmd
foreach ($r in $sdt.Rows) { $ctxs.Add([pscustomobject]@{ iSiteID=[int]$r.iSiteID; iPageClassID=$null; iPageVariantID=$null; iLanguageID=$null; iSiteVersionID=$null; iPageID=$null; iNodeID=$null }) }
$siteOnly = $ctxs.Count

$smpCmd = $conn.CreateCommand()
$smpCmd.CommandText = "SELECT TOP ($Sample) * FROM (SELECT DISTINCT iSiteID,iPageClassID,iPageVariantID,iLanguageID,iSiteVersionID,iPageID,iNodeID FROM DictEntry) q ORDER BY NEWID()"
$smp = Run $smpCmd
function Conv($v){ if ($v -is [DBNull]) { $null } else { [int]$v } }
foreach ($r in $smp.Rows) {
  $ctxs.Add([pscustomobject]@{ iSiteID=[int]$r.iSiteID; iPageClassID=(Conv $r.iPageClassID); iPageVariantID=(Conv $r.iPageVariantID);
    iLanguageID=(Conv $r.iLanguageID); iSiteVersionID=(Conv $r.iSiteVersionID); iPageID=(Conv $r.iPageID); iNodeID=(Conv $r.iNodeID) })
}

$oldCmd = New-Cmd '[f8_GetDictionaryByContext]' $true
$newCmd = New-Cmd $newSql $false

$exact=0; $tie=0; $real=0; $oldMs=0L; $newMs=0L; $diffs=New-Object System.Collections.Generic.List[string]
$sw=[System.Diagnostics.Stopwatch]::new()
$idx=0
foreach ($ctx in $ctxs) {
  $idx++
  Set-Ctx $oldCmd $ctx; Set-Ctx $newCmd $ctx
  $sw.Restart(); $o = Run $oldCmd; $sw.Stop(); $oldMs += $sw.ElapsedMilliseconds
  $sw.Restart(); $n = Run $newCmd; $sw.Stop(); $newMs += $sw.ElapsedMilliseconds

  $oIds = [System.Collections.Generic.HashSet[int]]::new(); foreach($x in $o.Rows){[void]$oIds.Add([int]$x.iDictEntryID)}
  $nIds = [System.Collections.Generic.HashSet[int]]::new(); foreach($x in $n.Rows){[void]$nIds.Add([int]$x.iDictEntryID)}
  $same = ($oIds.Count -eq $nIds.Count); if ($same) { foreach($id in $oIds){ if(-not $nIds.Contains($id)){$same=$false;break} } }
  if ($same) { $exact++; continue }

  # id sets differ -> compare consumer projection multiset
  function Proj($dt){ $h=@{}; foreach($x in $dt.Rows){ $k="{0}|{1}|{2}|{3}|{4}" -f $x.vchrName,("$($x.vchrSlotRef)"),$x.iValueType,("$($x.vchrValue)"),("$($x.iValue)"); $h[$k]=1+([int]$h[$k]) }; $h }
  $po=Proj $o; $pn=Proj $n
  $projSame = ($po.Count -eq $pn.Count)
  if ($projSame){ foreach($k in $po.Keys){ if($po[$k] -ne $pn[$k]){$projSame=$false;break} } }
  if ($projSame) { $tie++ }
  else {
    $real++
    $ctxStr = ($ctx.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ','
    $missing = @($po.Keys | Where-Object { -not $pn.ContainsKey($_) }) | Select-Object -First 3
    $extra   = @($pn.Keys | Where-Object { -not $po.ContainsKey($_) }) | Select-Object -First 3
    $diffs.Add("CTX[$ctxStr] old_rows=$($o.Rows.Count) new_rows=$($n.Rows.Count)`n    only-in-OLD: $($missing -join ' ; ')`n    only-in-NEW: $($extra -join ' ; ')")
  }
}
$conn.Close()

"================ EQUIVALENCE: f8_GetDictionaryByContext rewrite ================"
"contexts tested : $($ctxs.Count)  (site-only=$siteOnly + sampled=$($ctxs.Count-$siteOnly))"
"exact match     : $exact"
"tie-break only  : $tie   (equivalent for callers)"
"REAL DIFFS      : $real"
"--------------------------------------------------------------"
"perf (sum over all contexts):  OLD=${oldMs}ms  NEW=${newMs}ms"
if ($oldMs -gt 0) { "speedup        :  {0}x" -f ([math]::Round($oldMs/[math]::Max(1,$newMs),1)) }
if ($real -gt 0) { "`n#### REAL DIFFS (investigate) ####"; $diffs | ForEach-Object { $_ } }
elseif ($tie -gt 0) { "`nAll mismatches were tie-break-only (data has exact-priority duplicate entries) -> safe." }
else { "`nPerfect: identical id-set on every context." }
