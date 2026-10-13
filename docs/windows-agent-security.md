# Windows Agent and Security Software

How to run the Looksee agent on Windows machines that have Smart App Control,
SmartScreen, Microsoft Defender, Attack Surface Reduction rules, App Control (WDAC),
AppLocker or a third-party antivirus/EDR — what each one does to the agent, how to tell
it's the cause, and the exact steps to allow the agent. Also how to sign the agent so
fewer of these steps are needed.

Related: [agent/README.md](../agent/README.md) (installing the agent),
[security-guide.md](security-guide.md) (securing the Looksee server itself),
[user-guide.md](user-guide.md), [README](../README.md).

## Contents

1. [What the agent is and does on Windows](#what-the-agent-is-and-does-on-windows)
2. [Is something blocking it?](#is-something-blocking-it)
3. [Smart App Control](#smart-app-control)
4. [SmartScreen and "Mark of the Web"](#smartscreen-and-mark-of-the-web)
5. [Microsoft Defender Antivirus](#microsoft-defender-antivirus)
6. [Attack Surface Reduction rules and Controlled Folder Access](#attack-surface-reduction-rules-and-controlled-folder-access)
7. [App Control for Business (WDAC) and AppLocker](#app-control-for-business-wdac-and-applocker)
8. [Third-party antivirus and EDR](#third-party-antivirus-and-edr)
9. [Windows Firewall](#windows-firewall)
10. [Signing the agent](#signing-the-agent)
11. [Verifying a binary by hand](#verifying-a-binary-by-hand)

## What the agent is and does on Windows

Knowing exactly what it does makes allow-listing decisions easy:

| | |
|---|---|
| Files | `C:\ProgramData\LookseeAgent\looksee-agent.exe` and `looksee-agent.yaml` (holds the agent key; readable by administrators/SYSTEM only). A site collector also unpacks a Node.js runtime and its bundle under the same folder. |
| Runs as | `SYSTEM`, as the Scheduled Task **LookseeAgent** (startup trigger, restart on failure) — not a Windows service. |
| Network | Outbound HTTPS only, to your Looksee URL. A site collector also listens on UDP/TCP 1514, UDP 1162, 2055 and 6343 for syslog, traps and flows. |
| Child processes | `powershell.exe` (service, event log, scheduled task, Defender, Hyper-V, BitLocker and performance-counter queries — values passed as environment variables, never spliced into commands), plus tools for the checks you configure: scripts in `script_dir`, `wg.exe`, `apcaccess`, `restic`/`borg`, `ping`, `tracert`. |
| Updates | When you click **Update agent**, it downloads a new `looksee-agent.exe` from your Looksee server over HTTPS, renames the old one aside, and restarts itself. |

Security products that object usually object to one of three things: an **unsigned
executable**, an executable **with no reputation** (few machines in the world have
it — true of anything self-built), or an **unsigned process that starts PowerShell**.

## Is something blocking it?

1. In an elevated PowerShell, check the task:

   ```powershell
   Get-ScheduledTask -TaskName LookseeAgent | Get-ScheduledTaskInfo
   ```

   `LastTaskResult` other than `0` or `267009` (running) means it failed to start.
2. Try running it in the foreground to see the error:

   ```powershell
   & "C:\ProgramData\LookseeAgent\looksee-agent.exe" -config "C:\ProgramData\LookseeAgent\looksee-agent.yaml" -once
   ```

   "This app has been blocked for your protection", "Access is denied", or the file
   disappearing are signs of security software.
3. Look in the relevant log:

   | Suspect | Where to look |
   |---|---|
   | Smart App Control / App Control (WDAC) | Event Viewer → Applications and Services Logs → Microsoft → Windows → **CodeIntegrity → Operational**: event **3077** (blocked), **3076** (would have been blocked, audit mode) |
   | AppLocker | Event Viewer → Applications and Services Logs → Microsoft → Windows → **AppLocker → EXE and DLL**: event **8004** (blocked) |
   | Defender Antivirus | `Get-MpThreatDetection` and Windows Security → Virus & threat protection → Protection history |
   | ASR rules | Event Viewer → Applications and Services Logs → Microsoft → Windows → **Windows Defender → Operational**: event **1121** (blocked) / 1122 (audit) |

   PowerShell for the CodeIntegrity log:

   ```powershell
   Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 20 | Where-Object Id -in 3076,3077 | Format-List TimeCreated, Message
   ```

## Smart App Control

**What it is:** on Windows 11 (22H2 and later, clean installs), Smart App Control (SAC)
allows an app only if Microsoft's cloud service predicts it's safe **or** it's signed by
a trusted certificate. Unknown, unsigned executables — which a self-built agent is — are
blocked. There is **no per-app exception**: you can't allow just Looksee.

**How to tell:** a "Smart App Control blocked an app" notification, and CodeIntegrity
event 3077 naming `looksee-agent.exe`. Check SAC's state:
Windows Security → **App & browser control** → **Smart App Control settings** (On,
Evaluation, or Off), or:

```powershell
Get-MpComputerStatus | Select-Object SmartAppControlState
```

**Options, best first:**

1. **Sign the agent** with a certificate SAC trusts — see
   [Signing the agent](#signing-the-agent). A signed agent is judged by its publisher
   instead of being blocked as an unknown file. A brand-new certificate can still need to
   build reputation, so test on one machine first.
2. **Turn Smart App Control off** on that machine: Windows Security → App & browser
   control → Smart App Control settings → **Off**. On many Windows builds this can't be
   turned back on without resetting or reinstalling Windows — read the text on the
   settings page for your build before choosing this.
3. In **Evaluation** mode, SAC is still deciding whether to turn itself on; it may switch
   to On later and start blocking. Installing the agent while in evaluation can itself
   cause SAC to turn off (it turns off when it sees software it would block in daily use).

Business machines managed with Intune/Group Policy usually don't use SAC; they use App
Control for Business (WDAC) instead, which *does* allow exceptions — see below.

## SmartScreen and "Mark of the Web"

**What it is:** SmartScreen warns before running a downloaded file that doesn't have
reputation. It only applies to files carrying the "Mark of the Web" — an alternate data
stream (`Zone.Identifier`) that browsers add to downloads.

**Does it affect the agent?** Not with the normal install: the PowerShell installer
downloads the agent with `Invoke-WebRequest`, which doesn't add the mark, and the
Scheduled Task starts it without a SmartScreen prompt. It matters only if you downloaded
`looksee-agent.exe` with a browser and run it by hand.

**How to fix:** remove the mark from a file you trust:

```powershell
Unblock-File "C:\ProgramData\LookseeAgent\looksee-agent.exe"
Get-Item "C:\ProgramData\LookseeAgent\looksee-agent.exe" -Stream * | Select-Object Stream   # Zone.Identifier should be gone
```

## Microsoft Defender Antivirus

**What it is:** Defender scans the agent like any other program. Go binaries with no
reputation that run PowerShell are occasionally flagged by heuristics (detections with
names like `Wacatac`, `Trojan:Win32/…!ml`, `!cl` are machine-learning guesses).

**How to tell:** `Get-MpThreatDetection` lists the detection and the file; Windows
Security → Protection history shows it quarantined.

**How to fix:**

1. First make sure the file is really yours — compare its hash with the one on your
   server (see [Verifying a binary by hand](#verifying-a-binary-by-hand)).
2. Restore it from quarantine (Protection history → the item → **Actions → Restore**), or
   reinstall the agent.
3. Add an exclusion for the agent's folder and process (elevated PowerShell):

   ```powershell
   Add-MpPreference -ExclusionPath "C:\ProgramData\LookseeAgent"
   Add-MpPreference -ExclusionProcess "C:\ProgramData\LookseeAgent\looksee-agent.exe"
   Get-MpPreference | Select-Object ExclusionPath, ExclusionProcess   # confirm
   ```

   Exclusions are a trade-off: anything placed in that folder is no longer scanned. The
   folder is writable only by administrators and SYSTEM, which limits the risk.
4. Report the false positive to Microsoft so it stops happening for everyone:
   <https://www.microsoft.com/wdsi/filesubmission> (choose "Incorrectly detected as
   malware"). Signing the agent also makes this much rarer.

In a managed environment, set the same exclusions in Intune (Endpoint security →
Antivirus) or Group Policy (Microsoft Defender Antivirus → Exclusions) instead.

## Attack Surface Reduction rules and Controlled Folder Access

**ASR rules** (Defender for Endpoint / Intune / Group Policy) can block the agent. The
one that matters is **"Block executable files from running unless they meet a
prevalence, age, or trusted list criterion"** (GUID
`01443614-cd74-433a-b99e-2ecdc07bfc25`) — a self-built agent is low-prevalence by
definition. Event 1121 in the Windows Defender Operational log names the rule and file.

Exclude the agent from ASR rules:

```powershell
Add-MpPreference -AttackSurfaceReductionOnlyExclusions "C:\ProgramData\LookseeAgent\looksee-agent.exe"
```

**Controlled Folder Access** blocks unknown apps from writing into protected folders
(Documents, Desktop, …). The agent only writes in its own folder, so it isn't normally
affected. If a file/backup check needs to *write* somewhere protected (it doesn't by
default — checks only read), allow it:

```powershell
Add-MpPreference -ControlledFolderAccessAllowedApplications "C:\ProgramData\LookseeAgent\looksee-agent.exe"
```

## App Control for Business (WDAC) and AppLocker

These are allow-lists used on managed business machines. Unlike Smart App Control, they
let you add rules. Choose the rule type by how the agent is built:

| Rule type | Use when | Survives agent updates? |
|---|---|---|
| **Publisher** (certificate) | The agent is signed — best option | Yes |
| **File path** | Unsigned; the folder is admin-only writable (it is: `C:\ProgramData\LookseeAgent`) | Yes |
| **File hash** | Unsigned and you want the strictest rule | **No** — every update changes the hash; update the rule each time |

**AppLocker** (Group Policy → Computer Configuration → Windows Settings → Security
Settings → Application Control Policies → AppLocker → Executable Rules), or with
PowerShell — a path rule:

```powershell
$rule = @"
<AppLockerPolicy Version="1"><RuleCollection Type="Exe" EnforcementMode="Enabled">
<FilePathRule Id="$(New-Guid)" Name="Looksee agent" Description="" UserOrGroupSid="S-1-5-18" Action="Allow">
<Conditions><FilePathCondition Path="%OSDRIVE%\ProgramData\LookseeAgent\*" /></Conditions></FilePathRule>
</RuleCollection></AppLockerPolicy>
"@
$rule | Out-File "$env:TEMP\looksee-applocker.xml" -Encoding utf8
Set-AppLockerPolicy -XmlPolicy "$env:TEMP\looksee-applocker.xml" -Merge
Get-AppLockerPolicy -Effective | Test-AppLockerPolicy -Path "C:\ProgramData\LookseeAgent\looksee-agent.exe" -User S-1-5-18
```

The last command should print `Allowed`. (`S-1-5-18` is SYSTEM, which the agent runs
as.) For a publisher rule once the agent is signed:

```powershell
Get-AppLockerFileInformation "C:\ProgramData\LookseeAgent\looksee-agent.exe" | New-AppLockerPolicy -RuleType Publisher -User Everyone -XML | Out-File "$env:TEMP\looksee-pub.xml"
Set-AppLockerPolicy -XmlPolicy "$env:TEMP\looksee-pub.xml" -Merge
```

**App Control for Business (WDAC)** — with the WDAC Wizard or PowerShell, add a rule to
your base or a supplemental policy:

```powershell
# Signed agent: allow its publisher. Unsigned: use -Level FilePath (or Hash).
New-CIPolicy -FilePath "$env:TEMP\looksee.xml" -ScanPath "C:\ProgramData\LookseeAgent" -Level Publisher -Fallback FilePath,Hash -UserPEs
```

then merge and deploy it the way you deploy your other WDAC policies (Intune, Group
Policy, or `CiTool --update-policy`). Note: WDAC in enforced mode puts PowerShell into
**Constrained Language Mode** for scripts it doesn't trust; the agent's built-in
PowerShell queries are simple cmdlet calls that work there, but your own `.ps1` scripts
in `script_dir` may need to be signed or allowed too.

## Third-party antivirus and EDR

CrowdStrike, SentinelOne, Defender for Endpoint, Sophos, Bitdefender, ESET and similar
products judge behavior as well as files. What they may notice, so you can allow it
specifically:

- an unsigned, low-prevalence executable (`looksee-agent.exe`) starting at boot as SYSTEM;
- it starting `powershell.exe` regularly (non-interactive, `-NoProfile`), and your
  scripts from `script_dir`;
- outbound HTTPS to your Looksee server every 30 seconds;
- (site collectors) `node.exe` under `C:\ProgramData\LookseeAgent` listening on UDP/TCP
  ports.

In the product's console, add an allow/exclusion for the path
`C:\ProgramData\LookseeAgent\looksee-agent.exe` (and its SHA-256 if the product prefers
hashes — update it after each agent update), and if it has "process exclusions", allow
`powershell.exe` started by that parent. Prefer the narrowest exclusion the product
supports, and set it in **audit/detect** first if you can, to see what it would block.

## Windows Firewall

The agent only makes outbound connections, which Windows Firewall allows by default. If
outbound is restricted by policy, allow `looksee-agent.exe` to your Looksee server on TCP
443. A **site collector** host also needs inbound rules for the ports devices send to —
the exact `New-NetFirewallRule` commands are in the user guide's
[Set up a site collector](user-guide.md#set-up-a-site-collector).

## Signing the agent

A digitally signed agent avoids most of the above: Smart App Control and App Control
can trust the publisher, Defender and EDRs treat signed software with less suspicion, and
AppLocker/WDAC publisher rules survive updates. Linux doesn't use code signing for this,
and on macOS the agent installed by the one-line command isn't quarantined (it's fetched
with `curl`), so Gatekeeper doesn't apply — only Windows needs it.

**What Looksee provides:** `agent/sign-windows.sh` runs automatically at the end of
`agent/build-all.sh` (which `scripts/update.sh` runs on your server). Until signing is
configured it does nothing and the agent ships unsigned. When configured, it
Authenticode-signs every Windows binary with an RFC 3161 timestamp (so signatures stay
valid after the certificate expires) and verifies each one. The tools it needs
(osslsigncode, jsign) run from a container if they aren't installed. The `pfx` path was
tested end to end with a throwaway certificate; the `azure` and `jsign` paths use the
same jsign tool but need a real account to test, and haven't been run against one yet.

**Getting a certificate** (prices and eligibility change — check the provider):

| Option | What it is | Notes |
|---|---|---|
| **Azure Artifact Signing** (formerly Trusted Signing) | Microsoft's signing service: certificates are managed for you, no hardware token | Monthly subscription; identity validation required (organizations, and individual developers in some countries). Signs through the Azure API — `SIGN_METHOD=azure`. |
| **OV/EV code-signing certificate** from a CA (DigiCert, Sectigo, SSL.com, …) | Your own certificate | Since June 2023 the private key must be on hardware: a USB token, an HSM, or the CA's cloud key service (DigiCert KeyLocker, SSL.com eSigner…) or Azure Key Vault. Use `SIGN_METHOD=jsign` with that keystore. EV no longer gives instant SmartScreen reputation. |
| **Internal CA** (Active Directory Certificate Services) | Free if you already run AD CS | Trusted only on machines that trust your CA (fine for AppLocker/WDAC on domain machines); **not** trusted by Smart App Control. Export as `.pfx` — `SIGN_METHOD=pfx`. |

**Using a YubiKey.** A YubiKey (PIV application) can hold the signing key, but it isn't a
certificate by itself:

- *With a purchased certificate*: generate the key on the YubiKey, send the CA a
  certificate request plus the YubiKey's attestation, and receive a publicly trusted
  certificate (roughly $100–400/year; some CAs require a FIPS YubiKey — check the CA's
  list). Trusted everywhere; Smart App Control still judges a new certificate by
  reputation.
- *With a self-signed certificate*: free; trusted only on machines where you install it as
  a trusted publisher (AppLocker/WDAC/Defender on your own machines) — never by Smart App
  Control.

Signing happens where the YubiKey is plugged in: either pass it through to the Looksee
server and use `SIGN_METHOD=jsign` with `SIGN_JSIGN_STORETYPE=YUBIKEY` (the PIN in
`signing.env`; the key's touch policy must allow unattended signing), or keep it on your
PC and sign each release there with `signtool`. Not set up yet — the agent ships unsigned
until one of the options above is chosen.

**Turning it on** (on the Looksee server, as the user that runs updates):

1. Copy the example config and lock it down:

   ```bash
   cd ~/Looksee/agent
   cp signing.env.example signing.env
   chmod 600 signing.env
   ```

2. Fill in **one** method in `signing.env`:

   - Azure Artifact Signing: install the Azure CLI, run `az login`, give your account the
     *Artifact Signing Certificate Profile Signer* role on the signing account, then set
     `SIGN_METHOD=azure`, `AZURE_SIGNING_ENDPOINT` (your region's endpoint, e.g.
     `https://eus.codesigning.azure.net`), `AZURE_SIGNING_ACCOUNT` and
     `AZURE_SIGNING_PROFILE`.
   - A hardware/cloud key: `SIGN_METHOD=jsign` and the `SIGN_JSIGN_*` values for your
     key store (store types and examples: <https://ebourg.github.io/jsign/>).
   - A `.pfx` file: `SIGN_METHOD=pfx`, `SIGN_PFX=/path/to/cert.pfx`, and
     `SIGN_PFX_PASSWORD_FILE=/path/to/password.txt` (both `chmod 600`, outside the repo).

3. Build and sign:

   ```bash
   ./build-all.sh
   ```

   **What success looks like:** the output ends with
   `==> bin/looksee-agent-windows-amd64.exe: signed and verified`. "signed (chain not
   trusted on this machine)" is expected for an internal CA.
4. Roll it out: on the Hosts page, select your Windows hosts and choose
   **Actions → Update agents**. Each downloads the signed binary.
5. Confirm on a Windows host:

   ```powershell
   Get-AuthenticodeSignature "C:\ProgramData\LookseeAgent\looksee-agent.exe" | Format-List Status, SignerCertificate, TimeStamperCertificate
   ```

   `Status : Valid` with your certificate as the signer.

`signing.env` is gitignored and never leaves the server. Back it up with the server's
other secrets (see the deployment guide's Backups section) — without it, builds go back
to being unsigned.

## Verifying a binary by hand

The install script and the self-updater both download the agent from your own Looksee
server over HTTPS (the updater also rejects a download too small to be a real build).
To check a binary yourself, compare the hash on the Windows machine with the one on the
server:

```powershell
Get-FileHash "C:\ProgramData\LookseeAgent\looksee-agent.exe" -Algorithm SHA256
```

```bash
sha256sum ~/Looksee/agent/bin/looksee-agent-windows-amd64.exe   # on the Looksee server
```

They match unless the agent has been updated since (or something replaced the file).
