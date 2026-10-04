package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/stats"
	"github.com/not-stbenjam/arbor/internal/worktree"
)

func statsRemoteFixture(t *testing.T, respond func(string) ([]byte, error)) {
	t.Helper()
	previous, previousVersion := managed, Version
	t.Cleanup(func() { managed, Version = previous, previousVersion })
	Version = "v1.2.3"
	managed = &provisioner{run: func(_ context.Context, host, command string, _ io.Reader) ([]byte, error) {
		if host != "stats-fixture-vps" {
			t.Fatalf("unexpected remote host %q", host)
		}
		switch {
		case command == "uname -s && uname -m":
			return []byte("Linux\naarch64\n"), nil
		case strings.Contains(command, "--version"):
			return []byte("arbor v1.2.3\n"), nil
		default:
			return respond(command)
		}
	}}
}

func TestRemoteStatsReadsSelectedHostWithoutChangingLocalHistory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "statistics.json")
	t.Setenv("ARBOR_STATS_PATH", file)
	if err := stats.RecordRemovalBatch(stats.Batch{ID: "local-only", Removals: []stats.Removal{{SizeBytes: 17}}}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	remote := stats.Report{Version: 1, RemovedWorktrees: 9, EstimatedBytesReclaimed: 1234, CleanupSessions: 3, Daily: []stats.Day{}}
	statsRemoteFixture(t, func(command string) ([]byte, error) {
		if !strings.HasSuffix(command, "'stats' '--json'") {
			t.Fatalf("unexpected remote stats command %s", command)
		}
		return json.Marshal(remote)
	})
	got, err := ReadStats(context.Background(), "stats-fixture-vps")
	if err != nil || got.Version != 1 || got.RemovedWorktrees != 9 || got.EstimatedBytesReclaimed != 1234 || got.CleanupSessions != 3 {
		t.Fatalf("remote statistics lost: %+v, %v", got, err)
	}
	after, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("remote stats changed local history: %v\nbefore %s\nafter %s", err, before, after)
	}
	local, err := ReadStats(context.Background(), "")
	if err != nil || local.RemovedWorktrees != 1 || local.EstimatedBytesReclaimed != 17 {
		t.Fatalf("local host selected wrong statistics: %+v, %v", local, err)
	}
}

func TestRemoteStatsRejectsUnknownFormat(t *testing.T) {
	for _, version := range []int{0, 2} {
		t.Run(strconv.Itoa(version), func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "statistics.json")
			t.Setenv("ARBOR_STATS_PATH", file)
			statsRemoteFixture(t, func(command string) ([]byte, error) {
				if !strings.HasSuffix(command, "'stats' '--json'") {
					t.Fatalf("unexpected command %s", command)
				}
				return json.Marshal(stats.Report{Version: version, Daily: []stats.Day{}})
			})
			if _, err := ReadStats(context.Background(), "stats-fixture-vps"); err == nil || !strings.Contains(err.Error(), "unsupported statistics format") {
				t.Fatalf("unsupported format accepted: %v", err)
			}
			if _, err := os.Stat(file); !os.IsNotExist(err) {
				t.Fatalf("failed remote stats created local history: %v", err)
			}
		})
	}
}

func TestRemoteRemovalForwardsOpaqueStatsSessionWithoutLocalRecording(t *testing.T) {
	file := filepath.Join(t.TempDir(), "statistics.json")
	t.Setenv("ARBOR_STATS_PATH", file)
	session := "desktop's batch; $(echo not-a-command)"
	w := worktree.Worktree{ID: "fixture", Path: "/remote/checkout", CommonDir: "/remote/repo/.git", Head: strings.Repeat("a", 40), Branch: "topic", CanRemove: true}
	statsRemoteFixture(t, func(command string) ([]byte, error) {
		if !strings.Contains(command, "'remove'") || !strings.Contains(command, "'--stats-session' "+quote(session)) {
			t.Fatalf("shared session was not passed as an opaque argument: %s", command)
		}
		if !strings.Contains(command, "'--keep-local'") || !strings.Contains(command, "'--repo' "+quote(w.CommonDir)) {
			t.Fatalf("session plumbing changed removal consent/repository: %s", command)
		}
		return json.Marshal(worktree.RemovalResult{Path: w.Path, Removed: true})
	})
	result, err := RemoveWithSession(context.Background(), "stats-fixture-vps", w, w.Head, false, false, session)
	if err != nil || !result.Removed || result.Path != w.Path {
		t.Fatalf("remote removal failed: %+v, %v", result, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("remote removal was double-counted locally: %v", err)
	}
}
