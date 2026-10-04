package engine

import (
	"encoding/json"
	"os"
	"testing"
)

func TestHostGrammarSharedWithDesktop(t *testing.T) {
	data, err := os.ReadFile("../../testdata/ssh-hosts.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Host  string `json:"host"`
		Valid bool   `json:"valid"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("empty shared host contract")
	}
	for _, tc := range cases {
		if valid := ValidateHost(tc.Host) == nil; valid != tc.Valid {
			t.Errorf("ValidateHost(%q): valid=%v, want %v", tc.Host, valid, tc.Valid)
		}
	}
}
