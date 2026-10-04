package worktree

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func ResolveRoot(root string) (string, error) {
	if root == "" || root == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = home
	}
	if strings.HasPrefix(root, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(home, root[2:])
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}

func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func discover(ctx context.Context, root string, excluded func(string) bool, progress func(Progress)) ([]string, []string, error) {
	var paths, warnings []string
	lastUpdate := time.Time{}
	update := func(path string, force bool) {
		if progress != nil && (force || time.Since(lastUpdate) >= 150*time.Millisecond) {
			progress(Progress{Stage: "discovery", Path: path, Discovered: len(paths)})
			lastUpdate = time.Now()
		}
	}
	update(root, true)
	found := func(path string) {
		paths = append(paths, path)
		if progress != nil {
			sum := sha256.Sum256([]byte(path))
			progress(Progress{Stage: "discovery", Path: path, Discovered: len(paths), Pending: true,
				Worktree: &Worktree{ID: hex.EncodeToString(sum[:12]), Path: path, Repo: filepath.Base(path)}})
			lastUpdate = time.Now()
		}
	}
	// Read each directory once and detect bare-repository markers in those
	// entries. Probing path/HEAD with Stat in every directory adds a syscall
	// for every folder in a home directory, including non-repository folders.
	stack := []string{root}
	for len(stack) > 0 {
		if ctx.Err() != nil {
			return paths, warnings, ctx.Err()
		}
		path := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if excluded(path) {
			continue
		}
		update(path, false)
		entries, err := os.ReadDir(path)
		if err != nil {
			if path == root {
				return paths, warnings, err
			}
			if len(warnings) < 100 {
				warnings = append(warnings, fmt.Sprintf("Cannot read %s: %v", path, err))
			}
			continue
		}
		var marker, head, objects bool
		for _, entry := range entries {
			if ctx.Err() != nil {
				return paths, warnings, ctx.Err()
			}
			switch entry.Name() {
			case ".git":
				marker = true
			case "HEAD":
				head = true
			case "objects":
				objects = entry.IsDir()
				if entry.Type()&os.ModeSymlink != 0 {
					info, err := os.Stat(filepath.Join(path, "objects"))
					objects = err == nil && info.IsDir()
				}
			}
		}
		if head && objects && gitText(ctx, path, "rev-parse", "--is-bare-repository") == "true" {
			found(path)
			continue
		}
		if marker {
			// .git identifies this directory, not an independently excludable
			// child. A '*' rule must not hide an explicitly selected root.
			found(path)
		}
		// Reverse pushes retain WalkDir's lexical discovery order. Never follow
		// symlinks or skip a checkout's other directories: nested repos count.
		for i := len(entries) - 1; i >= 0; i-- {
			if ctx.Err() != nil {
				return paths, warnings, ctx.Err()
			}
			entry := entries[i]
			if entry.IsDir() && entry.Name() != ".git" {
				stack = append(stack, filepath.Join(path, entry.Name()))
			}
		}
	}
	update(root, true)
	return paths, warnings, nil
}

