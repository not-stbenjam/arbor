package engine

import (
	"bytes"
	"encoding/json"

	"github.com/stbenjam/arbor/internal/worktree"
)

// progressWriter separates live remote progress from SSH diagnostics. os/exec
// invokes Write serially and waits for the stderr copier before Output returns.
// Bound both partial lines and diagnostics, including malformed remote output.
type progressWriter struct {
	callback    func(worktree.Progress)
	pending     []byte
	dropping    bool
	diagnostics bytes.Buffer
}

const maxProgressLine = 64 * 1024

func (w *progressWriter) Write(data []byte) (int, error) {
	count := len(data)
	for _, b := range data {
		if b == '\n' {
			w.flush()
			w.dropping = false
			continue
		}
		if w.dropping {
			continue
		}
		if len(w.pending) >= maxProgressLine {
			w.flush()
			w.dropping = true
			continue
		}
		w.pending = append(w.pending, b)
	}
	return count, nil
}

func (w *progressWriter) flush() {
	if len(w.pending) == 0 {
		return
	}
	line := w.pending
	w.pending = nil
	if bytes.HasPrefix(line, []byte(worktree.ProgressPrefix)) {
		var event worktree.Progress
		if json.Unmarshal(line[len(worktree.ProgressPrefix):], &event) == nil && validProgress(event) {
			if w.callback != nil {
				w.callback(event)
			}
			return
		}
	}
	if remaining := maxProgressLine - w.diagnostics.Len(); remaining > 0 {
		if len(line) >= remaining {
			w.diagnostics.Write(line[:remaining])
		} else {
			w.diagnostics.Write(line)
			w.diagnostics.WriteByte('\n')
		}
	}
}

func validProgress(event worktree.Progress) bool {
	if event.Discovered < 0 || event.Completed < 0 || event.Total < 0 || (event.Total > 0 && event.Completed > event.Total) {
		return false
	}
	if event.Files < 0 || event.FilesTotal < 0 || event.Files > event.FilesTotal || len(event.Current) > 4096 {
		return false
	}
	switch event.Stage {
	case "files-git", "files-search":
		return event.Total == 0 && event.Completed == 0
	case "files-measure":
		return event.Completed <= event.Total
	case "discovery", "fetch", "inspect", "connecting", "remove":
		return true
	}
	return false
}
