# Patching: updates and vulnerabilities that don't go away

[← User guide](user-guide.md) · [Check reference](check-reference.md) · [README](../README.md)

Looksee's **Upgradable packages** and **Vulnerable or unsupported software** checks often
keep listing things after you've run Windows Update, macOS Software Update or
`apt update && apt upgrade`. That's usually not a Looksee mistake: the normal update
deliberately leaves many things out. This page explains each case and gives the exact
commands to fix it.

Each row in those checks' results (the check's *Latest details*) has a `fix` column
(what's going on and what to do), a `command` column with a **Copy** button (run it on
that endpoint yourself — Looksee never runs it), a link to the advisory or vendor page
(`advisory` or `link`), a **Help** link to the matching section below and, for
vulnerabilities, `fixedIn` — the version that fixes it, empty when no fix exists yet.

After fixing something, the check updates once the agent reports again: the
upgradable list is refreshed every 6 hours, the vulnerability check runs every 6 hours.
To see the result sooner, restart the agent (Linux: `sudo systemctl restart looksee-agent`;
Windows: `Restart-Service looksee-agent`; macOS: `sudo launchctl kickstart -k system/com.looksee.agent`),
then press **Run now** on the vulnerability check.

## Contents

- [Linux — Debian and Ubuntu (apt)](#linux-apt)
  - [Kept back: apt upgrade leaves it out](#apt-kept-back)
  - [Phased updates (Ubuntu)](#apt-phased)
  - [Fixed, but this machine isn't offered the fix](#apt-not-offered)
  - [The fix is only in Ubuntu Pro (ESM)](#ubuntu-pro)
  - [No fix released yet](#no-fix-yet)
  - [Kernel vulnerabilities that stay after updating](#linux-kernel)
- [Linux — RHEL, Rocky, AlmaLinux, Fedora (dnf)](#dnf)
- [Linux — Alpine (apk)](#apk)
- [Linux — Arch (pacman)](#pacman)
- [Application dependencies: npm, pip, Composer](#app-dependencies)
- [Windows](#windows-update)
- [macOS](#macos)
- [Unsupported (end-of-life) software](#os-end-of-life)
- [Accepting a risk instead (exclusions)](#accepting)

<a id="linux-apt"></a>

## Linux — Debian and Ubuntu (apt)

First, always refresh the package lists — every other step depends on them being current:

```bash
sudo apt update
```

Success looks like a final line such as `12 packages can be upgraded` or
`All packages are up to date`. An error like `Release file … is not valid yet` or
`Could not resolve` means the machine can't reach its repositories — fix that first
(clock, DNS, proxy).

Note that Looksee's vulnerability check names the **source package** (e.g. `openssl`),
while apt installs **binary packages** built from it (`openssl`, `libssl3`). The
suggested command lists the binary packages installed on that endpoint.

<a id="apt-kept-back"></a>

### Kept back: apt upgrade leaves it out

`apt upgrade` never installs an update that needs a **new** package or the **removal** of
one. It lists those as `The following packages have been kept back:`. Automatic updates
(unattended-upgrades) also only install updates from the `-security` pocket, not from
`-updates`.

1. See what's held back:

   ```bash
   sudo apt upgrade --simulate | grep -A20 "kept back"
   ```

2. Install the package by name (this allows the new dependencies):

   ```bash
   sudo apt install --only-upgrade <package> [<package> …]
   ```

   or upgrade everything including dependency changes:

   ```bash
   sudo apt full-upgrade
   ```

3. Read the list apt shows before answering **Y**: `full-upgrade` may **remove**
   packages. If it wants to remove something you need, answer **n** and install the
   updates by name instead.

Success: `apt list --upgradable` no longer lists the package.

<a id="apt-phased"></a>

### Phased updates (Ubuntu)

Ubuntu releases many updates gradually: a growing share of machines get them over a few
days, so a bad update can be stopped before it reaches everyone. Until the rollout
reaches this machine, `apt upgrade` says `The following upgrades have been deferred due
to phasing:` and skips them. This isn't a fault: waiting is fine (Looksee's Upgradable
packages check leaves phased updates out unless you tick *Include Ubuntu phased updates*).

To install one now anyway:

```bash
sudo apt-get -o APT::Get::Always-Include-Phased-Updates=true install --only-upgrade <package>
```

Security updates are not phased — a phased update is never the only fix for a
vulnerability on its own.

<a id="apt-not-offered"></a>

### Fixed, but this machine isn't offered the fix

The distribution has published a fixed version (the result's `fixedIn` column), but
`apt` doesn't offer it. Work through these in order:

1. **Where does the package come from?**

   ```bash
   apt-cache policy <package>
   ```

   Look at the `Installed:` and `Candidate:` lines. If *Candidate* equals *Installed*,
   apt sees no newer version. The lines under `Version table:` show which repository each
   version comes from. A line with only `/var/lib/dpkg/status` means the package came
   from a downloaded `.deb` or a repository that's been removed — reinstall it from its
   proper source.

2. **Is the security repository configured?** It must appear in the output of:

   ```bash
   grep -rh "^deb\|^Types\|^Suites" /etc/apt/sources.list /etc/apt/sources.list.d/
   ```

   Ubuntu: a `<codename>-security` suite (e.g. `noble-security`). Debian: a
   `<codename>-security` line from `security.debian.org`. Add it if it's missing, then
   `sudo apt update`.

3. **Is the package held or pinned?**

   ```bash
   apt-mark showhold
   grep -r "Pin" /etc/apt/preferences /etc/apt/preferences.d/ 2>/dev/null
   ```

   A held package is never upgraded: `sudo apt-mark unhold <package>` if the hold is
   no longer needed.

4. Install the fix: `sudo apt install --only-upgrade <package>`.

<a id="ubuntu-pro"></a>

### The fix is only in Ubuntu Pro (ESM)

Many fixes for Ubuntu's `universe` packages, and all fixes for Ubuntu releases past
their standard support, are published only in **Expanded Security Maintenance (ESM)**,
part of Ubuntu Pro. A fixed version ending in `+esm1` (or similar) means exactly this:
the normal archive will never get it. Ubuntu Pro is free for personal use on up to
5 machines ([ubuntu.com/pro](https://ubuntu.com/pro)).

1. Get a token from your Ubuntu Pro dashboard (ubuntu.com/pro → sign in).
2. Attach the machine and enable ESM:

   ```bash
   sudo pro attach <your-token>
   sudo pro enable esm-infra esm-apps
   sudo apt update && sudo apt upgrade
   ```

3. Check: `pro status` shows `esm-apps` and `esm-infra` as `enabled`.

`pro fix CVE-2024-12345` also works without attaching: it says whether the CVE affects
this machine, whether a fix exists and where, and installs it when it can.

<a id="no-fix-yet"></a>

### No fix released yet

The vulnerability is known, but the distribution hasn't published a fixed package for
this release (the `fixedIn` column is empty). Nothing you install can fix it yet.
Options, in order:

1. **Check the advisory** (the `advisory` link): Ubuntu's and Debian's pages say the status for
   each release — *needed*, *deferred*, *ignored (end of life)*, *not affected*. "Not
   affected" or "negligible" often means the vulnerable code isn't built or used.
2. **Remove the package** if nothing needs it: `sudo apt remove <package>` (apt lists
   what would be removed with it — read before answering **Y**), then
   `sudo apt autoremove`.
3. **Accept the risk for now**: add the advisory ID to the check's *Accepted risks* with a
   reason (see [Accepting a risk instead](#accepting)). Remove the exclusion once a fix
   ships.

<a id="linux-kernel"></a>

### Kernel vulnerabilities that stay after updating

A kernel update installs a **new** kernel package alongside the old one, and the new one
only runs after a **reboot**. The old package stays installed, so it keeps being reported.

1. Install the newest kernel and reboot:

   ```bash
   sudo apt update && sudo apt full-upgrade
   sudo reboot
   ```

   (RHEL family: `sudo dnf upgrade --refresh kernel` then `sudo dnf needs-restarting -r`;
   it says `Reboot is required` when it is.)

2. After the reboot, confirm the running kernel is the newest:

   ```bash
   uname -r
   dpkg --list 'linux-image-*' | grep ^ii
   ```

3. Remove the old kernels:

   ```bash
   sudo apt autoremove --purge
   ```

   (RHEL family keeps the last 3 by default: `sudo dnf remove --oldinstallonly` removes
   the rest.)

<a id="dnf"></a>

## Linux — RHEL, Rocky, AlmaLinux, Fedora (dnf)

```bash
sudo dnf upgrade --refresh <package>     # one package
sudo dnf upgrade --refresh               # everything
sudo dnf updateinfo list --security      # security updates waiting
sudo dnf updateinfo info <advisory-id>   # details of one advisory (RHSA-…, RLSA-…, ALSA-…)
```

`--refresh` makes dnf fetch fresh repository data instead of using its cache — without
it a recent fix may not be seen. If dnf says `Nothing to do` but Looksee still lists a
fixed version, the fixed build isn't in the repositories this machine uses yet (they
sync on their own schedule): check `dnf repolist` and try again later. After a kernel,
glibc or systemd update, `sudo dnf needs-restarting -r` says whether a reboot is needed.

<a id="apk"></a>

## Linux — Alpine (apk)

```bash
sudo apk update
sudo apk upgrade <package>
sudo apk upgrade --available    # also replaces packages pinned to the old branch
```

Alpine often fixes a vulnerability only in its **newer branches**. If `apk upgrade` doesn't
install the fixed version, the fix isn't in the branch named in `/etc/apk/repositories`
(e.g. `v3.18`). Upgrading the branch: change the version in that file to a supported one,
then `sudo apk update && sudo apk upgrade --available`, then reboot.

<a id="pacman"></a>

## Linux — Arch (pacman)

Arch only supports upgrading everything at once — upgrading single packages ("partial
upgrades") can break the system:

```bash
sudo pacman -Syu
```

<a id="app-dependencies"></a>

## Application dependencies: npm, pip, Composer

**No operating system update ever touches these.** They're the libraries inside your own
applications (found in the lock files listed in the check's *Also check lock files*
setting) or tools
installed with npm/pip rather than the OS package manager. Each has to be updated in its
project and the application redeployed (or restarted).

<a id="npm"></a>

### npm (Node.js)

In the project folder (the folder holding `package-lock.json`):

```bash
cd /path/to/project
npm audit                 # what's vulnerable, and which direct dependency pulls it in
npm audit fix             # upgrades within the version ranges package.json allows
npm install <package>@<fixed-version>   # a direct dependency beyond its range
```

If the vulnerable package is a **dependency of a dependency** and `npm audit fix` can't
reach it, force the fixed version with an `overrides` entry in `package.json`
([npm docs](https://docs.npmjs.com/cli/configuring-npm/package-json#overrides)):

```json
{
  "overrides": {
    "<package>": "<fixed-version>"
  }
}
```

then `npm install`, test, commit the lock file and redeploy. A globally installed tool
(no lock file in the result) is updated with `sudo npm install -g <package>@latest`.

<a id="pip"></a>

### pip (Python)

```bash
cd /path/to/project
source .venv/bin/activate         # the app's virtual environment, if it has one
python3 -m pip install --upgrade "<package>>=<fixed-version>"
python3 -m pip freeze > requirements.txt   # or update the version in your lock file
```

On Debian 12+, Ubuntu 23.04+ and other recent systems, installing into the **system**
Python with pip is refused (`error: externally-managed-environment`): update system
Python packages with apt (`python3-<name>`), and app packages inside the app's virtual
environment. Don't use `--break-system-packages` on a server.

<a id="composer"></a>

### Composer (PHP)

```bash
cd /path/to/project
composer update <vendor/package> --with-all-dependencies
composer audit
```

<a id="windows-update"></a>

## Windows

Windows Update installs the monthly cumulative updates automatically, but several kinds
of update stay listed until someone acts:

<a id="windows-drivers"></a>

### Driver, firmware and optional updates

Windows offers drivers and "Preview" updates as **optional**: they install only when picked.

1. **Settings → Windows Update → Advanced options → Optional updates**.
2. Expand **Driver updates**, tick the ones listed, **Download & install**.
3. For laptops and desktops, the manufacturer's tool often has newer drivers and BIOS
   updates than Windows Update: Dell Command Update, Lenovo Vantage / System Update,
   HP Image Assistant / Support Assistant.

<a id="windows-feature"></a>

### Feature updates (a new Windows version)

A feature update (e.g. Windows 11, version 24H2) isn't installed with the monthly updates.
When it's offered, **Settings → Windows Update** shows a separate **Download and install**
for it. If it isn't offered, the machine may not meet the requirements, or a
compatibility hold is in place (Microsoft blocks it on hardware or software with a known
problem). Windows versions past their support date stop getting security updates
altogether — see [Unsupported software](#os-end-of-life).

<a id="windows-defender"></a>

### Microsoft Defender definitions

Definitions update by themselves several times a day. If they're stuck, in PowerShell as
administrator:

```powershell
Update-MpSignature
Get-MpComputerStatus | Select-Object AntivirusSignatureLastUpdated, AntivirusSignatureVersion
```

<a id="windows-office"></a>

### Microsoft 365 / Office

Office (Click-to-Run) updates itself with its own updater, not through Windows Update
— unless **Settings → Windows Update → Advanced options → Receive updates for other
Microsoft products** is on. To update now, in any Office app: **File → Account → Update
Options → Update Now**, or from a Command Prompt:

```bat
"C:\Program Files\Common Files\microsoft shared\ClickToRun\OfficeC2RClient.exe" /update user
```

### An update that keeps failing

1. Note the KB number (e.g. KB5034441) and its error code in **Settings → Windows Update →
   Update history**.
2. Repair Windows' own files, in a Command Prompt as administrator (takes 10–30 minutes):

   ```bat
   DISM /Online /Cleanup-Image /RestoreHealth
   sfc /scannow
   ```

   Success: `The restore operation completed successfully` and `Windows Resource
   Protection did not find any integrity violations` (or `…found corrupt files and
   successfully repaired them`). Restart, then try Windows Update again.

3. Still failing: download that update from the
   [Microsoft Update Catalog](https://www.catalog.update.microsoft.com) (search for the
   KB number; the result's `link` opens that search), pick the version for this
   machine (x64 / ARM64, Windows version) and run the `.msu` file.
4. Microsoft's release notes and known issues for each update are on the
   [Security Update Guide](https://msrc.microsoft.com/update-guide).

<a id="windows-apps"></a>

### Other programs (Chrome, Firefox, Zoom, Adobe, Java…)

Windows Update only updates Windows and Microsoft products. Every other program updates
itself or not at all, and **isn't listed in Looksee's Upgradable packages** (that list is
what Windows Update offers). Looksee's vulnerability check doesn't cover Windows programs
either: OSV.dev, its vulnerability source, has no data for them. To update them, Windows'
own package manager **winget** can update most programs at once (PowerShell, as the
signed-in user):

```powershell
winget upgrade                                   # what has an update
winget upgrade --all --include-unknown           # update all of them
winget upgrade --id Mozilla.Firefox              # one program
```

See [Microsoft's winget documentation](https://learn.microsoft.com/windows/package-manager/winget/upgrade).
Programs installed from the Microsoft Store update from the Store: **Microsoft Store →
Library → Get updates**.

<a id="macos"></a>

## macOS

macOS's **Software Update** lists updates to macOS itself, Safari and Apple's
command-line tools — that's the list Looksee shows. Install from **System Settings →
General → Software Update**, or in Terminal:

```bash
softwareupdate --list
sudo softwareupdate --install "<label>" --restart    # one update, e.g. "Safari18.2VenturaAuto-18.2"
sudo softwareupdate --install --all --restart        # everything
```

On Apple silicon Macs, `softwareupdate` asks for an administrator's password and can't
install macOS updates unattended unless the Mac is managed by an MDM — so the agent can
report updates but no script can quietly install them.

<a id="macos-major"></a>

### A major macOS upgrade

A new major version (e.g. macOS Sequoia → macOS Tahoe) is never installed by a normal
update. Start it from **System Settings → General → Software Update → Upgrade Now**, after
checking the Mac and its important apps support it. To download the full installer first:
`softwareupdate --fetch-full-installer`. Older major versions eventually stop getting
security fixes (see [Unsupported software](#os-end-of-life)).

<a id="macos-apps"></a>

### Other apps

Apps from the Mac App Store update from **App Store → Updates** (or `mas upgrade` with the
[mas](https://github.com/mas-cli/mas) tool). Apps installed with [Homebrew](https://brew.sh):

```bash
brew update && brew upgrade
brew upgrade --cask --greedy     # also apps that update themselves
```

Other apps update through their own menu (*App name → Check for Updates…*).

<a id="os-end-of-life"></a>

## Unsupported (end-of-life) software

An operating system, runtime or database past its end of life gets **no more security
fixes at all**, so no amount of updating fixes it: it has to move to a supported version.
The result's link opens the product's page on [endoflife.date](https://endoflife.date),
which lists every version's support dates.

| Product | How to move to a supported version |
|---|---|
| Ubuntu | `sudo apt update && sudo apt full-upgrade && sudo reboot`, then `sudo do-release-upgrade`. LTS releases upgrade to the next LTS. Or keep it with Ubuntu Pro (up to 10 more years of security fixes) — see [Ubuntu Pro](#ubuntu-pro). |
| Debian | One release at a time: follow the "Upgrades from Debian *previous*" chapter of the new release's [release notes](https://www.debian.org/releases/) (change the codename in the APT sources, `apt update`, `apt upgrade --without-new-pkgs`, then `apt full-upgrade`). |
| Fedora | `sudo dnf upgrade --refresh`, `sudo dnf system-upgrade download --releasever=<next>`, `sudo dnf system-upgrade reboot`. |
| Rocky / AlmaLinux / RHEL | Major versions are upgraded with [ELevate](https://almalinux.org/elevate/) / Red Hat Leapp, or a fresh install. |
| CentOS Linux | No more updates at all — migrate to Rocky Linux, AlmaLinux or RHEL (each has an in-place migration script). |
| Windows | Upgrade to a supported Windows version (Windows 10 support ended 14 October 2025; Extended Security Updates are available for a fee). |

<a id="runtimes"></a>

### Runtimes: Node.js, Python, PHP

OS updates keep a runtime on its major version, so an end-of-life version stays until it's
replaced:

- **Node.js** — install a supported LTS version (see
  [Node.js releases](https://nodejs.org/en/about/previous-releases)) from nodejs.org,
  NodeSource's repository or nvm; reinstall the apps' dependencies (`npm ci`) and restart
  them.
- **Python** — install a newer version alongside (the distribution's newer `python3.x`
  package; on Ubuntu, the deadsnakes PPA), recreate each app's virtual environment with
  it, reinstall its requirements, and retire the old version.
- **PHP** — install a supported version (Ubuntu: the `ondrej/php` PPA; RHEL family: Remi's
  repository), switch the web server or PHP-FPM pool to it, and test the apps.

<a id="databases"></a>

### Databases: PostgreSQL, MariaDB, MySQL

Take a backup first. **PostgreSQL**: install the new major version, then move the data
with [`pg_upgrade`](https://www.postgresql.org/docs/current/pgupgrade.html) (Debian/Ubuntu:
`sudo pg_upgradecluster <old-version> main`). **MariaDB / MySQL**: upgrade one series at a
time, then run `mariadb-upgrade` (MariaDB) — MySQL 8.0.16+ upgrades its data on first start.

<a id="other"></a>

## Anything else

Update it with the tool that installed it. If you don't know what installed it, the
package's **Source** column in the result says where Looksee found it (`dpkg`, `rpm`,
`npm`, `pip`, a lock-file path…).

<a id="accepting"></a>

## Accepting a risk instead (exclusions)

When a finding can't be fixed yet — no fix released, a package the business needs, a
vulnerability that doesn't apply to how it's used — add it to the check's **Accepted risks** setting (or a reusable exclusion list of kind
*packages*) with the reason after ` #`:

```text
CVE-2024-12345 # no fix in Debian 12 yet, service not exposed — review 2027-01
libssl1.1 # needed by the old ERP client until its replacement in March
```

An advisory ID (CVE-…, GHSA-…, USN-…) skips that one vulnerability; a package name skips
the package. The reason shows with the result, and the check stops counting it. Review
exclusions regularly and remove them once the fix is installed.
