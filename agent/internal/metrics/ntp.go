package metrics

import (
	"encoding/binary"
	"fmt"
	"net"
	"time"
)

const ntpEpochOffset = 2208988800

func ntpTime(b []byte) time.Time {
	secs := binary.BigEndian.Uint32(b[0:4])
	frac := binary.BigEndian.Uint32(b[4:8])
	nanos := (int64(frac) * 1e9) >> 32
	return time.Unix(int64(secs)-ntpEpochOffset, nanos)
}

// SNTPOffset asks an NTP server for its time and returns how far the local
// clock is from it (positive = the server is ahead).
func SNTPOffset(server string, timeout time.Duration) (time.Duration, error) {
	addr := server
	if _, _, err := net.SplitHostPort(server); err != nil {
		addr = net.JoinHostPort(server, "123")
	}
	conn, err := net.DialTimeout("udp", addr, timeout)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	req := make([]byte, 48)
	req[0] = 0x1b
	t1 := time.Now()
	if _, err := conn.Write(req); err != nil {
		return 0, err
	}
	resp := make([]byte, 48)
	n, err := conn.Read(resp)
	t4 := time.Now()
	if err != nil {
		return 0, err
	}
	if n < 48 {
		return 0, fmt.Errorf("short NTP reply")
	}
	if resp[1] == 0 || resp[1] >= 16 {
		return 0, fmt.Errorf("NTP server is unsynchronized (stratum %d)", resp[1])
	}
	t2 := ntpTime(resp[32:40])
	t3 := ntpTime(resp[40:48])
	return (t2.Sub(t1) + t3.Sub(t4)) / 2, nil
}
