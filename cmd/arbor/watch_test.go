package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestCLIWatchedStdinWithInheritedPipe(t *testing.T) {
	if os.Getenv("ARBOR_TEST_STDIN_CHILD") == "1" {
		err := execute(context.Background(), []string{"list", "--watch-stdin", "--json", "--path", os.Getenv("ARBOR_TEST_STDIN_ROOT")}, os.Stdout, os.Stderr)
		if err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCLIWatchedStdinWithInheritedPipe$")
	command.Env = append(os.Environ(), "ARBOR_TEST_STDIN_CHILD=1", "ARBOR_TEST_STDIN_ROOT="+t.TempDir())
	command.Stdin = reader
	data, err := command.CombinedOutput()
	if err != nil || !json.Valid(data) {
		t.Fatalf("inherited stdin pipe prevented successful scan: %s, %v", data, err)
	}
}

func TestWatchInputCancelsOnDisconnectAndCleansUp(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		stop := watchInput(ctx, reader, cancel)
		if disconnect {
			writer.Close()
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
				t.Fatal("SSH EOF did not cancel scan")
			}
		}
		done := make(chan struct{})
		go func() { stop(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("stdin watcher leaked after scan")
		}
		cancel()
		reader.Close()
		writer.Close()
	}
}
