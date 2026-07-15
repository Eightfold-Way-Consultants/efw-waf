<#
.SYNOPSIS
    Deploys the amazon-cloudwatch-agent config (AmazonCloudWatch-windows) to the
    shared SSM String parameter and fetches it onto the target instances.

.DESCRIPTION
    ONE SSM String parameter -- AmazonCloudWatch-windows (us-west-1) -- drives BOTH
    web-06 (i-0c82adf476c7c5e32, prod/public) and web-04 (i-0272763b46610ac1b,
    preview2). The config interpolates {hostname}/{instance_id} so a single param
    serves both boxes. There is no on-disk json on the instances.

    The Logon box web-03b uses a SEPARATE param (WindowsAgentConfig-Logon) and is
    intentionally NOT touched here.

    What this script does when invoked:
      (a) put-parameter: overwrites AmazonCloudWatch-windows with the checked-in json.
      (b) for each target instance-id: sends an SSM AWS-RunPowerShellScript command
          that runs amazon-cloudwatch-agent-ctl.ps1 -a fetch-config ... -c
          ssm:AmazonCloudWatch-windows, then polls each command to Success/failure.

    Idempotent: re-running simply re-puts the same value and re-fetches. Safe to run
    repeatedly.

    IMPORTANT: dot-sourcing / importing this file does NOTHING except define
    Invoke-DeployAgentConfig. No put-parameter or deploy happens on import. The work
    runs only when the script is executed directly (or the function is called).

.PARAMETER ParameterName
    SSM parameter name. Default: AmazonCloudWatch-windows

.PARAMETER Region
    AWS region. Default: us-west-1

.PARAMETER ConfigFile
    Path to the config json to upload. Default: AmazonCloudWatch-windows.json next to
    this script.

.PARAMETER InstanceIds
    Target EC2 instance ids to fetch-config on.
    Default: web-06 (i-0c82adf476c7c5e32) + web-04 (i-0272763b46610ac1b).

.PARAMETER SkipPut
    Skip the put-parameter step and only re-fetch config on the instances.

.PARAMETER SkipFetch
    Only put the parameter; do not send fetch-config to any instance.

.EXAMPLE
    .\deploy-agent-config.ps1
    Puts the parameter and fetches config on web-06 + web-04.

.EXAMPLE
    .\deploy-agent-config.ps1 -InstanceIds i-0c82adf476c7c5e32 -SkipPut
    Re-fetch only on web-06 without re-uploading the parameter.
#>
[CmdletBinding()]
param(
    [string]   $ParameterName = 'AmazonCloudWatch-windows',
    [string]   $Region        = 'us-west-1',
    [string]   $ConfigFile    = $null,
    [string[]] $InstanceIds   = @('i-0c82adf476c7c5e32', 'i-0272763b46610ac1b'),
    [switch]   $SkipPut,
    [switch]   $SkipFetch
)

