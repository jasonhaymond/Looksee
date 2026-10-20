// Installed software and upgradable packages.
//
// What it collects (every 6 hours, in the background — see slow.go):
//   - installed packages from the OS package manager (dpkg, rpm, apk,
//     pacman), Windows' installed-programs list (the registry's Uninstall
//     keys), macOS applications, globally installed npm and pip packages,
//     and the Node.js / Python / PHP runtimes themselves;
//   - project dependencies from lock files at paths the engine asks for
//     (package-lock.json, npm-shrinkwrap.json, Pipfile.lock,
//     requirements.txt, composer.lock) — only files with those exact names
//     are read, and only package names and versions are kept from them;
//   - packages with an update available, marking security updates and, on
//     Ubuntu, "phased" updates (rolled out gradually by Ubuntu, held back on
//     purpose for now — Looksee leaves them out of counts by default).
//
// The engine uses this for the "Upgradable packages", "Installed software
// changed" and "Vulnerable or unsupported software" checks
// (engine/src/services/software.ts). Package lists can be thousands of
// rows, so main.go only sends them when they change (or once a day).
package metrics

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"looksee-agent/internal/execx"
)

// Package is one installed package. JSON keys are short because a host can
// have thousands of these.
type Package struct {
	Name    string `json:"n"`
	Version string `json:"v"`
	// Where it came from: "dpkg", "rpm", "apk", "pacman", "windows",
	// "macos", "npm", "pip", "composer" or "runtime".
	Source string `json:"s"`
	// For project dependencies: the lock file it was read from.
	Path string `json:"p,omitempty"`
	// Debian/Ubuntu: the source package it was built from, when the name
	// differs ("openssl" for "libssl3").
	Origin string `json:"o,omitempty"`
}

// Upgradable is one package with an update available.
type Upgradable struct {
	Name      string `json:"name"`
	Current   string `json:"current,omitempty"`
	Candidate string `json:"candidate,omitempty"`
	Security  bool   `json:"security,omitempty"`
	// Ubuntu phased update: available, but deliberately held back by
	// Ubuntu's gradual rollout for now.
	Phased bool   `json:"phased,omitempty"`
	Source string `json:"source"`
}

// Software is the whole software report.
type Software struct {
	CollectedAt  int64             `json:"collectedAt"`
	OS           map[string]string `json:"os,omitempty"`
	Packages     []Package         `json:"packages"`
	Upgradable   []Upgradable      `json:"upgradable"`
	UpgradableAt int64             `json:"upgradableAt,omitempty"`
	// Collection problems worth showing (e.g. a lock file that couldn't be
	// read); never fatal.
	Errors []string `json:"errors,omitempty"`
}

// LockfileNames are the only file names a lock-file path may end in. This
// stops the setting from being used to read any other file on the host.
var LockfileNames = map[string]bool{"package-lock.json": true, "npm-shrinkwrap.json": true, "Pipfile.lock": true, "requirements.txt": true, "composer.lock": true}

// maxLockfileBytes caps how much of a lock file is read (20 MB).
const maxLockfileBytes = 20 << 20

// OSRelease reads /etc/os-release (ID, VERSION_ID, PRETTY_NAME), which
// tells the engine which vulnerability database applies (Ubuntu 24.04,
// Debian 12, …).
func OSRelease() map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			out["id"] = v
		case "VERSION_ID":
			out["versionId"] = v
		case "PRETTY_NAME":
			out["name"] = v
		case "VERSION_CODENAME":
			out["codename"] = v
		}
	}
	return out
}

// lines splits command output into non-empty trimmed lines.
func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// ParseDpkg reads `dpkg-query -W -f '${Package}\t${Version}\t${db:Status-Abbrev}\t${source:Package}\n'`,
// keeping installed packages only (status "ii"). The source package
// ("openssl" for "libssl3") is what Debian/Ubuntu security data names.
func ParseDpkg(out string) []Package {
	var pkgs []Package
	for _, l := range lines(out) {
		f := strings.Split(l, "\t")
		if len(f) >= 3 && strings.HasPrefix(strings.TrimSpace(f[2]), "ii") {
			p := Package{Name: f[0], Version: f[1], Source: "dpkg"}
			if len(f) >= 4 && f[3] != "" && f[3] != f[0] {
				p.Origin = f[3]
			}
			pkgs = append(pkgs, p)
		}
	}
	return pkgs
}

