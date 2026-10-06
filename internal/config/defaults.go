// Package config provides shared defaults for the CLI and desktop application.
package config

import (
	_ "embed"
	"encoding/json"
	"slices"
)

//go:embed defaults.json
var data []byte

type defaults struct {
	SafeIgnored []string `json:"safeIgnored"`
	Excludes    []string `json:"excludes"`
	MaxExcludes int      `json:"maxExcludes"`
}

var values = func() defaults {
	var result defaults
	if err := json.Unmarshal(data, &result); err != nil {
		panic(err)
	}
	return result
}()

// Excludes returns an independent copy of the default discovery exclusions.
func Excludes() []string { return slices.Clone(values.Excludes) }

// MaxExcludes is the shared CLI and desktop limit for exclusion rules.
func MaxExcludes() int { return values.MaxExcludes }

// SafeIgnored contains disposable install/build output or OS-generated metadata.
// Never add names commonly holding secrets, handwritten work, databases or logs.
func SafeIgnored() []string { return slices.Clone(values.SafeIgnored) }
