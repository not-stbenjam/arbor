package main

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
)

// Human status never shares stdout with command results or the JSON protocol.
// Scan serializes progress callbacks. Rate limiting keeps redirected logs small.
type scanStatus struct {
	out           io.Writer
	enabled       bool
	started, last time.Time
	stage         string
}

func newScanStatus(out io.Writer, enabled bool) *scanStatus {
	return &scanStatus{out: out, enabled: enabled, started: time.Now()}
}

func (s *scanStatus) start(root, host string) {
	if !s.enabled {
		return
	}
	if root == "" {
		root = "~"
	}
	target := printable(root)
	if host != "" {
		target = printable(host) + ":" + target
	}
	fmt.Fprintln(s.out, "Scanning", target+"…")
}

func (s *scanStatus) update(event worktree.Progress) {
	if !s.enabled {
		return
	}
	now := time.Now()
	// A quick scan needs no running commentary. Connecting is the exception:
	// it explains a wait that precedes any scan progress.
	if event.Stage != "connecting" && now.Sub(s.started) < time.Second {
		return
	}
	if event.Stage == s.stage && now.Sub(s.last) < time.Second {
		return
	}
	s.stage, s.last = event.Stage, now
	switch event.Stage {
	case "connecting":
		fmt.Fprintln(s.out, "Connecting to", printable(event.Path)+"…")
	case "inspect":
		fmt.Fprintf(s.out, "Inspecting worktrees: %d/%d · %s\n", event.Completed, event.Total, printable(event.Path))
	default:
		fmt.Fprintf(s.out, "Discovering repositories: %d found · %s\n", event.Discovered, printable(event.Path))
	}
}

func (s *scanStatus) finish(report worktree.Report) {
	if s.enabled {
		fmt.Fprintf(s.out, "Scan complete: %s in %s.\n", count(len(report.Worktrees), "worktree"), time.Since(s.started).Round(time.Millisecond))
	}
}

// removalProgress says how the deletion of one folder is going: framed JSON
// for an integration, or for a person a line now and then, and only once a
// deletion has gone on long enough to wonder about.
func removalProgress(out io.Writer, framed, human bool) func(worktree.Progress) {
	switch {
	case framed:
		return func(event worktree.Progress) {
			if data, err := json.Marshal(event); err == nil {
				fmt.Fprintf(out, "%s%s\n", worktree.ProgressPrefix, data)
			}
		}
	case human:
		started, last := time.Now(), time.Time{}
		return func(event worktree.Progress) {
			now := time.Now()
			if event.Files == 0 || now.Sub(started) < time.Second || now.Sub(last) < time.Second {
				return
			}
			last = now
			fmt.Fprintf(out, "  %d of %s gone · %s\n", event.Files, count(event.FilesTotal, "file"), printable(event.Current))
		}
	}
	return nil
}
