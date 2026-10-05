package worktree

import (
	"context"
	"sync"
)

// inspectWorktrees owns worker lifetime and serialized progress publication.
// Each worker mutates a distinct row; only default-ref lookup is shared, and
// that cache exists solely for this scan rather than later removal validation.
func inspectWorktrees(ctx context.Context, report *Report, options Options, discovered int, defaults map[string]*repositoryDefault) error {
	jobs := make(chan int)
	var wg sync.WaitGroup
	var progressMu sync.Mutex
	completed := 0
	notify := func(path string) {
		if options.Progress != nil {
			options.Progress(Progress{Stage: "inspect", Path: path, Discovered: discovered, Completed: completed, Total: len(report.Worktrees)})
		}
	}
	notify(report.Root)
	// Git worktrees are independent. Keep I/O bounded for large home directories.
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range jobs {
				if ctx.Err() != nil {
					return
				}
				progressMu.Lock()
				notify(report.Worktrees[index].Path)
				progressMu.Unlock()
				inspectWithDefault(ctx, &report.Worktrees[index], options, defaults[report.Worktrees[index].CommonDir])
				if ctx.Err() != nil {
					return
				}
				progressMu.Lock()
				completed++
				if options.Progress != nil {
					w := report.Worktrees[index]
					options.Progress(Progress{Stage: "inspect", Path: w.Path, Discovered: discovered, Completed: completed, Total: len(report.Worktrees), Worktree: &w})
				}
				progressMu.Unlock()
			}
		}()
	}
dispatch:
	for i := range report.Worktrees {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break dispatch
		}
	}
	close(jobs)
	wg.Wait()
	return ctx.Err()
}