func Scan(ctx context.Context, options Options) (Report, error) {
	start := time.Now()
	root, err := ResolveRoot(options.Root)
	if err != nil {
		return Report{}, err
	}
	st, err := os.Stat(root)
	if err != nil {
		return Report{}, err
	}
	if !st.IsDir() {
		return Report{}, errors.New("scan root must be a directory")
	}
	excluded, err := compileExcludes(root, options.Excludes)
	if err != nil {
		return Report{}, err
	}
	gitVersion, err := git(ctx, root, "--version")
	if err != nil {
		return Report{}, fmt.Errorf("Git is required: %w", err)
	}
	var major, minor int
	if _, err := fmt.Sscanf(gitVersion, "git version %d.%d", &major, &minor); err != nil || major < 2 || (major == 2 && minor < 36) {
		return Report{}, fmt.Errorf("Git 2.36 or newer is required (found %s)", strings.TrimSpace(gitVersion))
	}
	report := Report{Root: root, ScannedAt: start, Worktrees: []Worktree{}, Warnings: []string{}, GitHub: options.GitHub, Fetched: options.Fetch}
	paths := []string{root}
	var warnings []string
	if !options.TargetOnly {
		progress := options.Progress
		if options.LinkedOnly && progress != nil {
			progress = func(event Progress) {
				// A .git marker alone cannot classify the checkout as linked.
				// Wait for Git's registered worktree list before showing rows.
				event.Worktree = nil
				options.Progress(event)
			}
		}
		paths, warnings, err = discover(ctx, root, excluded, progress)
	}
	if err != nil {
		return report, err
	}
	report.Warnings = append(report.Warnings, warnings...)
	seen := map[string]bool{}
	registeredPaths := map[string]bool{}
	notify := func(stage, path string, completed, total int) {
		if options.Progress != nil {
			options.Progress(Progress{Stage: stage, Path: path, Discovered: len(paths), Completed: completed, Total: total})
		}
	}
	for _, path := range paths {
		if ctx.Err() != nil {
			return report, ctx.Err()
		}
		if registeredPaths[path] {
			continue
		}
		common := gitText(ctx, path, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if common == "" {
			report.Warnings = append(report.Warnings, "Could not inspect repository: "+path)
			continue
		}
		if resolved, err := filepath.EvalSymlinks(common); err == nil {
			common = resolved
		}
		if seen[common] {
			continue
		}
		seen[common] = true
		if options.Fetch {
			notify("fetch", path, len(seen)-1, 0)
			// Fetch only on explicit request; never prune or change a local branch.
			_, err := run(ctx, 2*time.Minute, "git", "-c", "core.hooksPath=/dev/null", "-C", path, "fetch", "--all", "--no-recurse-submodules")
			if err != nil {
				report.Fetched = false
				report.Warnings = append(report.Warnings, "Fetch failed for "+path+": "+err.Error())
			}
		}
		raw, err := git(ctx, path, "worktree", "list", "--porcelain", "-z")
		if err != nil {
			report.Warnings = append(report.Warnings, err.Error())
			continue
		}
		entries := parseList(raw)
		for i := range entries {
			w := &entries[i]
			registeredPaths[w.Path] = true
			w.Main = i == 0
			w.OutsideRoot = !within(root, w.Path)
			if (options.TargetOnly && w.Path != root) || (options.LinkedOnly && (w.Main || w.Bare || w.OutsideRoot)) {
				continue
			}
			if excluded(w.Path) {
				continue
			}
			w.CommonDir = common
			w.Repo = filepath.Base(filepath.Dir(common))
			if w.Main && w.Bare {
				w.Repo = strings.TrimSuffix(filepath.Base(common), ".git")
			}
			if len(entries) > 0 && entries[0].Bare {
				w.Repo = strings.TrimSuffix(filepath.Base(common), ".git")
			}
			sum := sha256.Sum256([]byte(common + "\x00" + w.Path))
			w.ID = hex.EncodeToString(sum[:12])
			report.Worktrees = append(report.Worktrees, *w)
			if options.Progress != nil {
				// Registration entries are not modified by inspection workers.
				options.Progress(Progress{Stage: "discovery", Path: w.Path, Discovered: len(paths), Worktree: w, Pending: true})
			}
		}
	}
	// Git worktrees are independent. Keep I/O bounded for large home directories.
	jobs := make(chan int)
	var wg sync.WaitGroup
	var progressMu sync.Mutex
	completed := 0
	defaults := map[string]*repositoryDefault{}
	for _, w := range report.Worktrees {
		if defaults[w.CommonDir] == nil {
			defaults[w.CommonDir] = &repositoryDefault{}
		}
	}
	notify("inspect", root, 0, len(report.Worktrees))
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				if ctx.Err() != nil {
					return
				}
				progressMu.Lock()
				notify("inspect", report.Worktrees[index].Path, completed, len(report.Worktrees))
				progressMu.Unlock()
				inspectWithDefault(ctx, &report.Worktrees[index], options, defaults[report.Worktrees[index].CommonDir])
				if ctx.Err() != nil {
					return
				}
				progressMu.Lock()
				completed++
				if options.Progress != nil {
					w := report.Worktrees[index]
					options.Progress(Progress{Stage: "inspect", Path: w.Path, Discovered: len(paths), Completed: completed, Total: len(report.Worktrees), Worktree: &w})
				}
				progressMu.Unlock()
			}
		}()
	}
