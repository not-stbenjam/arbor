package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// testRoot is a temporary folder by the name Git will call it, which on
// macOS is not the name it is handed out by.
func testRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func fileInventory(t *testing.T, path, repo string, limit int) FilesReport {
	t.Helper()
	r, err := Files(context.Background(), path, repo, limit)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func inventoryEntry(t *testing.T, r FilesReport, kind, path string) FileEntry {
	t.Helper()
	for _, e := range r.Entries {
		if e.Kind == kind && e.Path == path {
			return e
		}
	}
	t.Fatalf("missing %s %q in %+v", kind, path, r)
	return FileEntry{}
}
func TestFilesKindsSizesAndLimit(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	for _, name := range []string{"delete", "rename", "assume", "skip"} {
		testWrite(t, filepath.Join(repo, name), name)
	}
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "More files")
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "modified contents")
	testWrite(t, filepath.Join(wt, "new\nfile"), "untracked")
	testWrite(t, filepath.Join(wt, "added"), "added")
	testGit(t, wt, "add", "added")
	testGit(t, wt, "rm", "delete")
	testGit(t, wt, "mv", "rename", "renamed")
	testGit(t, wt, "update-index", "--assume-unchanged", "assume")
	testGit(t, wt, "update-index", "--skip-worktree", "skip")
	testWrite(t, filepath.Join(wt, "assume"), "secret")
	testWrite(t, filepath.Join(wt, "skip"), "hidden")
	if err := os.Mkdir(filepath.Join(wt, "ignored"), 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(wt, "ignored", "one"), "123")
	testWrite(t, filepath.Join(wt, "ignored", "two"), "45678")
	testRepo(t, filepath.Join(wt, "nested"))
	testGit(t, wt, "update-ref", "refs/worktree/held", "HEAD")
	admin := adminDirectory(filepath.Join(repo, ".git"), wt)
	testWrite(t, filepath.Join(admin, "MERGE_HEAD"), testGit(t, wt, "rev-parse", "HEAD")+"\n")
	r := fileInventory(t, wt, repo, 200)
	for name, status := range map[string]string{"tracked.txt": "modified", "new\nfile": "untracked", "added": "added", "delete": "deleted", "renamed": "renamed"} {
		if e := inventoryEntry(t, r, "changes", name); e.Status != status {
			t.Fatalf("%s: %+v", name, e)
		}
	}
	if e := inventoryEntry(t, r, "ignored", "ignored"); !e.Directory || e.SizeBytes != 8 || e.Files != 2 {
		t.Fatalf("ignored: %+v", e)
	}
	for _, name := range []string{"assume", "skip"} {
		inventoryEntry(t, r, "unchecked", name)
	}
	inventoryEntry(t, r, "nested", "nested")
	inventoryEntry(t, r, "operation", "merge")
	inventoryEntry(t, r, "refs", "refs/worktree/held")
	for i, e := range r.Entries {
		if i > 0 && r.Entries[i-1].Kind == e.Kind && r.Entries[i-1].SizeBytes < e.SizeBytes {
			t.Fatal("not largest first")
		}
	}
	limited := fileInventory(t, wt, repo, 1)
	if !limited.Truncated || !reflect.DeepEqual(r.Counts, limited.Counts) || !reflect.DeepEqual(r.Bytes, limited.Bytes) {
		t.Fatalf("limit changed totals: %+v, %+v", r, limited)
	}
	per := map[string]int{}
	for _, e := range limited.Entries {
		per[e.Kind]++
		if per[e.Kind] > 1 {
			t.Fatal("limit exceeded")
		}
	}
}
func TestFilesMissingAndSubmodules(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	sub := testRepo(t, filepath.Join(root, "sub"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testGit(t, wt, "-c", "protocol.file.allow=always", "submodule", "add", sub, "module")
	r := fileInventory(t, wt, repo, 200)
	inventoryEntry(t, r, "submodules", "module")
	admin := adminDirectory(filepath.Join(repo, ".git"), wt)
	testWrite(t, filepath.Join(admin, "REVERT_HEAD"), testGit(t, wt, "rev-parse", "HEAD"))
	testGit(t, wt, "update-ref", "refs/worktree/saved", "HEAD")
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	r = fileInventory(t, wt, repo, 200)
	if r.Counts["changes"] != 0 || r.Counts["ignored"] != 0 || r.Counts["nested"] != 0 || r.Counts["unchecked"] != 0 || r.Counts["submodules"] == 0 {
		t.Fatalf("missing: %+v", r)
	}
	inventoryEntry(t, r, "operation", "revert")
	inventoryEntry(t, r, "refs", "refs/worktree/saved")
}
func TestFilesOperationsAndConflict(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	admin := adminDirectory(filepath.Join(repo, ".git"), wt)
	for marker, name := range map[string]string{"rebase-merge": "rebase", "rebase-apply": "rebase", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert", "BISECT_LOG": "bisect", "sequencer": "revert"} {
		t.Run(marker, func(t *testing.T) {
			path := filepath.Join(admin, marker)
			if strings.HasPrefix(marker, "rebase") || marker == "sequencer" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
				if marker == "sequencer" {
					testWrite(t, filepath.Join(path, "todo"), "revert abc commit\n")
				}
			} else {
				testWrite(t, path, "x")
			}
			inventoryEntry(t, fileInventory(t, wt, repo, 200), "operation", name)
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
		})
	}
	testWrite(t, filepath.Join(wt, "tracked.txt"), "topic\n")
	testGit(t, wt, "commit", "-am", "Topic")
	testWrite(t, filepath.Join(repo, "tracked.txt"), "main\n")
	testGit(t, repo, "commit", "-am", "Main")
	cmd := exec.Command("git", "-C", wt, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "main")
	cmd.Env = commandEnv()
	if cmd.Run() == nil {
		t.Fatal("expected conflict")
	}
	if e := inventoryEntry(t, fileInventory(t, wt, repo, 200), "changes", "tracked.txt"); e.Status != "conflicted" {
		t.Fatalf("conflict: %+v", e)
	}
}
func TestFilesRefusesOtherPathsAndDoesNotFollowLinks(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	other := testRepo(t, filepath.Join(root, "other"))
	for _, target := range [][2]string{{repo, repo}, {wt, other}, {root, repo}, {filepath.Join(root, "missing"), repo}} {
		if _, err := Files(context.Background(), target[0], target[1], 200); err == nil {
			t.Fatalf("accepted %v", target)
		}
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(wt, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Files(context.Background(), link, repo, 200); err == nil {
		t.Fatal("accepted link")
	}
	if err := os.Symlink(other, filepath.Join(wt, "external")); err != nil {
		t.Fatal(err)
	}
	r := fileInventory(t, wt, repo, 200)
	if e := inventoryEntry(t, r, "changes", "external"); e.SizeBytes != 0 || e.Directory {
		t.Fatalf("followed symlink: %+v", e)
	}
}
func TestFilesSizeBudget(t *testing.T) {
	root := testRoot(t)
	testWrite(t, filepath.Join(root, "file"), "contents")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	bytes, files, dir, lower := measureFiles(ctx, root, root)
	if bytes != 0 || files != 0 || !dir || !lower {
		t.Fatalf("measurement = %d %d %v %v", bytes, files, dir, lower)
	}
}
func TestFilesRunsNoRepositoryPrograms(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	testWrite(t, filepath.Join(repo, ".gitattributes"), "tracked.txt filter=probe\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "Attributes")
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	program, ran := testFilter(t, root, "probe")
	testGit(t, repo, "config", "filter.probe.clean", program)
	testGit(t, repo, "config", "filter.probe.required", "true")
	testStale(t, filepath.Join(wt, "tracked.txt"))
	control := exec.Command("git", "-C", wt, "status", "--porcelain")
	control.Env = commandEnv()
	if err := control.Run(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(ran); err != nil {
		t.Fatal("control did not run filter:", err)
	}
	testGit(t, repo, "config", "core.fsmonitor", program)
	testGit(t, repo, "config", "diff.external", program)
	r := fileInventory(t, wt, repo, 200)
	inventoryEntry(t, r, "unchecked", "tracked.txt")
	if len(r.Warnings) != 1 {
		t.Fatalf("no filter warning: %+v", r)
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Fatal("repository program ran")
	}
}

func TestFilesNestedBareAndSubmoduleFilter(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	sub := testRepo(t, filepath.Join(root, "sub"))
	testWrite(t, filepath.Join(sub, ".gitattributes"), "tracked.txt filter=probe\n")
	testGit(t, sub, "add", ".")
	testGit(t, sub, "commit", "-m", "Attributes")
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testGit(t, wt, "-c", "protocol.file.allow=always", "submodule", "add", sub, "module")
	module := filepath.Join(wt, "module")
	program, ran := testFilter(t, root, "sub-filter")
	testGit(t, module, "config", "filter.probe.clean", program)
	testStale(t, filepath.Join(module, "tracked.txt"))
	control := exec.Command("git", "-C", module, "status", "--porcelain")
	control.Env = commandEnv()
	if err := control.Run(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(ran); err != nil {
		t.Fatal("submodule control did not run filter:", err)
	}
	testGit(t, wt, "clone", "--bare", repo, "bare.git")
	r := fileInventory(t, wt, repo, 200)
	inventoryEntry(t, r, "nested", "bare.git")
	inventoryEntry(t, r, "submodules", "module")
	for _, e := range r.Entries {
		if e.Kind == "nested" && e.Path == "module" {
			t.Fatal("submodule classified as nested")
		}
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Fatal("a submodule's filter ran")
	}
}

func TestFilesSaysWhatItCouldNotLookThrough(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "notes"), "untracked")
	sealed := filepath.Join(wt, "sealed")
	if err := os.Mkdir(sealed, 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(sealed, "inside"), "unseen")
	if err := os.Chmod(sealed, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(sealed, 0700) })
	if _, err := os.ReadDir(sealed); err == nil {
		t.Skip("this user can read any folder")
	}
	// A folder nobody can open, as a container's build output often is, is
	// said to be unread; the rest is still listed.
	r := fileInventory(t, wt, repo, 200)
	if e := inventoryEntry(t, r, "changes", "notes"); e.SizeBytes != 9 {
		t.Fatalf("%+v", e)
	}
	if len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "1 folder could not be read") {
		t.Fatalf("warnings = %q", r.Warnings)
	}

	// So is a search that runs out of time.
	budget := filesSearchBudget
	filesSearchBudget = 0
	t.Cleanup(func() { filesSearchBudget = budget })
	r = fileInventory(t, wt, repo, 200)
	inventoryEntry(t, r, "changes", "notes")
	if len(r.Warnings) != 1 || !strings.Contains(r.Warnings[0], "was not finished (it took too long)") {
		t.Fatalf("warnings = %q", r.Warnings)
	}
}

func TestFilesMeasuresAWorktreeReachedThroughALink(t *testing.T) {
	root := testRoot(t)
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0700); err != nil {
		t.Fatal(err)
	}
	testWrite(t, filepath.Join(real, "file"), "contents")
	if err := os.Symlink(real, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	// The link is how the folder is reached, not something inside it.
	via := filepath.Join(root, "link")
	if bytes, _, _, lower := measureFiles(context.Background(), via, filepath.Join(via, "file")); bytes != 8 || lower {
		t.Fatalf("measured %d, least %v", bytes, lower)
	}
	// A link inside it is not followed to what it points at.
	if err := os.Symlink(real, filepath.Join(real, "inner")); err != nil {
		t.Fatal(err)
	}
	if bytes, _, _, lower := measureFiles(context.Background(), real, filepath.Join(real, "inner", "file")); bytes != 0 || !lower {
		t.Fatalf("measured %d through a link, least %v", bytes, lower)
	}
}

func TestFilesTellsApartNamesThatAreNotText(t *testing.T) {
	root := testRoot(t)
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
	for _, name := range []string{"bad\xfe", "bad\xff"} {
		if err := os.WriteFile(filepath.Join(wt, name), []byte("x"), 0600); err != nil {
			t.Skip("this file system takes only text for names")
		}
	}
	r := fileInventory(t, wt, repo, 200)
	inventoryEntry(t, r, "changes", `bad\xFE`)
	inventoryEntry(t, r, "changes", `bad\xFF`)
	if r.Counts["changes"] != 2 {
		t.Fatalf("counts = %v", r.Counts)
	}
}
