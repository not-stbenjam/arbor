package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/not-stbenjam/arbor/internal/stats"
)

// ReadStats reads the selected machine's history, including CLI and GUI cleanup.
func ReadStats(ctx context.Context, host string) (stats.Report, error) {
	if host == "" {
		return stats.Load()
	}
	data, err := ssh(ctx, host, "stats", "--json")
	if err != nil {
		return stats.Report{}, err
	}
	var report stats.Report
	if err := json.Unmarshal(data, &report); err != nil {
		return report, fmt.Errorf("invalid statistics from remote Arbor: %w", err)
	}
	if report.Version != 1 {
		return stats.Report{}, fmt.Errorf("remote Arbor returned an unsupported statistics format")
	}
	for _, stamp := range []string{report.FirstCleanupAt, report.LastCleanupAt} {
		if stamp == "" {
			continue
		}
		if _, err := time.Parse(time.RFC3339, stamp); err != nil {
			// Remote fields can reach terminal output; do not echo invalid data.
			return stats.Report{}, fmt.Errorf("remote Arbor returned an invalid statistics timestamp")
		}
	}
	return report, nil
}
