// Local user accounts (check type agent_users): lists the machine's local
// accounts with the details that matter for security — enabled or not,
// administrator or not, when the password was last set — and reports the
// list. The engine compares it with the previous list and decides what's an
// alert (engine/src/services/userAccounts.ts); the agent never judges.
//
// Where the list comes from:
//   - Linux: /etc/passwd (accounts), /etc/group (who is in sudo/wheel/admin)
//     and, when readable, /etc/shadow (locked passwords, password age,
//     expired accounts). The agent's user can't read /etc/shadow unless an
//     admin opts in (agent README → Privileges); without it those fields are
//     left out rather than guessed. Only the shadow file's status and dates
//     are used — the password hashes are never kept or sent; they're dropped
//     as soon as each line is split.
//   - macOS: dscl (Directory Service command line) for accounts, real names
//     and the admin group.
//   - Windows: PowerShell's Get-LocalUser and the members of the built-in
//     Administrators group (by its fixed SID S-1-5-32-544, which is the same
//     in every language of Windows).
// Domain accounts aren't listed — only accounts that exist on this machine.

package checks

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"looksee-agent/internal/android"
	"looksee-agent/internal/execx"
)

// UserAccount is one local account as reported to the engine. Pointer
// fields are left out of the JSON when the platform can't tell.
type UserAccount struct {
	Name            string `json:"name"`
	UID             string `json:"uid,omitempty"`
	FullName        string `json:"fullName,omitempty"`
	Enabled         *bool  `json:"enabled,omitempty"`
	Admin           *bool  `json:"admin,omitempty"`
	System          bool   `json:"system,omitempty"`
	Shell           string `json:"shell,omitempty"`
	Locked          *bool  `json:"locked,omitempty"`
	PasswordLastSet string `json:"passwordLastSet,omitempty"`
	LastLogon       string `json:"lastLogon,omitempty"`
}

func boolPtr(b bool) *bool { return &b }

// adminGroups are the Linux groups whose members can become root with sudo
// (Debian/Ubuntu: sudo or admin; Red Hat/Arch/Alpine: wheel).
var adminGroups = map[string]bool{"sudo": true, "wheel": true, "admin": true}

// ParseLinuxUsers builds the account list from the contents of /etc/passwd,
// /etc/group and (optional, "" when unreadable) /etc/shadow. uidMin is the
// first ordinary user ID (UID_MIN in /etc/login.defs, normally 1000); lower
// IDs are system accounts, except root (0), which always matters.
func ParseLinuxUsers(passwd, group, shadow string, uidMin int, now time.Time) []UserAccount {
	// Who is in an admin group: by name (the group's member list) and by
	// primary group ID (users whose own group is wheel/sudo).
	adminMembers := map[string]bool{}
	adminGIDs := map[string]bool{}
	for _, line := range strings.Split(group, "\n") {
		// group:password:GID:member,member
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) < 4 || !adminGroups[f[0]] {
			continue
		}
		adminGIDs[f[2]] = true
		for _, m := range strings.Split(f[3], ",") {
			if m = strings.TrimSpace(m); m != "" {
				adminMembers[m] = true
			}
		}
	}
	// Shadow fields per user: status (locked "!" / no password "*"), date of
	// the last password change and account expiry, in days since 1970.
	type shadowInfo struct {
		locked  bool
		lastSet string
		expired bool
	}
	shadows := map[string]shadowInfo{}
	for _, line := range strings.Split(shadow, "\n") {
		// name:hash:lastchg:min:max:warn:inactive:expire:reserved — the hash
		// (f[1]) is only looked at for its lock marker, never kept.
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) < 8 {
			continue
		}
		info := shadowInfo{locked: strings.HasPrefix(f[1], "!") || f[1] == "*" || f[1] == "!!"}
		if days, err := strconv.Atoi(f[2]); err == nil && days > 0 {
			info.lastSet = time.Unix(int64(days)*86400, 0).UTC().Format("2006-01-02")
		}
		if days, err := strconv.Atoi(f[7]); err == nil && days > 0 && now.After(time.Unix(int64(days)*86400, 0)) {
			info.expired = true
		}
		shadows[f[0]] = info
	}
	var out []UserAccount
	for _, line := range strings.Split(passwd, "\n") {
		// name:password:UID:GID:full name,room,phone:home:shell
		f := strings.Split(strings.TrimSpace(line), ":")
		if len(f) < 7 || f[0] == "" || strings.HasPrefix(f[0], "#") {
			continue
		}
		uid, _ := strconv.Atoi(f[2])
		u := UserAccount{
			Name:     f[0],
			UID:      f[2],
			FullName: strings.Split(f[4], ",")[0],
			Shell:    f[6],
			Admin:    boolPtr(uid == 0 || adminMembers[f[0]] || adminGIDs[f[3]]),
			// nobody (65534) and every ID below the first ordinary user ID,
			// except root, are system accounts.
			System: uid != 0 && (uid < uidMin || uid == 65534),
		}
		if s, ok := shadows[f[0]]; ok {
			u.Locked = boolPtr(s.locked)
			u.PasswordLastSet = s.lastSet
			u.Enabled = boolPtr(!s.expired)
		}
		out = append(out, u)
	}
	return out
}

// uidMinFrom reads UID_MIN from /etc/login.defs text (1000 when absent).
func uidMinFrom(loginDefs string) int {
	sc := bufio.NewScanner(strings.NewReader(loginDefs))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && f[0] == "UID_MIN" {
			if n, err := strconv.Atoi(f[1]); err == nil {
				return n
			}
		}
	}
	return 1000
}

