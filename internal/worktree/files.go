package worktree

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// FilesReport describes losses, never permission to delete. Categories may
// overlap (an untracked folder can also be a repository), so bytes are not a
// promise of space recovered.
type FilesReport struct {
	Path           string           `json:"path"`
	Head           string           `json:"head"`
	Branch         string           `json:"branch"`
	Truncated      bool             `json:"truncated"`
	Counts         map[string]int   `json:"counts"`
	Bytes          map[string]int64 `json:"bytes"`
	Entries        []FileEntry      `json:"entries"`
	SizeLowerBound bool             `json:"sizeLowerBound"`
	Warnings       []string         `json:"warnings"`
}

type FileEntry struct {
	SafeIgnored     bool   `json:"safeIgnored"`
	SafeIgnoredRule string `json:"safeIgnoredRule,omitempty"`
	Kind            string `json:"kind"`
	Path            string `json:"path"`
	Status          string `json:"status,omitempty"`
	Directory       bool   `json:"directory"`
	SizeBytes       int64  `json:"sizeBytes"`
	Files           int    `json:"files"`
	SizeLowerBound  bool   `json:"sizeLowerBound"`
}

var FileKinds = []string{"changes", "ignored", "unchecked", "submodules", "operation", "nested", "refs"}

// Files uses the same exact registration selection as remove, without doing
// merge, publication or deletion checks that cannot add to this inventory.
func Files(ctx context.Context, path, repository string, limit int, progress ...func(Progress)) (FilesReport, error) {
	return FilesWithRules(ctx, path, repository, limit, nil, progress...)
}

