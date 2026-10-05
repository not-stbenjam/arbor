package worktree

import (
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// How often a file being deleted is looked for, and the least time between
// counts of what is left. A count walks the whole folder, so the wait before
// the next one also grows with how long the last one took.
var (
	removalTick  = 100 * time.Millisecond
	removalCount = 300 * time.Millisecond
)

// watchRemoval reports, while Git deletes a worktree's folder, how many of
// its files are gone and one that is going about now. It only reads: Git
// still does all of the deleting, and nothing here can change what is
// deleted. The function it returns stops the reports and waits for the last.
func watchRemoval(root string, report func(Progress)) (stop func()) {
	if report == nil {
		return func() {}
	}
	done := make(chan struct{})
	total := countFiles(root, done)
	if total == 0 {
		return func() {}
	}
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
