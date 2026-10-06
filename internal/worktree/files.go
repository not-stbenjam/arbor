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
	Kind           string `json:"kind"`
	Path           string `json:"path"`
	Status         string `json:"status,omitempty"`
	Directory      bool   `json:"directory"`
	SizeBytes      int64  `json:"sizeBytes"`
	Files          int    `json:"files"`
	SizeLowerBound bool   `json:"sizeLowerBound"`
}

var FileKinds = []string{"changes", "ignored", "unchecked", "submodules", "operation", "nested", "refs"}

// Files uses the same exact registration selection as remove, without doing
// merge, publication or deletion checks that cannot add to this inventory.
func Files(ctx context.Context, path, repository string, limit int) (FilesReport, error) {
	result := FilesReport{Counts: map[string]int{}, Bytes: map[string]int64{}, Entries: []FileEntry{}, Warnings: []string{}}
	if limit < 1 || limit > 10000 {
		return result, errors.New("limit must be between 1 and 10000")
	}
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
			candidates = append(candidates, candidate{FileEntry{Kind: kind, Path: name, Status: status}, disk})
			seen[key] = true
		}
	}
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
		// Finding repositories must finish: otherwise a count of zero would hide
		// history. Measuring their contents below can safely give a lower bound.
		search, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = walkFiles(search, w.Path, func(disk string, d fs.DirEntry) error {
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
		if err != nil {
			return result, fmt.Errorf("could not finish looking for repositories inside the folder: %w", err)
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
	measuring, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for _, item := range candidates {
		entry := item.entry
		if item.disk != "" {
			entry.SizeBytes, entry.Files, entry.Directory, entry.SizeLowerBound = measureFiles(measuring, item.disk)
		}
		if !entry.Directory {
			entry.Files = 0
		}
		result.SizeLowerBound = result.SizeLowerBound || entry.SizeLowerBound
		result.Counts[entry.Kind]++
		result.Bytes[entry.Kind] += entry.SizeBytes
		result.Entries = append(result.Entries, entry)
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
	return result, nil
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

// Read directory entries in batches: WalkDir reads a whole giant directory
// before its callback can observe a deadline. Neither walker follows links.
func walkFiles(ctx context.Context, path string, visit func(string, fs.DirEntry) error) error {
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
			return err
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
				return err
			}
		}
	}
	err = walk(path, fs.FileInfoToDirEntry(info))
	if err == filepath.SkipDir {
		return nil
	}
	return err
}

func measureFiles(ctx context.Context, path string) (bytes int64, files int, directory, lower bool) {
	// A tracked parent may have become a link. Count no bytes through it.
	for parent := filepath.Dir(path); parent != filepath.Dir(parent); parent = filepath.Dir(parent) {
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
	err = walkFiles(ctx, path, func(_ string, d fs.DirEntry) error {
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
	lower = err != nil
	return
}
