package engine

import (
	"context"
	"errors"
	"fmt"
	"github.com/not-stbenjam/arbor/internal/worktree"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type sshRunner func(context.Context, string, string, io.Reader) ([]byte, error)

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
	data, err := cmd.Output()
	stderr.flush()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		detail := strings.TrimSpace(stderr.diagnostics.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("SSH %s: %s. Check SSH keys, known_hosts, and the host configuration", host, detail)
	}
	return data, nil
}