// ParseRpm reads `rpm -qa --qf '%{NAME}\t%{EPOCH}:%{VERSION}-%{RELEASE}\n'`;
// an epoch of "(none)" is dropped.
func ParseRpm(out string) []Package {
	var pkgs []Package
	for _, l := range lines(out) {
		name, ver, ok := strings.Cut(l, "\t")
		if !ok || strings.HasPrefix(name, "gpg-pubkey") {
			continue
		}
		ver = strings.TrimPrefix(ver, "(none):")
		pkgs = append(pkgs, Package{Name: name, Version: ver, Source: "rpm"})
	}
	return pkgs
}

// apkRelease matches the "-r<number>" release suffix of an Alpine version,
// e.g. the "-r2" in "musl-1.2.4-r2".
var apkRelease = regexp.MustCompile(`-r\d+$`)

// ParseApk reads `apk list --installed` ("musl-1.2.4-r2 x86_64 {musl} (MIT)
// [installed]"): the name is everything before the version, which is the
// last "-" followed by a digit before the -rN release.
func ParseApk(out string) []Package {
	var pkgs []Package
	for _, l := range lines(out) {
		token := strings.Fields(l)[0]
		rel := apkRelease.FindString(token)
		base := strings.TrimSuffix(token, rel)
		cut := -1
		for i := len(base) - 1; i > 0; i-- {
			if base[i-1] == '-' && base[i] >= '0' && base[i] <= '9' {
				cut = i - 1
				break
			}
		}
		if cut <= 0 {
			continue
		}
		pkgs = append(pkgs, Package{Name: base[:cut], Version: base[cut+1:] + rel, Source: "apk"})
	}
	return pkgs
}

// ParsePacman reads `pacman -Q` ("name version").
func ParsePacman(out string) []Package {
	var pkgs []Package
	for _, l := range lines(out) {
		if f := strings.Fields(l); len(f) == 2 {
			pkgs = append(pkgs, Package{Name: f[0], Version: f[1], Source: "pacman"})
		}
	}
	return pkgs
}

// ParseNpmGlobal reads `npm ls -g --depth=0 --json`.
func ParseNpmGlobal(out string) []Package {
	var parsed struct {
		Dependencies map[string]struct {
			Version string `json:"version"`
		} `json:"dependencies"`
	}
	if json.Unmarshal([]byte(out), &parsed) != nil {
		return nil
	}
	var pkgs []Package
	for name, d := range parsed.Dependencies {
		if d.Version != "" {
			pkgs = append(pkgs, Package{Name: name, Version: d.Version, Source: "npm"})
		}
	}
	return pkgs
}

// ParsePipList reads `pip list --format=json`.
func ParsePipList(out string) []Package {
	var rows []struct{ Name, Version string }
	if json.Unmarshal([]byte(out), &rows) != nil {
		return nil
	}
	var pkgs []Package
	for _, r := range rows {
		pkgs = append(pkgs, Package{Name: r.Name, Version: r.Version, Source: "pip"})
	}
	return pkgs
}

// ParseLockfile reads package names and versions from one lock file; the
// file's base name decides the format. Returns nil for anything else.
func ParseLockfile(path string, data []byte) ([]Package, error) {
	var pkgs []Package
	add := func(name, version, source string) {
		version = strings.TrimPrefix(strings.TrimPrefix(version, "=="), "v")
		if name != "" && version != "" {
			pkgs = append(pkgs, Package{Name: name, Version: version, Source: source, Path: path})
		}
	}
	switch filepath.Base(path) {
	case "package-lock.json", "npm-shrinkwrap.json":
		var lock struct {
			Packages map[string]struct {
				Version string `json:"version"`
			} `json:"packages"`
			Dependencies map[string]json.RawMessage `json:"dependencies"`
		}
		if err := json.Unmarshal(data, &lock); err != nil {
			return nil, err
		}
		if len(lock.Packages) > 0 {
			// lockfileVersion 2/3: "node_modules/a/node_modules/b" → b.
			for key, p := range lock.Packages {
				if i := strings.LastIndex(key, "node_modules/"); i >= 0 {
					add(key[i+len("node_modules/"):], p.Version, "npm")
				}
			}
		} else {
			// lockfileVersion 1: nested "dependencies".
			var walk func(map[string]json.RawMessage)
			walk = func(deps map[string]json.RawMessage) {
				for name, raw := range deps {
					var d struct {
						Version      string                     `json:"version"`
						Dependencies map[string]json.RawMessage `json:"dependencies"`
					}
					if json.Unmarshal(raw, &d) == nil {
						add(name, d.Version, "npm")
						walk(d.Dependencies)
					}
				}
			}
			walk(lock.Dependencies)
		}
	case "Pipfile.lock":
		var lock map[string]json.RawMessage
		if err := json.Unmarshal(data, &lock); err != nil {
			return nil, err
		}
		for _, section := range []string{"default", "develop"} {
			var deps map[string]struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(lock[section], &deps) == nil {
				for name, d := range deps {
					add(name, d.Version, "pip")
				}
			}
		}
	case "requirements.txt":
		// Only exactly pinned lines ("name==1.2.3") have a known version.
		for _, l := range lines(string(data)) {
			if strings.HasPrefix(l, "#") || strings.HasPrefix(l, "-") {
				continue
			}
			l, _, _ = strings.Cut(l, ";")
			l, _, _ = strings.Cut(l, " #")
			if name, ver, ok := strings.Cut(l, "=="); ok {
				name, _, _ = strings.Cut(name, "[")
				add(strings.TrimSpace(name), strings.TrimSpace(ver), "pip")
			}
		}
	case "composer.lock":
		var lock struct {
			Packages    []struct{ Name, Version string } `json:"packages"`
			PackagesDev []struct{ Name, Version string } `json:"packages-dev"`
		}
		if err := json.Unmarshal(data, &lock); err != nil {
			return nil, err
		}
		for _, p := range append(lock.Packages, lock.PackagesDev...) {
			add(p.Name, p.Version, "composer")
		}
	default:
		return nil, nil
	}
	return pkgs, nil
}

