package stats

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func statsFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "preferences", "arbor", "statistics.json")
	t.Setenv("ARBOR_STATS_PATH", file)
	return file
}

func TestLoadAndCancelledBatchDoNotCreateFiles(t *testing.T) {
	file := statsFile(t)
	report, err := Load()
	if err != nil || report.RemovedWorktrees != 0 || report.Daily == nil {
		t.Fatalf("initial read: %+v %v", report, err)
	}
	if err := RecordRemovalBatch(Batch{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(file)); !os.IsNotExist(err) {
		t.Fatal("read-only/cancelled statistics created storage")
	}
}

func TestSuccessfulBatchesDeduplicateAndShareCleanupSession(t *testing.T) {
	file := statsFile(t)
	first := Batch{ID: "invocation-one", SessionID: "gui-selection", Removals: []Removal{{SizeBytes: 2048}, {SizeBytes: 8192, Missing: true}, {Detached: true, SizeBytes: 1024}}}
	if err := RecordRemovalBatch(first); err != nil {
		t.Fatal(err)
	}
	// The next process rereads persisted state rather than relying on memory.
	if err := RecordRemovalBatch(first); err != nil {
		t.Fatal(err)
	}
	if err := RecordRemovalBatch(Batch{ID: "invocation-two", SessionID: "gui-selection", Removals: []Removal{{SizeBytes: 512}}}); err != nil {
		t.Fatal(err)
	}
	report, err := Load()
	if err != nil || report.RemovedWorktrees != 4 || report.EstimatedBytesReclaimed != 3584 || report.MissingRegistrations != 1 || report.CleanupSessions != 1 || report.DetachedCommitsRetained != 1 || report.LargestWorktreeBytes != 2048 {
		t.Fatalf("incorrect persisted totals: %+v %v", report, err)
	}
	if len(report.Daily) != 1 || report.Daily[0].RemovedWorktrees != 4 || report.Daily[0].EstimatedBytesReclaimed != 3584 {
		t.Fatalf("daily totals: %+v", report.Daily)
	}
	data, err := os.ReadFile(file)
	if err != nil || strings.Contains(string(data), "path") || strings.Contains(string(data), "hostname") {
		t.Fatalf("statistics should contain no path/hostname history: %s %v", data, err)
	}
	info, _ := os.Stat(file)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("statistics permissions: %v", info.Mode())
	}
}

