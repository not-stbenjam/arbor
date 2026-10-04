package config

import "testing"

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
