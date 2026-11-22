// "How to fix this" for the software checks: for each upgradable package
// (host_packages), vulnerable package (host_vulnerable) and unsupported
// product (end of life), a plain-language explanation of why the usual
// update may not have fixed it, the command to run, and links — to the
// advisory, to the in-app help page docs/patching.md (section by case), and
// to the vendor's own page where one is useful.
//
// Why this exists: many findings survive "run Windows Update / softwareupdate /
// apt upgrade" for ordinary reasons — apt keeps back updates that need new
// dependencies, Ubuntu rolls updates out in phases, some fixes ship only in
// Ubuntu Pro (ESM), a distribution hasn't released a fix yet, a newer kernel
// is installed but the old one is still running, application dependencies
// (npm, pip, Composer) are never touched by OS updates, Windows keeps driver,
// optional and feature updates separate, and macOS major upgrades aren't
// installed by a normal update. Each case gets its own advice.
//
// Where this sits: pure functions (no database, no network), called by
// services/software.ts when it builds the checks' result details.
//
// Security: package names, versions and lock-file paths come from the agent's
// report — untrusted text. They're put into a suggested command only when
// they're made of safe characters (isSafeName / isSafePath below); otherwise
// no command is suggested, only the explanation and the help link. Without
// this, a crafted package name like "x; rm -rf /" could turn a command an
// admin copies and runs as root into a different one. Advisory links from
// OSV.dev are only passed on when they're plain http(s) addresses.

import type { SoftwareReport, SwPackage, SwUpgradable } from "./software.js";
import { own } from "../lib/own.js";

/** The advice attached to one finding (all optional except `fix`). */
export type Advice = {
  // What's going on and what to do, in plain language.
  fix: string;
  // A command to run on the endpoint (copy and paste), or null.
  command: string | null;
  // The in-app help section, e.g. "/help/patching#apt-kept-back".
  help: string;
  // The advisory or vendor page, or null.
  link: string | null;
};

/** The fixed versions OSV.dev lists for one package in one ecosystem. */
export type OsvAffected = { ecosystem: string; name: string; fixed: string[] };

// These checks look at the text one character at a time, without regular
// expressions, so no crafted input can make them slow.

/** ASCII letters and digits. */
const isAlnum = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9");

/**
 * Whether a package name (or name@version) may go into a command: letters,
 * digits and . + _ : @ / - (npm scopes, Debian epochs, Python dashes),
 * starting with a letter or digit — or @ then a letter or digit, for an npm
 * scope — and at most 201 characters. "libssl3", "@babel/core" and
 * "lodash@4.17.21" pass; anything with spaces, quotes, ; | & $ ` < > or new
 * lines fails, and so does a name starting with "-" (it would read as an option).
 */
export function isSafeName(name: string): boolean {
  const body = name.startsWith("@") ? name.slice(1) : name;
  if (body.length < 1 || body.length > 201 || !isAlnum(body.charAt(0))) return false;
  for (const c of body) if (!isAlnum(c) && !".+_:@/-".includes(c)) return false;
  return true;
}

/**
 * Whether a folder path may go inside double quotes in a command: 1–500
 * characters with no quote marks (" ' and the curly “ ” ‘ ’, which PowerShell
 * also treats as quotes), $, backticks, % or new lines — anything that could
 * end the quoting or expand inside it. A backslash is allowed only in a
 * Windows path (one with a drive letter, "C:\…"): elsewhere it could escape
 * the closing quote.
 */
export function isSafePath(path: string): boolean {
  if (path.length < 1 || path.length > 500) return false;
  const windows = path.length > 2 && isAlnum(path.charAt(0)) && path.charAt(1) === ":" && path.charAt(2) === "\\";
  for (const c of path) {
    if ("\"'`$%\r\n\u201C\u201D\u2018\u2019".includes(c)) return false;
    if (c === "\\" && !windows) return false;
  }
  return true;
}

/** Whether every name may go into a command. */
const safeNames = (names: string[]) => names.length > 0 && names.every(isSafeName);

/** The help page section for a case. */
const help = (section: string) => `/help/patching#${section}`;

/** An advisory link only if it's a plain http(s) address (OSV data is untrusted). */
export function safeLink(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 500) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The folder a lock file is in ("/srv/app/package-lock.json" → "/srv/app"). */
const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, "") || "/";

