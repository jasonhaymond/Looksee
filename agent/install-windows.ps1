# Installs the Looksee agent as a Windows Scheduled Task (runs at startup as
# SYSTEM, restarts on failure) - no third-party service wrapper needed.
#
# Reads $env:LOOKSEE_ENGINE_URL and $env:LOOKSEE_AGENT_KEY (set by the
# one-liner shown in the dashboard before invoking this script) rather than
# taking them as script parameters - PowerShell's -Command/iex don't bind
# trailing arguments the way -File does, so a parameter here wouldn't
# actually receive anything when invoked via the piped one-liner. Run
# elevated (the scheduled task's SYSTEM principal requires it).
#
# Optional: $env:LOOKSEE_PROXY = "http://proxy.example.com:8080" for networks
# where web traffic must go through a proxy. It's used for this script's
# download and written into the agent's config (proxy_url), because the
# agent runs as SYSTEM, which doesn't use the signed-in user's proxy.
#
# What it does: checks this Windows version can run the agent, downloads the
# agent, writes its config (folder locked to SYSTEM and Administrators - the
# config holds the agent key), registers and starts the task, then waits up
# to a minute for the agent's first check-in and says plainly whether it
# happened. The agent logs to C:\ProgramData\LookseeAgent\looksee-agent.log.
#
# Idempotent: safe to re-run (e.g. after a newer binary is available) - it
# unregisters and re-registers the task and overwrites the installed files.
$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Must be run as Administrator."
    exit 1
}

# The agent is built with a Go version that only runs on Windows 10 /
# Windows Server 2016 (build 14393) or newer, 64-bit. On anything older the
# program can't start at all, so stop here with a clear message instead of
# installing something that silently never runs.
$os = [Environment]::OSVersion.Version
if ($os.Major -lt 10 -or ($os.Major -eq 10 -and $os.Build -lt 14393)) {
    Write-Error "This Windows version ($os) is too old for the Looksee agent. It needs Windows 10 or Windows Server 2016 (build 14393) or newer."
    exit 1
}
if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Error "The Looksee agent needs 64-bit Windows."
    exit 1
}

$EngineUrl = $env:LOOKSEE_ENGINE_URL
$AgentKey = $env:LOOKSEE_AGENT_KEY
$Proxy = $env:LOOKSEE_PROXY
if (-not $EngineUrl -or -not $AgentKey) {
    Write-Error "LOOKSEE_ENGINE_URL and LOOKSEE_AGENT_KEY must be set in the environment before running this script."
    exit 1
}
# Regex: http:// or https://, then a host (and optional port), nothing
# else - e.g. "http://proxy.example.com:8080". No spaces, quotes or path, so
# the value can't break the config file it's written into.
if ($Proxy -and $Proxy -notmatch '^https?://[^\s"''/]+/?$') {
    Write-Error "LOOKSEE_PROXY must look like http://proxy.example.com:8080 (got '$Proxy')."
    exit 1
}

$InstallDir = "$env:ProgramData\LookseeAgent"
$BinaryPath = "$InstallDir\looksee-agent.exe"
$ConfigPath = "$InstallDir\looksee-agent.yaml"
$LogPath = "$InstallDir\looksee-agent.log"
$TaskName = "LookseeAgent"

# The signed-in user's proxy (Internet Options) applies to this script but
# not to the agent, which runs as SYSTEM. If one is set for the engine's
# address and LOOKSEE_PROXY wasn't given, say so: it's the usual reason an
# install "succeeds" but the agent never checks in.
if (-not $Proxy) {
    try {
        $sysProxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]$EngineUrl)
        if ($sysProxy -and $sysProxy.AbsoluteUri -ne ([Uri]$EngineUrl).AbsoluteUri) {
            Write-Warning "This account reaches $EngineUrl through a proxy ($($sysProxy.Scheme)://$($sysProxy.Authority)), but the agent runs as SYSTEM and won't use it. If the agent doesn't check in, re-run with `$env:LOOKSEE_PROXY='$($sysProxy.Scheme)://$($sysProxy.Authority)' set first."
        }
    } catch {
        # Proxy detection is only advice; never fail the install over it.
        Write-Verbose "Couldn't check this account's proxy settings: $_"
    }
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Lock the folder down: the config holds the agent key, and by default
# folders under ProgramData are readable by every local user. Only SYSTEM
# (which the agent runs as) and Administrators keep access. /inheritance:r
# drops the permissions inherited from ProgramData; (OI)(CI)F = full control,
# inherited by every file and subfolder. Well-known SIDs (*S-1-5-18 =
# SYSTEM, *S-1-5-32-544 = Administrators) work on any Windows language.
icacls $InstallDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null

