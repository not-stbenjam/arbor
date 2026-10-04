package config

import (
	"reflect"
	"testing"
)

func TestDefaultsAreIndependentAndBounded(t *testing.T) {
	copy := Excludes()
	if len(copy) == 0 || MaxExcludes() < len(copy) {
		t.Fatal("invalid scan defaults")
	}
	copy[0] = "changed"
	if Excludes()[0] == "changed" {
		t.Fatal("caller mutated shared defaults")
	}
}

func TestDefaultExclusionContract(t *testing.T) {
	want := []string{".cache", ".Trash", "node_modules", "tmp", "temp", "~/Library/Caches", "~/Library/Logs", "~/.local/share/Trash", "~/.codex/.tmp"}
	if !reflect.DeepEqual(Excludes(), want) {
		t.Fatalf("default exclusions changed: got %v, want %v", Excludes(), want)
	}
	if MaxExcludes() != 128 {
		t.Fatalf("exclusion limit changed: %d", MaxExcludes())
	}
}
