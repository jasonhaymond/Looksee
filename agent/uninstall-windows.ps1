# Stops and removes the Looksee agent scheduled task. Leaves the binary and
# config in C:\ProgramData\LookseeAgent in place by default - pass -Purge to
# remove those too.
#
# Messages go to the output stream (Write-Output) rather than straight to the
# console, so they can be captured or redirected when this runs from another
# script or a remote session. The file is kept plain ASCII so Windows
# PowerShell 5.1 reads it correctly without a byte-order mark.
param([switch]$Purge)

$ErrorActionPreference = "Stop"
$TaskName = "LookseeAgent"
$InstallDir = "$env:ProgramData\LookseeAgent"

# Removing a task that doesn't exist isn't an error: the result is the same.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Output "Task removed."

if ($Purge) {
    Remove-Item -Recurse -Force -Path $InstallDir -ErrorAction SilentlyContinue
    Write-Output "Binary and config removed."
} else {
    Write-Output "Binary and config left in place - re-run with -Purge to remove those too."
}
