package main

import (
	"encoding/json"
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/stbenjam/arbor/internal/engine"
)

func newStatsCommand() *cobra.Command {
	var host string
	var asJSON bool
	cmd := &cobra.Command{
		Use: "stats", Short: "Show cleanup statistics for this computer or an SSH host",
		Long:    "Show persistent cleanup statistics from this computer or an SSH host, including\nremovals made through the desktop app, this CLI, and SSH. Disk recovery is\nestimated from checkout files; missing registrations reclaim zero checkout bytes.\nHistory starts when a statistics-capable Arbor version first removes a worktree.",
		Example: "  arbor stats\n  arbor stats --json\n  arbor stats --host my-vps",
		Args:    checkedArgs(cobra.NoArgs),
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := engine.ValidateHost(host); err != nil {
				return err
			}
			report, err := engine.ReadStats(cmd.Context(), host)
			if err != nil {
				return err
			}
			if asJSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(report)
			}
			if report.Warning != "" {
				fmt.Fprintln(cmd.ErrOrStderr(), "Warning:", printable(report.Warning))
			}
			out := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintf(out, "Worktrees removed\t%d\nEstimated disk reclaimed\t%s\nCleanup sessions\t%d\nMissing registrations removed\t%d\nLargest checkout removed\t%s\nDetached commits retained\t%d\n", report.RemovedWorktrees, byteSize(report.EstimatedBytesReclaimed), report.CleanupSessions, report.MissingRegistrations, byteSize(report.LargestWorktreeBytes), report.DetachedCommitsRetained)
			if at, err := time.Parse(time.RFC3339, report.LastCleanupAt); err == nil {
				// Stored in UTC; a person reads it in their own time zone.
				fmt.Fprintf(out, "Last cleanup\t%s (%s)\n", at.Local().Format("2006-01-02 15:04 MST"), duration(time.Since(at)))
			}
			return out.Flush()
		},
	}
	cmd.Flags().StringVar(&host, "host", "", "SSH host alias or user@hostname (default: this computer)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Write machine-readable statistics")
	return cmd
}

func byteSize(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	value := float64(bytes)
	for _, unit := range []string{"KiB", "MiB", "GiB", "TiB", "PiB", "EiB"} {
		value /= 1024
		if value < 1024 || unit == "EiB" {
			return fmt.Sprintf("%.1f %s", value, unit)
		}
	}
	return "0 B"
}
