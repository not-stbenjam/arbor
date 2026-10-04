package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/stats"
	"github.com/not-stbenjam/arbor/internal/worktree"
)

func isolatedCLIStats(t *testing.T) {
	t.Helper()
	t.Setenv("ARBOR_STATS_PATH", filepath.Join(t.TempDir(), "statistics.json"))
}

func runRemovalStatsCLI(t *testing.T, args ...string) []byte {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if err := execute(context.Background(), args, &stdout, &stderr); err != nil {
		t.Fatalf("arbor %v: %v\nstderr: %s\nstdout: %s", args, err, &stderr, &stdout)
	}
	return stdout.Bytes()
}

func readCLIStats(t *testing.T) stats.Report {
	t.Helper()
	var report stats.Report
	if err := json.Unmarshal(runRemovalStatsCLI(t, "stats", "--json"), &report); err != nil {
		t.Fatalf("decode stats.Report: %v", err)
	}
	return report
}

func TestCLIMissingLockedForceRemovesOnlyItsRegistration(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "missing-locked")
	other := filepath.Join(root, "missing-other")
	cliTestGit(t, repo, "worktree", "add", "-b", "retain-locked", target)
	cliTestGit(t, target, "commit", "--allow-empty", "-m", "Unique committed work")
	head := cliTestGit(t, target, "rev-parse", "HEAD")
	cliTestGit(t, repo, "worktree", "lock", "--reason", "Offline checkout", target)
	cliTestGit(t, repo, "worktree", "add", "-b", "retain-other", other)
	for _, path := range []string{target, other} {
		if err := os.Rename(path, path+"-saved"); err != nil {
			t.Fatal(err)
		}
	}
	before := cliTestGit(t, repo, "worktree", "list", "--porcelain")
	var preview struct {
		DryRun    bool                `json:"dryRun"`
		Worktrees []worktree.Worktree `json:"worktrees"`
	}
	if err := json.Unmarshal(runRemovalStatsCLI(t, "remove", target, "--repo", repo, "--json"), &preview); err != nil {
		t.Fatal(err)
	}
	if !preview.DryRun || len(preview.Worktrees) != 1 || !preview.Worktrees[0].Missing || !preview.Worktrees[0].Locked {
		t.Fatalf("expected preview of one missing locked registration: %+v", preview)
	}
	if got := cliTestGit(t, repo, "worktree", "list", "--porcelain"); got != before {
		t.Fatalf("preview changed registrations:\nbefore %s\nafter %s", before, got)
	}
	if got := readCLIStats(t); got.RemovedWorktrees != 0 || got.CleanupSessions != 0 {
		t.Fatalf("preview counted as cleanup: %+v", got)
	}
	var result worktree.RemovalResult
	if err := json.Unmarshal(runRemovalStatsCLI(t, "remove", target, "--repo", filepath.Join(repo, ".git"), "--force", "--yes", "--json"), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Removed || result.Path != target {
		t.Fatalf("registration was not removed: %+v", result)
	}
	remaining := cliTestGit(t, repo, "worktree", "list", "--porcelain")
	if strings.Contains(remaining, "worktree "+target+"\n") || !strings.Contains(remaining, "worktree "+other+"\n") {
		t.Fatalf("wrong registrations changed: %s", remaining)
	}
	if got := cliTestGit(t, repo, "rev-parse", "refs/heads/retain-locked"); got != head {
		t.Fatalf("named committed work lost: got %s, want %s", got, head)
	}
	for _, path := range []string{target, other} {
		if _, err := os.Stat(path + "-saved"); err != nil {
			t.Fatalf("moved checkout touched: %s: %v", path, err)
		}
	}
	got := readCLIStats(t)
	if got.RemovedWorktrees != 1 || got.MissingRegistrations != 1 || got.EstimatedBytesReclaimed != 0 || got.CleanupSessions != 1 {
		t.Fatalf("missing registration must count once but reclaim zero bytes: %+v", got)
	}
}

func TestCLIForceConflictsAreRejectedBeforeIO(t *testing.T) {
	for _, flag := range []string{"--keep-local", "--recommended-only"} {
		t.Run(flag, func(t *testing.T) {
			isolatedCLIStats(t)
			// Neither Git nor SSH is available, and the host and paths are invalid.
			// Policy conflicts must win over all of those later checks.
			t.Setenv("PATH", t.TempDir())
			var stdout, stderr bytes.Buffer
			err := execute(context.Background(), []string{"remove", "/nonexistent/arbor-target", "--repo", "/nonexistent/arbor-repo", "--host", "-invalid", "--force", flag, "--yes"}, &stdout, &stderr)
			if err == nil || !strings.Contains(err.Error(), "--force") || !strings.Contains(err.Error(), flag) {
				t.Fatalf("expected policy conflict, got %v; stdout=%s stderr=%s", err, &stdout, &stderr)
			}
			if stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("conflicting policy started work: stdout=%s stderr=%s", &stdout, &stderr)
			}
			if _, err := os.Stat(os.Getenv("ARBOR_STATS_PATH")); !os.IsNotExist(err) {
				t.Fatalf("conflicting flags wrote statistics: %v", err)
			}
		})
	}
}

