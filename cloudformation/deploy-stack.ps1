<#
.SYNOPSIS
  Reproducible CloudFormation deploy for the efw-waf stack family — a thin wrapper over
  `aws cloudformation deploy`, driven by a checked-in manifest + per-stack parameter file.

.DESCRIPTION
  The friction this removes: you no longer look up (or remember) a stack's name, region, IAM
  capability, or parameters. The manifest below is the single source of truth for name/region/
  capability/template/param-file per stack; the parameter VALUES live in cloudformation/params/<key>.json
  (checked in, declarative) — NOT in the deployed stack's state. So first-deploy and redeploy read the
  SAME source, the stack is recreatable from the repo, and a param change is a reviewable `git diff`.

  Deploy is idempotent: `aws cloudformation deploy` creates + executes a change-set, streams events,
  waits for completion, and (with --no-fail-on-empty-changeset) is a clean no-op when nothing changed.

  To change a parameter: edit cloudformation/params/<key>.json and re-run. That's the whole workflow.

.EXAMPLE
  .\deploy-stack.ps1 logon-telemetry     # deploy (create/execute change-set, wait)
  .\deploy-stack.ps1 -List                # show the family
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Stack,
  [switch] $List
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- Manifest: the family. Verified against the live stacks (capabilities + regions). ----
# ParamFile is relative to cloudformation/params/. NOT-yet-deployed stacks (edge-public, redirect)
# ship a param file too so their first deploy is reproducible; edge-public's domain list is a
# placeholder that must be filled before it will deploy.
$STACKS = [ordered]@{
  'base'            = @{ Template = 'base.yaml';            StackName = 'efw-waf-base';          Region = 'us-east-1'; Capabilities = 'CAPABILITY_NAMED_IAM' }
  'diagnostics'     = @{ Template = 'diagnostics.yaml';     StackName = 'efw-waf-diagnostics';   Region = 'us-east-1'; Capabilities = $null }
  'edge-preview2'   = @{ Template = 'edge.yaml';            StackName = 'efw-waf-edge-preview2'; Region = 'us-east-1'; Capabilities = 'CAPABILITY_NAMED_IAM' }
  'edge-public'     = @{ Template = 'edge.yaml';            StackName = 'efw-waf-edge-public';   Region = 'us-east-1'; Capabilities = 'CAPABILITY_NAMED_IAM' }
  'redirect'        = @{ Template = 'redirect.yaml';        StackName = 'efw-waf-redirect';      Region = 'us-east-1'; Capabilities = $null }
  'logon-telemetry' = @{ Template = 'logon-telemetry.yaml'; StackName = 'logon-telemetry';       Region = 'us-west-1'; Capabilities = 'CAPABILITY_IAM' }
}

if ($List -or -not $Stack) {
  Write-Host "efw-waf CloudFormation stack family:`n"
  '{0,-16} {1,-24} {2,-11} {3}' -f 'KEY', 'STACK', 'REGION', 'TEMPLATE' | Write-Host
  foreach ($k in $STACKS.Keys) { $s = $STACKS[$k]; '{0,-16} {1,-24} {2,-11} {3}' -f $k, $s.StackName, $s.Region, $s.Template | Write-Host }
  if (-not $Stack) { Write-Host "`nUsage: .\deploy-stack.ps1 <key>   (params in cloudformation/params/<key>.json)"; return }
  return
}

if (-not $STACKS.Contains($Stack)) { throw "Unknown stack key '$Stack'. Known: $($STACKS.Keys -join ', ')" }
$cfg       = $STACKS[$Stack]
$template  = Join-Path $here $cfg.Template
$paramFile = Join-Path $here "params\$Stack.json"
foreach ($f in @($template, $paramFile)) { if (-not (Test-Path $f)) { throw "Not found: $f" } }

# Guard: refuse to deploy an unfilled scaffold (e.g. edge-public's placeholder domain list).
if ((Get-Content -Raw $paramFile) -match 'REPLACE_WITH_') {
  throw "$Stack.json still has a REPLACE_WITH_ placeholder — fill it in before deploying."
}

Write-Host "Stack     : $($cfg.StackName) ($($cfg.Region))"
Write-Host "Template  : $($cfg.Template)"
Write-Host "Params    : params\$Stack.json"

$deployArgs = @(
  'cloudformation', 'deploy',
  '--region', $cfg.Region,
  '--stack-name', $cfg.StackName,
  '--template-file', $template,
  '--parameter-overrides', "file://$paramFile",
  '--no-fail-on-empty-changeset'
)
if ($cfg.Capabilities) { $deployArgs += @('--capabilities', $cfg.Capabilities) }

Write-Host "`n> aws $($deployArgs -join ' ')`n"
& aws @deployArgs
if ($LASTEXITCODE -ne 0) { throw "aws cloudformation deploy failed (exit $LASTEXITCODE)" }

$final = aws cloudformation describe-stacks --region $cfg.Region --stack-name $cfg.StackName --query "Stacks[0].StackStatus" --output text
Write-Host "`nDone: $final" -ForegroundColor Green
