package main

import (
	"strings"
	"testing"

	"github.com/not-stbenjam/arbor/internal/worktree"
)

func TestSelectionBindsEveryConfirmedIdentityAndRecommendation(t *testing.T) {
	w := worktree.Worktree{ID: "current-id", Path: "/fixture/topic", Head: strings.Repeat("a", 40), Branch: "topic", CanRemove: true}
	base := worktreeRequest{command: "remove", id: w.ID, head: w.Head, branch: w.Branch, expectBranch: true}
	report := worktree.Report{Root: w.Path, Worktrees: []worktree.Worktree{w}}
	if selected, err := selectTargets(base, report); err != nil || len(selected.selected) != 1 {
		t.Fatalf("matching confirmation rejected: %+v, %v", selected, err)
	}
	for _, tc := range []struct {
		name, message string
		change        func(*worktreeRequest)
	}{
		{"commit", "commit changed", func(r *worktreeRequest) { r.head = strings.Repeat("b", 40) }},
		{"identity", "identity changed", func(r *worktreeRequest) { r.id = "previous-id" }},
		{"branch", "branch changed", func(r *worktreeRequest) { r.branch = "previous-branch" }},
		{"detached", "branch changed", func(r *worktreeRequest) { r.branch = "" }},
		{"recommendation", "not a cleanup recommendation", func(r *worktreeRequest) { r.recommended = true }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := base
			tc.change(&request)
			if _, err := selectTargets(request, report); err == nil || !strings.Contains(err.Error(), tc.message) {
				t.Fatalf("stale confirmation accepted or wrong refusal: %v", err)
			}
		})
	}
	base.recommended = true
	report.Worktrees[0].Recommended = true
	if _, err := selectTargets(base, report); err != nil {
		t.Fatalf("current recommendation rejected: %v", err)
	}
}