func FilesWithRules(ctx context.Context, path, repository string, limit int, rules []string, progress ...func(Progress)) (FilesReport, error) {
	result := FilesReport{Counts: map[string]int{}, Bytes: map[string]int64{}, Entries: []FileEntry{}, Warnings: []string{}}
	if limit < 1 || limit > 10000 {
		return result, errors.New("limit must be between 1 and 10000")
	}
	match, err := compileSafeIgnored(rules)
	if err != nil {
		return result, err
	}
	var callback func(Progress)
	if len(progress) > 0 {
		callback = progress[0]
	}
	emit := filesReporter(ctx, path, callback)
	emit("files-git", 0, 0, 0, true)
	options := Options{Root: path, Repository: repository, TargetOnly: true, LinkedOnly: true, Excludes: []string{}}
	location, err := prepareScan(ctx, options)
	if err != nil {
		return result, err
	}
	report := Report{Root: location.root}
	_, err = collectRegistrations(ctx, &report, []string{location.lookupRoot}, location.excluded, options)
	if err != nil {
		return result, err
	}
	if len(report.Worktrees) != 1 {
		return result, fmt.Errorf("not a linked worktree of this repository: %s%s", location.root, strings.Join(report.Warnings, "; "))
	}
	w := report.Worktrees[0]
	where := inspectLocation(ctx, &w, func(reasonCode) {})
	if where == inspectionUnverified {
		return result, errors.New("cannot verify worktree path and repository")
	}
	result.Path, result.Head, result.Branch = w.Path, w.Head, w.Branch
	for _, kind := range FileKinds {
		result.Counts[kind] = 0
		result.Bytes[kind] = 0
	}
	admin := adminDirectory(w.CommonDir, w.Path)
	if admin == "" {
		return result, errors.New("cannot find worktree metadata")
	}
	type candidate struct {
		entry FileEntry
		disk  string
	}
	var candidates []candidate
	seen := map[string]bool{}
	add := func(kind, name, status, disk string) {
		name = filepath.ToSlash(strings.TrimSuffix(name, "/"))
		key := kind + "\x00" + name
		if !seen[key] {
			entry := FileEntry{Kind: kind, Path: textName(name), Status: status}
			if kind == "ignored" {
				entry.SafeIgnoredRule = match(name)
				entry.SafeIgnored = entry.SafeIgnoredRule != ""
			}
			candidates = append(candidates, candidate{entry, disk})
			seen[key] = true
		}
	}
	visited := 0
	var submodules []string
	if where == inspectionCheckout {
		off, names := repositoryFilters(ctx, w.Path)
		if len(off) > 0 {
			defer holdFilters(w.Path, off)()
			result.Warnings = append(result.Warnings, "Repository filter programs were left off; files they rewrite may have changes Git cannot report: "+strings.Join(names, ", "))
		}
		// Never let status enter a submodule and run that repository's filters.
		status, err := git(ctx, w.Path, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=all")
		if err != nil {
			return result, err
		}
		items := strings.Split(status, "\x00")
		for i := 0; i < len(items); i++ {
			item := items[i]
			if len(item) < 4 {
				continue
			}
			kind, state := "changes", fileStatus(item[:2])
			if item[:2] == "!!" {
				kind, state = "ignored", ""
			}
			name := item[3:]
			add(kind, name, state, filepath.Join(w.Path, filepath.FromSlash(name)))
			if strings.ContainsAny(item[:2], "RC") {
				i++
			}
		}
		index, err := git(ctx, w.Path, "ls-files", "-v", "--stage", "-z")
		if err != nil {
			return result, err
		}
		for _, line := range strings.Split(index, "\x00") {
			if len(line) < 2 {
				continue
			}
			_, name, found := strings.Cut(line, "\t")
			if !found {
				return result, errors.New("invalid Git index output")
			}
			disk := filepath.Join(w.Path, filepath.FromSlash(name))
			if line[0] == 'S' || line[0] >= 'a' && line[0] <= 'z' {
				if present(disk) {
					add("unchecked", name, "", disk)
				}
			}
			if strings.HasPrefix(line[2:], "160000 ") {
				if present(filepath.Join(disk, ".git")) {
					submodules = append(submodules, disk)
					add("submodules", name, "", disk)
				} else if !vacant(disk) {
					add("unchecked", name, "", disk)
				}
			}
		}
		// Filtered tracked files are unchecked too. check-attr only reads attributes;
		// no filter program is asked to interpret the file.
		if len(off) > 0 {
			tracked, err := git(ctx, w.Path, "ls-files", "-z")
			if err != nil {
				return result, err
			}
			var batch []string
			flush := func() error {
				if len(batch) == 0 {
					return nil
				}
				out, err := git(ctx, w.Path, append([]string{"check-attr", "-z", "filter", "--"}, batch...)...)
				if err != nil {
					return err
				}
				fields := strings.Split(out, "\x00")
				for i := 0; i+2 < len(fields); i += 3 {
					if slices.Contains(names, fields[i+2]) {
						disk := filepath.Join(w.Path, filepath.FromSlash(fields[i]))
						if present(disk) {
							add("unchecked", fields[i], "", disk)
						}
					}
				}
				batch = nil
				return nil
			}
			for _, name := range strings.Split(tracked, "\x00") {
				if name != "" {
					batch = append(batch, name)
				}
				if len(batch) == 100 {
					if err := flush(); err != nil {
						return result, err
					}
				}
			}
			if err := flush(); err != nil {
				return result, err
			}
		}
		// A repository inside holds history that is nowhere else, so what could
		// not be looked through is said: a count of none would hide it.
		emit("files-search", 0, 0, 0, true)
		search, cancel := context.WithTimeout(ctx, filesSearchBudget)
		unread := 0
		err = walkFiles(search, w.Path, func(string, error) error { unread++; return nil }, func(disk string, d fs.DirEntry) error {
			if !d.IsDir() {
				visited++
				// Amortize the clock check across directory-read-sized batches.
				// Counting never needs another stat or another walk.
				if visited%128 == 0 {
					emit("files-search", visited, 0, 0, false)
				}
			}
			if d.Name() == ".git" {
				parent := filepath.Dir(disk)
				if parent != w.Path && !slices.Contains(submodules, parent) {
					rel, _ := filepath.Rel(w.Path, parent)
					add("nested", rel, "", parent)
				}
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Name() == "HEAD" && filepath.Dir(disk) != w.Path {
				parent := filepath.Dir(disk)
				entries, e := os.ReadDir(parent)
				if e != nil {
					return e
				}
				kind, e := recognizeRepository(search, parent, entries)
				if e != nil {
					return e
				}
				if kind != repositoryNone {
					rel, _ := filepath.Rel(w.Path, parent)
					add("nested", rel, "", parent)
					return filepath.SkipDir
				}
			}
			return nil
		})
		cancel()
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if err != nil {
			result.Warnings = append(result.Warnings, "Looking for repositories inside this folder was not finished ("+searchFailure(err).Error()+"); there may be some that are not listed.")
		} else if unread > 0 {
			result.Warnings = append(result.Warnings, fmt.Sprintf("%s could not be read, and may hold files or repositories that are not listed.", folders(unread)))
		}
	}
	// Repositories Git kept for submodules survive a missing checkout. Show
	// their location relative to the worktree, explicitly labelled in the UI.
	modules := filepath.Join(admin, "modules")
	if holdsSubmodules(modules) {
		rel, _ := filepath.Rel(w.Path, modules)
		add("submodules", rel, "", modules)
	}
	operations := map[string]string{"rebase-merge": "rebase", "rebase-apply": "rebase", "MERGE_HEAD": "merge", "CHERRY_PICK_HEAD": "cherry-pick", "REVERT_HEAD": "revert", "BISECT_LOG": "bisect", "sequencer": "cherry-pick or revert"}
	for _, marker := range operationMarkers {
		if present(filepath.Join(admin, marker)) {
			name := operations[marker]
			if marker == "sequencer" {
				data, _ := os.ReadFile(filepath.Join(admin, marker, "todo"))
				if strings.HasPrefix(string(data), "pick ") {
					name = "cherry-pick"
				}
				if strings.HasPrefix(string(data), "revert ") {
					name = "revert"
				}
			}
			add("operation", name, "", "")
		}
	}
	refs, err := git(ctx, w.CommonDir, "--git-dir="+admin, "for-each-ref", "--format=%(refname)", "refs/worktree/")
	if err != nil {
		return result, err
	}
	for _, ref := range strings.Split(strings.TrimSuffix(refs, "\n"), "\n") {
		if ref != "" {
			add("refs", ref, "", "")
		}
	}
	emit("files-measure", visited, 0, len(candidates), true)
	measuring, cancel := context.WithTimeout(ctx, filesMeasureBudget)
	defer cancel()
	for i, item := range candidates {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		entry := item.entry
		if item.disk != "" {
			entry.SizeBytes, entry.Files, entry.Directory, entry.SizeLowerBound = measureFiles(measuring, w.Path, item.disk)
		}
		if !entry.Directory {
			entry.Files = 0
		}
		result.SizeLowerBound = result.SizeLowerBound || entry.SizeLowerBound
		result.Counts[entry.Kind]++
		result.Bytes[entry.Kind] += entry.SizeBytes
		result.Entries = append(result.Entries, entry)
		emit("files-measure", visited, i+1, len(candidates), false)
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Kind != b.Kind {
			return slices.Index(FileKinds, a.Kind) < slices.Index(FileKinds, b.Kind)
		}
		if a.SizeBytes != b.SizeBytes {
			return a.SizeBytes > b.SizeBytes
		}
		return a.Path < b.Path
	})
	retained := result.Entries[:0]
	counts := map[string]int{}
	for _, entry := range result.Entries {
		counts[entry.Kind]++
		if counts[entry.Kind] <= limit {
			retained = append(retained, entry)
		} else {
			result.Truncated = true
		}
	}
	result.Entries = retained
	emit("files-measure", visited, len(candidates), len(candidates), true)
	return result, nil
}

// textName is a file's name as it can be written down. A name need not be
// text, and bytes that are not would all be written as the same mark, so
// that two files could not be told apart: each such byte is given as \xNN.
func textName(name string) string {
	if utf8.ValidString(name) {
		return name
	}
	var text strings.Builder
	for len(name) > 0 {
		r, size := utf8.DecodeRuneInString(name)
		if r == utf8.RuneError && size == 1 {
			fmt.Fprintf(&text, `\x%02X`, name[0])
		} else {
			text.WriteString(name[:size])
		}
		name = name[size:]
	}
	return text.String()
}

func fileStatus(xy string) string {
	if strings.Contains(xy, "U") || xy == "AA" || xy == "DD" {
		return "conflicted"
	}
	if xy == "??" {
		return "untracked"
	}
	if strings.ContainsAny(xy, "RC") {
		return "renamed"
	}
	if strings.Contains(xy, "D") {
		return "deleted"
	}
	if strings.Contains(xy, "A") {
		return "added"
	}
	return "modified"
}

// filesSearchBudget is how long is spent looking for repositories inside a
// worktree, and filesMeasureBudget how long adding up what was found.
var filesSearchBudget, filesMeasureBudget = 10 * time.Second, 3 * time.Second

func searchFailure(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("it took too long")
	}
	return err
}

