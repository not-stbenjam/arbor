package worktree

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestScanCancellationStopsInspectionWithoutCompleting(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testLinked(t, repo, filepath.Join(root, "feature"), "feature")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := time.Now()
	_, err := Scan(ctx, Options{Root: root, Progress: func(event Progress) {
		if event.Stage == "inspect" {
			cancel()
			if event.Completed != 0 || (!event.Pending && event.Worktree != nil) {
				t.Errorf("reported completed inspection after cancellation: %+v", event)
			}
		}
	}})
	if !errors.Is(err, context.Canceled) || time.Since(started) > 2*time.Second {
		t.Fatalf("scan did not cancel promptly: %v after %v", err, time.Since(started))
	}
}

func TestScanProgressStreamsDiscoveryAndInspection(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	testLinked(t, repo, filepath.Join(root, "feature"), "feature")
	var events []Progress
	report, err := Scan(context.Background(), Options{Root: root, Fetch: true, Progress: func(event Progress) {
		// No mutex: Scan promises serialized callbacks even with four workers.
		events = append(events, event)
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) == 0 || events[0].Stage != "discovery" || events[0].Path != report.Root {
		t.Fatalf("expected initial discovery: %+v", events)
	}
	provisional, registered, inspected := map[string]bool{}, map[string]bool{}, map[string]bool{}
	lastCompleted := 0
	sawFetch := false
	for _, event := range events {
		if event.Stage == "fetch" {
			sawFetch = true
		}
		if event.Stage == "inspect" {
			if event.Total != len(report.Worktrees) || event.Completed < lastCompleted || event.Completed > event.Total {
				t.Fatalf("invalid inspection counts: %+v (previous %d)", event, lastCompleted)
			}
			lastCompleted = event.Completed
		}
		if w := event.Worktree; w != nil {
			if event.Pending {
				if w.CommonDir == "" {
					provisional[w.Path] = true
				} else {
					registered[w.Path] = true
				}
			} else {
				if !registered[w.Path] || event.Stage != "inspect" || w.Head == "" {
					t.Fatalf("inspection missing registration or metadata: %+v", event)
				}
				inspected[w.Path] = true
			}
		}
	}
	if !sawFetch || lastCompleted != len(report.Worktrees) || len(provisional) != 2 || len(registered) != 2 || len(inspected) != 2 {
		t.Fatalf("missing events: fetch=%v completed=%d provisional=%v registered=%v inspected=%v", sawFetch, lastCompleted, provisional, registered, inspected)
	}
}

func TestScanProgressEmptyRoot(t *testing.T) {
	var events []Progress
	report, err := Scan(context.Background(), Options{Root: t.TempDir(), Progress: func(event Progress) { events = append(events, event) }})
	if err != nil {
		t.Fatal(err)
	}
	last := events[len(events)-1]
	if last.Stage != "inspect" || last.Completed != 0 || last.Total != 0 || last.Discovered != 0 || len(report.Worktrees) != 0 {
		t.Fatalf("invalid empty scan progress: %+v", events)
	}
}