// linuxUsers lists accounts from the files above.
func linuxUsers() ([]UserAccount, error) {
	passwd, err := os.ReadFile("/etc/passwd")
	if err != nil {
		if android.IsAndroid() {
			return nil, fmt.Errorf("Android has no local user accounts to list")
		}
		return nil, fmt.Errorf("reading /etc/passwd: %w", err)
	}
	group, _ := os.ReadFile("/etc/group")
	// Unreadable unless the admin opted in (agent README → Privileges) —
	// the details it gives are then simply left out.
	shadow, _ := os.ReadFile("/etc/shadow")
	defs, _ := os.ReadFile("/etc/login.defs")
	return ParseLinuxUsers(string(passwd), string(group), string(shadow), uidMinFrom(string(defs)), time.Now()), nil
}

// ParseDsclList reads `dscl . -list /Users <attribute>` output: one account
// per line, its name then the attribute's value (which may contain spaces,
// e.g. a real name).
func ParseDsclList(out string) map[string]string {
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			m[f[0]] = strings.Join(f[1:], " ")
		}
	}
	return m
}

// macUsers lists accounts with dscl. Names starting with "_" and IDs below
// 500 are macOS's own service accounts.
func macUsers() ([]UserAccount, error) {
	ids, err := execx.Run(30*time.Second, nil, "dscl", ".", "-list", "/Users", "UniqueID")
	if err != nil || ids.ExitCode != 0 {
		return nil, fmt.Errorf("dscl failed: %s", execx.FirstLine(ids.Stderr))
	}
	names, _ := execx.Run(30*time.Second, nil, "dscl", ".", "-list", "/Users", "RealName")
	shells, _ := execx.Run(30*time.Second, nil, "dscl", ".", "-list", "/Users", "UserShell")
	admins, _ := execx.Run(30*time.Second, nil, "dscl", ".", "-read", "/Groups/admin", "GroupMembership")
	adminSet := map[string]bool{}
	// "GroupMembership: root alice bob"
	for _, n := range strings.Fields(strings.TrimPrefix(strings.TrimSpace(admins.Stdout), "GroupMembership:")) {
		adminSet[n] = true
	}
	real := ParseDsclList(names.Stdout)
	shell := ParseDsclList(shells.Stdout)
	var out []UserAccount
	for name, id := range ParseDsclList(ids.Stdout) {
		uid, _ := strconv.Atoi(id)
		out = append(out, UserAccount{Name: name, UID: id, FullName: real[name], Shell: shell[name], Admin: boolPtr(uid == 0 || adminSet[name]), System: uid != 0 && (strings.HasPrefix(name, "_") || uid < 500)})
	}
	return out, nil
}

// windowsUsersScript lists local accounts as JSON. Administrators-group
// members come from Get-LocalGroupMember, or — when that fails (it throws on
// a group holding a deleted domain account) — from the older ADSI interface.
// Built-in accounts other than Administrator (Guest, DefaultAccount,
// WDAGUtilityAccount: RIDs 501, 503, 504) count as system accounts.
const windowsUsersScript = `
$admins = @()
try { $admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { $_.SID.Value }) }
catch {
  $g = [ADSI]('WinNT://./' + (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1] + ',group')
  $admins = @($g.psbase.Invoke('Members') | ForEach-Object { (New-Object System.Security.Principal.SecurityIdentifier($_.GetType().InvokeMember('objectSid','GetProperty',$null,$_,$null), 0)).Value })
}
ConvertTo-Json -Compress -InputObject @(Get-LocalUser -ErrorAction Stop | ForEach-Object {
  $rid = [int]($_.SID.Value.Split('-')[-1])
  [pscustomobject]@{
    name = $_.Name; uid = $_.SID.Value; fullName = $_.FullName; enabled = [bool]$_.Enabled
    admin = [bool]($admins -contains $_.SID.Value); system = ($rid -in 501,503,504)
    passwordLastSet = if ($_.PasswordLastSet) { $_.PasswordLastSet.ToUniversalTime().ToString('o') } else { '' }
    lastLogon = if ($_.LastLogon) { $_.LastLogon.ToUniversalTime().ToString('o') } else { '' }
  }
})`

// windowsUsers runs the script above.
func windowsUsers() ([]UserAccount, error) {
	res, err := execx.PowerShell(60*time.Second, nil, windowsUsersScript)
	if err != nil || res.ExitCode != 0 {
		return nil, fmt.Errorf("Get-LocalUser failed (a domain controller has no local accounts): %s", execx.FirstLine(res.Stderr))
	}
	var users []UserAccount
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &users); err != nil {
		return nil, fmt.Errorf("couldn't read Get-LocalUser output: %w", err)
	}
	return users, nil
}

// runUsers is the agent_users check: it reports the account list in
// details.users and how many there are. Status is "up" whenever the list
// could be read; the engine decides whether anything changed.
func runUsers(Cfg) Result {
	var users []UserAccount
	var err error
	switch runtime.GOOS {
	case "linux":
		users, err = linuxUsers()
	case "darwin":
		users, err = macUsers()
	case "windows":
		users, err = windowsUsers()
	default:
		return unknown("user account checks support Windows, Linux and macOS")
	}
	if err != nil {
		return unknown(err.Error())
	}
	sort.Slice(users, func(i, j int) bool { return users[i].Name < users[j].Name })
	admins := 0
	for _, u := range users {
		if u.Admin != nil && *u.Admin && !u.System {
			admins++
		}
	}
	return Result{Status: "up", Message: fmt.Sprintf("%d account(s), %d admin(s)", len(users), admins), Value: val(float64(len(users))), Details: map[string]any{"users": users}}
}
