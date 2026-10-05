package engine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSSHExitPreservesStdoutAndTypedFailure(t *testing.T) {
	fixture := t.TempDir()
	shim := filepath.Join(fixture, "ssh")
	if err := os.WriteFile(shim, []byte("#!/bin/sh\nprintf '%s' \"$ARBOR_TEST_SSH_OUTPUT\"\nprintf '%s\\n' 'generic failure' >&2\nexit 7\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fixture+string(os.PathListSeparator)+os.Getenv("PATH"))
	const output = `{"path":"/fixture/session","removed":false,"error":"close older Arbor processes"}`
	t.Setenv("ARBOR_TEST_SSH_OUTPUT", output)
	data, err := runSSH(context.Background(), "fixture-host", "unused fixture command", nil)
	var exited *sshExitError
	if string(data) != output || !errors.As(err, &exited) || exited.status != 7 || err.Error() != "fixture-host: generic failure" {
		t.Fatalf("lost stdout or exit context: %q, %v", data, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	data, err = runSSH(ctx, "fixture-host", "unused fixture command", nil)
	if len(data) != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation leaked a command response: %q %v", data, err)
	}
}

func TestSSHOutputIsBoundedWithoutShortWrites(t *testing.T) {
	w := &sshOutput{}
	chunk := make([]byte, 1024*1024)
	for i := 0; i < maxSSHOutput/len(chunk); i++ {
		if n, err := w.Write(chunk); n != len(chunk) || err != nil {
			t.Fatalf("write: %d %v", n, err)
		}
	}
	if w.overflow || w.Len() != maxSSHOutput {
		t.Fatal("exact bound rejected")
	}
	if n, err := w.Write([]byte("extra")); n != 5 || err != nil || !w.overflow || w.Len() != maxSSHOutput {
		t.Fatalf("overflow was not bounded: %d %v, length=%d", n, err, w.Len())
	}
}

// An error should say what went wrong and offer the one check that fits it. A
// remote command's own failure is not an SSH problem and gets no SSH advice.
func TestSSHErrorsNameTheirCause(t *testing.T) {
	for _, tc := range []struct {
		name, detail string
		status       int
		want         string
	}{
		{"unknown host", "ssh: Could not resolve hostname build: Name or service not known", 255, "Could not connect to build over SSH: Could not resolve hostname build: Name or service not known. Check the SSH alias or hostname."},
		{"rejected key", "dev@build: Permission denied (publickey).", 255, "Could not connect to build over SSH: dev@build: Permission denied (publickey). Check your SSH key and agent; Arbor cannot enter a password."},
		{"unverified host key", "Host key verification failed.", 255, "Could not connect to build over SSH: Host key verification failed. Connect once with ssh in a terminal to verify the host's key."},
		{"offline", "ssh: connect to host build port 22: Connection timed out", 255, "Could not connect to build over SSH: connect to host build port 22: Connection timed out. Check that the host is online and reachable."},
		{"something else", "kex_exchange_identification: read: Connection reset by peer", 255, "Could not connect to build over SSH: kex_exchange_identification: read: Connection reset by peer. Check that `ssh build` connects from a terminal."},
		{"remote command", "arbor: folder does not exist: /srv/code", 1, "build: folder does not exist: /srv/code"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := &sshExitError{host: "build", detail: tc.detail, status: tc.status}
			if err.Error() != tc.want {
				t.Fatalf("got  %q\nwant %q", err.Error(), tc.want)
			}
		})
	}
}
