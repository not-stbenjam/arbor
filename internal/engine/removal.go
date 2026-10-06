package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/stbenjam/arbor/internal/worktree"
)

// RemovalRequest binds an inspected target and explicit cleanup policy to its host.
type RemovalRequest struct {
	Host      string
	Worktree  worktree.Worktree
	Options   worktree.RemovalOptions
	SessionID string
}

// RemoveWorktree applies the same named removal contract locally or through the managed SSH CLI.
func RemoveWorktree(ctx context.Context, request RemovalRequest) (result worktree.RemovalResult, err error) {
	host, w, head := request.Host, request.Worktree, request.Options.ExpectedHead
	recommendedOnly, discardLocal, sessionID := request.Options.RecommendedOnly, request.Options.DiscardLocal, request.SessionID
	result.Path = w.Path
	defer func() {
		if err != nil {
			result.Error = err.Error()
		}
	}()
	if recommendedOnly && discardLocal {
		return result, errors.New("discarding local files cannot be used for recommended cleanup")
	}
	if host == "" {
		return worktree.RemoveWorktree(ctx, w, request.Options)
	}
	if (!w.CanRemove && !(discardLocal && w.CanDiscard)) || w.OutsideRoot {
		return result, errors.New("worktree is protected; scan again to see why")
	}
	args := []string{"remove", "--json", "--yes", "--head", head, "--id", w.ID, "--branch", w.Branch}
	if !request.Options.NotActiveSince.IsZero() {
		args = append(args, "--not-active-since", request.Options.NotActiveSince.Format(time.RFC3339Nano))
	}
	if w.Missing {
		args = append(args, "--expect-missing")
	} else if w.Empty {
		args = append(args, "--expect-empty")
	}
	if sessionID != "" {
		args = append(args, "--stats-session", sessionID)
	}
	if w.CommonDir != "" {
		args = append(args, "--repo", w.CommonDir)
	}
	if w.PR != nil && w.PR.Merged {
		args = append(args, "--github")
	}
	if recommendedOnly {
		args = append(args, "--recommended-only")
	}
	if discardLocal {
		args = append(args, "--discard-local")
	} else {
		args = append(args, "--keep-local")
	}
	for _, loss := range request.Options.Acknowledged {
		args = append(args, "--acknowledge", loss)
	}
	if request.Options.OnlyAcknowledged {
		args = append(args, "--only-acknowledged")
	}
	if request.Options.Progress != nil {
		args = append(args, "--progress")
	}
	args = safeIgnoredArguments(args, request.Options.SafeIgnored)
	args = append(args, "--", w.Path)
	// The remote reports on its own scan of the target as well; only the
	// deletion itself is of interest here.
	var deleting func(worktree.Progress)
	if report := request.Options.Progress; report != nil {
		deleting = func(event worktree.Progress) {
			if event.Stage == "remove" && event.Path == w.Path {
				report(event)
			}
		}
	}
	data, err := sshProgress(ctx, host, deleting, args...)
	if err != nil {
		// Only a completed remote command may supply a structured refusal.
		// SSH's transport status 255, cancellation, and malformed/mismatched
		// responses retain their original diagnostic. A claimed success never
		// overrides a nonzero exit, and the requested path remains authoritative.
		var exited *sshExitError
		var refusal struct {
			Path    string `json:"path"`
			Removed *bool  `json:"removed"`
			Error   string `json:"error"`
		}
		if errors.As(err, &exited) && exited.status > 0 && exited.status != sshTransportStatus && len(data) <= maxProgressLine &&
			json.Unmarshal(data, &refusal) == nil && refusal.Path == w.Path && refusal.Removed != nil && !*refusal.Removed && strings.TrimSpace(refusal.Error) != "" {
			return result, fmt.Errorf("%s: %s", host, refusal.Error)
		}
		return result, err
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return worktree.RemovalResult{Path: w.Path}, fmt.Errorf("could not confirm remote removal: %w; scan again", err)
	}
	if !result.Removed || result.Path != w.Path {
		return worktree.RemovalResult{Path: w.Path}, errors.New("remote did not confirm removal; scan again")
	}
	return result, nil
}
