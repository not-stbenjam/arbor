package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

func TestCLICachedMissingAndEmptyConsentRejectsRecreatedCheckout(t *testing.T) {
	for _, kind := range []string{"missing", "empty"} {
		t.Run(kind, func(t *testing.T) {
			isolatedCLIStats(t)
			root, repo := cliTestRepository(t)
			target := filepath.Join(root, "checkout")
			cliTestGit(t, repo, "worktree", "add", "-b", "topic", target)
			if err := os.Rename(target, target+"-saved"); err != nil {
				t.Fatal(err)
			}
			if kind == "empty" {
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var report worktree.Report
			if err := json.Unmarshal(runRemovalStatsCLI(t, "list", "--target-only", "--repo", repo, "--path", target, "--json"), &report); err != nil {
				t.Fatal(err)
			}
			if len(report.Worktrees) != 1 {
				t.Fatalf("expected one stale registration: %+v", report)
			}
			confirmed := report.Worktrees[0]
			if (kind == "missing" && !confirmed.Missing) || (kind == "empty" && !confirmed.Empty) {
				t.Fatalf("wrong snapshot state: %+v", confirmed)
			}
			if kind == "empty" {
				if err := os.Rename(target, target+"-empty-saved"); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Rename(target+"-saved", target); err != nil {
				t.Fatal(err)
			}
			payload := []byte("newly recreated work must survive stale consent")
			if err := os.WriteFile(filepath.Join(target, "keep.txt"), payload, 0600); err != nil {
				t.Fatal(err)
			}
			// Bind exactly as the desktop/SSH subprocess does: same registration,
			// commit and branch, but consent was only for the earlier stale state.
			err := execute(context.Background(), []string{"remove", target, "--repo", confirmed.CommonDir, "--head", confirmed.Head, "--id", confirmed.ID, "--branch", confirmed.Branch, "--discard-local", "--expect-" + kind, "--yes", "--json"}, io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "after confirmation") {
				t.Fatalf("recreated checkout accepted by stale %s consent: %v", kind, err)
			}
			if got, err := os.ReadFile(filepath.Join(target, "keep.txt")); err != nil || string(got) != string(payload) {
				t.Fatalf("recreated data changed: %q, %v", got, err)
			}
			if got := cliTestGit(t, repo, "worktree", "list", "--porcelain"); !strings.Contains(got, "worktree "+target+"\n") {
				t.Fatalf("recreated registration removed: %s", got)
			}
			if got := readCLIStats(t); got.RemovedWorktrees != 0 {
				t.Fatalf("refused stale consent counted as deletion: %+v", got)
			}
		})
	}
}

// The desktop and SSH client always send the branch they confirmed. An empty
// value states that the checkout was detached, and binds that like any name.
func TestCLIDetachedConsentRejectsCheckoutNowOnABranch(t *testing.T) {
	isolatedCLIStats(t)
	root, repo := cliTestRepository(t)
	target := filepath.Join(root, "session")
	cliTestGit(t, repo, "worktree", "add", "--detach", target, "HEAD")
	var report worktree.Report
	if err := json.Unmarshal(runRemovalStatsCLI(t, "list", "--path", root, "--json"), &report); err != nil || len(report.Worktrees) != 1 {
		t.Fatalf("expected one detached checkout: %+v, %v", report, err)
	}
	confirmed := report.Worktrees[0]
	if !confirmed.Detached || confirmed.Branch != "" || !confirmed.CanDiscard {
		t.Fatalf("wrong snapshot state: %+v", confirmed)
	}
	cliTestGit(t, target, "checkout", "-b", "started-after-confirmation")
	payload := []byte("work begun on a branch must survive consent given for a detached session")
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"remove", target, "--repo", confirmed.CommonDir, "--head", confirmed.Head, "--id", confirmed.ID, "--branch", confirmed.Branch, "--discard-local", "--yes", "--json"}
	if err := execute(context.Background(), args, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "branch changed") {
		t.Fatalf("detached consent removed a checkout now on a branch: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(target, "keep.txt")); err != nil || string(got) != string(payload) {
		t.Fatalf("local work changed: %q, %v", got, err)
	}
	// The same consent is honored once the checkout matches it again.
	cliTestGit(t, target, "checkout", "--detach")
	if err := execute(context.Background(), args, io.Discard, io.Discard); err != nil {
		t.Fatalf("current detached confirmation refused: %v", err)
	}
}

func TestCLIStaleExpectationsPermitOnlyConfirmedEmptyOrMissingStates(t *testing.T) {
	for _, kind := range []string{"missing-remains-missing", "empty-remains-empty", "empty-now-missing"} {
		t.Run(kind, func(t *testing.T) {
			isolatedCLIStats(t)
			root, repo := cliTestRepository(t)
			target := filepath.Join(root, "stale")
			cliTestGit(t, repo, "worktree", "add", "-b", "topic", target)
			if err := os.Rename(target, target+"-saved"); err != nil {
				t.Fatal(err)
			}
			flag := "--expect-missing"
			if strings.HasPrefix(kind, "empty") {
				flag = "--expect-empty"
			}
			if kind == "empty-remains-empty" {
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var result worktree.RemovalResult
			if err := json.Unmarshal(runRemovalStatsCLI(t, "remove", target, "--repo", repo, flag, "--yes", "--json"), &result); err != nil || !result.Removed {
				t.Fatalf("valid narrow cleanup refused: %+v %v", result, err)
			}
		})
	}
}

func TestCLIStatsSessionValidationRunsBeforeScan(t *testing.T) {
	for _, session := range []string{strings.Repeat("a", 129), "spaces are invalid", "contains/slash", "new\nline", "é", "id;command"} {
		t.Run(session, func(t *testing.T) {
			isolatedCLIStats(t)
			t.Setenv("PATH", t.TempDir())
			err := execute(context.Background(), []string{"remove", "/not-an-arbor-fixture", "--host", "-invalid-host", "--stats-session", session, "--yes"}, io.Discard, io.Discard)
			if err == nil || !strings.Contains(err.Error(), "--stats-session") {
				t.Fatalf("session validation must precede host validation and Git: %v", err)
			}
			if _, err := os.Stat(os.Getenv("ARBOR_STATS_PATH")); !os.IsNotExist(err) {
				t.Fatalf("invalid session created statistics: %v", err)
			}
		})
	}
}

func TestCLIEmptyCheckoutWithoutRepositoryHintSuggestsRepo(t *testing.T) {
	isolatedCLIStats(t)
	target := t.TempDir()
	err := execute(context.Background(), []string{"remove", target, "--yes", "--json"}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "--repo") {
		t.Fatalf("empty target needs actionable owning-repository hint: %v", err)
	}
}
