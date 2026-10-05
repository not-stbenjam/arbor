package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// collectRegistrations visits each common repository once and materializes
// linked registrations before inspection. Discovery markers are not authority
// to identify a checkout or to offer it for removal.
func collectRegistrations(ctx context.Context, report *Report, paths []string, excluded func(string) bool, options Options) (map[string]*repositoryDefault, error) {
	defaults := map[string]*repositoryDefault{}
	seen := map[string]bool{}
	registeredPaths := map[string]bool{}
	for _, path := range paths {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if registeredPaths[path] {
			continue
		}
		common, explicitGitDir, reason := resolveCommonDirectory(ctx, path)
		if common == "" {
			report.Warnings = append(report.Warnings, "Could not inspect repository: "+path+gitReason(reason))
			continue
		}
		if resolved, err := filepath.EvalSymlinks(common); err == nil {
			common = resolved
		}
		if seen[common] {
			continue
		}
		seen[common] = true
		defaults[common] = &repositoryDefault{repository: path}
		if options.Fetch {
			if options.Progress != nil {
				options.Progress(Progress{Stage: "fetch", Path: path, Discovered: len(paths), Completed: len(seen) - 1})
			}
			unconfirmed, err := fetchRepository(ctx, path)
			if err != nil {
				report.Fetched = false
				// The scan goes on; say what its merge checks then rest on.
				report.Warnings = append(report.Warnings, "Could not fetch "+path+gitReason(err)+". Merge checks used the Git data already on disk.")
			}
			defaults[common].unconfirmed = unconfirmed
		}
		args := []string{"worktree", "list", "--porcelain", "-z"}
		if explicitGitDir != "" {
			args = append([]string{"--bare"}, args...)
		}
		raw, err := gitCommon(ctx, common, args...)
		if err != nil {
			report.Warnings = append(report.Warnings, err.Error())
			continue
		}
		entries := parseList(raw)
		if len(entries) > 0 {
			// Its primary checkout names a repository better than whichever
			// of its worktrees discovery happened to reach first.
			defaults[common].repository = entries[0].Path
		}
		for _, w := range entries {
			registeredPaths[w.Path] = true
		}
		for _, w := range selectRegistrations(entries, common, report.Root, excluded, options) {
			report.Worktrees = append(report.Worktrees, w)
			if options.Progress != nil {
				// Registration snapshots are not modified by inspection workers.
				options.Progress(Progress{Stage: "discovery", Path: w.Path, Discovered: len(paths), Worktree: &w, Pending: true})
			}
		}
	}
	return defaults, nil
}

// gitReason reduces a Git failure to the one line that says why, for a
// warning that already names the repository.
func gitReason(err error) string {
	if err == nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(strings.TrimPrefix(err.Error(), "git: ")), "\n")
	line := lines[0]
	// Notices can come first; the line Git gave up on says why.
	for _, candidate := range lines {
		if strings.HasPrefix(candidate, "fatal: ") {
			line = candidate
			break
		}
	}
	line = strings.TrimPrefix(line, "fatal: ")
	// Git names the directory it gave up on, or "(null)" when it had none.
	line = strings.TrimSuffix(line, ": (null)")
	if line == "" {
		return ""
	}
	return " (" + line + ")"
}

// fetchRepository fetches every remote and then learns which branch the
// deciding remote calls its default. It returns, for that remote, why the
// default branch could not be confirmed.
func fetchRepository(ctx context.Context, path string) (map[string]string, error) {
	// Fetch only on explicit request; never prune or change a local branch.
	// Unlike read-only recognition/listing, fetch must use ordinary Git
	// discovery so explicit-only bare and ownership policies still apply.
	if _, err := run(ctx, 2*time.Minute, "git", "-c", "core.hooksPath=/dev/null", "-C", path, "fetch", "--all", "--no-recurse-submodules"); err != nil {
		return nil, err
	}
	configured := strings.Fields(gitText(ctx, path, "remote"))
	remote := decidingRemote(ctx, path, configured)
	// Branches left behind by a remote that is no longer configured cannot
	// be refreshed; they decide exactly as they would without a fetch.
	if !slices.Contains(configured, remote) {
		return nil, nil
	}
	if reason := refreshRemoteDefault(ctx, path, remote); reason != "" {
		return map[string]string{remote: reason}, nil
	}
	return nil, nil
}

