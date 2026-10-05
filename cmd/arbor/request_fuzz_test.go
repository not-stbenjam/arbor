package main

import (
	"encoding/json"
	"testing"
)

// Desktop requests reach this binary as argv, not JSON. Exercise the shared
// normalization entry point without allowing fuzz input to start scans.
func FuzzRequest(f *testing.F) {
	f.Add("remove", "", "", "nested", uint8(0))
	f.Add("clean", "host", "session", "operation", uint8(255))
	f.Fuzz(func(t *testing.T, command, host, session, loss string, bits uint8) {
		flags := &commandOptions{common: commonFlags{host: host}, statsSession: session,
			yes: bits&1 != 0, all: bits&2 != 0, force: bits&4 != 0, recommended: bits&8 != 0,
			discardLocal: bits&16 != 0, keepLocal: bits&32 != 0, expectMissing: bits&64 != 0, expectEmpty: bits&128 != 0}
		if loss != "" {
			flags.acknowledge = []string{loss}
		}
		r, err := normalizeRequest(command, flags)
		if err == nil {
			if r.preview == flags.yes || r.discardLocal && flags.keepLocal || r.discardLocal && r.recommended {
				t.Fatal("invalid consent normalized")
			}
			if _, err := json.Marshal(r.scan); err != nil {
				t.Fatal(err)
			}
		}
	})
}
