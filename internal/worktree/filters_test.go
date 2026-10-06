package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
	// The files do differ here, and are seen to. Whether or not they were,
	// what a filter rewrites could not be checked, so this is no clean delete.
	w := testTree(t, report, linked)
	if !w.Dirty || w.ChangedFiles != 2 || w.Recommended || w.CanRemove || !w.CanDiscard || len(w.Problems) != 0 {
		t.Fatalf("the worktree: dirty=%v changed=%d recommended=%v canRemove=%v problems=%v", w.Dirty, w.ChangedFiles, w.Recommended, w.CanRemove, w.Problems)
	}
	assertProtected(t, w, "its repository names a filter program Arbor does not run")
	if !slices.Contains(w.Losses, "unchecked") {
		t.Fatalf("losses = %v", w.Losses)
	}
	said := strings.Join(report.Warnings, "\n")
	if !strings.Contains(said, "Arbor does not run the filter programs") || !strings.Contains(said, "(a=b, probe)") || !strings.Contains(said, "cannot tell whether files they rewrite have changed") {
		t.Fatalf("the scan did not say which filters it left off: %q", said)
	}

	// It is not deleted as a clean one, and deleting it runs none either.
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head}); err == nil {
		t.Fatal("deleted without being told to discard what could not be checked")
	}
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

// With its filter off, a file is compared as it lies. One edited to hold
// exactly what the filter would have stored then looks unchanged, though
// Git with the filter on calls it modified. Such a worktree is never a
// clean delete.
func TestAFileAFilterWouldRewriteIsNeverVouchedFor(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testGit(t, repo, "config", "filter.rot.clean", "tr A-Za-z N-ZA-Mn-za-m")
	testGit(t, repo, "config", "filter.rot.smudge", "tr A-Za-z N-ZA-Mn-za-m")
	testWrite(t, filepath.Join(repo, ".gitattributes"), "message filter=rot\n")
	testWrite(t, filepath.Join(repo, "message"), "secret\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "A message")
	linked := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	// What is stored is "frperg". Written out plainly, it is a change.
	testWrite(t, filepath.Join(linked, "message"), "frperg\n")
	if status := testGit(t, linked, "status", "--porcelain"); !strings.Contains(status, "message") {
		t.Fatalf("the fixture is not a change to Git: %q", status)
	}
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	w := testTree(t, report, linked)
	if w.Recommended || w.CanRemove {
		t.Fatalf("a worktree with a change its filter hides counts as clean: %+v", w)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("removed as a recommendation")
	}
	if data, _ := os.ReadFile(filepath.Join(linked, "message")); string(data) != "frperg\n" {
		t.Fatal("the changed file is gone")
	}
}

// "git lfs" is found through Git, where a repository can make "lfs" mean
// anything. Only the program named outright is taken for Git LFS. And a
// worktree can have settings of its own, which are read for each.
func TestOnlyGitLFSNamedOutrightIsRun(t *testing.T) {
	root := t.TempDir()
	tools := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testWrite(t, filepath.Join(repo, ".gitattributes"), "tracked.txt filter=lfs\nother.txt filter=own\n")
	testWrite(t, filepath.Join(repo, "other.txt"), "other\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "Attributes")
	first := testLinked(t, repo, filepath.Join(root, "first"), "first")
	second := testLinked(t, repo, filepath.Join(root, "second"), "second")
	_, aliasRan := testFilter(t, tools, "alias")
	testGit(t, repo, "config", "filter.lfs.clean", "git lfs clean -- %f")
	testGit(t, repo, "config", "alias.lfs", "!echo ran >> '"+aliasRan+"'; cat")
	// A filter set for the second worktree alone.
	own, ownRan := testFilter(t, tools, "own")
	testGit(t, repo, "config", "extensions.worktreeConfig", "true")
	testGit(t, second, "config", "--worktree", "filter.own.clean", own)
	for _, linked := range []string{first, second} {
		testStale(t, filepath.Join(linked, "tracked.txt"))
		testStale(t, filepath.Join(linked, "other.txt"))
	}
	report, err := Scan(context.Background(), Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	for name, ran := range map[string]string{"the repository's \"lfs\"": aliasRan, "the second worktree's own filter": ownRan} {
		if _, err := os.Stat(ran); err == nil {
			t.Errorf("%s was run", name)
		}
	}
	for _, linked := range []string{first, second} {
		if w := testTree(t, report, linked); w.CanRemove || w.Recommended {
			t.Errorf("%s counts as a clean delete", filepath.Base(linked))
		}
	}
}

// Two looks at one worktree can overlap. The first to finish must not take
// the other's protection with it.
func TestFiltersStayOffUntilTheLastInspectionEnds(t *testing.T) {
	first := holdFilters("/work/topic", []string{"GIT_CONFIG_COUNT=1"})
	second := holdFilters("/work/topic", []string{"GIT_CONFIG_COUNT=1"})
	second()
	if heldFor("/work/topic") == nil {
		t.Fatal("one inspection ending let go of what another still held")
	}
	first()
	if heldFor("/work/topic") != nil {
		t.Fatal("nothing let go of it once both had ended")
	}
}
