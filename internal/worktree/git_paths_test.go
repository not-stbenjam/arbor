package worktree

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestBatchedGitPathsPreserveSharedAndWorktreeRouting(t *testing.T) {
	for _, suffix := range []string{"ordinary", "with\nnewline"} {
		root := t.TempDir()
		repo := testRepo(t, filepath.Join(root, suffix))
		linked := testLinked(t, repo, filepath.Join(root, suffix+"-linked"), "feature")
		for _, path := range []string{repo, linked} {
			names := []string{"HEAD", "index", "logs/HEAD", "rebase-merge", "MERGE_HEAD", "objects", "refs/heads/main"}
			paths, err := gitPaths(context.Background(), path, names)
			if err != nil || len(paths) != len(names) {
				t.Fatalf("batched paths: %v %v", paths, err)
			}
			for i, name := range names {
				want, err := git(context.Background(), path, "rev-parse", "--path-format=absolute", "--git-path", name)
				if err != nil || paths[i] != strings.TrimSuffix(want, "\n") {
					t.Fatalf("%q metadata %q = %q, want %q (%v)", path, name, paths[i], want, err)
				}
			}
		}
	}
}
