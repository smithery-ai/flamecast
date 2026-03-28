// Package terminal manages PTY-backed terminal sessions.
package terminal

import (
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

const defaultOutputBufSize = 100 * 1024 // 100KB ring buffer per terminal

// OutputHandler is called whenever a terminal produces output.
type OutputHandler func(terminalID string, data []byte)

// Terminal represents a single PTY-backed terminal session.
type Terminal struct {
	mu       sync.Mutex
	ID       string
	Command  string
	cmd      *exec.Cmd
	ptmx     *os.File
	output   *ringBuffer
	exitCode *int // nil while running
	exitCh   chan struct{}
}

// Registry manages a set of terminals scoped to a session.
type Registry struct {
	mu        sync.RWMutex
	terminals map[string]*Terminal
	onOutput  OutputHandler
}

// NewRegistry creates a terminal registry. onOutput is called for each chunk
// of PTY output (may be called from any goroutine).
func NewRegistry(onOutput OutputHandler) *Registry {
	return &Registry{
		terminals: make(map[string]*Terminal),
		onOutput:  onOutput,
	}
}

// Create spawns a new PTY-backed terminal. The command is run in the given
// working directory with the supplied environment. Returns the terminal ID.
func (r *Registry) Create(id, command string, args []string, cwd string, env []string, cols, rows uint16) (*Terminal, error) {
	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	if len(env) > 0 {
		cmd.Env = env
	}

	winSize := &pty.Winsize{Cols: cols, Rows: rows}
	if cols == 0 {
		winSize.Cols = 120
	}
	if rows == 0 {
		winSize.Rows = 30
	}

	ptmx, err := pty.StartWithSize(cmd, winSize)
	if err != nil {
		return nil, err
	}

	t := &Terminal{
		ID:      id,
		Command: command,
		cmd:     cmd,
		ptmx:    ptmx,
		output:  newRingBuffer(defaultOutputBufSize),
		exitCh:  make(chan struct{}),
	}

	r.mu.Lock()
	r.terminals[id] = t
	r.mu.Unlock()

	// Read PTY output in background
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])

				t.mu.Lock()
				t.output.Write(chunk)
				t.mu.Unlock()

				if r.onOutput != nil {
					r.onOutput(id, chunk)
				}
			}
			if err != nil {
				break
			}
		}

		// Process exited — collect exit code
		exitCode := -1
		if err := cmd.Wait(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			}
		} else {
			exitCode = 0
		}

		t.mu.Lock()
		t.exitCode = &exitCode
		t.mu.Unlock()
		close(t.exitCh)
	}()

	return t, nil
}

// Get returns a terminal by ID, or nil.
func (r *Registry) Get(id string) *Terminal {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.terminals[id]
}

// Write sends data to the terminal's stdin (PTY master).
func (r *Registry) Write(id string, data []byte) error {
	t := r.Get(id)
	if t == nil {
		return io.ErrClosedPipe
	}
	_, err := t.ptmx.Write(data)
	return err
}

// Resize changes the PTY window size.
func (r *Registry) Resize(id string, cols, rows uint16) error {
	t := r.Get(id)
	if t == nil {
		return io.ErrClosedPipe
	}
	return pty.Setsize(t.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// Output returns the buffered output for a terminal.
func (r *Registry) Output(id string) (string, bool) {
	t := r.Get(id)
	if t == nil {
		return "", false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	data := t.output.Bytes()
	truncated := t.output.Truncated()
	return string(data), truncated
}

// WaitForExit blocks until the terminal's process exits and returns the exit code.
func (r *Registry) WaitForExit(id string) (int, error) {
	t := r.Get(id)
	if t == nil {
		return -1, io.ErrClosedPipe
	}
	<-t.exitCh
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.exitCode != nil {
		return *t.exitCode, nil
	}
	return -1, nil
}

// Kill sends SIGKILL to the terminal's process.
func (r *Registry) Kill(id string) error {
	t := r.Get(id)
	if t == nil {
		return nil
	}
	if t.cmd.Process != nil {
		return t.cmd.Process.Kill()
	}
	return nil
}

// Release kills the process (if running) and cleans up the PTY.
func (r *Registry) Release(id string) error {
	t := r.Get(id)
	if t == nil {
		return nil
	}

	// Kill process if still running
	_ = r.Kill(id)

	// Close PTY master
	_ = t.ptmx.Close()

	// Remove from registry
	r.mu.Lock()
	delete(r.terminals, id)
	r.mu.Unlock()

	return nil
}

// ReleaseAll kills and cleans up all terminals.
func (r *Registry) ReleaseAll() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.terminals))
	for id := range r.terminals {
		ids = append(ids, id)
	}
	r.mu.Unlock()

	for _, id := range ids {
		_ = r.Release(id)
	}
}

// List returns info for all terminals.
func (r *Registry) List() []map[string]any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]map[string]any, 0, len(r.terminals))
	for _, t := range r.terminals {
		t.mu.Lock()
		info := map[string]any{
			"terminalId": t.ID,
			"command":    t.Command,
		}
		if t.exitCode != nil {
			info["exitCode"] = *t.exitCode
		}
		t.mu.Unlock()
		result = append(result, info)
	}
	return result
}

// ---------- Ring buffer ----------

type ringBuffer struct {
	buf       []byte
	size      int
	pos       int  // next write position
	full      bool // buffer has wrapped at least once
	truncated bool // data was dropped
}

func newRingBuffer(size int) *ringBuffer {
	return &ringBuffer{buf: make([]byte, size), size: size}
}

func (rb *ringBuffer) Write(data []byte) {
	for _, b := range data {
		if rb.full {
			rb.truncated = true
		}
		rb.buf[rb.pos] = b
		rb.pos = (rb.pos + 1) % rb.size
		if rb.pos == 0 {
			rb.full = true
		}
	}
}

func (rb *ringBuffer) Bytes() []byte {
	if !rb.full {
		return append([]byte(nil), rb.buf[:rb.pos]...)
	}
	// Wrapped: return from pos..end + start..pos
	result := make([]byte, rb.size)
	copy(result, rb.buf[rb.pos:])
	copy(result[rb.size-rb.pos:], rb.buf[:rb.pos])
	return result
}

func (rb *ringBuffer) Truncated() bool {
	return rb.truncated
}
