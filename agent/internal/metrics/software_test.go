// Tests for the software parsers (software.go), using real-shaped output
// from each package manager. Each test says what it proves.
package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

// Proves apt's upgradable list is parsed with versions and security
// pockets, and that phased (deferred) packages are recognised.
func TestAptUpgradableAndPhased(t *testing.T) {
	list := `Listing...
openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.12 amd64 [upgradable from: 3.0.2-0ubuntu1.10]
libsystemd0/jammy-updates 249.11-0ubuntu3.12 amd64 [upgradable from: 249.11-0ubuntu3.11]
`
	ups := ParseAptUpgradable(list)
	if len(ups) != 2 || ups[0].Name != "openssl" || !ups[0].Security || ups[0].Candidate != "3.0.2-0ubuntu1.12" || ups[0].Current != "3.0.2-0ubuntu1.10" {
		t.Fatalf("got %+v", ups)
	}
	if ups[1].Security {
		t.Fatal("libsystemd0 isn't a security update")
	}
	sim := `Reading package lists...
Calculating upgrade...
The following upgrades have been deferred due to phasing:
  libsystemd0 systemd
The following packages will be upgraded:
  openssl
1 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.
`
	phased := ParseAptPhased(sim)
	if !phased["libsystemd0"] || !phased["systemd"] || phased["openssl"] {
		t.Fatalf("phased: %v", phased)
	}
}

// Proves dnf, pacman and the installed-package formats parse, and that
// non-installed dpkg rows and rpm's "(none)" epoch are handled.
func TestPackageManagers(t *testing.T) {
	dnf := ParseDnfCheckUpdate("openssl-libs.x86_64   1:3.1.4-1.fc39   updates\nbash.x86_64   5.2.26-1.fc39   updates\n", "FEDORA-2024-abc Important/Sec. openssl-libs-3.1.4-1.fc39.x86_64\n")
	if len(dnf) != 2 || dnf[0].Name != "openssl-libs" || !dnf[0].Security || dnf[1].Security {
		t.Fatalf("dnf: %+v", dnf)
	}
	pac := ParseCheckupdates("linux 6.8.1-1 -> 6.8.2-1\n")
	if len(pac) != 1 || pac[0].Candidate != "6.8.2-1" {
		t.Fatalf("pacman: %+v", pac)
	}
	dpkg := ParseDpkg("bash\t5.1-6ubuntu1\tii \tbash\nlibssl3\t3.0.2\tii \topenssl\nold-kernel\t5.15\trc \n")
	if len(dpkg) != 2 || dpkg[0].Name != "bash" || dpkg[0].Origin != "" || dpkg[1].Origin != "openssl" {
		t.Fatalf("dpkg: %+v", dpkg)
	}
	rpm := ParseRpm("bash\t(none):5.2.26-1.fc39\ngpg-pubkey\t(none):abc-def\nopenssl\t1:3.1.4-1\n")
	if len(rpm) != 2 || rpm[0].Version != "5.2.26-1.fc39" || rpm[1].Version != "1:3.1.4-1" {
		t.Fatalf("rpm: %+v", rpm)
	}
	apk := ParseApk("musl-1.2.4-r2 x86_64 {musl} (MIT) [installed]\nca-certificates-bundle-20240226-r0 x86_64 {ca-certificates} (MPL-2.0) [installed]\n")
	if len(apk) != 2 || apk[0].Name != "musl" || apk[0].Version != "1.2.4-r2" || apk[1].Name != "ca-certificates-bundle" {
		t.Fatalf("apk: %+v", apk)
	}
	npm := ParseNpmGlobal(`{"dependencies":{"npm":{"version":"10.8.2"},"pm2":{"version":"5.4.2"}}}`)
	if len(npm) != 2 {
		t.Fatalf("npm: %+v", npm)
	}
	pip := ParsePipList(`[{"name":"requests","version":"2.31.0"}]`)
	if len(pip) != 1 || pip[0].Source != "pip" {
		t.Fatalf("pip: %+v", pip)
	}
}

// Proves each lock-file format yields name/version pairs tagged with the
// file, and that only the allowed file names are read at all — the setting
// can't be used to read other files on the host.
func TestLockfiles(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	npm := write("package-lock.json", `{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/express":{"version":"4.18.2"},"node_modules/a/node_modules/qs":{"version":"6.11.0"}}}`)
	pkgs, err := readLockfile(npm)
	if err != nil || len(pkgs) != 2 || pkgs[0].Path != npm {
		t.Fatalf("npm lock: %+v %v", pkgs, err)
	}
	req := write("requirements.txt", "# comment\nrequests==2.31.0\nflask>=2\nuvicorn[standard]==0.29.0 ; python_version>'3.8'\n")
	pkgs, _ = readLockfile(req)
	if len(pkgs) != 2 || pkgs[1].Name != "uvicorn" || pkgs[1].Version != "0.29.0" {
		t.Fatalf("requirements: %+v", pkgs)
	}
	composer := write("composer.lock", `{"packages":[{"name":"guzzlehttp/guzzle","version":"7.8.1"}],"packages-dev":[]}`)
	if pkgs, _ := readLockfile(composer); len(pkgs) != 1 {
		t.Fatalf("composer: %+v", pkgs)
	}
	pipfile := write("Pipfile.lock", `{"default":{"django":{"version":"==4.2.11"}},"develop":{}}`)
	if pkgs, _ := readLockfile(pipfile); len(pkgs) != 1 || pkgs[0].Version != "4.2.11" {
		t.Fatalf("pipfile: %+v", pkgs)
	}
	secret := write("shadow", "root:$6$hash:19000:0:99999:7:::")
	if _, err := readLockfile(secret); err == nil {
		t.Fatal("a file that isn't a lock file was read")
	}
}

// Proves the Windows installed-programs list is cleaned of NUL characters.
// A SHARP printer-driver uninstaller pads its registry DisplayName with
// them; PowerShell's ConvertTo-Json writes each as the escape \u0000, which
// decoding turns back into a real NUL — and one of those in the software
// list used to make the engine reject the whole report. Blank names
// (nothing left after cleaning) are dropped.
func TestParseWindowsUninstallStripsNul(t *testing.T) {
	out := `[{"n":"SHARP Driver Uninstall Tool\u0000\u0000\u0000","v":"1.2.1.11\u0000"},{"n":"7-Zip 24.08 (x64)","v":"24.08"},{"n":"\u0000\u0000","v":"1"}]`
	pkgs := ParseWindowsUninstall(out)
	if len(pkgs) != 2 {
		t.Fatalf("got %+v", pkgs)
	}
	if pkgs[0].Name != "SHARP Driver Uninstall Tool" || pkgs[0].Version != "1.2.1.11" || pkgs[0].Source != "windows" {
		t.Fatalf("got %+v", pkgs[0])
	}
	if ParseWindowsUninstall("not json") != nil {
		t.Fatal("bad output should give no packages")
	}
}
