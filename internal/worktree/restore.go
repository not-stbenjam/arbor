package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type RestoreOptions struct{ Path, CommonDir, Branch, Detach, Head string }
type RestoreResult struct {
	Path     string `json:"path"`
	Branch   string `json:"branch"`
	Head     string `json:"head"`
	Restored bool   `json:"restored"`
	Moved    bool   `json:"moved"`
	Error    string `json:"error"`
}

var commitID = regexp.MustCompile(`^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$`)

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
	if _, names := repositoryFilters(ctx, o.CommonDir); len(names) > 0 {
		command := []string{"git", "-C", shellQuote(o.CommonDir)}
		command = append(command, args...)
		command = append(command, "--", shellQuote(target), shellQuote(o.Branch+o.Detach))
		return result, fmt.Errorf("repository filter programs would run (%s). Run this yourself: %s", strings.Join(names, ", "), strings.Join(command, " "))
	}
	// Separate registration from writing files: Git otherwise removes a partly
	// written checkout when a checkout fails. checkout-index refuses overwrites.
	args = append(args, "--no-checkout", "--", target, o.Branch+o.Detach)
	if _, err = git(ctx, o.CommonDir, args...); err == nil {
		_, err = git(ctx, target, "read-tree", "HEAD")
		if err == nil {
			_, err = git(ctx, target, "checkout-index", "--all")
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
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

func restorePathKind(info os.FileInfo) string {
	if info.IsDir() {
		return "a partial checkout folder"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "a symbolic link"
	}
	return "a file"
}
