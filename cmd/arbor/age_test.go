package main

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stbenjam/arbor/internal/engine"
	"github.com/stbenjam/arbor/internal/worktree"
)

func TestAgeDuration(t *testing.T) {
	for input, want := range map[string]time.Duration{"30d": 720 * time.Hour, "12h": 12 * time.Hour, "2w": 336 * time.Hour, "1h30m": 90 * time.Minute, "1.5d": 36 * time.Hour} {
		var d ageDuration
		if err := d.Set(input); err != nil || time.Duration(d) != want {
			t.Fatalf("%s: %v %s", input, err, d.String())
		}
	}
	for _, input := range []string{"", "0", "0d", "-1h", "later", "999999999999w"} {
		var d ageDuration
		if err := d.Set(input); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestAgeFiltersListAndCleanupAndBindsRemoval(t *testing.T) {
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	report := worktree.Report{Worktrees: []worktree.Worktree{
		{Path: "old", Recommended: true, ActivityAt: cutoff.Add(-time.Second)},
		{Path: "boundary", Recommended: true, ActivityAt: cutoff},
		{Path: "recent", Recommended: true, ActivityAt: cutoff.Add(time.Second)},
		{Path: "unknown", Recommended: true},
	}}
	r := worktreeRequest{command: "clean", json: true, notActiveSince: cutoff}
	var out bytes.Buffer
	if err := writeList(&out, r, report); err != nil {
		t.Fatal(err)
	}
	var listed worktree.Report
	if err := json.Unmarshal(out.Bytes(), &listed); err != nil || len(listed.Worktrees) != 2 {
		t.Fatalf("%s: %v", &out, err)
	}
	selected, err := selectTargets(r, report)
	if err != nil || len(selected.selected) != 2 {
		t.Fatalf("%+v %v", selected, err)
	}
	outcome := executeBatch(context.Background(), r, selected.selected, "", func(_ context.Context, request engine.RemovalRequest) (worktree.RemovalResult, error) {
		if !request.Options.NotActiveSince.Equal(cutoff) {
			t.Fatal("age consent lost")
		}
		return worktree.RemovalResult{Removed: true}, nil
	}, nil)
	if outcome.err != nil {
		t.Fatal(outcome.err)
	}
}

func TestAgeFlagsReachCommands(t *testing.T) {
	root, repo := cliTestRepository(t)
	cliTestGit(t, repo, "worktree", "add", "-b", "recent", root+"/recent")
	for _, command := range []string{"list", "clean"} {
		out, _, err := commandOutput(t, command, "--path", root, "--older-than", "30d", "--json")
		var report struct {
			Worktrees []worktree.Worktree `json:"worktrees"`
		}
		if err != nil || json.Unmarshal([]byte(out), &report) != nil || len(report.Worktrees) != 0 {
			t.Fatalf("%s: %s %v", command, out, err)
		}
	}
}
