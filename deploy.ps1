<#
.SYNOPSIS  Stage web/ + output/*.glb into build\site and deploy to https://dionysus.dk/webxr/<Name>/
.EXAMPLE   .\deploy.ps1            # stage + deploy
           .\deploy.ps1 -StageOnly # only stage (test locally: python -m http.server -d build\site)
Uses the shared deploy-static skill (env: DEPLOY_HOST/USER/KEY/REMOTE_BASE).
#>
param([string]$Name = 'charactercreator', [switch]$StageOnly, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$site = Join-Path $PSScriptRoot 'build\site'
if (Test-Path $site) { Remove-Item $site -Recurse -Force }
New-Item -ItemType Directory -Force $site | Out-Null
Copy-Item "$PSScriptRoot\web\*" $site -Recurse
Copy-Item "$PSScriptRoot\output\*.glb" $site
Copy-Item "$PSScriptRoot\deploy.htaccess" "$site\.htaccess"
Write-Host "Staged $((Get-ChildItem $site -Recurse -File).Count) files in $site"
if ($StageOnly) { return }
$ds = 'C:\Devstuff\git\ai-control-center\skills\deploy-static\deploy-static.ps1'
$args2 = @('-Dir', $site, '-Name', $Name); if ($DryRun) { $args2 += '-DryRun' }
& pwsh $ds @args2
if ($LASTEXITCODE -eq 0 -and -not $DryRun) { Write-Host "Live: https://dionysus.dk/webxr/$Name/" }