function Invoke-DeployAgentConfig {
    [CmdletBinding()]
    param(
        [string]   $ParameterName,
        [string]   $Region,
        [string]   $ConfigFile,
        [string[]] $InstanceIds,
        [switch]   $SkipPut,
        [switch]   $SkipFetch
    )

    $ErrorActionPreference = 'Stop'

    # Resolve the default config path next to this script if none was supplied.
    if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
        $base = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
        $ConfigFile = Join-Path $base 'AmazonCloudWatch-windows.json'
    }

    # ---- preflight -------------------------------------------------------------
    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        throw "Config file not found: $ConfigFile"
    }
    # Fail fast on malformed json before touching AWS.
    try {
        Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json | Out-Null
    } catch {
        throw "Config file is not valid JSON ($ConfigFile): $($_.Exception.Message)"
    }
    Write-Host "Config file : $ConfigFile (valid JSON)"
    Write-Host "Parameter   : $ParameterName"
    Write-Host "Region      : $Region"
    Write-Host "Instances   : $($InstanceIds -join ', ')"

    # ---- (a) put-parameter -----------------------------------------------------
    if ($SkipPut) {
        Write-Host "`n[put-parameter] SKIPPED (-SkipPut)."
    } else {
        Write-Host "`n[put-parameter] Overwriting $ParameterName as String ..."
        # file:// avoids shell-escaping the multi-line json on the command line.
        $fileUri = 'file://' + ($ConfigFile -replace '\\', '/')
        aws ssm put-parameter `
            --name $ParameterName `
            --type String `
            --overwrite `
            --value $fileUri `
            --region $Region | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "put-parameter failed (exit $LASTEXITCODE)." }
        Write-Host "[put-parameter] OK."
    }

    # ---- (b) fetch-config on each instance ------------------------------------
    if ($SkipFetch) {
        Write-Host "`n[fetch-config] SKIPPED (-SkipFetch)."
        return
    }

    $remoteCmd = '& "C:\Program Files\Amazon\AmazonCloudWatchAgent\amazon-cloudwatch-agent-ctl.ps1" ' +
                 "-a fetch-config -m ec2 -s -c ssm:$ParameterName"

    foreach ($id in $InstanceIds) {
        Write-Host "`n[fetch-config] $id : sending AWS-RunPowerShellScript ..."

        # SSM SendCommand wants the commands as a JSON array of strings. Write it to a
        # temp file and pass file://; an inline --parameters value word-splits under
        # Windows PowerShell 5.1 on the space in "C:\Program Files\...\...-ctl.ps1"
        # (aws sees "Unknown options: Files\Amazon..."). BOM-free so aws parses it.
        $paramsJson = @{ commands = @($remoteCmd) } | ConvertTo-Json -Compress
        $paramsFile = Join-Path $env:TEMP ("ssm-fetch-config-{0}.json" -f $id)
        [System.IO.File]::WriteAllText($paramsFile, $paramsJson)
        $paramsUri  = 'file://' + ($paramsFile -replace '\\', '/')

        try {
            $sendJson = aws ssm send-command `
                --instance-ids $id `
                --document-name 'AWS-RunPowerShellScript' `
                --comment 'CloudWatch agent fetch-config (deploy-agent-config.ps1)' `
                --parameters $paramsUri `
                --region $Region `
                --output json
        } finally {
            Remove-Item -LiteralPath $paramsFile -ErrorAction SilentlyContinue
        }
        if ($LASTEXITCODE -ne 0) { throw "send-command failed for $id (exit $LASTEXITCODE)." }

        $commandId = ($sendJson | ConvertFrom-Json).Command.CommandId
        Write-Host "[fetch-config] $id : CommandId $commandId -- polling ..."

        # Poll to a terminal state.
        $terminal = @('Success', 'Cancelled', 'Failed', 'TimedOut', 'Undeliverable', 'Terminated')
        $status   = 'Pending'
        $deadline = (Get-Date).AddMinutes(5)
        do {
            Start-Sleep -Seconds 5
            $inv = aws ssm get-command-invocation `
                --command-id $commandId `
                --instance-id $id `
                --region $Region `
                --output json 2>$null
            if ($LASTEXITCODE -eq 0 -and $inv) {
                $status = ($inv | ConvertFrom-Json).Status
            }
            Write-Host "    $id : $status"
        } while ($terminal -notcontains $status -and (Get-Date) -lt $deadline)

        if ($status -ne 'Success') {
            $detail = aws ssm get-command-invocation --command-id $commandId --instance-id $id --region $Region --output json 2>$null
            if ($detail) {
                $d = $detail | ConvertFrom-Json
                Write-Host "    StandardOutput: $($d.StandardOutputContent)"
                Write-Host "    StandardError : $($d.StandardErrorContent)"
            }
            throw "fetch-config on $id ended in status '$status' (CommandId $commandId)."
        }
        Write-Host "[fetch-config] $id : Success."
    }

    Write-Host "`nDone. All targets fetched ssm:$ParameterName."
}

# Run ONLY when executed directly, never on dot-source/import.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-DeployAgentConfig `
        -ParameterName $ParameterName `
        -Region        $Region `
        -ConfigFile    $ConfigFile `
        -InstanceIds   $InstanceIds `
        -SkipPut:$SkipPut `
        -SkipFetch:$SkipFetch
}
