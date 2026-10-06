package worktree

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// RestoreOptions says which deleted worktree to put back: where it was, the
// repository it belonged to, and either the branch it was on or the commit a
// detached one was at. Head is the commit it was at when it was deleted, and
// is only compared with where the branch is now.
type RestoreOptions struct{ Path, CommonDir, Branch, Detach, Head string }

// RestoreResult is what came of it. Moved says the branch is not where it
// was when the worktree was deleted; it is put back as the branch is now.
type RestoreResult struct {
	Path     string `json:"path"`
	Branch   string `json:"branch"`
	Head     string `json:"head"`
	Restored bool   `json:"restored"`
	Moved    bool   `json:"moved"`
	Error    string `json:"error"`
}

var commitID = regexp.MustCompile(`^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$`)

// ValidateRestore reports what is wrong with the request itself, before
// anything is looked at on disk.
func ValidateRestore(o RestoreOptions) error {
	if o.Path == "" || o.CommonDir == "" {
		return errors.New("PATH and --repo are required")
	}
	if (o.Branch == "") == (o.Detach == "") {
		return errors.New("choose exactly one of --branch or --detach")
	}
	if o.Detach != "" && !commitID.MatchString(o.Detach) {
		return errors.New("--detach requires a full commit ID")
	}
	if o.Head != "" && !commitID.MatchString(o.Head) {
		return errors.New("--head requires a full commit ID")
	}
	return nil
}

