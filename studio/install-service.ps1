<#
.SYNOPSIS
    Install / uninstall the Studio Supervisor Windows Scheduled Task.

.DESCRIPTION
    Registers "StudioSupervisor" to run `node <repo>/studio/studio.js supervise --home <HQ>`
    at system startup (run whether user is logged on or not via S4U, restart on
    failure every 1 min up to 999 times).  STUDIO_HOME is passed via the `--home`
    CLI argument, so the supervisor and all its children inherit the HQ checkout path.

    The supervisor's 60 s tick also runs a daily backup at 03:00 -- no second task needed.

    -Uninstall    removes the task
    -WhatIf       dry-run (prints what it would do, builds the real action to validate)

    Requirements:
      - Elevated PowerShell (S4U logon type plus -RunLevel Highest require admin rights).
      - studio.home.json exists, or -StudioHome is passed, or $env:STUDIO_HOME is set.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Uninstall,
    # Explicit HQ checkout path; defaults to studio.home.json -> $env:STUDIO_HOME.
    [string]$StudioHome
)

$ErrorActionPreference = 'Stop'

$repo   = (Resolve-Path $PSScriptRoot\..).Path
$script = Join-Path $PSScriptRoot 'studio.js'
$task   = 'StudioSupervisor'

# Resolve STUDIO_HOME: explicit param -> studio.home.json -> $env:STUDIO_HOME -> error.
if (-not $StudioHome) {
    try {
        $homeJson = Join-Path $repo 'studio.home.json'
        if (Test-Path $homeJson) {
            $StudioHome = (Get-Content -Raw $homeJson | ConvertFrom-Json).home
        }
    } catch { }
}
if (-not $StudioHome) { $StudioHome = $env:STUDIO_HOME }
if (-not $StudioHome) {
    Write-Error "Cannot resolve STUDIO_HOME (the HQ checkout). Pass -StudioHome <path> or create studio.home.json."
    exit 1
}
$resolved = (Resolve-Path -LiteralPath $StudioHome -ErrorAction SilentlyContinue).Path
if (-not $resolved) {
    Write-Error "Cannot resolve STUDIO_HOME: '$StudioHome' does not exist."
    exit 1
}
$StudioHome = $resolved

function Register-Task {
    $node = (Get-Command node.exe -ErrorAction Stop).Source

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
        -AllowHardTerminate

    # Register node directly with --home arg. No per-action env vars needed
    # (Task Scheduler ExecAction does not support environment variables).
    $action  = New-ScheduledTaskAction `
        -Execute $node `
        -Argument ('"{0}" supervise --home "{1}"' -f $script, $StudioHome) `
        -WorkingDirectory $repo

    $trigger   = New-ScheduledTaskTrigger -AtStartup
    # Run as the current user via S4U (no password stored, works whether logged on or not).
    # Highest privileges apply to this user, never SYSTEM.
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType S4U `
        -RunLevel Highest

    Register-ScheduledTask -TaskName $task `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force `
        -Description "Studio Supervisor: keeps services up, resumes runs, daily backup at 03:00"

    Write-Host "Installed Scheduled Task '$task'  --  startup trigger, restart on failure (1 min x 999)."
    Write-Host "  STUDIO_HOME = $StudioHome"
    Write-Host "  Run-as      : $env:USERDOMAIN\$env:USERNAME (S4U, no password stored)"
}

function Uninstall-Task {
    $existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Unregister-ScheduledTask -Confirm:$false
        Write-Host "Uninstalled Scheduled Task '$task'."
    } else {
        Write-Host "Scheduled Task '$task' was not installed -- nothing to remove."
    }
}

# ---- CLI ----
if ($Uninstall) {
    if ($PSCmdlet.ShouldProcess($task, 'Uninstall Scheduled Task')) {
        Uninstall-Task
    } else {
        Write-Host "[WhatIf] Would uninstall Scheduled Task '$task'."
    }
} else {
    if ($PSCmdlet.ShouldProcess($task, 'Register Scheduled Task')) {
        Register-Task
    } else {
        # Build the real action so the dry run exercises the same code path.
        $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if (-not $node) { $node = 'node.exe (from PATH)' }
        $action = New-ScheduledTaskAction `
            -Execute $node `
            -Argument ('"{0}" supervise --home "{1}"' -f $script, $StudioHome) `
            -WorkingDirectory $repo
        Write-Host "[WhatIf] Would register Scheduled Task '$task':"
        Write-Host "  Trigger   : At startup"
        Write-Host "  Principal : $env:USERDOMAIN\$env:USERNAME (S4U, no password)"
        Write-Host "  Action    : $($action.Execute) $($action.Arguments)"
        Write-Host "  Restart   : 1 min, up to 999 times"
        Write-Host "  Backup    : daily at 03:00 (inside the supervisor tick)"
    }
}
