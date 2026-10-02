package worktree

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitHubRepoURLs(t *testing.T) {
	cases := map[string]string{
		"git@github.com:Owner/Project.git":              "owner/project",
		"https://github.com/Owner/Project.git":          "owner/project",
		"https://github.com/Owner/Project/":             "owner/project",
		"ssh://git@github.com/Owner/Project.git":        "owner/project",
		"git://github.com/Owner/Project.git":            "owner/project",
		"https://GITHUB.COM/Owner/Project.git":          "owner/project",
		"https://github.com.evil.invalid/Owner/Project": "",
		"git@gitlab.com:Owner/Project.git":              "",
		"/local/path/repo.git":                          "",
		"https://github.com/Owner/Project/tree/main":    "",
		"https://github.com/Owner":                      "",
		"https://github.com/owner/project%0A":           "",
		"":                                              "",
	}
	for remote, want := range cases {
		t.Run(remote, func(t *testing.T) {
			if got := githubRepo(remote); got != want {
				t.Fatalf("githubRepo(%q) = %q; want %q", remote, got, want)
			}
		})
	}
}

func testPull(t *testing.T, head, branch, headRepo, baseRepo, base string, merged bool) githubPull {
	t.Helper()
	var mergedAt any
	if merged {
		mergedAt = "2026-01-02T12:00:00Z"
	}
	var repository any
	if headRepo != "" {
		repository = map[string]any{"full_name": headRepo}
	}
	data, err := json.Marshal(map[string]any{
		"number": 42, "html_url": "https://github.com/owner/project/pull/42", "title": "Example pull request", "state": "closed", "merged_at": mergedAt,
		"head": map[string]any{"sha": head, "ref": branch, "repo": repository},
		"base": map[string]any{"ref": base, "repo": map[string]any{"full_name": baseRepo}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var p githubPull
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMatchingPullRequiresExactCommitBranchAndRepository(t *testing.T) {
	w := Worktree{Head: strings.Repeat("a", 40), Branch: "topic"}
	repos := map[string]bool{"owner/project": true}
	if !matchingPull(testPull(t, w.Head, w.Branch, "Owner/Project", "owner/project", "main", true), &w, repos) {
		t.Fatal("exact case-insensitive repository match rejected")
	}
	cases := []struct{ name, head, branch, repo string }{
		{"stale commit", strings.Repeat("b", 40), w.Branch, "owner/project"},
		{"different branch", w.Head, "old-topic", "owner/project"},
		{"unrelated fork", w.Head, w.Branch, "stranger/project"},
		{"deleted head repository", w.Head, w.Branch, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if matchingPull(testPull(t, tc.head, tc.branch, tc.repo, "owner/project", "main", true), &w, repos) {
				t.Fatal("unrelated or stale PR accepted")
			}
		})
	}
}

func TestGitHubMergedRecommendationsRequireTrustedDefaultBase(t *testing.T) {
	cases := []struct {
		name, headRepo, baseRepo, base           string
		merged, stale, wantMerged, wantPublished bool
	}{
		{"matching merge", "owner/project", "owner/project", "main", true, false, true, true},
		{"stale head", "owner/project", "owner/project", "main", true, true, false, false},
		{"unrelated head repo", "stranger/project", "owner/project", "main", true, false, false, false},
		{"deleted head repo", "", "owner/project", "main", true, false, false, false},
		{"unrelated base repo", "owner/project", "stranger/project", "main", true, false, false, true},
		{"nondefault base", "owner/project", "owner/project", "release", true, false, false, true},
		{"closed without merge", "owner/project", "owner/project", "main", false, false, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			testWrite(t, filepath.Join(wt, "tracked.txt"), "topic commit\n")
			testGit(t, wt, "commit", "-am", "Topic work")
			testGit(t, repo, "remote", "add", "origin", "https://github.com/owner/project.git")
			w := testTree(t, testScan(t, root), wt)
			if w.Merged || w.Published {
				t.Fatal("fixture must start unmerged and unpublished")
			}
			head := w.Head
			if tc.stale {
				head = strings.Repeat("0", 40)
			}
			pull := testPull(t, head, w.Branch, tc.headRepo, tc.baseRepo, tc.base, tc.merged)
			data, err := json.Marshal([]githubPull{pull})
			if err != nil {
				t.Fatal(err)
			}
			// A fake gh executable supplies API responses; no request leaves this test.
			bin := t.TempDir()
			quotedJSON := "'" + strings.ReplaceAll(string(data), "'", "'\\''") + "'"
			script := "#!/bin/sh\ncase \"$*\" in\n  *'/pulls?per_page=100') printf '%s\\n' " + quotedJSON + ";;\n  *) printf '%s\\n' '{\"default_branch\":\"main\"}';;\nesac\n"
			if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			inspect(context.Background(), &w, Options{GitHub: true})
			if w.Merged != tc.wantMerged || w.Recommended != tc.wantMerged || w.Published != tc.wantPublished {
				t.Fatalf("GitHub classification: merged=%v recommended=%v published=%v; want merged=%v published=%v; %+v", w.Merged, w.Recommended, w.Published, tc.wantMerged, tc.wantPublished, w)
			}
		})
	}
}
