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
	if expectedHead == "" || expectedHead != snapshot.Head {
		return errors.New("commit changed or was not supplied; scan again")
	}
	if snapshot.OutsideRoot {
		return errors.New("worktree is outside the scan folder")
	}
	resolved, err := filepath.EvalSymlinks(snapshot.Path)
	if err != nil || resolved != snapshot.Path {
		return errors.New("worktree path changed; scan again")
	}
	common := gitText(ctx, snapshot.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
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
	raw, err := git(ctx, snapshot.Path, "worktree", "list", "--porcelain", "-z")
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
	if current.Head != expectedHead {
		return errors.New("worktree commit changed during validation; scan again")
	}
	if !current.CanRemove {
		return fmt.Errorf("cannot remove: %s", strings.Join(append(current.Blockers, current.Problems...), "; "))
	}
	if recommendedOnly && !current.Recommended {
		return errors.New("worktree is no longer a cleanup recommendation")
	}
	// Retaining the named branch is part of Arbor's removal contract.
	if current.Branch == "" || gitText(ctx, current.Path, "rev-parse", "--verify", "refs/heads/"+current.Branch) != expectedHead {
		return errors.New("branch no longer preserves this commit")
	}
	_, err = git(ctx, current.Path, "worktree", "remove", "--", current.Path)
	return err
}