// Restore puts a deleted worktree back with `git worktree add`. It creates
// and never deletes or overwrites: anything at all at the path is a refusal,
// and a checkout that fails part-way is left as far as it got, and said to
// be. Hooks are off, and a repository whose own filter programs would write
// the files out is refused with the command to run by hand.
func Restore(ctx context.Context, o RestoreOptions) (result RestoreResult, err error) {
	result.Path, result.Branch = o.Path, o.Branch
	defer func() {
		if err != nil {
			result.Error = err.Error()
		}
	}()
	if err = ValidateRestore(o); err != nil {
		return
	}
	target, err := filepath.Abs(o.Path)
	if err != nil {
		return result, err
	}
	if _, err = os.Lstat(target); err == nil {
		return result, fmt.Errorf("nothing restored: something already exists at %s", target)
	} else if !os.IsNotExist(err) {
		return result, err
	}
	parent, err := os.Stat(filepath.Dir(target))
	if err != nil {
		return result, fmt.Errorf("parent folder must exist: %w", err)
	}
	if !parent.IsDir() {
		return result, errors.New("parent must be a folder")
	}
	if _, err = git(ctx, o.CommonDir, "rev-parse", "--git-common-dir"); err != nil {
		return result, fmt.Errorf("not a repository: %w", err)
	}
	args := []string{"worktree", "add"}
	revision := o.Branch
	if o.Detach != "" {
		args = append(args, "--detach")
		revision = o.Detach
	} else {
		if _, err = git(ctx, o.CommonDir, "check-ref-format", "refs/heads/"+o.Branch); err != nil {
			return result, errors.New("invalid branch name")
		}
		revision = "refs/heads/" + o.Branch
	}
	head, err := git(ctx, o.CommonDir, "rev-parse", "--verify", "--end-of-options", revision+"^{commit}")
	if err != nil {
		return result, fmt.Errorf("branch or commit does not exist: %w", err)
	}
	result.Head = strings.TrimSpace(head)
	if o.Branch != "" {
		listed, e := git(ctx, o.CommonDir, "worktree", "list", "--porcelain", "-z")
		if e != nil {
			return result, e
		}
		for _, w := range parseList(listed) {
			if w.Branch == o.Branch {
				return result, fmt.Errorf("branch %s is already checked out at %s", o.Branch, w.Path)
			}
		}
	}
	byHand := strings.Join(append(append([]string{"git", "-C", ShellArgument(o.CommonDir)}, args...), "--", ShellArgument(target), ShellArgument(o.Branch+o.Detach)), " ")
	if _, names := repositoryFilters(ctx, o.CommonDir); len(names) > 0 {
		return result, fmt.Errorf("repository filter programs would run (%s). Run this yourself: %s", strings.Join(names, ", "), byHand)
	}
	// A partial clone fetches the contents of files when a checkout asks for
	// them, from wherever and by whatever means its configuration says.
	// Arbor does not fetch. What was checked out before is usually all there
	// still; when it is not, that is found out before anything is created.
	if partialClone(ctx, o.CommonDir) {
		listed, e := gitCompare(ctx, o.CommonDir, nil, "rev-list", "--objects", "--missing=print", "--no-walk", result.Head)
		if e != nil || strings.HasPrefix(listed, "?") || strings.Contains(listed, "\n?") {
			return result, fmt.Errorf("some of its files have not been fetched from the remote this repository takes them from, and Arbor does not fetch. Run this yourself: %s", byHand)
		}
	}
	// Separate registration from writing files: Git otherwise removes a partly
	// written checkout when a checkout fails. checkout-index refuses overwrites.
	args = append(args, "--no-checkout", "--", target, o.Branch+o.Detach)
	err = gitWriting(ctx, o.CommonDir, args...)
	// Git checks a branch out by its short name, and one it would let nobody
	// create, such as a name that begins with a dash, it takes for a commit:
	// the worktree is then on no branch. It is put on the one asked for.
	if err == nil && o.Branch != "" && gitText(ctx, target, "symbolic-ref", "-q", "HEAD") != "refs/heads/"+o.Branch {
		err = gitWriting(ctx, target, "symbolic-ref", "HEAD", "refs/heads/"+o.Branch)
	}
	if err == nil {
		// Configuration can be taken in for one branch or one folder only, so
		// what the repository names is asked again from where the files are to
		// be written, now that there is such a place and it is on its branch.
		if _, names := repositoryFilters(ctx, target); len(names) > 0 {
			return result, fmt.Errorf("its files were not written: repository filter programs would run there (%s). The worktree is registered at %s with no files in it. Write them yourself: git -C %s reset --hard", strings.Join(names, ", "), target, ShellArgument(target))
		}
		if err = gitWriting(ctx, target, "read-tree", "HEAD"); err == nil {
			err = gitWriting(ctx, target, "checkout-index", "--all")
		}
	}
	if err != nil {
		if info, statErr := os.Lstat(target); statErr == nil {
			return result, fmt.Errorf("restore failed: %w; %s remains at %s; Arbor left it in place", err, restorePathKind(info), target)
		}
		return result, fmt.Errorf("restore failed: %w; no checkout exists at %s", err, target)
	}
	result.Head = gitText(ctx, target, "rev-parse", "HEAD")
	result.Restored = true
	result.Moved = o.Branch != "" && o.Head != "" && !strings.EqualFold(o.Head, result.Head)
	return result, nil
}

// gitWriting runs a Git command that writes a worktree out. That takes as
// long as there are files, so nothing ends it but the caller giving up:
// ended early, it would leave some of the files and not the rest. Hooks are
// off as they are for inspection, and nothing is fetched.
func gitWriting(ctx context.Context, path string, args ...string) error {
	prefix := []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", path}
	cmd := exec.CommandContext(ctx, "git", append(prefix, args...)...)
	cmd.WaitDelay = 2 * time.Second
	cmd.Env = append(commandEnv(), "GIT_NO_LAZY_FETCH=1")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if message := strings.TrimSpace(stderr.String()); message != "" {
			return fmt.Errorf("git: %s", message)
		}
		return fmt.Errorf("git: %w", err)
	}
	return nil
}

func restorePathKind(info os.FileInfo) string {
	if info.IsDir() {
		return "a partial checkout folder"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "a symbolic link"
	}
	return "a file"
}
