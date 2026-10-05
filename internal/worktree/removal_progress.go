package worktree

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// How often a file being deleted is looked for, and the least time between
// counts of what is left. A count walks the whole folder, so the wait before
// the next one also grows with how long the last one took.
var (
	removalTick  = 100 * time.Millisecond
	removalCount = 300 * time.Millisecond
)

// survey takes a last look through a folder that is about to be deleted. It
// counts the files, for the progress that follows, and reports whether a
// repository is inside that the inspection did not account for as one of the
// worktree's own submodules.
func survey(ctx context.Context, root string, submodules []string) (files int, nested bool, err error) {
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			return err
		}
		parent := filepath.Dir(path)
		if entry.Name() == ".git" {
			if parent != root && !slices.Contains(submodules, parent) {
				nested = true
			}
			if entry.IsDir() {
				// Its contents are counted, not searched for more of the same.
				files += countFiles(path, nil)
				return filepath.SkipDir
			}
		}
		if !entry.IsDir() {
			files++
		}
		if entry.Name() == "HEAD" && !entry.IsDir() && parent != root {
			// A repository without a checkout has no ".git" to find.
			entries, readErr := os.ReadDir(parent)
			if readErr != nil {
				return readErr
			}
			kind, probeErr := recognizeRepository(ctx, parent, entries)
			if probeErr != nil {
				return probeErr
			}
			if kind != repositoryNone {
				nested = true
				return filepath.SkipDir
			}
		}
		return nil
	})
	return files, nested, err
}

// watchRemoval reports, while Git deletes a worktree's folder, how many of
// its total files are gone and one that is going about now. It only reads:
// Git still does all of the deleting, and nothing here can change what is
// deleted. It starts at once, without looking through the folder first: the
// checks that this is still the right folder at the right commit come
// immediately before the deletion, and nothing slow may come between them.
// The function it returns stops the reports and waits for the last.
func watchRemoval(root string, total int, report func(Progress)) (stop func()) {
	if report == nil || total == 0 {
		return func() {}
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		sent := Progress{Stage: "remove", Path: root, FilesTotal: total}
		report(sent)
		ticker := time.NewTicker(removalTick)
		defer ticker.Stop()
		next := time.Now().Add(removalCount)
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
			}
			now := sent
			now.Current = goingFile(root)
			if started := time.Now(); !started.Before(next) {
				// Files never come back, so the count only moves forward.
				if gone := total - countFiles(root, done); gone > now.Files {
					now.Files = gone
				}
				next = time.Now().Add(max(removalCount, 4*time.Since(started)))
			}
			select {
			case <-done:
				// The count was cut short; what it found is not a total.
				return
			default:
			}
			if now != sent {
				sent = now
				report(sent)
			}
		}
	}()
	return func() {
		close(done)
		<-finished
	}
}

// countFiles counts what is in a folder other than folders. Entries that
// vanish while it looks are simply not counted.
func countFiles(root string, done <-chan struct{}) int {
	count := 0
	_ = filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		select {
		case <-done:
			return fs.SkipAll
		default:
		}
		if err != nil {
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.IsDir() {
			count++
		}
		return nil
	})
	return count
}

// goingFile names a file that is being deleted about now, relative to root.
// Git empties a folder in the order the folder lists its entries, going into
// each subfolder as it comes to it, so the first entry still there at every
// level leads to where it is working.
func goingFile(root string) string {
	path := root
	for depth := 0; depth < 128; depth++ {
		folder, err := os.Open(path)
		if err != nil {
			break
		}
		names, _ := folder.Readdirnames(16)
		folder.Close()
		into := ""
		for _, name := range names {
			child := filepath.Join(path, name)
			info, err := os.Lstat(child)
			if err != nil {
				continue // gone since it was listed
			}
			if !info.IsDir() {
				return relative(root, child)
			}
			into = child
			break
		}
		if into == "" {
			break
		}
		path = into
	}
	if path == root {
		return ""
	}
	return relative(root, path)
}

func relative(root, path string) string {
	name, err := filepath.Rel(root, path)
	if err != nil {
		return ""
	}
	// A report is one line of text; a very deep path keeps its end.
	const limit = 1024
	if len(name) > limit {
		name = "…" + name[len(name)-limit:]
	}
	return filepath.ToSlash(name)
}
