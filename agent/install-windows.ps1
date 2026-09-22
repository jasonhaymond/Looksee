# Installs the Looksee agent as a Windows Scheduled Task (runs at startup as
# SYSTEM, restarts on failure) — no third-party service wrapper needed.
#
# Reads $env:LOOKSEE_ENGINE_URL and $env:LOOKSEE_AGENT_KEY (set by the
# one-liner shown in the dashboard before invoking this script) rather than
# taking them as script parameters — PowerShell's -Command/iex don't bind
# trailing arguments the way -File does, so a parameter here wouldn't
# actually receive anything when invoked via the piped one-liner. Run
# elevated (the scheduled task's SYSTEM principal requires it).
#
# Idempotent: safe to re-run (e.g. after a newer binary is available) — it
# unregisters and re-registers the task and overwrites the installed files.
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Must be run as Administrator."
    exit 1
}

$EngineUrl = $env:LOOKSEE_ENGINE_URL
$AgentKey = $env:LOOKSEE_AGENT_KEY
if (-not $EngineUrl -or -not $AgentKey) {
    Write-Error "LOOKSEE_ENGINE_URL and LOOKSEE_AGENT_KEY must be set in the environment before running this script."
    exit 1
}

$InstallDir = "$env:ProgramData\LookseeAgent"
$BinaryPath = "$InstallDir\looksee-agent.exe"
$ConfigPath = "$InstallDir\looksee-agent.yaml"
$TaskName = "LookseeAgent"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "==> Downloading looksee-agent for windows-amd64"
Invoke-WebRequest -Uri "$EngineUrl/install/agent/windows-amd64" -OutFile $BinaryPath -UseBasicParsing

Write-Host "==> Writing config to $ConfigPath"
@"
engine_url: "$EngineUrl"
agent_key: "$AgentKey"
interval_seconds: 30
"@ | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Host "==> Registering scheduled task '$TaskName'"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $BinaryPath -Argument "-config `"$ConfigPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "==> Done. Check status with: Get-ScheduledTask -TaskName $TaskName"
