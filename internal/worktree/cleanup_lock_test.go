package worktree

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCleanupLockHelperProcess(t *testing.T) {
	common := os.Getenv("ARBOR_FIXTURE_LOCK_DIRECTORY")
	if common == "" {
		return
	}
	lock, err := acquireCleanupLock(common)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	fmt.Println("LOCKED")
	// The helper never reaches a mutation: it holds ownership until the parent
	// closes stdin or kills it. All paths are isolated test repositories.
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestCleanupLockLiveOwnerBlocksRemovalAndKernelReleasesAfterKill(t *testing.T) {
	root := canonicalFixtureDir(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	checkout := testLinked(t, repo, filepath.Join(root, "session"), "session")
	w := testTree(t, testScan(t, root), checkout)
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "-test.run=^TestCleanupLockHelperProcess$")
	cmd.Env = append(os.Environ(), "ARBOR_FIXTURE_LOCK_DIRECTORY="+w.CommonDir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	finished := false
	t.Cleanup(func() {
		if !finished {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); ready <- line }()
	select {
	case line := <-ready:
		if line != "LOCKED\n" {
			t.Fatalf("helper did not acquire lock: %q", line)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not acquire lock before deadline")
	}
	if lock, err := acquireCleanupLock(w.CommonDir); err == nil {
		lock.Close()
		t.Fatal("second process acquired live cleanup lock")
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true}); err == nil || !strings.Contains(err.Error(), "another cleanup") {
		t.Fatalf("live lock did not stop cleanup before mutation: %v", err)
	}
	if _, err := os.Stat(filepath.Join(checkout, "tracked.txt")); err != nil {
		t.Fatal("blocked cleanup changed checkout:", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	finished = true
	lock, err := acquireCleanupLock(w.CommonDir)
	if err != nil {
		t.Fatalf("crashed owner left a permanent cleanup lock: %v", err)
	}
	lock.Close()
	if _, err := os.Stat(filepath.Join(w.CommonDir, "arbor-cleanup.flock")); err != nil {
		t.Fatal("advisory lock inode must remain persistent:", err)
	}
	if got := testGit(t, checkout, "rev-parse", "HEAD"); got != w.Head {
		t.Fatal("lock-only helper changed Git data")
	}
	if _, err := os.Stat(filepath.Join(checkout, "tracked.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupLockReleasedNormallyCanBeReacquired(t *testing.T) {
	common := canonicalFixtureDir(t)
	first, err := acquireCleanupLock(common)
	if err != nil {
		t.Fatal(err)
	}
	original, err := first.Stat()
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, err := acquireCleanupLock(common)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	current, err := second.Stat()
	if err != nil || !os.SameFile(original, current) {
		t.Fatalf("lock inode changed: %v", err)
	}
}

func TestCleanupLockNeverDeletesLegacyOrFollowsSymlinks(t *testing.T) {
	for _, kind := range []string{"legacy", "symlink", "directory"} {
		t.Run(kind, func(t *testing.T) {
			common := canonicalFixtureDir(t)
			filename := filepath.Join(common, "arbor-cleanup.flock")
			switch kind {
			case "legacy":
				filename = filepath.Join(common, "arbor-cleanup.lock")
				testWrite(t, filename, "")
			case "symlink":
				target := filepath.Join(canonicalFixtureDir(t), "preserve")
				testWrite(t, target, "untouched")
				if err := os.Symlink(target, filename); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(filename, 0700); err != nil {
					t.Fatal(err)
				}
			}
			lock, err := acquireCleanupLock(common)
			if err == nil {
				lock.Close()
				t.Fatal("ambiguous existing lock accepted")
			}
			if kind == "legacy" && (!strings.Contains(err.Error(), "close older Arbor") || !strings.Contains(err.Error(), filename)) {
				t.Fatalf("legacy recovery not actionable: %v", err)
			}
			if _, err := os.Lstat(filename); err != nil {
				t.Fatalf("existing lock path was altered: %v", err)
			}
			if kind == "symlink" {
				if data, err := os.ReadFile(filename); err != nil || string(data) != "untouched" {
					t.Fatalf("symlink target changed: %q %v", data, err)
				}
			}
		})
	}
}