// readLockfile reads one lock file if its name is allowed and it isn't too
// big.
func readLockfile(path string) ([]Package, error) {
	if !LockfileNames[filepath.Base(path)] {
		return nil, os.ErrPermission
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxLockfileBytes {
		return nil, os.ErrInvalid
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseLockfile(path, data)
}

// runtimeVersion runs a version command and returns the first version
// number it prints ("v20.11.1" → "20.11.1", "Python 3.12.3" → "3.12.3").
var versionNumber = regexp.MustCompile(`\d+\.\d+(\.\d+)?`)

func runtimeVersion(name string, args ...string) string {
	if !execx.Exists(name) {
		return ""
	}
	res, err := execx.Run(20*time.Second, nil, name, args...)
	if err != nil {
		return ""
	}
	return versionNumber.FindString(res.Stdout + " " + res.Stderr)
}

// collectPackages gathers every installed package this platform can list,
// plus lock files, and returns them sorted.
func collectPackages(lockfiles []string) ([]Package, []string) {
	var pkgs []Package
	var errs []string
	run := func(timeout time.Duration, parse func(string) []Package, name string, args ...string) {
		if !execx.Exists(name) {
			return
		}
		res, err := execx.Run(timeout, map[string]string{"LC_ALL": "C"}, name, args...)
		if err != nil {
			errs = append(errs, name+": "+err.Error())
			return
		}
		pkgs = append(pkgs, parse(res.Stdout)...)
	}
	switch runtime.GOOS {
	case "linux":
		run(2*time.Minute, ParseDpkg, "dpkg-query", "-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\t${source:Package}\n")
		if len(pkgs) == 0 {
			run(2*time.Minute, ParseRpm, "rpm", "-qa", "--qf", "%{NAME}\t%{EPOCH}:%{VERSION}-%{RELEASE}\n")
		}
		if len(pkgs) == 0 {
			run(2*time.Minute, ParseApk, "apk", "list", "--installed")
		}
		if len(pkgs) == 0 {
			run(2*time.Minute, ParsePacman, "pacman", "-Q")
		}
	case "windows":
		// Installed programs from the registry's Uninstall keys (64-bit,
		// 32-bit and per-user), the same list as "Apps & features".
		out, ok := ps(`$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
ConvertTo-Json -Compress -InputObject @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } | ForEach-Object { [pscustomobject]@{ n = [string]$_.DisplayName; v = [string]$_.DisplayVersion } })`, nil, 2*time.Minute)
		if ok {
			var rows []Package
			if json.Unmarshal([]byte(out), &rows) == nil {
				for _, r := range rows {
					pkgs = append(pkgs, Package{Name: strings.TrimSpace(r.Name), Version: strings.TrimSpace(r.Version), Source: "windows"})
				}
			}
		}
	case "darwin":
		if res, err := execx.Run(3*time.Minute, nil, "system_profiler", "SPApplicationsDataType", "-json", "-detailLevel", "mini"); err == nil {
			var parsed struct {
				Apps []struct {
					Name    string `json:"_name"`
					Version string `json:"version"`
				} `json:"SPApplicationsDataType"`
			}
			if json.Unmarshal([]byte(res.Stdout), &parsed) == nil {
				for _, a := range parsed.Apps {
					pkgs = append(pkgs, Package{Name: a.Name, Version: a.Version, Source: "macos"})
				}
			}
		}
	}
	// Language package managers and runtimes, wherever they're installed.
	run(2*time.Minute, ParseNpmGlobal, "npm", "ls", "-g", "--depth=0", "--json")
	if execx.Exists("python3") {
		run(2*time.Minute, ParsePipList, "python3", "-m", "pip", "list", "--format=json", "--disable-pip-version-check")
	}
	for _, rt := range []struct{ name, cmd, arg string }{{"node", "node", "--version"}, {"python", "python3", "--version"}, {"php", "php", "--version"}} {
		if v := runtimeVersion(rt.cmd, rt.arg); v != "" {
			pkgs = append(pkgs, Package{Name: rt.name, Version: v, Source: "runtime"})
		}
	}
	for _, p := range lockfiles {
		found, err := readLockfile(p)
		if err != nil {
			errs = append(errs, p+": "+err.Error())
			continue
		}
		pkgs = append(pkgs, found...)
	}
	sort.Slice(pkgs, func(i, j int) bool {
		if pkgs[i].Source != pkgs[j].Source {
			return pkgs[i].Source < pkgs[j].Source
		}
		return pkgs[i].Name < pkgs[j].Name
	})
	return pkgs, errs
}

// ParseAptUpgradable reads `apt list --upgradable` lines such as
// "openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.12 amd64 [upgradable from: 3.0.2-0ubuntu1.10]".
// A package from a "-security" pocket is a security update.
func ParseAptUpgradable(out string) []Upgradable {
	var ups []Upgradable
	for _, l := range lines(out) {
		nameSuite, rest, ok := strings.Cut(l, " ")
		if !ok || !strings.Contains(nameSuite, "/") {
			continue
		}
		name, suite, _ := strings.Cut(nameSuite, "/")
		f := strings.Fields(rest)
		u := Upgradable{Name: name, Source: "apt", Security: strings.Contains(suite, "-security")}
		if len(f) > 0 {
			u.Candidate = f[0]
		}
		if i := strings.Index(rest, "upgradable from: "); i >= 0 {
			u.Current = strings.TrimSuffix(strings.TrimSpace(rest[i+len("upgradable from: "):]), "]")
		}
		ups = append(ups, u)
	}
	return ups
}

// ParseAptPhased returns the packages apt holds back because of Ubuntu's
// phased rollout, from `apt-get -s upgrade` output: the indented names
// after "The following upgrades have been deferred due to phasing:".
func ParseAptPhased(out string) map[string]bool {
	phased := map[string]bool{}
	scanner := bufio.NewScanner(strings.NewReader(out))
	in := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "deferred due to phasing") {
			in = true
			continue
		}
		if in {
			if !strings.HasPrefix(line, " ") {
				in = false
				continue
			}
			for _, n := range strings.Fields(line) {
				phased[n] = true
			}
		}
	}
	return phased
}