func TestDailyHistoryIsBoundedWithoutLosingLifetimeTotals(t *testing.T) {
	statsFile(t)
	start := time.Date(2025, 1, 1, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 100; i++ {
		if err := record(Batch{ID: fmt.Sprintf("day-%d", i), Removals: []Removal{{SizeBytes: 100}}}, start.AddDate(0, 0, i)); err != nil {
			t.Fatal(err)
		}
	}
	report, err := Load()
	if err != nil || len(report.Daily) != 90 || report.RemovedWorktrees != 100 || report.CleanupSessions != 100 || report.EstimatedBytesReclaimed != 10000 || report.Daily[0].Date != start.AddDate(0, 0, 10).Format(time.DateOnly) {
		t.Fatalf("history/lifetime mismatch: %+v %v", report, err)
	}
}

func TestCorruptStatsStayRecoverable(t *testing.T) {
	file := statsFile(t)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	corrupt := []byte("{truncated original statistics")
	if err := os.WriteFile(file, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	report, err := Load()
	if err != nil || report.Warning == "" || report.RemovedWorktrees != 0 {
		t.Fatalf("corruption not surfaced gracefully: %+v %v", report, err)
	}
	data, _ := os.ReadFile(file)
	if string(data) != string(corrupt) {
		t.Fatal("read-only stats changed corrupt file")
	}
	if err := RecordRemovalBatch(Batch{ID: "after-corruption", Removals: []Removal{{SizeBytes: 20}}}); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(file + ".corrupt-*")
	if err != nil || len(backups) != 1 {
		t.Fatalf("missing recoverable backup: %v %v", backups, err)
	}
	data, _ = os.ReadFile(backups[0])
	if string(data) != string(corrupt) {
		t.Fatal("corrupt source content was lost")
	}
	report, err = Load()
	if err != nil || report.RemovedWorktrees != 1 || !strings.Contains(report.Warning, filepath.Base(backups[0])) {
		t.Fatalf("recovery notice/totals missing: %+v %v", report, err)
	}
	// Merely rereading or retrying an already-recorded action does not swallow
	// the notice. A new successful cleanup clears it, but preserves the backup.
	if err := RecordRemovalBatch(Batch{ID: "after-corruption", Removals: []Removal{{SizeBytes: 20}}}); err != nil {
		t.Fatal(err)
	}
	if report, err = Load(); err != nil || report.Warning == "" {
		t.Fatalf("duplicate action swallowed recovery notice: %+v %v", report, err)
	}
	if err := RecordRemovalBatch(Batch{ID: "later-cleanup", Removals: []Removal{{SizeBytes: 30}}}); err != nil {
		t.Fatal(err)
	}
	if report, err = Load(); err != nil || report.Warning != "" || report.RemovedWorktrees != 2 {
		t.Fatalf("later successful cleanup kept stale warning: %+v %v", report, err)
	}
	if data, err = os.ReadFile(backups[0]); err != nil || string(data) != string(corrupt) {
		t.Fatalf("acknowledging recovery changed backup: %s %v", data, err)
	}
}

func TestFailedSaveDoesNotOverwriteExistingData(t *testing.T) {
	file := statsFile(t)
	if err := os.MkdirAll(file, 0700); err != nil {
		t.Fatal(err)
	}
	err := RecordRemovalBatch(Batch{ID: "blocked", Removals: []Removal{{}}})
	if err == nil {
		t.Fatal("directory collision did not surface save error")
	}
	info, err := os.Stat(file)
	if err != nil || !info.IsDir() {
		t.Fatalf("failed save replaced existing directory: %v", err)
	}
}

func TestFutureStatisticsVersionIsNeverReplaced(t *testing.T) {
	file := statsFile(t)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{"version":2,"removedWorktrees":23}`)
	if err := os.WriteFile(file, original, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil {
		t.Fatal("future format should require a newer Arbor")
	}
	if err := RecordRemovalBatch(Batch{ID: "future", Removals: []Removal{{}}}); err == nil {
		t.Fatal("future format was overwritten")
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != string(original) {
		t.Fatalf("future statistics changed: %s %v", data, err)
	}
}

func TestInvalidBatchDoesNotCreateStorage(t *testing.T) {
	file := statsFile(t)
	for _, batch := range []Batch{
		{ID: "", Removals: []Removal{{}}},
		{ID: "../../invalid", Removals: []Removal{{}}},
		{ID: "valid", SessionID: "invalid session", Removals: []Removal{{}}},
	} {
		if err := RecordRemovalBatch(batch); err == nil {
			t.Fatalf("accepted invalid batch: %+v", batch)
		}
	}
	if _, err := os.Stat(filepath.Dir(file)); !os.IsNotExist(err) {
		t.Fatal("invalid batches created storage")
	}
}

func TestConcurrentProcessesDoNotLoseTotals(t *testing.T) {
	statsFile(t)
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			command := exec.Command(os.Args[0], "-test.run=^TestStatisticsChildWriter$")
			command.Env = append(os.Environ(), fmt.Sprintf("ARBOR_STATS_CHILD=process-%d", index))
			if out, err := command.CombinedOutput(); err != nil {
				errors <- fmt.Errorf("child: %v %s", err, out)
			}
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	report, err := Load()
	if err != nil || report.RemovedWorktrees != 8 || report.EstimatedBytesReclaimed != 800 || report.CleanupSessions != 1 {
		t.Fatalf("concurrent totals were lost: %+v %v", report, err)
	}
}

func TestStatisticsChildWriter(t *testing.T) {
	if id := os.Getenv("ARBOR_STATS_CHILD"); id != "" {
		if err := RecordRemovalBatch(Batch{ID: id, SessionID: "shared-cli-session", Removals: []Removal{{SizeBytes: 100}}}); err != nil {
			t.Fatal(err)
		}
	}
}