/** The CVE among a vulnerability's ID and aliases, for the distributions' trackers. */
const cveOf = (ids: string[]) => ids.find((i) => /^CVE-\d{4}-\d+$/.test(i)) ?? null;

/** The distribution's own page for a CVE (Ubuntu, Debian), else OSV.dev's page for the advisory. */
export function advisoryLink(id: string, aliases: string[], osId: string): string {
  const cve = cveOf([id, ...aliases]);
  if (cve && osId === "ubuntu") return `https://ubuntu.com/security/${cve}`;
  if (cve && osId === "debian") return `https://security-tracker.debian.org/tracker/${cve}`;
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

/**
 * The fixed versions for a package from OSV's "affected" data: entries for
 * this package name in the same ecosystem family ("Ubuntu:22.04:LTS" matches
 * "Ubuntu:22.04:LTS"; "npm" matches "npm").
 */
export function fixedVersions(affected: OsvAffected[], name: string, ecosystem: string): string[] {
  const family = ecosystem.split(":").slice(0, 2).join(":");
  const out = new Set<string>();
  for (const a of affected) {
    if (a.name !== name) continue;
    if (a.ecosystem !== ecosystem && !a.ecosystem.startsWith(family)) continue;
    for (const f of a.fixed) out.add(f);
  }
  return [...out];
}

/** One vulnerable package as software.ts finds it. */
export type VulnerableInput = {
  // For Debian/Ubuntu, the source package (what the distribution's data names).
  name: string;
  version: string;
  source: string;
  // The lock file it was found in (npm, pip, Composer projects).
  path?: string;
  // Fixed versions from OSV.dev (empty: no fix released).
  fixed: string[];
  // The first advisory's ID and aliases (CVE, USN…).
  advisoryId: string;
  aliases: string[];
};

/**
 * Advice for one vulnerable package (see the file header).
 *
 * @param v the package and what OSV.dev says about it
 * @param sw the endpoint's software report (OS, installed and upgradable packages)
 */
export function adviceForVulnerable(v: VulnerableInput, sw: SoftwareReport): Advice {
  const osId = (sw.os?.id ?? "").toLowerCase();
  const link = advisoryLink(v.advisoryId, v.aliases, osId);
  const fixedText = v.fixed.length ? v.fixed.slice(0, 3).join(", ") : null;
  const cve = cveOf([v.advisoryId, ...v.aliases]);
  switch (v.source) {
    case "dpkg": {
      const distro = osId === "ubuntu" ? "Ubuntu" : "Debian";
      // The installed binary packages built from this source package —
      // what apt installs and upgrades (source "openssl" → libssl3, openssl).
      const binaries = [...new Set(sw.packages.filter((p) => p.s === "dpkg" && (p.o === v.name || p.n === v.name)).map((p) => p.n))].slice(0, 20);
      const offered = sw.upgradable.filter((u) => u.source === "apt" && binaries.includes(u.name));
      const names = binaries.join(" ");
      const ok = safeNames(binaries);
      if ((v.name === "linux" || v.name.startsWith("linux-")) && binaries.some((b) => b.startsWith("linux-image"))) {
        return {
          fix: `Kernel package. A fixed kernel is often already installed, but the old one is still installed (and still running until a reboot), so it's still reported. Reboot into the newest kernel, then remove the old ones.${fixedText ? ` Fixed in ${fixedText}.` : ""}`,
          command: "sudo apt update && sudo apt full-upgrade && sudo reboot   # afterwards: uname -r, then: sudo apt autoremove --purge",
          help: help("linux-kernel"),
          link,
        };
      }
      if (!v.fixed.length) {
        return {
          fix: `${distro} hasn't released a fixed version of ${v.name} yet, so no update can install one. Follow the advisory; meanwhile remove the package if it isn't needed, or exclude this advisory with a reason if the risk is accepted.${osId === "ubuntu" ? " On Ubuntu, \"pro fix\" says whether a fix exists, including in Ubuntu Pro." : ""}`,
          command: osId === "ubuntu" && cve ? `pro fix ${cve}` : ok ? `apt-cache policy ${names}` : null,
          help: help("no-fix-yet"),
          link,
        };
      }
      if (v.fixed.some((f) => /esm/i.test(f))) {
        return {
          fix: `The fix (${fixedText}) is only published in Ubuntu Pro's Expanded Security Maintenance (ESM) — the normal Ubuntu archive doesn't have it, so apt upgrade can't install it. Ubuntu Pro is free for personal use on up to 5 machines. Attach the machine, enable ESM, then upgrade.`,
          command: `sudo pro attach <your-token> && sudo pro enable esm-infra esm-apps && sudo apt update && sudo apt upgrade${cve ? `   # or: sudo pro fix ${cve}` : ""}`,
          help: help("ubuntu-pro"),
          link,
        };
      }
      if (offered.some((u) => u.phased)) {
        return {
          fix: `The fix (${fixedText}) is published, but Ubuntu is releasing it to machines gradually (a "phased update") and this one isn't in the rollout yet, so apt upgrade skips it. It arrives by itself within days; to install it now:`,
          command: ok ? `sudo apt-get -o APT::Get::Always-Include-Phased-Updates=true install --only-upgrade ${names}` : null,
          help: help("apt-phased"),
          link,
        };
      }
      if (offered.length) {
        return {
          fix: `A fixed version (${fixedText}) is available but not installed. "apt upgrade" keeps back updates that need new or removed dependencies ("kept back"), and automatic updates (unattended-upgrades) only install security-pocket updates. Install it directly:`,
          command: ok ? `sudo apt update && sudo apt install --only-upgrade ${names}` : "sudo apt update && sudo apt full-upgrade",
          help: help("apt-kept-back"),
          link,
        };
      }
      return {
        fix: `${distro} has a fixed version (${fixedText}), but this machine isn't offered it. Usual causes: its package lists are out of date (apt update), its sources don't include the security repository, the package is held (apt-mark showhold) or pinned, or it was installed from another repository or a downloaded .deb (apt-cache policy shows where from).`,
        command: ok ? `sudo apt update && apt-cache policy ${names} && apt-mark showhold` : "sudo apt update && apt-mark showhold",
        help: help("apt-not-offered"),
        link,
      };
    }
    case "rpm": {
      const ok = isSafeName(v.name);
      if (!v.fixed.length) return { fix: `No fixed version of ${v.name} is published for this release yet. Follow the advisory; remove the package if unused or exclude the advisory with a reason meanwhile.`, command: ok ? `sudo dnf check-update --refresh ${v.name}` : null, help: help("no-fix-yet"), link };
      if (v.name.startsWith("kernel")) return { fix: `Kernel package, fixed in ${fixedText}. The new kernel only runs after a reboot; until then the old one is still reported.`, command: "sudo dnf upgrade --refresh kernel && sudo dnf needs-restarting -r && sudo reboot", help: help("linux-kernel"), link };
      return { fix: `Fixed in ${fixedText}. Update the package (refreshing the repository data first); if dnf says nothing to do, the fixed build isn't in the repositories this machine uses yet.`, command: ok ? `sudo dnf upgrade --refresh ${v.name}` : "sudo dnf upgrade --refresh", help: help("dnf"), link };
    }
    case "apk": {
      const ok = isSafeName(v.name);
      if (!v.fixed.length) return { fix: `No fixed version of ${v.name} for this Alpine release yet. Often the fix only goes into newer Alpine releases — upgrading the release (edit /etc/apk/repositories) may be the way to get it.`, command: null, help: help("apk"), link };
      return { fix: `Fixed in ${fixedText}. If "apk upgrade" doesn't install it, the fix is only in a newer Alpine branch than the one in /etc/apk/repositories.`, command: ok ? `sudo apk update && sudo apk upgrade ${v.name}` : "sudo apk update && sudo apk upgrade", help: help("apk"), link };
    }
    case "npm": {
      const target = fixedText ? `${v.name}@${v.fixed[0]}` : `${v.name}@latest`;
      const ok = isSafeName(target);
      if (!v.path) return { fix: `A globally installed npm tool. OS updates never update npm packages; update it with npm itself.${fixedText ? ` Fixed in ${fixedText}.` : ""}`, command: ok ? `sudo npm install -g ${target}` : null, help: help("npm"), link };
      const dir = folderOf(v.path);
      const okDir = isSafePath(dir);
      return {
        fix: `An application's own dependency (from ${v.path}). OS updates never change these — the project has to be updated and redeployed.${fixedText ? ` Fixed in ${fixedText}.` : " No fixed version yet."} "npm audit fix" upgrades within the allowed version ranges; if it's a dependency of a dependency, an "overrides" entry in package.json forces the fixed version.`,
        command: okDir ? `cd "${dir}" && npm audit fix${ok && fixedText ? `   # or: npm install ${target}` : ""}` : null,
        help: help("npm"),
        link,
      };
    }
    case "pip": {
      const req = fixedText ? `${v.name}>=${v.fixed[0]}` : v.name;
      const ok = isSafeName(v.name) && (!fixedText || isSafeName(v.fixed[0]));
      if (!v.path) {
        return {
          fix: `A Python package installed with pip. OS updates don't update pip-installed packages (and a package installed by apt is updated by apt instead — then it shows as an OS package).${fixedText ? ` Fixed in ${fixedText}.` : ""} Upgrade it in the environment it was installed in; on newer Debian/Ubuntu, system-wide pip refuses ("externally-managed-environment") — use the app's virtual environment.`,
          command: ok ? `python3 -m pip install --upgrade "${req}"` : null,
          help: help("pip"),
          link,
        };
      }
      const dir = folderOf(v.path);
      const okDir = isSafePath(dir);
      return { fix: `A dependency in ${v.path}. OS updates never change it: raise the version there, install it into the app's environment and redeploy.${fixedText ? ` Fixed in ${fixedText}.` : ""}`, command: ok && okDir ? `cd "${dir}" && python3 -m pip install --upgrade "${req}"   # then update the version in the requirements/lock file` : null, help: help("pip"), link };
    }
    case "composer": {
      const ok = isSafeName(v.name);
      const dir = v.path ? folderOf(v.path) : null;
      const okDir = dir != null && (isSafePath(dir));
      return { fix: `A PHP application's dependency${v.path ? ` (from ${v.path})` : ""}. OS updates never change it: update it with Composer and redeploy.${fixedText ? ` Fixed in ${fixedText}.` : ""}`, command: ok && okDir ? `cd "${dir}" && composer update ${v.name} --with-all-dependencies` : null, help: help("composer"), link };
    }
    default:
      return { fix: fixedText ? `Fixed in ${fixedText}; update ${v.name} with the tool that installed it.` : `No fixed version is listed yet; see the advisory.`, command: null, help: help("other"), link };
  }
}

/**
 * Advice for one package with an update waiting (host_packages).
 *
 * @param u the upgradable package
 */
export function adviceForUpgradable(u: SwUpgradable): Advice {
  const ok = isSafeName(u.name);
  switch (u.source) {
    case "apt":
      if (u.phased) return { fix: "Held back on purpose by Ubuntu's phased rollout — apt installs it by itself once the rollout reaches this machine (usually within days). To install it now:", command: ok ? `sudo apt-get -o APT::Get::Always-Include-Phased-Updates=true install --only-upgrade ${u.name}` : null, help: help("apt-phased"), link: null };
      return { fix: `If "apt upgrade" leaves this out ("kept back"), it needs a new or removed dependency; installing it by name (or "apt full-upgrade") does it. Automatic updates only install security-pocket updates${u.security ? " — this one is a security update" : ""}.`, command: ok ? `sudo apt update && sudo apt install --only-upgrade ${u.name}` : "sudo apt update && sudo apt full-upgrade", help: help("apt-kept-back"), link: null };
    case "dnf":
      return { fix: "Install it with dnf (refreshing repository data first).", command: ok ? `sudo dnf upgrade --refresh ${u.name}` : "sudo dnf upgrade --refresh", help: help("dnf"), link: null };
    case "pacman":
      return { fix: "Arch Linux only supports upgrading everything together (no partial upgrades).", command: "sudo pacman -Syu", help: help("pacman"), link: null };
    case "windows-update":
      return adviceForWindowsUpdate(u.name);
    case "softwareupdate":
      return adviceForMacUpdate(u.name);
    default:
      return { fix: "Update it with the tool that installed it.", command: null, help: help("other"), link: null };
  }
}

/**
 * Windows Update items that stay listed after "Check for updates", by kind:
 * drivers and optional updates (installed only when picked), feature
 * updates (a new Windows version), Defender definitions, Office, and
 * monthly updates that fail to install.
 */
export function adviceForWindowsUpdate(title: string): Advice {
  // "KB" followed by digits, e.g. "KB5034441" — the update's article number.
  const kb = /\bKB(\d{6,8})\b/i.exec(title)?.[1];
  const catalog = kb ? `https://www.catalog.update.microsoft.com/Search.aspx?q=KB${kb}` : null;
  if (/security intelligence|definition update|defender antivirus/i.test(title)) {
    return { fix: "Microsoft Defender's definitions. They update on their own several times a day; if they're stuck, update them directly (PowerShell as administrator).", command: "Update-MpSignature", help: help("windows-defender"), link: null };
  }
  if (/feature update|windows 1[01],? version|upgrade to windows/i.test(title)) {
    return { fix: "A feature update (a new Windows version). Windows doesn't install these with the regular monthly updates: start it from Settings → Windows Update (\"Download and install\" under the feature update), or with Microsoft's Installation Assistant. Check the machine meets the requirements first.", command: null, help: help("windows-feature"), link: null };
  }
  if (/driver|firmware|\b(intel|amd|nvidia|realtek|dell|hp|lenovo)\b.*-|- (system|display|net|audio|bluetooth|firmware|extension|softwarecomponent)/i.test(title)) {
    return { fix: "A driver or firmware update. Windows offers these as optional updates and only installs them when picked: Settings → Windows Update → Advanced options → Optional updates → Driver updates. The manufacturer's own update tool (Dell Command Update, Lenovo Vantage, HP Image Assistant) may have newer ones.", command: null, help: help("windows-drivers"), link: catalog };
  }
  if (/microsoft 365|office/i.test(title)) {
    return { fix: "Microsoft 365 / Office updates itself through its own updater (Click-to-Run), not Windows Update, unless \"Receive updates for other Microsoft products\" is on. Start an Office update now (Command Prompt):", command: '"C:\\Program Files\\Common Files\\microsoft shared\\ClickToRun\\OfficeC2RClient.exe" /update user', help: help("windows-office"), link: null };
  }
  return {
    fix: `If this keeps failing to install, download it${kb ? ` (KB${kb})` : ""} from the Microsoft Update Catalog and run the .msu, or repair Windows' update components first (Command Prompt as administrator), then try again. "Preview" updates are optional and only install when picked.`,
    command: "DISM /Online /Cleanup-Image /RestoreHealth && sfc /scannow",
    help: help("windows-update"),
    link: catalog,
  };
}

/**
 * macOS softwareupdate items that stay listed: a major upgrade (not
 * installed by a normal update), and updates that need a restart or an
 * administrator (on Apple silicon, softwareupdate needs a password or MDM).
 */
export function adviceForMacUpdate(label: string): Advice {
  // Labels are Apple's text ("macOS Sequoia 15.2-24C101"); quoting is only
  // safe when it has no quote or shell characters.
  const safe = label.length >= 1 && label.length <= 200 && [...label].every((c) => isAlnum(c) || " .,()_+-".includes(c));
  if (/^macOS [A-Za-z]+ \d+(\.0)?(-|$)/.test(label) && !/\d+\.\d*[1-9]/.test(label)) {
    return { fix: "A major macOS upgrade. A normal update doesn't install these: start it from System Settings → General → Software Update (\"Upgrade Now\"). Check apps and hardware support it first.", command: safe ? `softwareupdate --fetch-full-installer   # or install directly: sudo softwareupdate --install "${label}" --restart` : null, help: help("macos-major"), link: null };
  }
  return {
    fix: "Install it from System Settings → General → Software Update, or in Terminal. Most updates need a restart; on Apple silicon, softwareupdate asks for an administrator's password (it can't run unattended without MDM). App Store and other apps aren't in this list — see the help page.",
    command: safe ? `sudo softwareupdate --install "${label}" --restart` : "sudo softwareupdate --install --all --restart",
    help: help("macos"),
    link: null,
  };
}

/** Upgrade paths for unsupported (end-of-life) products, by endoflife.date product name. */
const EOL_ADVICE: Record<string, { fix: string; command: string | null; section: string }> = {
  ubuntu: { fix: "This Ubuntu release no longer gets security updates (outside Ubuntu Pro). Upgrade to a supported release, or attach Ubuntu Pro for extended (ESM) support.", command: "sudo apt update && sudo apt full-upgrade && sudo do-release-upgrade", section: "os-end-of-life" },
  debian: { fix: "This Debian release no longer gets security updates. Upgrade to the next release one step at a time (change the codename in the APT sources, then upgrade) — see Debian's upgrade notes for that release first.", command: null, section: "os-end-of-life" },
  fedora: { fix: "This Fedora release no longer gets updates. Upgrade with the system-upgrade plugin.", command: "sudo dnf upgrade --refresh && sudo dnf system-upgrade download --releasever=<next> && sudo dnf system-upgrade reboot", section: "os-end-of-life" },
  "rocky-linux": { fix: "This Rocky Linux major version no longer gets updates. Major versions are upgraded with ELevate (leapp) or a fresh install.", command: null, section: "os-end-of-life" },
  almalinux: { fix: "This AlmaLinux major version no longer gets updates. Major versions are upgraded with ELevate (leapp) or a fresh install.", command: null, section: "os-end-of-life" },
  rhel: { fix: "This RHEL major version is out of support. Upgrade with Red Hat's Leapp tool, or buy Extended Life-cycle Support.", command: null, section: "os-end-of-life" },
  centos: { fix: "CentOS Linux no longer gets updates. Move to Rocky Linux, AlmaLinux or RHEL (their migration scripts convert in place).", command: null, section: "os-end-of-life" },
  alpine: { fix: "This Alpine branch no longer gets security fixes. Point /etc/apk/repositories at a supported branch, then upgrade.", command: "sudo apk update && sudo apk upgrade --available", section: "os-end-of-life" },
  opensuse: { fix: "This openSUSE Leap release is out of support. Upgrade to the next Leap release (zypper dup after switching repositories).", command: null, section: "os-end-of-life" },
  nodejs: { fix: "This Node.js major version no longer gets security fixes, and OS updates won't move to a new major version. Install a supported LTS version (from nodejs.org, NodeSource or nvm), then test and restart the apps that use it.", command: null, section: "runtimes" },
  python: { fix: "This Python version no longer gets security fixes. Install a supported version alongside it (the distribution's newer package, or deadsnakes on Ubuntu), recreate the apps' virtual environments with it, and retire the old one.", command: null, section: "runtimes" },
  php: { fix: "This PHP version no longer gets security fixes. Install a supported version (the distribution's newer package, or the ondrej/php PPA on Ubuntu, Remi on RHEL-family), switch the web server to it, and test the apps.", command: null, section: "runtimes" },
  postgresql: { fix: "This PostgreSQL major version no longer gets fixes. Install the new major version and move the data with pg_upgrade (Debian/Ubuntu: pg_upgradecluster) — take a backup first.", command: null, section: "databases" },
  mariadb: { fix: "This MariaDB series is out of support. Upgrade to a supported series one step at a time and run mariadb-upgrade — take a backup first.", command: null, section: "databases" },
  mysql: { fix: "This MySQL series is out of support. Upgrade to a supported series (in-place upgrade or dump and reload) — take a backup first.", command: null, section: "databases" },
};

/**
 * Advice for an unsupported (end-of-life) product.
 *
 * @param product the endoflife.date product name ("ubuntu", "nodejs"…)
 * @param soon true when it's only reaching end of life soon
 */
export function adviceForEol(product: string, soon: boolean): Advice {
  const a = own(EOL_ADVICE, product) ?? { fix: "Move to a supported version.", command: null, section: "runtimes" };
  // endoflife.date product names are lowercase letters, digits and dashes.
  const link = product.length >= 1 && product.length <= 60 && [...product].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-") ? `https://endoflife.date/${product}` : null;
  return { fix: `${soon ? "Support ends soon. " : ""}${a.fix} No update to the current version fixes this.`, command: a.command, help: help(a.section), link };
}

/** The OSV "affected" data the advice needs, compacted for the cache. */
export function compactAffected(record: Record<string, unknown>): OsvAffected[] {
  const out: OsvAffected[] = [];
  for (const a of (record.affected as { package?: { ecosystem?: string; name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[] | undefined) ?? []) {
    const fixed = (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((f): f is string => typeof f === "string" && f.length < 100));
    if (a.package?.name && a.package.ecosystem) out.push({ ecosystem: String(a.package.ecosystem).slice(0, 100), name: String(a.package.name).slice(0, 200), fixed: [...new Set(fixed)].slice(0, 10) });
  }
  return out.slice(0, 50);
}

/** Debian/Ubuntu binary package names for a source package, for tests and callers. */
export const binariesOf = (packages: SwPackage[], source: string) => packages.filter((p) => p.s === "dpkg" && (p.o === source || p.n === source)).map((p) => p.n);
