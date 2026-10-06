package main

import (
	"encoding/json"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestStrictScanPrintsOutputBeforeFailing(t *testing.T) {
	root, repo := cliTestRepository(t)
	cliTestGit(t, repo, "worktree", "add", "-b", "topic", root+"/topic")
	// A deciding remote with no fetched default branch produces a warning.
	cliTestGit(t, repo, "remote", "add", "upstream", root+"/unfetched.git")
	for _, command := range []string{"list", "clean"} {
		for _, strict := range []bool{false, true} {
			for _, asJSON := range []bool{false, true} {
				args := []string{command, "--path", root, "--older-than=100w"}
				if command == "clean" && !asJSON {
					args = append(args, "--yes")
				}
				if strict {
					args = append(args, "--strict")
				}
				if asJSON {
					args = append(args, "--json")
				}
				out, _, err := commandOutput(t, args...)
				want := 0
				if strict {
					want = 3
				}
				if exitStatus(err) != want || out == "" {
					t.Fatalf("%v: %s %v", args, out, err)
				}
				if asJSON && !json.Valid([]byte(out)) {
					t.Fatalf("bad JSON: %s", out)
				}
			}
		}
	}
	// A worktree problem alone also makes inspection incomplete.
	if !incompleteScan(worktree.Report{Worktrees: []worktree.Worktree{{Problems: []string{"unreadable"}}}}) {
		t.Fatal("missed incomplete inspection")
	}
	if incompleteScan(worktree.Report{Worktrees: []worktree.Worktree{{Dirty: true, Blockers: []string{"local changes"}}}}) {
		t.Fatal("ordinary blockers are not incomplete inspection")
	}
	out, _, err := commandOutput(t, "list", "--path", t.TempDir(), "--strict", "--json")
	if err != nil || !json.Valid([]byte(out)) {
		t.Fatalf("complete empty scan: %s %v", out, err)
	}
}