// refreshRemoteDefault asks a remote which branch it calls its default and
// points the local selector at it. A fetch updates branches, not that
// selector, so after a project renames its default branch the old name would
// keep deciding what counts as merged. It returns why the default branch is
// not available here, when the remote names one that is not.
func refreshRemoteDefault(ctx context.Context, path, remote string) string {
	listed, err := run(ctx, 30*time.Second, "git", "-c", "core.hooksPath=/dev/null", "-C", path, "ls-remote", "--symref", remote, "HEAD")
	if err != nil {
		return remote + " could not be asked for its default branch" + gitReason(err)
	}
	branch := ""
	for _, line := range strings.Split(listed, "\n") {
		if name, ok := strings.CutPrefix(line, "ref: refs/heads/"); ok {
			branch, _, _ = strings.Cut(name, "\t")
			break
		}
	}
	// What an earlier fetch recorded is replaced by what this one learns. A
	// record that cannot be written or cleared is a reason in itself: the
	// scans that follow would otherwise not know what this one found.
	learned := gitText(ctx, path, "config", "--local", "--get", learnedDefault(remote))
	record := func(value string) string {
		if value == learned {
			return ""
		}
		args := []string{"-c", "core.hooksPath=/dev/null", "-C", path, "config", "--local"}
		if value == "" {
			args = append(args, "--unset", learnedDefault(remote))
		} else {
			args = append(args, learnedDefault(remote), value)
		}
		if _, err := run(ctx, 30*time.Second, "git", args...); err != nil {
			return "what this fetch learned about the default branch of " + remote + " could not be recorded" + gitReason(err)
		}
		return ""
	}
	if branch == "" {
		// The remote names no default branch, so no selector can be stale.
		return record("")
	}
	selector, target := "refs/remotes/"+remote+"/HEAD", "refs/remotes/"+remote+"/"+branch
	if gitText(ctx, path, "rev-parse", "--verify", target+"^{commit}") == "" {
		if !tracksRemote(ctx, path, remote) {
			// A bare clone tracks none of the remote's branches as such.
			return record("")
		}
		// Kept for the scans and removals that follow without a fetch.
		reason := untrackedDefault(remote, branch)
		if failure := record(branch); failure != "" {
			reason += "; " + failure
		}
		return reason
	}
	// The selector is published before the barrier is lifted. If it cannot
	// be, the barrier stays: without it the old selector would decide again.
	if gitText(ctx, path, "symbolic-ref", selector) != target {
		// Full ref names, so a branch name can never be read as an option.
		if _, err := run(ctx, 30*time.Second, "git", "-c", "core.hooksPath=/dev/null", "-C", path, "symbolic-ref", selector, target); err != nil {
			return "the default branch of " + remote + " could not be recorded" + gitReason(err)
		}
	}
	return record("")
}

// selectRegistrations applies scan scope and assigns stable repository identity.
// The complete list is retained by the caller for discovery deduplication.
func selectRegistrations(entries []Worktree, common, root string, excluded func(string) bool, options Options) []Worktree {
	var selected []Worktree
	for i, w := range entries {
		w.Main = i == 0
		w.OutsideRoot = !within(root, w.Path)
		if (options.TargetOnly && w.Path != root) || (options.LinkedOnly && (w.Main || w.Bare || w.OutsideRoot)) || excluded(w.Path) {
			continue
		}
		w.CommonDir = common
		w.Repo = filepath.Base(filepath.Dir(common))
		if (w.Main && w.Bare) || (len(entries) > 0 && entries[0].Bare) {
			w.Repo = strings.TrimSuffix(filepath.Base(common), ".git")
		}
		sum := sha256.Sum256([]byte(common + "\x00" + w.Path))
		w.ID = hex.EncodeToString(sum[:12])
		selected = append(selected, w)
	}
	return selected
}
