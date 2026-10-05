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

// A pull request merged into a fork's own default branch has not landed where
// the project's default branch lives. Only the repository the default ref was
// read from can say that work is finished.
func TestGitHubMergeIntoAForkIsNotMergeEvidence(t *testing.T) {
	cases := []struct {
		name, baseRepo string
		upstreamRef    bool
		// originLikeAClone gives the fork the tracking refs a clone of it has.
		originLikeAClone bool
		upstreamURL      string
		wantMerged       bool
	}{
		{"merged upstream, tracked", "owner/project", true, false, "", true},
		{"merged into the fork, upstream tracked", "me/project", true, false, "", false},
		{"merged upstream, no tracking ref yet", "owner/project", false, false, "", true},
		{"merged into the fork, no tracking ref yet", "me/project", false, false, "", false},
		// An upstream that was added and never fetched still decides. The
		// fork's own default branch is not a stand-in for it.
		{"merged into a cloned fork, upstream never fetched", "me/project", false, true, "", false},
		{"merged upstream, cloned fork, upstream never fetched", "owner/project", false, true, "", true},
		{"merged into the fork, upstream is not on GitHub", "me/project", false, false, "https://git.example.invalid/owner/project.git", false},
		{"merged into a cloned fork, upstream is not on GitHub", "me/project", true, true, "https://git.example.invalid/owner/project.git", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			initial := testGit(t, repo, "rev-parse", "HEAD")
			wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			testWrite(t, filepath.Join(wt, "tracked.txt"), "topic commit\n")
			testGit(t, wt, "commit", "-am", "Topic work")
			testGit(t, repo, "remote", "add", "origin", "https://github.com/me/project.git")
			upstream := "https://github.com/owner/project.git"
			if tc.upstreamURL != "" {
				upstream = tc.upstreamURL
			}
			testGit(t, repo, "remote", "add", "upstream", upstream)
			if tc.upstreamRef {
				// The project's default branch does not contain the topic commit.
				testGit(t, repo, "update-ref", "refs/remotes/upstream/main", initial)
			}
			if tc.originLikeAClone {
				testGit(t, repo, "update-ref", "refs/remotes/origin/main", initial)
				testGit(t, repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
			}
			report, err := Scan(context.Background(), Options{Root: root})
			if err != nil {
				t.Fatal(err)
			}
			w := testTree(t, report, wt)
			if w.Merged {
				t.Fatalf("fixture must start unmerged: %+v", w)
			}
			if !tc.upstreamRef && (w.DefaultRef != "" || len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "upstream has not been fetched")) {
				t.Fatalf("an unfetched upstream yielded to %q without saying so: %v", w.DefaultRef, report.Warnings)
			}
			data, err := json.Marshal([]githubPull{testPull(t, w.Head, w.Branch, "me/project", tc.baseRepo, "main", true)})
			if err != nil {
				t.Fatal(err)
			}
			bin := t.TempDir()
			quotedJSON := "'" + strings.ReplaceAll(string(data), "'", "'\\''") + "'"
			script := "#!/bin/sh\ncase \"$*\" in\n  *'/pulls?per_page=100') printf '%s\\n' " + quotedJSON + ";;\n  *) printf '%s\\n' '{\"default_branch\":\"main\"}';;\nesac\n"
			if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			inspect(context.Background(), &w, Options{GitHub: true})
			if w.Merged != tc.wantMerged || w.Recommended != tc.wantMerged {
				t.Fatalf("merged=%v recommended=%v, want %v; default ref %q, reason %q", w.Merged, w.Recommended, tc.wantMerged, w.DefaultRef, w.MergeReason)
			}
			if w.PR == nil || !w.PR.Merged {
				t.Fatalf("the pull request itself should still be reported: %+v", w.PR)
			}
		})
	}
}

func TestMergeDestinationIsTheDecidingRemote(t *testing.T) {
	for _, tc := range []struct {
		name, deciding string
		slugs          map[string]string
		ordered        []string
		want           string
	}{
		{"a fork's upstream decides", "upstream", map[string]string{"origin": "me/project", "upstream": "owner/project", "mirror": ""}, []string{"me/project", "owner/project"}, "owner/project"},
		{"origin decides without an upstream", "origin", map[string]string{"origin": "me/project", "mirror": "other/project"}, []string{"me/project", "other/project"}, "me/project"},
		// A deciding remote that is not on GitHub leaves no GitHub repository
		// entitled to declare the work merged, least of all the fork.
		{"an upstream that is not on GitHub", "upstream", map[string]string{"upstream": "", "origin": "me/project"}, []string{"me/project"}, ""},
		{"an origin that is not on GitHub", "origin", map[string]string{"origin": "", "github": "me/project"}, []string{"me/project"}, ""},
		{"an upstream known only by branches left behind", "upstream", map[string]string{"origin": "me/project"}, []string{"me/project"}, ""},
		{"a single GitHub remote under another name", "", map[string]string{"company": "owner/project"}, []string{"owner/project"}, "owner/project"},
		{"an ambiguous destination is not guessed", "", map[string]string{"a": "one/project", "b": "two/project"}, []string{"one/project", "two/project"}, ""},
	} {
		if got := mergeDestination(tc.deciding, tc.slugs, tc.ordered); got != tc.want {
			t.Errorf("%s: mergeDestination = %q, want %q", tc.name, got, tc.want)
		}
	}
}