# On a re-install the old agent is still running: Windows locks a running
# exe, so overwriting it fails, and the old process would otherwise keep
# its old (possibly revoked) key. Stop it first.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Output "==> Stopping the existing agent"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
Get-Process -Name "looksee-agent" -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $BinaryPath } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Output "==> Downloading looksee-agent for windows-amd64"
$TmpPath = "$BinaryPath.download"
$download = @{ Uri = "$EngineUrl/install/agent/windows-amd64"; OutFile = $TmpPath; UseBasicParsing = $true }
if ($Proxy) { $download.Proxy = $Proxy }
Invoke-WebRequest @download
Move-Item -Force -Path $TmpPath -Destination $BinaryPath
Remove-Item -Force -Path "$BinaryPath.old" -ErrorAction SilentlyContinue

Write-Output "==> Writing config to $ConfigPath"
$proxyLine = if ($Proxy) { "proxy_url: `"$Proxy`"" } else { "" }
@"
engine_url: "$EngineUrl"
agent_key: "$AgentKey"
interval_seconds: 30
$proxyLine
"@ | Set-Content -Path $ConfigPath -Encoding UTF8

Write-Output "==> Registering scheduled task '$TaskName'"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $BinaryPath -Argument "-config `"$ConfigPath`" -log-file `"$LogPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# -ExecutionTimeLimit 0 = no limit. The default (72 hours) makes Task
# Scheduler stop the agent three days after each start.
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
# Remember where the log ended before this start, so only new lines are read.
$logStart = if (Test-Path $LogPath) { (Get-Item $LogPath).Length } else { 0 }
Start-ScheduledTask -TaskName $TaskName

# Confirm it actually started and checked in, instead of assuming so. The
# agent writes "first report accepted by the engine" to its log once the
# engine has stored its first report; errors reaching the engine are logged
# as "fetching agent config: ..." or "sending report: ...".
Write-Output "==> Waiting for the agent's first check-in (up to 60 seconds)"
$checkedIn = $false
$problems = @()
for ($i = 0; $i -lt 30 -and -not $checkedIn; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $LogPath) {
        $fs = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
        try {
            if ($fs.Length -lt $logStart) { $logStart = 0 }  # the log was rotated
            [void]$fs.Seek($logStart, 'Begin')
            $new = (New-Object System.IO.StreamReader($fs)).ReadToEnd()
        } finally { $fs.Close() }
        if ($new -match 'first report accepted') { $checkedIn = $true }
        $problems = @($new -split "`r?`n" | Where-Object { $_ -match 'fetching agent config:|sending report:|looksee-agent: ' })
    }
}
$running = Get-Process -Name "looksee-agent" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $BinaryPath }
$info = Get-ScheduledTaskInfo -TaskName $TaskName

if ($checkedIn) {
    Write-Output "==> Done. The agent is running and has checked in with $EngineUrl."
} elseif (-not $running) {
    # 267009 (0x41301) means "currently running"; anything else after a
    # start usually means the program exited or couldn't start.
    Write-Warning "The agent isn't running (task result $($info.LastTaskResult)). Its log: $LogPath"
    $problems | Select-Object -Last 5 | ForEach-Object { Write-Warning $_ }
    Write-Warning "To see the problem directly, run: & '$BinaryPath' -config '$ConfigPath' -once -log-file none"
} else {
    Write-Warning "The agent is running but hasn't checked in yet."
    if ($problems) { $problems | Select-Object -Last 5 | ForEach-Object { Write-Warning $_ } }
    else { Write-Warning "No errors so far - it may simply need another minute. Check the endpoint in the dashboard, or the log: $LogPath" }
}
Write-Output "    Status: Get-ScheduledTask -TaskName $TaskName   |   Log: Get-Content '$LogPath' -Tail 20"
