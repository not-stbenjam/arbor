package worktree

import (
	"context"
	"strconv"
	"strings"
	"time"
)

// freshGrace withholds a newly created, never-used checkout from cleanup
// recommendations. Manual deletion remains available throughout.
const freshGrace = 24 * time.Hour

// inspectFreshness identifies a checkout that was created recently and whose
// HEAD has never moved. Its branch is trivially an ancestor of the default
// branch because it still points at its starting commit, so ancestry is not
// evidence that any work was finished. Without this, a worktree a person or a
// coding tool created minutes ago is offered for one-click cleanup.
//
// The HEAD reflog is per-worktree and begins at creation. A repository that
// keeps no reflog offers no creation evidence, so its age is simply unknown.
func inspectFreshness(ctx context.Context, w *Worktree) {
	log, err := git(ctx, w.Path, "reflog", "show", "--date=unix", "--format=%H %gd", "HEAD")
	if err != nil {
		return
	}
	var created time.Time
	for _, entry := range strings.Split(strings.TrimSpace(log), "\n") {
		head, selector, ok := strings.Cut(entry, " ")
		if !ok || head != w.Head {
			return
		}
		seconds, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(selector, "HEAD@{"), "}"), 10, 64)
		if err != nil {
			return
		}
		// Entries are newest first; the last one records the checkout's creation.
		created = time.Unix(seconds, 0)
	}
	w.Fresh = !created.IsZero() && time.Since(created) < freshGrace
}
