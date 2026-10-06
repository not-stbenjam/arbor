package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testFilter makes a program that records that it ran and passes its input
// through, as a filter must.
func testFilter(t *testing.T, dir, name string) (program, ran string) {
	t.Helper()
	ran = filepath.Join(dir, name+"-ran")
	program = filepath.Join(dir, name)
	testWrite(t, program, "#!/bin/sh\necho ran >> '"+ran+"'\ncat\n")
	if err := os.Chmod(program, 0700); err != nil {
		t.Fatal(err)
	}
	return program, ran
}

// testStale changes a tracked file without changing its size, and dates it
// apart from Git's record, so that Git has to read it to compare it.
func testStale(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	testWrite(t, path, strings.Repeat("x", len(data)))
	when := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatal(err)
	}
}

func TestARepositorysOwnFilterProgramsAreNotRun(t *testing.T) {
	root := t.TempDir()
	tools := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testWrite(t, filepath.Join(repo, ".gitattributes"), "tracked.txt filter=probe\nother.txt filter=a=b\n")
	testWrite(t, filepath.Join(repo, "other.txt"), "other\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "Attributes")
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	program, ran := testFilter(t, tools, "probe")
	for _, key := range []string{"filter.probe.clean", "filter.probe.smudge", "filter.probe.process", "filter.a=b.clean"} {
		testGit(t, repo, "config", key, program)
	}
	testGit(t, repo, "config", "filter.probe.required", "true")
	testStale(t, filepath.Join(linked, "tracked.txt"))
	testStale(t, filepath.Join(linked, "other.txt"))
	// Git by itself does run it here, or this test would prove nothing.
	// (It then fails, since this stand-in is no real filter. That it was
	// started is the point.)
	control := exec.Command("git", "-C", linked, "status", "--porcelain")
	control.Env = append(commandEnv(), "GIT_CONFIG_GLOBAL=/dev/null")
	_ = control.Run()
	if _, err := os.Stat(ran); err != nil {
		t.Fatal("the fixture does not make Git run the filter")
	}
	if err := os.Remove(ran); err != nil {
		t.Fatal(err)
	}

	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("looking at a worktree ran a filter program its repository names")
	}
	// The files do differ here, and are seen to: nothing was passed over.
	w := testTree(t, report, linked)
	if !w.Dirty || w.ChangedFiles != 2 || w.Recommended || len(w.Problems) != 0 {
		t.Fatalf("the worktree: dirty=%v changed=%d recommended=%v problems=%v", w.Dirty, w.ChangedFiles, w.Recommended, w.Problems)
	}
	said := strings.Join(report.Warnings, "\n")
	if !strings.Contains(said, "Arbor does not run the filter programs") || !strings.Contains(said, "(a=b, probe)") {
		t.Fatalf("the scan did not say which filters it left off: %q", said)
	}

	// Git looks again itself when it deletes, and runs none then either.
	if result, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, DiscardLocal: true, Acknowledged: w.Losses}); err != nil || !result.Removed {
		t.Fatalf("removal: %+v, %v", result, err)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("deleting a worktree ran a filter program its repository names")
	}
}

// Git LFS, named the way `git lfs install` names it, is the person's own
// installed program and is run as Git would run it. So is any filter of
// their own Git configuration, outside the repository.
func TestGitLFSAndThePersonsOwnFiltersStillRun(t *testing.T) {
	root := t.TempDir()
	tools := t.TempDir()
	home := t.TempDir()
	lfs, lfsRan := testFilter(t, tools, "git-lfs")
	_ = lfs
	own, ownRan := testFilter(t, tools, "own")
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	testWrite(t, filepath.Join(home, ".gitconfig"), "[filter \"own\"]\n\tclean = "+own+"\n")
	repo := testRepo(t, filepath.Join(root, "repo"))
	testWrite(t, filepath.Join(repo, ".gitattributes"), "tracked.txt filter=lfs\nother.txt filter=own\n")
	testWrite(t, filepath.Join(repo, "other.txt"), "other\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "Attributes")
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testGit(t, repo, "config", "filter.lfs.clean", "git-lfs clean -- %f")
	testGit(t, repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f")
	testGit(t, repo, "config", "filter.lfs.process", "git-lfs filter-process")
	testStale(t, filepath.Join(linked, "tracked.txt"))
	testStale(t, filepath.Join(linked, "other.txt"))
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	for name, ran := range map[string]string{"Git LFS": lfsRan, "the person's own filter": ownRan} {
		if _, err := os.Stat(ran); err != nil {
			t.Errorf("%s was not run", name)
		}
	}
	if said := strings.Join(report.Warnings, "\n"); strings.Contains(said, "filter programs") {
		t.Fatalf("a warning about filters that were run: %q", said)
	}
}
