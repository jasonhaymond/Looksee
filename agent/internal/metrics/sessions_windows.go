//go:build windows

// Lists Windows sessions (who is signed in, whether at the console or over RDP,
// active or disconnected, and from which computer) for the "RDP sessions" check
// and the endpoint page.
//
// It calls the Windows Terminal Services API (wtsapi32.dll, the same source as
// Task Manager's Users tab) rather than parsing `quser`, whose output is
// translated into the system's language and has no client address.
//
// Security: read-only. It reports user and computer names and addresses to the
// engine, nothing about what a user is doing. The agent runs as SYSTEM, which may
// see every session.

package metrics

import (
	"fmt"
	"net"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Loaded from the Windows system folder only, so a planted DLL next to the agent
// can't be picked up instead.
var (
	wtsapi32                        = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSQuerySessionInformationW = wtsapi32.NewProc("WTSQuerySessionInformationW")
)

// Which fact to ask WTSQuerySessionInformation for (WTS_INFO_CLASS in Windows'
// headers).
const (
	wtsInfoClassUserName       = 5
	wtsInfoClassWinStationName = 6
	wtsInfoClassDomainName     = 7
	wtsInfoClassClientName     = 10
	wtsInfoClassClientAddress  = 14
	wtsInfoClassSessionInfo    = 24
)

// wtsInfo mirrors Windows' WTSINFOW structure, field for field, because Windows
// fills it in directly. Times are FILETIMEs: 100-nanosecond steps since 1601.
type wtsInfo struct {
	State                   uint32
	SessionID               uint32
	IncomingBytes           uint32
	OutgoingBytes           uint32
	IncomingFrames          uint32
	OutgoingFrames          uint32
	IncomingCompressedBytes uint32
	OutgoingCompressedBytes uint32
	WinStationName          [32]uint16
	Domain                  [17]uint16
	UserName                [21]uint16
	ConnectTime             int64
	DisconnectTime          int64
	LastInputTime           int64
	LogonTime               int64
	CurrentTime             int64
}

// wtsClientAddress mirrors WTS_CLIENT_ADDRESS.
type wtsClientAddress struct {
	AddressFamily uint32
	Address       [20]byte
}

// querySession fetches one fact about a session and hands the raw bytes to read,
// then frees Windows' copy. Returns false if Windows has no answer.
func querySession(id uint32, class uintptr, read func(buffer unsafe.Pointer, size uint32)) bool {
	var buffer *uint16
	var size uint32
	ok, _, _ := procWTSQuerySessionInformationW.Call(0, uintptr(id), class, uintptr(unsafe.Pointer(&buffer)), uintptr(unsafe.Pointer(&size)))
	if ok == 0 || buffer == nil {
		return false
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buffer)))
	read(unsafe.Pointer(buffer), size)
	return true
}

// sessionText fetches a text fact about a session ("" if there isn't one).
func sessionText(id uint32, class uintptr) string {
	text := ""
	querySession(id, class, func(buffer unsafe.Pointer, _ uint32) {
		text = windows.UTF16PtrToString((*uint16)(buffer))
	})
	return strings.TrimSpace(text)
}

// clientAddress is the address an RDP client connected from, or "" for a console
// session. Windows puts an IPv4 address two bytes into the field, and an IPv6
// address at the start.
func clientAddress(id uint32) string {
	address := ""
	querySession(id, wtsInfoClassClientAddress, func(buffer unsafe.Pointer, size uint32) {
		if size < uint32(unsafe.Sizeof(wtsClientAddress{})) {
			return
		}
		a := (*wtsClientAddress)(buffer)
		switch a.AddressFamily {
		case windows.AF_INET:
			address = net.IP(a.Address[2:6]).String()
		case windows.AF_INET6:
			address = net.IP(a.Address[:16]).String()
		}
	})
	if address == "0.0.0.0" {
		return ""
	}
	return address
}

// filetimeToUnix converts a FILETIME to Unix seconds; 0 stays 0 ("never").
func filetimeToUnix(t int64) int64 {
	if t <= 0 {
		return 0
	}
	const secondsFrom1601To1970 = 11644473600
	return t/10_000_000 - secondsFrom1601To1970
}

// SessionState names Windows' session state number (WTS_CONNECTSTATE_CLASS).
func SessionState(state uint32) string {
	names := []string{"active", "connected", "connecting", "shadowing", "disconnected", "idle", "listening", "resetting", "down", "initializing"}
	if int(state) < len(names) {
		return names[state]
	}
	return fmt.Sprintf("state %d", state)
}

// SessionKind says how a session is connected, from its session name: Windows
// names RDP sessions "RDP-Tcp#3" and the local one "Console". A disconnected
// session has lost its name, so its kind is "" (unknown).
func SessionKind(station string) string {
	s := strings.ToLower(station)
	switch {
	case strings.HasPrefix(s, "rdp"):
		return "rdp"
	case s == "console":
		return "console"
	default:
		return ""
	}
}

// windowsSessions lists every session with a signed-in user. Sessions with no
// user (session 0, the listeners waiting for connections) are left out.
func windowsSessions() ([]Session, error) {
	var list *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &list, &count); err != nil {
		return nil, fmt.Errorf("WTSEnumerateSessions: %w", err)
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(list)))

	sessions := []Session{}
	for _, entry := range unsafe.Slice(list, count) {
		user := sessionText(entry.SessionID, wtsInfoClassUserName)
		if user == "" {
			continue
		}
		if domain := sessionText(entry.SessionID, wtsInfoClassDomainName); domain != "" {
			user = domain + `\` + user
		}
		station := sessionText(entry.SessionID, wtsInfoClassWinStationName)
		s := Session{
			User:       user,
			Terminal:   station,
			ID:         int(entry.SessionID),
			State:      SessionState(entry.State),
			Kind:       SessionKind(station),
			ClientName: sessionText(entry.SessionID, wtsInfoClassClientName),
			Host:       clientAddress(entry.SessionID),
		}
		// Times come from a separate query. Idle time is measured against the
		// clock Windows reports alongside it, so it's right even if the agent's
		// own idea of the time differs.
		querySession(entry.SessionID, wtsInfoClassSessionInfo, func(buffer unsafe.Pointer, size uint32) {
			if size < uint32(unsafe.Sizeof(wtsInfo{})) {
				return
			}
			info := (*wtsInfo)(buffer)
			s.Started = filetimeToUnix(info.LogonTime)
			s.DisconnectedAt = filetimeToUnix(info.DisconnectTime)
			if info.LastInputTime > 0 && info.CurrentTime >= info.LastInputTime {
				idle := (info.CurrentTime - info.LastInputTime) / 10_000_000
				s.IdleSeconds = &idle
			}
		})
		sessions = append(sessions, s)
	}
	return sessions, nil
}
