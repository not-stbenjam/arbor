package worktree

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRestoreBranchAndDetached(t *testing.T) {
	for _, detached := range []bool{false, true} {
		t.Run(map[bool]string{false: "branch", true: "detached"}[detached], func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			target := testLinked(t, repo, filepath.Join(root, "linked"), "topic")
			head := testGit(t, repo, "rev-parse", "HEAD")
			testGit(t, repo, "worktree", "remove", target)
			o := RestoreOptions{Path: target, CommonDir: filepath.Join(repo, ".git"), Branch: "topic", Head: head}
			if detached {
				o.Branch = ""
				o.Detach = head
			}
			r, err := Restore(context.Background(), o)
			if err != nil || !r.Restored || r.Moved || r.Head != head {
				t.Fatalf("%+v %v", r, err)
			}
			if _, err := os.Stat(filepath.Join(target, "tracked.txt")); err != nil {
				t.Fatal(err)
			}
			if got := testGit(t, target, "status", "--porcelain"); got != "" {
				t.Fatalf("restored files differ: %s", got)
			}
			listed := testGit(t, repo, "worktree", "list", "--porcelain")
			if !strings.Contains(listed, target) {
				t.Fatal(listed)
			}
			if detached && !strings.Contains(listed, "detached") {
				t.Fatal(listed)
			}
		})
	}
}
func TestRestoreRefusals(t *testing.T) {
	for _, kind := range []string{"file", "folder", "link", "dangling link", "parent", "branch", "checked out", "repository", "commit"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			testGit(t, repo, "branch", "topic")
			target := filepath.Join(root, "restored")
			o := RestoreOptions{Path: target, CommonDir: filepath.Join(repo, ".git"), Branch: "topic"}
			switch kind {
			case "file":
				testWrite(t, target, "keep me")
			case "folder":
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			case "link", "dangling link":
				dest := repo
				if kind == "dangling link" {
					dest = filepath.Join(root, "absent")
				}
				if err := os.Symlink(dest, target); err != nil {
					t.Fatal(err)
				}
			case "parent":
				o.Path = filepath.Join(root, "absent", "restored")
			case "branch":
				o.Branch = "absent"
			case "checked out":
				testGit(t, repo, "worktree", "add", filepath.Join(root, "other"), "topic")
			case "repository":
				o.CommonDir = root
			case "commit":
				o.Branch = ""
				o.Detach = strings.Repeat("0", 40)
			}
			r, err := Restore(context.Background(), o)
			if err == nil || r.Restored || r.Error == "" {
				t.Fatalf("%+v %v", r, err)
			}
			if kind == "file" {
				data, _ := os.ReadFile(target)
				if string(data) != "keep me" {
					t.Fatal("file changed")
				}
			}
			if kind == "folder" {
				info, err := os.Stat(target)
				if err != nil || !info.IsDir() {
					t.Fatal("folder changed")
				}
			}
			if strings.Contains(kind, "link") {
				if _, err := os.Readlink(target); err != nil {
					t.Fatal("link changed")
				}
			}
		})
	}
}
func TestRestoreReportsMovedBranch(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	head := testGit(t, repo, "rev-parse", "HEAD")
	testGit(t, repo, "commit", "--allow-empty", "-m", "later")
	testGit(t, repo, "branch", "topic")
	r, err := Restore(context.Background(), RestoreOptions{Path: filepath.Join(root, "restored"), CommonDir: repo, Branch: "topic", Head: head})
	if err != nil || !r.Restored || !r.Moved || r.Head == head {
		t.Fatalf("%+v %v", r, err)
	}
}
func TestRestoreRunsNoHooksOrRepositoryFilters(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testGit(t, repo, "branch", "topic")
	hook, hookRan := testFilter(t, root, "post-checkout")
	testGit(t, repo, "config", "core.hooksPath", filepath.Dir(hook))
	r, err := Restore(context.Background(), RestoreOptions{Path: filepath.Join(root, "restored"), CommonDir: repo, Branch: "topic"})
	if err != nil || !r.Restored {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := os.Stat(hookRan); !os.IsNotExist(err) {
		t.Fatal("hook ran")
	}
	// Prove the configured hook runs for Git itself.
	testGit(t, repo, "-c", "core.hooksPath="+filepath.Dir(hook), "worktree", "add", "--detach", filepath.Join(root, "control"), "HEAD")
	if _, err := os.Stat(hookRan); err != nil {
		t.Fatal("hook control did not run", err)
	}
	testWrite(t, filepath.Join(repo, ".gitattributes"), "tracked.txt filter=probe\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "attributes")
	testGit(t, repo, "branch", "filtered")
	program, ran := testFilter(t, root, "filter")
	testGit(t, repo, "config", "filter.probe.smudge", program)
	target := filepath.Join(root, "filter target")
	r, err = Restore(context.Background(), RestoreOptions{Path: target, CommonDir: repo, Branch: "filtered"})
	if err == nil || r.Restored || !strings.Contains(r.Error, "git -C '"+repo+"' worktree add -- '"+target+"' 'filtered'") {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Fatal("refusal created a folder")
	}
	if _, err := os.Stat(ran); !os.IsNotExist(err) {
		t.Fatal("filter ran")
	}
	testGit(t, repo, "worktree", "add", target, "filtered")
	if _, err := os.Stat(ran); err != nil {
		t.Fatal("filter control did not run", err)
	}
}
func TestRestoreLeavesPartialCheckout(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	// A global filter is permitted but can fail. Registration and files already
	// written must survive that failure, unlike worktree add's normal rollback.
	testWrite(t, filepath.Join(repo, ".gitattributes"), "z.txt filter=fail\n")
	testWrite(t, filepath.Join(repo, "z.txt"), "z\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "filter attribute")
	testGit(t, repo, "branch", "topic")
	global := filepath.Join(root, "global")
	testWrite(t, global, "[filter \"fail\"]\n smudge = false\n required = true\n")
	// commandEnv deliberately clears GIT_CONFIG_GLOBAL: HOME is the user's config.
	home := filepath.Join(root, "home")
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(global)
	testWrite(t, filepath.Join(home, ".gitconfig"), string(data))
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	target := filepath.Join(root, "restored")
	r, err := Restore(context.Background(), RestoreOptions{Path: target, CommonDir: repo, Branch: "topic"})
	if err == nil || r.Restored || !strings.Contains(r.Error, "left it in place") {
		t.Fatalf("%+v %v", r, err)
	}
	for _, name := range []string{".git", "tracked.txt"} {
		if _, err := os.Stat(filepath.Join(target, name)); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(testGit(t, repo, "worktree", "list"), target) {
		t.Fatal("registration removed")
	}
}

func TestRestoreAllowsStandardLFS(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testWrite(t, filepath.Join(repo, ".gitattributes"), "tracked.txt filter=lfs\n")
	testGit(t, repo, "add", ".")
	testGit(t, repo, "commit", "-m", "LFS attribute")
	testGit(t, repo, "branch", "topic")
	tools := filepath.Join(root, "tools")
	if err := os.Mkdir(tools, 0700); err != nil {
		t.Fatal(err)
	}
	_, ran := testFilter(t, tools, "git-lfs")
	t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
	testGit(t, repo, "config", "filter.lfs.smudge", "git-lfs smudge -- %f")
	r, err := Restore(context.Background(), RestoreOptions{Path: filepath.Join(root, "restored"), CommonDir: repo, Branch: "topic"})
	if err != nil || !r.Restored {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := os.Stat(ran); err != nil {
		t.Fatal("standard LFS was not allowed", err)
	}
}