func folders(n int) string {
	if n == 1 {
		return "1 folder"
	}
	return fmt.Sprintf("%d folders", n)
}

// Read directory entries in batches: WalkDir reads a whole giant directory
// before its callback can observe a deadline. Neither walker follows links.
// A folder that cannot be opened or read is given to unreadable, which says
// whether to go on without it (nil) or stop.
func walkFiles(ctx context.Context, path string, unreadable func(string, error) error, visit func(string, fs.DirEntry) error) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	var walk func(string, fs.DirEntry) error
	walk = func(path string, d fs.DirEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := visit(path, d); err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		dir, err := os.Open(path)
		if err != nil {
			return unreadable(path, err)
		}
		defer dir.Close()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			entries, err := dir.ReadDir(128)
			for _, entry := range entries {
				e := walk(filepath.Join(path, entry.Name()), entry)
				if e == filepath.SkipDir {
					if !entry.IsDir() {
						return nil
					}
				} else if e != nil {
					return e
				}
			}
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return unreadable(path, err)
			}
		}
	}
	err = walk(path, fs.FileInfoToDirEntry(info))
	if err == filepath.SkipDir {
		return nil
	}
	return err
}

func measureFiles(ctx context.Context, root, path string) (bytes int64, files int, directory, lower bool) {
	// A tracked parent may have become a link. Count no bytes through it.
	// Only folders inside the worktree are in question: how the worktree
	// itself is reached is not something a repository decides.
	for parent := filepath.Dir(path); parent != root && strings.HasPrefix(parent, root+string(filepath.Separator)); parent = filepath.Dir(parent) {
		info, err := os.Lstat(parent)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return 0, 0, false, true
		}
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		return 0, 0, false, true
	}
	directory = info.IsDir()
	// What cannot be read is left out of the sum, which is then a least.
	err = walkFiles(ctx, path, func(string, error) error { lower = true; return nil }, func(_ string, d fs.DirEntry) error {
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			bytes += info.Size()
			files++
		}
		return nil
	})
	lower = lower || err != nil
	return
}

// Stage boundaries and the final count are immediate; intermediate counts are
// limited to ten per second. No timer, extra walk, or goroutine does reporting.
func filesReporter(ctx context.Context, path string, callback func(Progress)) func(string, int, int, int, bool) {
	var last time.Time
	var previous Progress
	return func(stage string, discovered, completed, total int, boundary bool) {
		if callback == nil || ctx.Err() != nil {
			return
		}
		now := time.Now()
		if !boundary && now.Sub(last) < 100*time.Millisecond {
			return
		}
		event := Progress{Stage: stage, Path: path, Discovered: discovered, Completed: completed, Total: total}
		if event == previous {
			return
		}
		last, previous = now, event
		callback(event)
	}
}
