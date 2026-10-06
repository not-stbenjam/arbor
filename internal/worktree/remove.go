package worktree

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// RemovalOptions binds a requested cleanup to the confirmed commit and policy.
type RemovalOptions struct {
	ExpectedHead    string
	RecommendedOnly bool
	DiscardLocal    bool
	// Acknowledged names the grave losses (see GraveLosses) that the person
	// deleting was shown and accepted. DiscardLocal alone agrees to losing
	// files in the folder, not to these.
	Acknowledged []string
	// Progress is optional. It is told how far the deletion of the folder
	// has got, from a goroutine of its own.
	Progress func(Progress)
}

// RemoveWorktree freshly validates and removes one registered linked checkout.
func RemoveWorktree(ctx context.Context, snapshot Worktree, options RemovalOptions) (RemovalResult, error) {
	result := RemovalResult{Path: snapshot.Path}
	err := remove(ctx, snapshot, options, &result)
	result.Removed = err == nil
	if err != nil {
		result.Error = err.Error()
	}
	return result, err
}

func remove(ctx context.Context, snapshot Worktree, options RemovalOptions, result *RemovalResult) (failure error) {
	expectedHead, recommendedOnly, discardLocal := options.ExpectedHead, options.RecommendedOnly, options.DiscardLocal
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
		// Remove Git's terminator only; whitespace can be part of the directory.
		output, _ := git(ctx, snapshot.Path, "rev-parse", "--path-format=absolute", "--git-common-dir")
		common = strings.TrimSuffix(output, "\n")
	}
	if resolved, err := filepath.EvalSymlinks(common); err == nil {
		common = resolved
	}
	if common == "" || common != snapshot.CommonDir {
		return errors.New("repository changed; scan again")
	}
	lock, err := acquireCleanupLock(common)
	if err != nil {
		return err
	}
	defer lock.Close()
	raw, err := gitCommon(ctx, common, "worktree", "list", "--porcelain", "-z")
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
	details := inspect(ctx, current, Options{GitHub: snapshot.PR != nil && snapshot.PR.Merged})
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
	// Consent is for what was shown. Something graver found since, or never
	// shown, stops the deletion so that it can be seen and agreed to.
	if missing := unacknowledged(current.Losses, options.Acknowledged); missing != "" {
		return fmt.Errorf("not deleted: it would also discard %s. Look at it again and confirm that", missing)
	}
	// Retaining the named branch is part of Arbor's removal contract.
	if current.Detached && discardLocal {
		// Most detached tool sessions point at an existing branch commit. Avoid
		// creating a permanent recovery ref for each of those disposable checkouts.
		refs, err := gitCommon(ctx, common, "for-each-ref", "--contains", expectedHead, "--format=%(refname)", "refs/heads/", "refs/remotes/")
		if err != nil {
			return fmt.Errorf("could not check detached commit retention: %w", err)
		}
		if strings.TrimSpace(string(refs)) == "" {
			branch := RecoveryBranch(*current)
			if _, err := gitCommon(ctx, common, "branch", "--", branch, expectedHead); err != nil {
				return fmt.Errorf("could not preserve detached commit: %w", err)
			}
			result.RetainedBranch = branch
		}
	} else if current.Branch == "" || gitCommonText(ctx, common, "rev-parse", "--verify", "refs/heads/"+current.Branch) != expectedHead {
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
		// Git is still to remove its record. Should it not, the folder Arbor
		// took away is put back, so that a refusal changes nothing.
		emptied := pathInfo.Mode().Perm()
		defer func() {
			if failure != nil {
				_ = os.Mkdir(current.Path, emptied)
			}
		}()
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
	// Everything above took time, and the folder may not be as it was. Look
	// through it once more for what is graver than files: a repository that
	// was not there, or an operation begun since. What was agreed to is what
	// was shown, so anything of that kind that was not stops the deletion.
	// This look also counts the files, for the progress reported below. It
	// comes before the final checks so that nothing slow comes after them.
	files := 0
	var late []string
	if !missing {
		var nested bool
		files, nested, err = survey(ctx, current.Path, details.submodules)
		if err != nil {
			return fmt.Errorf("cannot look through the worktree before deleting it: %w", err)
		}
		if nested {
			late = append(late, "nested")
		}
	}
	// What Git keeps for an unfinished operation and for the worktree's
	// submodules is outside the folder, and goes with the worktree whether
	// or not the folder is still there.
	if unfinished(details.markers) {
		late = append(late, "operation")
	}
	if holdsSubmodules(details.modules) {
		late = append(late, "submodules")
	}
	if missing := unacknowledged(late, options.Acknowledged); missing != "" {
		return fmt.Errorf("not deleted: it would also discard %s. Look at it again and confirm that", missing)
	}
	if !missing {
		if folder := sealed(current.Path); folder != "" {
			where := "it"
			if rel, err := filepath.Rel(current.Path, folder); err == nil && rel != "." {
				where = "the folder " + rel + " inside it"
			}
			return fmt.Errorf("not deleted: %s is read-only, so only part of the worktree could be removed. Make it writable (chmod -R u+w on the worktree) and delete again", where)
		}
	}
	// Inspection reads every file and can query GitHub, long enough for the
	// checkout to change. Confirm as the last step that this is still the folder
	// that was inspected, at the same commit and branch: a folder swapped into
	// its place has unrelated files, and a commit made on a newly detached HEAD
	// has no branch. Either would be lost with the removal.
	if !missing {
		info, err := os.Lstat(current.Path)
		canonical, pathErr := resolveMissingRoot(current.Path)
		if err != nil || pathErr != nil || canonical != current.Path || !os.SameFile(pathInfo, info) {
			return errors.New("worktree directory was replaced during validation; scan again")
		}
		ref := ""
		if current.Branch != "" {
			ref = "refs/heads/" + current.Branch
		}
		if gitText(ctx, current.Path, "rev-parse", "--verify", "HEAD") != expectedHead ||
			gitText(ctx, current.Path, "symbolic-ref", "--quiet", "HEAD") != ref {
			return errors.New("worktree commit or branch changed during validation; scan again")
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
	// Asked to stop before the deletion began, it does not begin.
	if err := ctx.Err(); err != nil {
		return err
	}
	defer watchRemoval(current.Path, files, options.Progress)()
	err = deleteWithGit(common, args...)
	// With no folder there, nothing on disk was deleted: only what Git kept.
	result.Missing = err == nil && missing
	return err
}

// deleteWithGit runs the one command that deletes. Git removes a worktree's
// files and then its own record of it, and stopped between the two it
// leaves a worktree that is neither there nor gone. So this command is given
// all the time it takes, however large the folder, and is not stopped when
// Arbor is asked to stop: Arbor finishes the worktree it is on and starts no
// other. It runs apart from Arbor's terminal for the same reason, so that
// Ctrl-C reaches Arbor and not Git.
func deleteWithGit(common string, args ...string) error {
	prefix := []string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "log.showSignature=false", "-C", common, "--git-dir=" + common}
	cmd := exec.Command("git", append(prefix, args...)...)
	cmd.Env = commandEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git: %s", strings.TrimSpace(stderr.String()))
	}
	return nil
}
