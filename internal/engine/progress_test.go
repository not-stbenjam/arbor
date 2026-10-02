package engine

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

func TestProgressWriterStreamsSplitLinesAndKeepsDiagnostics(t *testing.T) {
	var events []worktree.Progress
	w := &progressWriter{callback: func(event worktree.Progress) { events = append(events, event) }}
	line := worktree.ProgressPrefix + `{"stage":"inspect","path":"/repo","discovered":2,"completed":1,"total":2,"worktree":{"path":"/repo"},"pending":false}` + "\n"
	w.Write([]byte("SSH warning\n" + line[:12]))
	if len(events) != 0 {
		t.Fatal("partial line dispatched")
	}
	w.Write([]byte(line[12:]))
	if len(events) != 1 || events[0].Worktree == nil || events[0].Worktree.Path != "/repo" {
		t.Fatalf("missing live event: %+v", events)
	}
	w.Write([]byte(worktree.ProgressPrefix + `{"stage":"inspect","completed":-1}` + "\n"))
	w.Write([]byte(strings.Repeat("x", maxProgressLine*3) + "\n" + line))
	w.flush()
	if len(events) != 2 || w.diagnostics.Len() > maxProgressLine || !strings.Contains(w.diagnostics.String(), "SSH warning") {
		t.Fatalf("invalid/big lines not handled: %d events, %d diagnostics", len(events), w.diagnostics.Len())
	}
}

func TestRemoteScanStreamsProgressAndPreservesReport(t *testing.T) {
	oldManaged, oldVersion := managed, Version
	t.Cleanup(func() { managed, Version = oldManaged, oldVersion })
	Version = "v1.2.3"
	managed = &provisioner{
		run: func(_ context.Context, _, command string, _ io.Reader) ([]byte, error) {
			if strings.Contains(command, "uname") {
				return []byte("Linux\naarch64\n"), nil
			}
			return []byte("arbor v1.2.3\n"), nil
		},
		stream: func(_ context.Context, host, command string, _ io.Reader, callback func(worktree.Progress)) ([]byte, error) {
			if host != "my-vps" || !strings.Contains(command, "'--progress'") || !strings.Contains(command, "'--watch-stdin'") || !strings.Contains(command, "'--no-default-excludes'") || !strings.Contains(command, "'--exclude' 'node_modules'") {
				t.Fatalf("missing remote progress option: %s, %s", host, command)
			}
			callback(worktree.Progress{Stage: "discovery", Path: "/code", Discovered: 1})
			return json.Marshal(worktree.Report{Root: "/code", Worktrees: []worktree.Worktree{}})
		},
	}
	var events []worktree.Progress
	report, err := Scan(context.Background(), "my-vps", worktree.Options{Excludes: []string{"node_modules"}, Progress: func(event worktree.Progress) { events = append(events, event) }})
	if err != nil || report.Root != "/code" || len(events) != 2 || events[0].Stage != "connecting" || events[1].Stage != "discovery" {
		t.Fatalf("remote progress/report: %+v %+v %v", report, events, err)
	}
}
