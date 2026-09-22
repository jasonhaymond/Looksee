# Stops and removes the Looksee agent scheduled task. Leaves the binary and
# config in C:\ProgramData\LookseeAgent in place by default — pass -Purge to
# remove those too.
param([switch]$Purge)

$ErrorActionPreference = "Stop"
$TaskName = "LookseeAgent"
$InstallDir = "$env:ProgramData\LookseeAgent"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Task removed."

if ($Purge) {
    Remove-Item -Recurse -Force -Path $InstallDir -ErrorAction SilentlyContinue
    Write-Host "Binary and config removed."
} else {
    Write-Host "Binary and config left in place — re-run with -Purge to remove those too."
}
