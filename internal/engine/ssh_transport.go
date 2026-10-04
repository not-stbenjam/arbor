package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

type sshRunner func(context.Context, string, string, io.Reader) ([]byte, error)

const maxSSHOutput = 64 * 1024 * 1024

type sshExitError struct {
	host, detail string
	status       int
	cause        error
}

func (e *sshExitError) Error() string {
	return fmt.Sprintf("SSH %s: %s. Check SSH keys, known_hosts, and the host configuration", e.host, e.detail)
}

func (e *sshExitError) Unwrap() error { return e.cause }

// Keep stdout bounded even for a broken remote executable. Oversized output is
// never passed to a protocol decoder, including a seemingly valid JSON prefix.
type sshOutput struct {
	buffer   bytes.Buffer
	overflow bool
}

func (w *sshOutput) Len() int      { return w.buffer.Len() }
func (w *sshOutput) Bytes() []byte { return w.buffer.Bytes() }

func (w *sshOutput) Write(data []byte) (int, error) {
	count := len(data)
	remaining := maxSSHOutput - w.Len()
	if count > remaining {
		w.overflow = true
		data = data[:remaining]
	}
	w.buffer.Write(data)
	return count, nil
}

func runSSH(ctx context.Context, host, command string, input io.Reader) ([]byte, error) {
	return runSSHProgress(ctx, host, command, input, nil)
}

func runSSHProgress(ctx context.Context, host, command string, input io.Reader, progress func(worktree.Progress)) ([]byte, error) {
	if err := ValidateHost(host); err != nil {
		return nil, err
	}
	if host == "" {
		return nil, errors.New("SSH host is required")
	}
	// Run the installer in a POSIX shell even when the user's login shell is fish.
	cmd := exec.CommandContext(ctx, "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes", "--", host, "sh -c "+quote(command))
	cmd.WaitDelay = 2 * time.Second
	cmd.Stdin = input
	if input == nil {
		// An open stdin acts as a lifetime signal for remote list --watch-stdin.
		// Use *os.File rather than an io.Pipe so exec does not wait for an
		// input-copy goroutine after a normal, successful remote exit.
		reader, writer, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		defer writer.Close()
		cmd.Stdin = reader
	}
	stderr := &progressWriter{callback: progress}
	cmd.Stderr = stderr
	stdout := &sshOutput{}
	cmd.Stdout = stdout
	err := cmd.Run()
	stderr.flush()
	if stdout.overflow {
		return nil, fmt.Errorf("SSH %s: remote output exceeded %d bytes", host, maxSSHOutput)
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		detail := strings.TrimSpace(stderr.diagnostics.String())
		if detail == "" {
			detail = err.Error()
		}
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return stdout.Bytes(), &sshExitError{host: host, detail: detail, status: exited.ExitCode(), cause: err}
		}
		return nil, fmt.Errorf("SSH %s: %s. Check SSH keys, known_hosts, and the host configuration", host, detail)
	}
	return stdout.Bytes(), nil
}
