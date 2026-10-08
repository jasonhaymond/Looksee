//go:build windows

package checks

import (
	"context"
	"net"
	"strings"

	"github.com/Microsoft/go-winio"
)

func dialDocker(ctx context.Context, socket string) (net.Conn, error) {
	if socket == "" {
		socket = `\\.\pipe\docker_engine`
	}
	// Docker's own URL form, npipe:////./pipe/docker_engine, becomes the
	// \\.\pipe\docker_engine path winio expects.
	socket = strings.ReplaceAll(strings.TrimPrefix(socket, "npipe://"), "/", `\`)
	return winio.DialPipeContext(ctx, socket)
}
