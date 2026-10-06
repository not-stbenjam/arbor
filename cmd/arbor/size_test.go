package main

import "testing"

func TestByteSizeMatchesDesktop(t *testing.T) {
	// Captured with Node from size in desktop/renderer/presentation.mjs
	// using its default English locale. Keep the Go tests independent of Node.
	for _, tc := range []struct {
		bytes int64
		want  string
	}{
		{-1, "—"}, {0, "0 B"}, {1, "1 B"}, {999, "999 B"}, {1023, "1,023 B"},
		{1024, "1 KB"}, {1126, "1.1 KB"}, {1280, "1.3 KB"}, {1536, "1.5 KB"},
		{10235, "10 KB"}, {10240, "10 KB"}, {10752, "11 KB"}, {1048575, "1,024 KB"},
		{1048576, "1 MB"}, {3145728, "3 MB"}, {41943040, "40 MB"},
		{1288490189, "1.2 GB"}, {1099511627776, "1 TB"}, {1125899906842624, "1,024 TB"},
		{9223372036854775807, "8,388,608 TB"},
	} {
		if got := byteSize(tc.bytes); got != tc.want {
			t.Errorf("%d: %q, want %q", tc.bytes, got, tc.want)
		}
	}
}
