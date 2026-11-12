<#
.SYNOPSIS
  Add or remove the inbound Windows Firewall rule that lets phones on the local subnet reach the Control Room.

.DESCRIPTION
  Rule name: "Studio Control Room (LAN)". Inbound TCP on the Control Room port, RemoteAddress LocalSubnet,
  so only devices on the same subnet can connect. Needs an elevated (Administrator) PowerShell.

.EXAMPLE
  powershell -File studio\firewall.ps1                  # add the rule for port 4777
  powershell -File studio\firewall.ps1 -Port 5000       # custom port
  powershell -File studio\firewall.ps1 -WhatIf          # show what would happen, change nothing
  powershell -File studio\firewall.ps1 -Remove          # delete the rule
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 4777 }),
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$RuleName = 'Studio Control Room (LAN)'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
  Write-Error 'Run this from an elevated (Administrator) PowerShell.'
  exit 1
}

$existing = $null
if ($isAdmin) { $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue }

if ($Remove) {
  if (-not $existing -and $isAdmin) { Write-Host "Rule '$RuleName' not found; nothing to remove."; return }
  if ($PSCmdlet.ShouldProcess($RuleName, 'Remove inbound firewall rule')) {
    Remove-NetFirewallRule -DisplayName $RuleName
    Write-Host "Removed rule '$RuleName'."
  }
  return
}

if ($existing) {
  # Re-running replaces the rule so a changed port takes effect.
  if ($PSCmdlet.ShouldProcess($RuleName, 'Remove existing rule before re-adding')) { Remove-NetFirewallRule -DisplayName $RuleName }
}
if ($PSCmdlet.ShouldProcess($RuleName, "Allow inbound TCP $Port from LocalSubnet")) {
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $Port -RemoteAddress LocalSubnet -Profile Private | Out-Null
  Write-Host "Added rule '$RuleName': inbound TCP $Port from the local subnet (Private profile)."
}
