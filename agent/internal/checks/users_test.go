// Tests for the local user accounts check's parsers (users.go). Each test
// says what it proves.
package checks

import (
	"strings"
	"testing"
	"time"
)

// Proves the Linux parser finds admins through sudo/wheel group membership
// and primary group, marks system accounts by UID (but never root), reads
// lock state and password age from /etc/shadow, and never keeps the
// password hash.
func TestParseLinuxUsers(t *testing.T) {
	passwd := "root:x:0:0:root:/root:/bin/bash\n" +
		"daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n" +
		"alice:x:1000:1000:Alice Smith,,,:/home/alice:/bin/bash\n" +
		"bob:x:1001:10:Bob:/home/bob:/bin/zsh\n" +
		"carol:x:1002:1002::/home/carol:/bin/bash\n" +
		"nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n"
	group := "sudo:x:27:alice\nwheel:x:10:\nusers:x:100:carol\n"
	// alice: hash, last changed day 19000; carol: locked (!) and expired on day 10.
	shadow := "alice:$6$secret$hash:19000:0:99999:7:::\ncarol:!$6$x:19000:0:99999:7::10:\n"
	users := ParseLinuxUsers(passwd, group, shadow, 1000, time.Unix(19500*86400, 0))
	by := map[string]UserAccount{}
	for _, u := range users {
		by[u.Name] = u
	}
	if len(users) != 6 {
		t.Fatalf("want 6 accounts, got %d", len(users))
	}
	if !*by["root"].Admin || by["root"].System {
		t.Fatalf("root must be an admin and not a system account: %+v", by["root"])
	}
	if !by["daemon"].System || !by["nobody"].System || by["alice"].System {
		t.Fatalf("system flags wrong: daemon %v nobody %v alice %v", by["daemon"].System, by["nobody"].System, by["alice"].System)
	}
	if !*by["alice"].Admin || !*by["bob"].Admin || *by["carol"].Admin {
		t.Fatalf("admin via sudo member (alice) and wheel primary group (bob) only: %+v %+v %+v", by["alice"], by["bob"], by["carol"])
	}
	if by["alice"].FullName != "Alice Smith" || by["alice"].PasswordLastSet != "2022-01-08" || *by["alice"].Locked {
		t.Fatalf("alice details: %+v", by["alice"])
	}
	if !*by["carol"].Locked || *by["carol"].Enabled {
		t.Fatalf("carol is locked and expired: %+v", by["carol"])
	}
	if by["bob"].Locked != nil {
		t.Fatalf("no shadow line → lock state unknown, not guessed: %+v", by["bob"])
	}
	for _, u := range users {
		if strings.Contains(u.PasswordLastSet+u.FullName+u.Shell+u.UID, "$6$") {
			t.Fatalf("password hash leaked into %+v", u)
		}
	}
}

// Proves UID_MIN is read from /etc/login.defs, with 1000 as the fallback.
func TestUIDMin(t *testing.T) {
	if n := uidMinFrom("# comment\nUID_MIN 500\nUID_MAX 60000\n"); n != 500 {
		t.Fatalf("got %d", n)
	}
	if n := uidMinFrom(""); n != 1000 {
		t.Fatalf("fallback: got %d", n)
	}
}

// Proves dscl list output keeps multi-word values (real names) whole.
func TestParseDsclList(t *testing.T) {
	m := ParseDsclList("_www 70\nalice Alice Smith\nroot System Administrator\n")
	if m["alice"] != "Alice Smith" || m["_www"] != "70" || m["root"] != "System Administrator" {
		t.Fatalf("got %v", m)
	}
}
