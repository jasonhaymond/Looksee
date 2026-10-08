//go:build !windows

package checks

import (
	"context"
	"net"
)

func dialDocker(ctx context.Context, socket string) (net.Conn, error) {
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	var d net.Dialer
	return d.DialContext(ctx, "unix", socket)
}
