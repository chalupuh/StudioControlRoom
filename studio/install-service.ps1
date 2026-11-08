<#
.SYNOPSIS
    Install / uninstall the Studio Supervisor Windows Scheduled Task.

.DESCRIPTION
    Registers "StudioSupervisor" to run `node <repo>/studio/studio.js supervise`
    at system startup (highest privileges, run whether user is logged on or not,
    restart on failure every 1 min up to 999 times).  STUDIO_HOME is passed as an
    environment variable on the task action.

    The supervisor's 60 s tick also runs a daily backup at 03:00 — no second task needed.

    -Uninstall    removes the task
    -WhatIf       dry-run (prints what would happen)
#>
$ErrorActionPreference = 'Stop'

$repo   = (Resolve-Path $PSScriptRoot\..).Path
$script = Join-Path $PSScriptRoot 'studio.js'
$task   = 'StudioSupervisor'

function Register-Task {
    $node = (Get-Command node.exe -ErrorAction Stop).Source

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
        -AllowHardTerminate

    $action  = New-ScheduledTaskAction `
        -Execute $node `
        -Argument "$script supervise" `
        -WorkingDirectory $repo `
        -EnvironmentVariables @{ 'STUDIO_HOME' = $repo }

    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal `
        -UserId "SYSTEM" `
        -LogonType ServiceAccount `
        -RunLevel Highest

    Register-ScheduledTask -TaskName $task `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force `
        -Description "Studio Supervisor: keeps services up, resumes runs, daily backup at 03:00"

    Write-Host "Installed Scheduled Task '$task'  —  startup trigger, restart on failure (1 min x 999)."
    Write-Host "  STUDIO_HOME = $repo"
}

function Uninstall-Task {
    Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false
    Write-Host "Uninstalled Scheduled Task '$task'."
}

# ---- CLI ----
if ($args -contains '-Uninstall') {
    if ($args -contains '-WhatIf') {
        Write-Host "[WhatIf] Would uninstall Scheduled Task '$task'."
    } else {
        Uninstall-Task
    }
} else {
    if ($args -contains '-WhatIf') {
        $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if (-not $node) { $node = 'node.exe (from PATH)' }
        Write-Host "[WhatIf] Would register Scheduled Task '$task':"
        Write-Host "  Trigger   : At startup"
        Write-Host "  Principal : SYSTEM (highest privileges, whether logged on or not)"
        Write-Host "  Action    : $node $script  supervise"
        Write-Host "  Env       : STUDIO_HOME=$repo"
        Write-Host "  Restart   : 1 min, up to 999 times"
        Write-Host "  Backup    : daily at 03:00 (inside the supervisor tick)"
    } else {
        Register-Task
    }
}
