# build-catchall-site.ps1 — create the "catchall" IIS site (Policy #1 catch-all 404).
# Turns any routed-but-unbound Host (stray *.db101.org etc.) into a clean empty-body 404
# instead of a TLS reset / CloudFront 502. Blank-host *:80: + *:443: (SNI OFF) bindings;
# wildcard cert on the http.sys 0.0.0.0:443 default so unmatched-SNI handshakes complete.
#
# BUILT + VERIFIED on web-04 (i-0272763b46610ac1b) 2026-07-29. REUSE verbatim on web-06
# (i-0c82adf476c7c5e32) as a Phase-D prereq — but web-06 applicationHost.config edits are
# business-hours-restricted (Mon-Fri 08-17 PT): run web-06 OUTSIDE that window.
#
# PER-BOX PREREQS to confirm first:
#   1. URL Rewrite installed (Test-Path C:\Windows\System32\inetsrv\rewrite.dll). web-04 = yes.
#   2. Multi-SAN wildcard cert thumbprint in Cert:\LocalMachine\My (SAN must cover *.db101.org +
#      *.eightfoldway.com + *.hb101.org + *.vets101.org; pick the VALID one — stores hold expired
#      leftovers). web-04 = 4B2C5303CCAE5244AD37215BF0546072656AB067 (CN=*.db101.org, exp 2026-09-29).
#      web-06 = A315518EBA452E7EE16194321439EBA677F23D7C (CN=eightfoldway.com, exp 2026-10-21;
#      CONFIRMED 2026-07-29 as the cert on web-06's live https bindings). Pass -Thumb accordingly.
#   3. NO conflicting blank-host binding on the box (web-04's stale pubbot *:80: was removed
#      2026-07-29; web-06 CONFIRMED clean 2026-07-29 — no blank binding). Check:
#      Get-Website | %{ $_.bindings.Collection } | ? bindingInformation -match '^\*?:(80|443):$'
#   4. web-06 has NO existing http.sys 0.0.0.0:443 default (CONFIRMED 2026-07-29) — the :443 bind
#      CREATES it (no prior cert to roll back; that missing default is why web-06 resets on unmatched
#      SNI today). web-04 HAD a stale a6982b64 default that this recipe replaced.
#
# WEB-06 RUN (tonight / off-hours — apphost change on the business-hours-restricted box):
#   python run-ssm.py build-catchall-site.ps1 i-0c82adf476c7c5e32 --region us-west-1 \
#     -- -Thumb A315518EBA452E7EE16194321439EBA677F23D7C
#   (verify: scanner-magnet preview-site.db101.org via cf-public -> 404 not 502; efw-public-cf-5xx quiets.)
#
# Run via ssm-windows: python run-ssm.py build-catchall-site.ps1 <instance-id> --region us-west-1

param(
  [string]$Thumb = '4B2C5303CCAE5244AD37215BF0546072656AB067',   # web-04 wildcard; set per box
  [string]$Root  = 'C:\inetpub\catchall'
)

Import-Module WebAdministration -ErrorAction SilentlyContinue
$ErrorActionPreference = 'Stop'

Write-Output "=== record CURRENT 0.0.0.0:443 default sslcert (rollback) ==="
(netsh http show sslcert ipport=0.0.0.0:443) | Select-String 'Certificate Hash|Application ID|Certificate Store'

if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root | Out-Null }
$webconfig = @'
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="catchall-404" stopProcessing="true">
          <match url=".*" />
          <action type="CustomResponse" statusCode="404" statusReason="Not Found" statusDescription="Not Found" />
        </rule>
      </rules>
    </rewrite>
    <directoryBrowse enabled="false" />
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
'@
Set-Content -Path (Join-Path $Root 'web.config') -Value $webconfig -Encoding UTF8

if (-not (Test-Path 'IIS:\AppPools\catchall')) { New-WebAppPool -Name 'catchall' | Out-Null }
Set-ItemProperty 'IIS:\AppPools\catchall' -Name managedRuntimeVersion -Value ''    # No Managed Code
Set-ItemProperty 'IIS:\AppPools\catchall' -Name managedPipelineMode -Value 0       # Integrated

New-Website -Name 'catchall' -PhysicalPath $Root -ApplicationPool 'catchall' -IPAddress '*' -Port 80 -HostHeader '' -Force | Out-Null
New-WebBinding -Name 'catchall' -Protocol 'https' -IPAddress '*' -Port 443 -HostHeader '' -SslFlags 0
$b = Get-WebBinding -Name 'catchall' -Protocol 'https'
$b.AddSslCertificate($Thumb, 'My')     # SNI-off binding => writes http.sys 0.0.0.0:443 default
Start-Website -Name 'catchall' -ErrorAction SilentlyContinue
Start-WebAppPool -Name 'catchall' -ErrorAction SilentlyContinue

Write-Output "`n=== RESULT ==="
$s = Get-Website -Name 'catchall'
"State={0} Path={1} Pool={2}" -f $s.State, $s.physicalPath, $s.applicationPool
Get-WebBinding -Name 'catchall' | ForEach-Object { "  {0} {1} sslFlags={2} certHash={3}" -f $_.protocol,$_.bindingInformation,$_.sslFlags,$_.certificateHash }
(netsh http show sslcert ipport=0.0.0.0:443) | Select-String 'Certificate Hash'

# ROLLBACK (if ever needed): remove site + restore prior default cert
#   Remove-Website -Name catchall ; Remove-WebAppPool -Name catchall
#   netsh http delete sslcert ipport=0.0.0.0:443
#   netsh http add sslcert ipport=0.0.0.0:443 certhash=<PRIOR_HASH> appid='{4dc3e181-e14b-4a21-b022-59fc669b0914}' certstorename=MY
