package engine

import (
	"bytes"
	"github.com/stbenjam/arbor/internal/worktree"
	"reflect"
	"testing"
)

func FuzzProgress(f *testing.F) {
	f.Add([]byte("@arbor-progress {\"stage\":\"inspect\",\"completed\":1,\"total\":2}\n"), uint8(7))
	f.Add([]byte("bad\n"), uint8(1))
	f.Fuzz(func(t *testing.T, data []byte, width uint8) {
		var a, b []worktree.Progress
		first := &progressWriter{callback: func(p worktree.Progress) { a = append(a, p) }}
		second := &progressWriter{callback: func(p worktree.Progress) { b = append(b, p) }}
		first.Write(data)
		first.flush()
		for i := 0; i < len(data); {
			end := min(len(data), i+int(width)+1)
			second.Write(data[i:end])
			i = end
		}
		second.flush()
		if !reflect.DeepEqual(a, b) || !bytes.Equal(first.diagnostics.Bytes(), second.diagnostics.Bytes()) {
			t.Fatal("chunk boundaries change parser result")
		}
		if first.diagnostics.Len() > maxProgressLine || len(first.pending) > maxProgressLine {
			t.Fatal("unbounded output")
		}
		for _, p := range a {
			if !validProgress(p) {
				t.Fatal("invalid event delivered")
			}
		}
	})
}

func FuzzHostVersion(f *testing.F) {
	for _, s := range []string{"", "host", "-host", "user@host", "v1.2.3", "v99999999999999999.0.0", "Linux x86_64"} {
		f.Add(s, "v2.0.0")
	}
	f.Fuzz(func(t *testing.T, a, b string) {
		if ValidateHost(a) == nil && a != "" {
			if len(a) > 255 {
				t.Fatal("oversize host accepted")
			}
			for _, r := range a {
				if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '.' || r == '@' || r == ':' || r == '[' || r == ']' || r == '-') {
					t.Fatal("unsafe host accepted")
				}
			}
		}
		if earlierRelease(a, b) && earlierRelease(b, a) || earlierRelease(a, a) {
			t.Fatal("version ordering is inconsistent")
		}
		platform(a)
		checksumFor([]byte(a), b)
	})
}
