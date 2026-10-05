package config

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Defaults are embedded, not user input; this covers their actual JSON decoder.
func FuzzConfiguration(f *testing.F) {
	f.Add(data)
	f.Add([]byte(`{"excludes":["**/tmp"],"maxExcludes":256}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		var value defaults
		if json.Unmarshal(input, &value) != nil {
			return
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var again defaults
		if json.Unmarshal(encoded, &again) != nil || !reflect.DeepEqual(value, again) {
			t.Fatal("configuration did not round trip")
		}
	})
}
