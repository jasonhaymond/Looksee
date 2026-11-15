module looksee-agent

go 1.26.0

// The Go release the agent is built with. A machine whose own Go is older
// downloads this one automatically, so every agent build carries the
// standard-library security fixes it contains (net/http GO-2026-6859 is
// fixed in 1.27.4). Keep in step with the golang image in build-all.sh and
// scripts/security-check.sh.
toolchain go1.27.4

require (
	github.com/Microsoft/go-winio v0.6.4
	github.com/shirou/gopsutil/v4 v4.26.10
	golang.org/x/sys v0.49.0
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/ebitengine/purego v0.11.2 // indirect
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/lufia/plan9stats v0.0.0-20211012122336-39d0f177ccd0 // indirect
	github.com/power-devops/perfstat v0.0.0-20260805114148-88456608a4f6 // indirect
	github.com/tklauser/go-sysconf v0.4.0 // indirect
	github.com/tklauser/numcpus v0.12.0 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
)
