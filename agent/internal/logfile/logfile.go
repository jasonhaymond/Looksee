// Package logfile writes the agent's log to a file that can't grow without
// limit: when the file passes a size cap it's renamed to "<name>.1"
// (replacing the previous one) and a fresh file is started, so at most two
// files (about twice the cap) are ever kept.
//
// Why: on Windows the agent runs as a Scheduled Task, which throws away
// everything a program prints. Before 5.1 that meant every agent error —
// "can't read config", "sending report: unexpected status 500" — was
// invisible. main.go writes the log here as well as to the console.
//
// The log never contains the agent key or report contents, only what the
// agent says about what it's doing.
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Writer is an io.Writer (anything the standard log package can write to)
// that appends to a file and rotates it at MaxBytes. Safe for use from
// several goroutines at once.
type Writer struct {
	path     string
	maxBytes int64

	mu   sync.Mutex
	f    *os.File
	size int64
}

// Open starts appending to path (creating it and its folder if needed) and
// rotates it once it reaches maxBytes.
func Open(path string, maxBytes int64) (*Writer, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("creating log folder: %w", err)
	}
	w := &Writer{path: path, maxBytes: maxBytes}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

// open (re)opens the file for appending and records its current size.
// Mode 0644: readable by administrators/other accounts on the machine (the
// log holds no secrets), writable only by the agent's own account.
func (w *Writer) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("opening log file: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("reading log file size: %w", err)
	}
	w.f, w.size = f, info.Size()
	return nil
}

// Write appends p, rotating first if p would take the file past the cap.
// A failed rotation isn't fatal: writing simply continues in the current
// file, since losing the size cap is better than losing log lines.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.size > 0 && w.size+int64(len(p)) > w.maxBytes {
		w.rotate()
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

// rotate closes the current file, renames it to "<path>.1" (replacing an
// older one) and opens a new, empty file. On Windows a file can't be
// renamed while open, hence closing first. If anything fails, it reopens
// the current file so writing can continue.
func (w *Writer) rotate() {
	w.f.Close()
	old := w.path + ".1"
	_ = os.Remove(old)
	_ = os.Rename(w.path, old)
	if err := w.open(); err != nil {
		// Couldn't start a new file: fall back to whatever can be opened.
		if f, ferr := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); ferr == nil {
			w.f = f
		}
	}
}

// Close closes the file.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Close()
}
