package main

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/stbenjam/arbor/internal/worktree"
)

func TestRemovalsSayHowToPutThemBack(t *testing.T) {
	removed := func(n int) batchOutcome {
		outcome := batchOutcome{}
		for i := 0; i < n; i++ {
			w := worktree.Worktree{Path: fmt.Sprintf("/w/tree %d", i), CommonDir: "/w/repo/.git", Branch: "topic", Head: strings.Repeat("a", 40)}
			outcome.removed = append(outcome.removed, w)
			outcome.results = append(outcome.results, worktree.RemovalResult{Path: w.Path, Removed: true})
		}
		return outcome
	}
	said := func(r worktreeRequest, outcome batchOutcome) string {
		var out bytes.Buffer
		if err := writeOutcome(&out, r, outcome); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	one := said(worktreeRequest{host: "box"}, removed(1))
	if !strings.Contains(one, "Put it back with: arbor restore '/w/tree 0' --repo /w/repo/.git --branch topic --host box\n") {
		t.Fatalf("one removal: %q", one)
	}
	few := said(worktreeRequest{}, removed(3))
	if strings.Count(few, "\n  arbor restore '/w/tree ") != 3 {
		t.Fatalf("a few removals: %q", few)
	}
	many := said(worktreeRequest{}, removed(restoreHints+1))
	if strings.Contains(many, "/w/tree 0' --repo") || !strings.Contains(many, "arbor restore PATH --repo REPOSITORY --branch BRANCH") {
		t.Fatalf("many removals: %q", many)
	}
	// A commit with no branch goes back as it was, and a registration whose
	// folder was already gone had nothing to put back.
	detached := removed(1)
	detached.removed[0].Detached, detached.removed[0].Branch = true, ""
	if text := said(worktreeRequest{}, detached); !strings.Contains(text, "--detach "+strings.Repeat("a", 40)) {
		t.Fatalf("detached: %q", text)
	}
	missing := removed(1)
	missing.removed[0].Missing = true
	if text := said(worktreeRequest{}, missing); strings.Contains(text, "restore") {
		t.Fatalf("missing: %q", text)
	}
	if text := said(worktreeRequest{json: true, command: "clean"}, removed(2)); strings.Contains(text, "arbor restore") {
		t.Fatalf("JSON: %q", text)
	}
}