func TestCLIForceRemovesAnEmptyStaleDirectoryWithoutCountingItMissing(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "empty-locked")
	cliTestGit(t, repo, "worktree", "add", "-b", "empty-locked", target)
	cliTestGit(t, repo, "worktree", "lock", target)
	if err := os.Rename(filepath.Join(target, ".git"), filepath.Join(root, "saved-git-pointer")); err != nil {
		t.Fatal(err)
	}
	var result worktree.RemovalResult
	if err := json.Unmarshal(runRemovalStatsCLI(t, "remove", target, "--repo", repo, "--force", "--yes", "--json"), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Removed || result.Path != target {
		t.Fatalf("empty locked directory not removed: %+v", result)
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatalf("empty directory remains: %v", err)
	}
	if got := readCLIStats(t); got.RemovedWorktrees != 1 || got.MissingRegistrations != 0 || got.EstimatedBytesReclaimed != 0 || got.CleanupSessions != 1 {
		t.Fatalf("empty existing directory statistics: %+v", got)
	}
	cliTestGit(t, repo, "rev-parse", "--verify", "refs/heads/empty-locked")
}

func TestCLIRemovalStatisticsOnlyCountSuccessfulDeletion(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "local-files")
	cliTestGit(t, repo, "worktree", "add", "-b", "local-files", target)
	payload := []byte("exactly measured untracked local work\n")
	if err := os.WriteFile(filepath.Join(target, "payload.txt"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	runRemovalStatsCLI(t, "remove", target, "--json")
	var stdout, stderr bytes.Buffer
	if err := execute(context.Background(), []string{"remove", target, "--keep-local", "--yes", "--json"}, &stdout, &stderr); err == nil {
		t.Fatal("expected keep-local removal to refuse untracked data")
	}
	if got := readCLIStats(t); got.RemovedWorktrees != 0 || got.EstimatedBytesReclaimed != 0 || got.CleanupSessions != 0 {
		t.Fatalf("preview/failed deletion counted: %+v", got)
	}
	if got, err := os.ReadFile(filepath.Join(target, "payload.txt")); err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("preview or refused removal touched data: %q, %v", got, err)
	}
	runRemovalStatsCLI(t, "remove", target, "--yes", "--json")
	got := readCLIStats(t)
	if got.RemovedWorktrees != 1 || got.EstimatedBytesReclaimed != int64(len(payload)) || got.LargestWorktreeBytes != int64(len(payload)) || got.CleanupSessions != 1 || got.MissingRegistrations != 0 {
		t.Fatalf("incorrect successful deletion statistics: %+v", got)
	}
	// Repeating the now-absent target is not another successful removal.
	stdout.Reset()
	stderr.Reset()
	if err := execute(context.Background(), []string{"remove", target, "--repo", repo, "--yes", "--json"}, &stdout, &stderr); err == nil {
		t.Fatal("expected already-removed registration to be refused")
	}
	if again := readCLIStats(t); again.RemovedWorktrees != 1 || again.CleanupSessions != 1 || again.EstimatedBytesReclaimed != got.EstimatedBytesReclaimed {
		t.Fatalf("failed repeated deletion inflated totals: %+v", again)
	}
}

func TestCLICleanBatchCountsOneSession(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	for _, name := range []string{"first", "second"} {
		cliTestGit(t, repo, "worktree", "add", "-b", name, filepath.Join(root, name))
	}
	var results []worktree.RemovalResult
	if err := json.Unmarshal(runRemovalStatsCLI(t, "clean", "--path", root, "--all", "--yes", "--json"), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || !results[0].Removed || !results[1].Removed {
		t.Fatalf("expected two successful removals: %+v", results)
	}
	if got := readCLIStats(t); got.RemovedWorktrees != 2 || got.CleanupSessions != 1 || got.EstimatedBytesReclaimed != 0 {
		t.Fatalf("one clean command should count one cleanup session: %+v", got)
	}
}

func TestCLISeparateRemovalsShareDesktopStatsSession(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	for _, name := range []string{"first", "second"} {
		target := filepath.Join(root, name)
		cliTestGit(t, repo, "worktree", "add", "-b", name, target)
		runRemovalStatsCLI(t, "remove", target, "--keep-local", "--yes", "--stats-session", "desktop-batch-session", "--json")
	}
	if got := readCLIStats(t); got.RemovedWorktrees != 2 || got.CleanupSessions != 1 {
		t.Fatalf("separate CLI processes with the same desktop session must count one session: %+v", got)
	}
}