// ParseDnfCheckUpdate reads `dnf -q check-update` ("name.arch version repo")
// and marks names that also appear in `dnf -q updateinfo list --security`.
func ParseDnfCheckUpdate(out, securityOut string) []Upgradable {
	security := map[string]bool{}
	for _, l := range lines(securityOut) {
		// "FEDORA-2024-abc Important/Sec. openssl-3.1.4-1.fc39.x86_64"
		f := strings.Fields(l)
		if len(f) >= 3 {
			security[f[2]] = true
		}
	}
	var ups []Upgradable
	for _, l := range lines(out) {
		f := strings.Fields(l)
		if len(f) != 3 || !strings.Contains(f[0], ".") {
			continue
		}
		name := f[0][:strings.LastIndex(f[0], ".")]
		u := Upgradable{Name: name, Candidate: f[1], Source: "dnf"}
		// A security advisory names "<name>-<version>-<release>.<arch>":
		// the package name followed by "-" and a digit.
		for full := range security {
			if strings.HasPrefix(full, name+"-") && len(full) > len(name)+1 && full[len(name)+1] >= '0' && full[len(name)+1] <= '9' {
				u.Security = true
			}
		}
		ups = append(ups, u)
	}
	return ups
}

// ParseCheckupdates reads Arch's `checkupdates` ("name 1.0-1 -> 1.1-1").
func ParseCheckupdates(out string) []Upgradable {
	var ups []Upgradable
	for _, l := range lines(out) {
		f := strings.Fields(l)
		if len(f) == 4 && f[2] == "->" {
			ups = append(ups, Upgradable{Name: f[0], Current: f[1], Candidate: f[3], Source: "pacman"})
		}
	}
	return ups
}
