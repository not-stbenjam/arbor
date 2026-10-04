package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func emptyCheckoutDirectory(target string) bool {
	canonical, err := resolveMissingRoot(target)
	if err != nil || canonical != target {
		return false
	}
	info, err := os.Lstat(target)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	entries, err := os.ReadDir(target)
	return err == nil && len(entries) == 0
}

// removeEmptyCheckout never recursively removes content. The operating system
// refuses rmdir if a file appears even after the final emptiness check.
func removeEmptyCheckout(target string, original os.FileInfo) error {
	if !emptyCheckoutDirectory(target) {
		return errors.New("checkout is no longer an empty directory; inspect it again")
	}
	current, err := os.Lstat(target)
	if err != nil || original == nil || !os.SameFile(original, current) {
		return errors.New("empty checkout directory changed during validation")
	}
	if err := syscall.Rmdir(target); err != nil {
		return fmt.Errorf("could not remove empty checkout directory: %w", err)
	}
	return nil
}

// resolveMissingRoot resolves every existing ancestor and appends only absent
// path components. Dangling symlinks are not equivalent to absent directories.
func resolveMissingRoot(root string) (string, error) {
	if root == "" || root == "~" || strings.HasPrefix(root, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if root == "" || root == "~" {
			root = home
		} else {
			root = filepath.Join(home, root[2:])
		}
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	var suffix []string
	for current := abs; ; current = filepath.Dir(current) {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for i := len(suffix) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, suffix[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		if _, linkErr := os.Lstat(current); linkErr == nil {
			return "", errors.New("worktree path contains an unresolved symlink")
		} else if !os.IsNotExist(linkErr) {
			return "", linkErr
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		suffix = append(suffix, filepath.Base(current))
	}
}

func repositoryForTarget(ctx context.Context, root, hint string) (string, error) {
	lookup := hint
	if lookup == "" {
		lookup = root
		for {
			info, err := os.Stat(lookup)
			if err == nil {
				if !info.IsDir() {
					return "", errors.New("repository ancestor is not a directory")
				}
				break
			}
			if !os.IsNotExist(err) {
				return "", err
			}
			parent := filepath.Dir(lookup)
			if parent == lookup {
				return "", err
			}
			lookup = parent
		}
	}
	resolved, err := ResolveRoot(lookup)
	if err != nil {
		return "", fmt.Errorf("cannot locate repository: %w", err)
	}
	common := gitText(ctx, resolved, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if common == "" {
		return "", errors.New("cannot find the missing worktree's repository; supply --repo with its repository or Git directory")
	}
	common, err = filepath.EvalSymlinks(common)
	if err != nil {
		return "", fmt.Errorf("cannot resolve repository metadata: %w", err)
	}
	return common, nil
}