dispatch:
	for i := range report.Worktrees {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break dispatch
		}
	}
	close(jobs)
	wg.Wait()
	if ctx.Err() != nil {
		return report, ctx.Err()
	}
	sort.Slice(report.Worktrees, func(i, j int) bool {
		a, b := report.Worktrees[i], report.Worktrees[j]
		if a.Repo != b.Repo {
			return a.Repo < b.Repo
		}
		if a.Main != b.Main {
			return a.Main
		}
		return a.Path < b.Path
	})
	report.DurationMS = time.Since(start).Milliseconds()
	return report, nil
}

func inspect(ctx context.Context, w *Worktree, options Options) {
	inspectWithDefault(ctx, w, options, nil)
}

// Scan shares ref lookup only within its snapshot. Removal calls inspect with
// no cache, so all deletion decisions continue to use fresh repository state.
type repositoryDefault struct {
	once sync.Once
	ref  string
}

func inspectWithDefault(ctx context.Context, w *Worktree, options Options, defaultCache *repositoryDefault) {
	w.Blockers = []string{}
	w.Problems = []string{}
	w.PublishedRefs = []string{}
	w.GitHubState = "not_checked"
	block := func(message string) { w.Blockers = append(w.Blockers, message) }
	if w.Main {
		block("Primary worktree")
	}
	if w.Bare {
		block("Bare repository")
		return
	}
	if w.OutsideRoot {
		block("Outside the scan folder")
	}
	if w.Locked {
		block("Locked worktree")
	}
	if w.Detached {
		block("Detached HEAD; create a branch to retain its commits")
	}
	if st, err := os.Stat(w.Path); err != nil || !st.IsDir() {
		w.Missing = true
		block("Worktree directory is missing")
		return
	}
	actual := gitText(ctx, w.Path, "rev-parse", "--show-toplevel")
	if actual != w.Path {
		block("Worktree path could not be verified")
		return
	}
	w.Head = gitText(ctx, w.Path, "rev-parse", "--verify", "HEAD")
	if len(w.Head) < 40 {
		block("No commit to preserve")
		return
	}
	meta, err := git(ctx, w.Path, "show", "-s", "--format=%s%x00%an%x00%cI", "HEAD")
	if err != nil {
		w.Problems = append(w.Problems, err.Error())
	} else {
		parts := strings.Split(strings.TrimSpace(meta), "\x00")
		if len(parts) == 3 {
			w.Subject = parts[0]
			w.Author = parts[1]
			w.CommitAt, _ = time.Parse(time.RFC3339, parts[2])
			w.ActivityAt = w.CommitAt
		}
	}
	status, err := git(ctx, w.Path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none")
	if err != nil {
		block("Cannot read working directory status")
		w.Problems = append(w.Problems, err.Error())
	} else {
		items := strings.Split(status, "\x00")
		for i := 0; i < len(items); i++ {
			item := items[i]
			if len(item) < 3 {
				continue
			}
			if strings.HasPrefix(item, "!!") {
				w.Ignored = true
				continue
			}
			w.Dirty = true
			w.ChangedFiles++
			if strings.ContainsAny(item[:2], "RC") {
				i++
			}
		}
	}
	if w.Dirty {
		block("Uncommitted or untracked files")
	}
	if w.Ignored {
		block("Ignored files on disk (may include local secrets or build output)")
	}
	index, err := git(ctx, w.Path, "ls-files", "-v", "--stage", "-z")
	if err != nil {
		block("Cannot verify index flags")
		block("Cannot verify submodules")
	} else {
		var sparse, submodules bool
		for _, line := range strings.Split(index, "\x00") {
			if len(line) > 0 && (line[0] == 'S' || (line[0] >= 'a' && line[0] <= 'z')) {
				sparse = true
			}
			if len(line) >= 2 && strings.HasPrefix(line[2:], "160000 ") {
				submodules = true
			}
		}
		if sparse {
			block("Sparse or assume-unchanged index entries")
		}
		if submodules {
			block("Contains submodules")
		}
	}
	metadata, err := gitPaths(ctx, w.Path, []string{"rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "HEAD", "index", "logs/HEAD"})
	if err != nil {
		block("Cannot locate Git metadata")
		w.Problems = append(w.Problems, err.Error())
	} else {
		for _, p := range metadata[:6] {
			if _, err := os.Stat(p); err == nil {
				block("Git operation in progress")
				break
			}
		}
	}
	measure(ctx, w, block)
	if len(metadata) == 9 {
		for _, path := range metadata[6:] {
			if st, err := os.Stat(path); err == nil && st.ModTime().After(w.ActivityAt) {
				w.ActivityAt = st.ModTime()
			}
		}
	}
	w.Upstream = gitText(ctx, w.Path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if w.Upstream != "" {
		counts := strings.Fields(gitText(ctx, w.Path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"))
		if len(counts) == 2 {
			w.Ahead, _ = strconv.Atoi(counts[0])
			w.Behind, _ = strconv.Atoi(counts[1])
		}
	}
	refs := gitText(ctx, w.Path, "for-each-ref", "--contains=HEAD", "--format=%(refname)", "refs/remotes/")
	for _, ref := range strings.Split(refs, "\n") {
		if ref != "" && !strings.HasSuffix(ref, "/HEAD") {
			w.PublishedRefs = append(w.PublishedRefs, strings.TrimPrefix(ref, "refs/remotes/"))
		}
	}
	w.Published = len(w.PublishedRefs) > 0
	if defaultCache == nil {
		w.DefaultRef = defaultRef(ctx, w.Path)
	} else {
		defaultCache.once.Do(func() { defaultCache.ref = defaultRef(ctx, w.Path) })
		w.DefaultRef = defaultCache.ref
	}
	if w.DefaultRef != "" {
		_, err := git(ctx, w.Path, "merge-base", "--is-ancestor", w.Head, w.DefaultRef)
		w.Merged = err == nil
		if w.Merged {
			w.MergeReason = "All commits are in " + w.DefaultRef
		}
		defaultBranch := strings.TrimPrefix(w.DefaultRef, "refs/heads/")
		if strings.HasPrefix(w.DefaultRef, "refs/remotes/") {
			_, defaultBranch, _ = strings.Cut(strings.TrimPrefix(w.DefaultRef, "refs/remotes/"), "/")
		}
		if w.Branch == defaultBranch {
			block("Default branch")
		}
	}
	if w.Branch == "main" || w.Branch == "master" || w.Branch == "develop" {
		block("Protected branch name")
	}
	if options.GitHub {
		checkGitHub(ctx, w)
	}
	w.CanRemove = len(w.Blockers) == 0 && len(w.Problems) == 0
	w.Recommended = w.CanRemove && w.Merged
	annotateDiscard(w)
}

func defaultRef(ctx context.Context, path string) string {
	for _, remote := range []string{"upstream", "origin"} {
		ref := gitText(ctx, path, "symbolic-ref", "refs/remotes/"+remote+"/HEAD")
		if ref != "" && gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != "" {
			return ref
		}
		for _, branch := range []string{"main", "master"} {
			ref := "refs/remotes/" + remote + "/" + branch
			if gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != "" {
				return ref
			}
		}
	}
	for _, branch := range []string{"main", "master"} {
		ref := "refs/heads/" + branch
		if gitText(ctx, path, "rev-parse", "--verify", ref+"^{commit}") != "" {
			return ref
		}
	}
	return ""
}

func measure(ctx context.Context, w *Worktree, block func(string)) {
	nested := false
	err := filepath.WalkDir(w.Path, func(path string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return err
		}
		if d.Name() == ".git" {
			if filepath.Dir(path) != w.Path {
				nested = true
			}
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			w.SizeBytes += info.Size()
		}
		if info.ModTime().After(w.ActivityAt) {
			w.ActivityAt = info.ModTime()
		}
		return nil
	})
	if nested {
		block("Contains a nested repository or worktree")
	}
	if err != nil {
		block("Cannot inspect every file")
		w.Problems = append(w.Problems, err.Error())
	}
}
