package worktree

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Remove never removes branches, uses no force flags, and distrusts the scan's
// potentially stale status. expectedHead binds the user's action to its commit.
func Remove(ctx context.Context, snapshot Worktree, expectedHead string, recommendedOnly bool) error {
	return RemoveWithOptions(ctx, snapshot, expectedHead, recommendedOnly, false)
}

// RemoveWithOptions permits explicit local-file disposal, but never bypasses
// identity checks or turns a primary repository into a removable worktree.
func RemoveWithOptions(ctx context.Context, snapshot Worktree, expectedHead string, recommendedOnly, discardLocal bool) error {
	_, err := RemoveWithResult(ctx, snapshot, expectedHead, recommendedOnly, discardLocal)
	return err
}

// RemoveWithResult also reports a recovery branch created for a detached commit.
func RemoveWithResult(ctx context.Context, snapshot Worktree, expectedHead string, recommendedOnly, discardLocal bool) (RemovalResult, error) {
	result := RemovalResult{Path: snapshot.Path}
	err := remove(ctx, snapshot, expectedHead, recommendedOnly, discardLocal, &result)
	result.Removed = err == nil
	if err != nil {
		result.Error = err.Error()
	}
	return result, err
}

func remove(ctx context.Context, snapshot Worktree, expectedHead string, recommendedOnly, discardLocal bool, result *RemovalResult) error {
	if recommendedOnly && discardLocal {
		return errors.New("discarding local files cannot be used for recommended cleanup")
	}
	if expectedHead == "" || expectedHead != snapshot.Head {
		return errors.New("commit changed or was not supplied; scan again")
	}
	if snapshot.OutsideRoot {
		return errors.New("worktree is outside the scan folder")
	}
	resolved, err := resolveMissingRoot(snapshot.Path)
	if err != nil || resolved != snapshot.Path {
		return errors.New("worktree path changed; scan again")
	}
	pathInfo, pathErr := os.Lstat(snapshot.Path)
	missing := os.IsNotExist(pathErr)
	if pathErr != nil && !missing {
		return fmt.Errorf("cannot inspect worktree path: %w", pathErr)
	}
	if snapshot.Missing && !missing {
		return errors.New("worktree directory appeared after the scan; inspect it again")
	}
	if snapshot.Empty && !missing && !emptyCheckoutDirectory(snapshot.Path) {
		return errors.New("checkout is no longer an empty directory; inspect it again")
	}
	common := ""
	if missing || snapshot.Empty {
		common, err = repositoryForTarget(ctx, snapshot.Path, snapshot.CommonDir)
		if err != nil {
			return err
		}
	} else {
		common = gitText(ctx, snapshot.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	}
	if resolved, err := filepath.EvalSymlinks(common); err == nil {
		common = resolved
	}
	if common == "" || common != snapshot.CommonDir {
		return errors.New("repository changed; scan again")
	}
	lockPath := filepath.Join(common, "arbor-cleanup.lock")
	lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("cannot acquire cleanup lock (another cleanup may be running): %w", err)
	}
	lock.Close()
	defer os.Remove(lockPath)
	raw, err := git(ctx, common, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return err
	}
	var current *Worktree
	for i, item := range parseList(raw) {
		if item.Path == snapshot.Path {
			item.Main = i == 0
			item.CommonDir = common
			item.ID = snapshot.ID
			item.Repo = snapshot.Repo
			current = &item
			break
		}
	}
	if current == nil {
		return errors.New("worktree is no longer registered")
	}
	if current.Head != expectedHead || current.Branch != snapshot.Branch {
		return errors.New("worktree commit or branch changed; scan again")
	}
	inspect(ctx, current, Options{GitHub: snapshot.PR != nil && snapshot.PR.Merged})
	if snapshot.Empty && !current.Empty && !current.Missing {
		return errors.New("checkout is no longer an empty directory; inspect it again")
	}
	if current.Head != expectedHead {
		return errors.New("worktree commit changed during validation; scan again")
	}
	if !current.CanRemove && !(discardLocal && current.CanDiscard) {
		return fmt.Errorf("cannot remove: %s", strings.Join(append(current.Blockers, current.Problems...), "; "))
	}
	if recommendedOnly && !current.Recommended {
		return errors.New("worktree is no longer a cleanup recommendation")
	}
	// Retaining the named branch is part of Arbor's removal contract.
	if current.Detached && discardLocal {
		// Most detached tool sessions point at an existing branch commit. Avoid
		// creating a permanent recovery ref for each of those disposable checkouts.
		refs, err := git(ctx, common, "for-each-ref", "--contains", expectedHead, "--format=%(refname)", "refs/heads/", "refs/remotes/")
		if err != nil {
			return fmt.Errorf("could not check detached commit retention: %w", err)
		}
		if strings.TrimSpace(string(refs)) == "" {
			branch := RecoveryBranch(*current)
			if _, err := git(ctx, common, "branch", "--", branch, expectedHead); err != nil {
				return fmt.Errorf("could not preserve detached commit: %w", err)
			}
			result.RetainedBranch = branch
		}
	} else if current.Branch == "" || gitText(ctx, common, "rev-parse", "--verify", "refs/heads/"+current.Branch) != expectedHead {
		return errors.New("branch no longer preserves this commit")
	}
	if current.Empty {
		if !discardLocal {
			return errors.New("empty checkout removal requires explicit local cleanup consent")
		}
		if err := removeEmptyCheckout(current.Path, pathInfo); err != nil {
			return err
		}
		missing = true
	}
	// A missing registration must stay missing. Never reinterpret an entry that
	// was replaced by a directory or symlink as consent to delete its contents.
	if missing {
		canonical, err := resolveMissingRoot(current.Path)
		if err != nil || canonical != current.Path {
			return errors.New("worktree path changed during validation")
		}
		if _, err := os.Lstat(current.Path); !os.IsNotExist(err) {
			return errors.New("worktree directory appeared during validation; inspect it again")
		}
	}
	args := []string{"worktree", "remove"}
	if discardLocal {
		args = append(args, "--force")
		if current.Locked {
			args = append(args, "--force")
		}
	}
	args = append(args, "--", current.Path)
	_, err = git(ctx, common, args...)
	return err
}
