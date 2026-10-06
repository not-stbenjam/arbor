package stats

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func FuzzStatistics(f *testing.F) {
	for _, s := range []string{`{}`, `{"version":1,"daily":[]}`, `{"version":2}`, `{"version":1,"removedWorktrees":-1}`, "null"} {
		f.Add([]byte(s))
	}
	dir := f.TempDir()
	f.Fuzz(func(t *testing.T, data []byte) {
		file := filepath.Join(dir, "statistics.json")
		if err := os.WriteFile(file, data, 0600); err != nil {
			t.Fatal(err)
		}
		state, err := read(file)
		if err == nil {
			if !valid(state) || state.Daily == nil {
				t.Fatal("invalid state accepted")
			}
			encoded, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			var again diskState
			if json.Unmarshal(encoded, &again) != nil || !valid(again) {
				t.Fatal("state did not round trip")
			}
		}
		after, err := os.ReadFile(file)
		if err != nil || string(after) != string(data) {
			t.Fatal("read changed input")
		}
	})
}
