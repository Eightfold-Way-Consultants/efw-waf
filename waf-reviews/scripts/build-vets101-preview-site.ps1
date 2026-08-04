# build-vets101-preview-site.ps1  —  bind the vets101 PREVIEW IIS site on web-06.
#
# preview.vets101.org is a live PubBot target (content freshly published to
# C:\inetpub\wwwroot\preview.vets101.org, ~47 items) but was never bound as an IIS site, so it
# 404s via the catch-all. This binds it, mirroring the www.vets101.org site, so it serves the
# preview through CloudFront (DNS already cut: preview.vets101.org -> cf-public, off the web-06 EIP).
#
# *** OFF-HOURS ONLY *** — creating an IIS site edits applicationHost.config, which recycles app
# pools and wipes InProc estimator (BPSession) state for live public users. Run nights/weekends.
# Run via ssm-windows: run-ssm.py <this> i-0c82adf476c7c5e32 --region us-west-1
$ErrorActionPreference = 'Stop'
Import-Module WebAdministration

$site = 'preview.vets101.org'
$root = 'C:\inetpub\wwwroot\preview.vets101.org'
$pool = 'DefaultAppPool'                                    # mirrors www.vets101.org
$certHash = 'A315518EBA452E7EE16194321439EBA677F23D7C'      # multi-SAN LE cert (covers *.vets101.org)

if (-not (Test-Path $root)) { throw "content root missing: $root" }
if (-not (Test-Path "Cert:\LocalMachine\My\$certHash")) { throw "cert $certHash not in LocalMachine\My" }

# 1. Site + :80 host-header binding (create only if absent)
if (-not (Get-Website -Name $site)) {
  Write-Output "creating site $site -> $root (pool $pool)"
  New-Website -Name $site -PhysicalPath $root -ApplicationPool $pool -HostHeader $site -Port 80 -Force | Out-Null
} else { Write-Output "site $site already exists" }

# 2. :443 host-header binding, Require-SNI (sslFlags=1), mirroring www.vets101.org
if (-not (Get-WebBinding -Name $site -Protocol https -Port 443 -HostHeader $site)) {
  Write-Output "adding https binding *:443:$site (Require-SNI)"
  New-WebBinding -Name $site -Protocol https -Port 443 -HostHeader $site -SslFlags 1
}

# 3. Bind the SNI cert to preview.vets101.org:443
$sni = "IIS:\SslBindings\!443!$site"
if (-not (Test-Path $sni)) {
  Write-Output "binding cert $certHash to $site:443 (SNI)"
  Get-Item "Cert:\LocalMachine\My\$certHash" | New-Item $sni -SslFlags 1 | Out-Null
} else { Write-Output "SNI cert binding already present" }

# 4. Verify
Write-Output "`n=== result ==="
Get-Website -Name $site | Format-List Name, State, PhysicalPath, ApplicationPool
Get-WebBinding -Name $site | ForEach-Object { Write-Output ("  {0}  sslFlags={1}" -f $_.bindingInformation, $_.sslFlags) }
# rollback if ever needed: Remove-Website -Name 'preview.vets101.org'
