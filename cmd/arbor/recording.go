package main

import (
	"fmt"
	"io"

	"github.com/stbenjam/arbor/internal/stats"
)

// Remote CLI processes record their own history; the SSH client never duplicates it.
func recordOutcome(host, batchID, sessionID string, outcome batchOutcome, stderr io.Writer) {
	if host != "" || len(outcome.removed) == 0 {
		return
	}
	batch := stats.Batch{ID: batchID, SessionID: sessionID}
	for _, w := range outcome.removed {
		batch.Removals = append(batch.Removals, stats.Removal{SizeBytes: w.SizeBytes, Missing: w.Missing, Detached: w.Detached})
	}
	if err := stats.RecordRemovalBatch(batch); err != nil {
		fmt.Fprintln(stderr, "Warning: cleanup completed but statistics could not be saved:", printable(err.Error()))
	}
}
