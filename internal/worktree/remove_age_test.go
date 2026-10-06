package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRemovalRechecksActivity(t *testing.T) {
	for _, touched := range []bool{false, true} {
		root := t.TempDir()
		repo := testRepo(t, filepath.Join(root, "repo"))
		target := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
		w := testTree(t, testScan(t, root), target)
		cutoff := time.Now()
		if touched {
			// Touching a tracked file preserves HEAD and a clean Git status.
			later := cutoff.Add(time.Hour)
			if err := os.Chtimes(filepath.Join(target, "tracked.txt"), later, later); err != nil {
				t.Fatal(err)
			}
		}
		result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, NotActiveSince: cutoff})
		if touched {
			if err == nil || !strings.Contains(err.Error(), "used since it was listed") || result.Removed {
				t.Fatalf("%+v %v", result, err)
			}
			if _, err := os.Stat(target); err != nil {
				t.Fatal(err)
			}
		} else if err != nil || !result.Removed {
			t.Fatalf("%+v %v", result, err)
		}
	}
}
