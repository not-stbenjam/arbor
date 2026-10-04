package worktree

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func benchmarkGit(b *testing.B, repo string, args ...string) {
	b.Helper()
	cmd := exec.Command("git", append([]string{"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", repo}, args...)...)
	cmd.Env = append(commandEnv(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_AUTHOR_NAME=Arbor Benchmark", "GIT_AUTHOR_EMAIL=benchmark@example.invalid", "GIT_COMMITTER_NAME=Arbor Benchmark", "GIT_COMMITTER_EMAIL=benchmark@example.invalid")
	if out, err := cmd.CombinedOutput(); err != nil {
		b.Fatalf("git %v: %v: %s", args, err, out)
	}
}

func benchmarkFiles(b *testing.B, root string, directories, files int) {
	b.Helper()
	for directory := 0; directory < directories; directory++ {
		path := filepath.Join(root, fmt.Sprintf("directory-%05d", directory))
		if err := os.MkdirAll(path, 0700); err != nil {
			b.Fatal(err)
		}
		for file := 0; file < files; file++ {
			if err := os.WriteFile(filepath.Join(path, fmt.Sprintf("file-%04d", file)), []byte("fixture\n"), 0600); err != nil {
				b.Fatal(err)
			}
		}
	}
}

func BenchmarkDiscoverManyDirectories(b *testing.B) {
	root := b.TempDir()
	benchmarkFiles(b, root, 2000, 4)
	excluded, err := compileExcludes(root, []string{})
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for range b.N {
		if _, _, err := discover(context.Background(), root, excluded, nil); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkScanManyWorktrees(b *testing.B) {
	root := b.TempDir()
	repo := filepath.Join(root, "repo")
	benchmarkFiles(b, repo, 10, 10)
	benchmarkGit(b, repo, "init", "-b", "main")
	benchmarkGit(b, repo, "add", ".")
	benchmarkGit(b, repo, "commit", "-m", "Fixture")
	for i := 0; i < 12; i++ {
		name := fmt.Sprintf("feature-%02d", i)
		benchmarkGit(b, repo, "worktree", "add", "-b", name, filepath.Join(root, name))
	}
	b.ResetTimer()
	for range b.N {
		if report, err := Scan(context.Background(), Options{Root: root}); err != nil || len(report.Worktrees) != 13 {
			b.Fatalf("scan: %d worktrees, %v", len(report.Worktrees), err)
		}
	}
}

func BenchmarkScanOrdinaryRepository(b *testing.B) {
	root := b.TempDir()
	repo := filepath.Join(root, "repo")
	benchmarkFiles(b, repo, 1000, 10)
	benchmarkGit(b, repo, "init", "-b", "main")
	benchmarkGit(b, repo, "add", ".")
	benchmarkGit(b, repo, "commit", "-m", "Fixture")
	for _, linkedOnly := range []bool{false, true} {
		name, want := "all-checkouts", 1
		if linkedOnly {
			name, want = "linked-only", 0
		}
		b.Run(name, func(b *testing.B) {
			for range b.N {
				if report, err := Scan(context.Background(), Options{Root: root, LinkedOnly: linkedOnly}); err != nil || len(report.Worktrees) != want {
					b.Fatalf("scan: %d worktrees, %v", len(report.Worktrees), err)
				}
			}
		})
	}
}
