package engine

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	if string(data) != output || !errors.As(err, &exited) || exited.status != 7 || !strings.Contains(err.Error(), "SSH fixture-host: generic failure") {
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
