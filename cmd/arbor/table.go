package main

import (
	"fmt"
	"io"
	"strings"
	"unicode"
)

// renderTable reserves the measured fixed columns, then shares what remains
// between paths and branches. Unusually long diagnostics use blocks instead.
func renderTable(out io.Writer, rows [][6]string, width int) error {
	widths := [6]int{}
	for _, row := range rows {
		for i, s := range row {
			widths[i] = max(widths[i], textWidth(s))
		}
	}
	if width > 0 {
		remaining := width - 10 - widths[2] - widths[3] - widths[4] - widths[5]
		if width < 60 || remaining < 12 {
			return renderBlocks(out, rows[1:], width)
		}
		paths := min(widths[0], remaining/2)
		branches := min(widths[1], remaining-paths)
		paths = min(widths[0], remaining-branches)
		widths[0], widths[1] = paths, branches
	}
	for _, row := range rows {
		for i, value := range row {
			if width > 0 && i < 2 {
				value = shorten(value, widths[i])
			}
			padding := strings.Repeat(" ", max(0, widths[i]-textWidth(value)))
			if i == 4 {
				value = padding + value
			} else if i < 5 {
				value += padding
			}
			if i > 0 {
				if _, err := io.WriteString(out, "  "); err != nil {
					return err
				}
			}
			if _, err := io.WriteString(out, value); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintln(out); err != nil {
			return err
		}
	}
	return nil
}

func renderBlocks(out io.Writer, rows [][6]string, width int) error {
	labels := []string{"", "Branch: ", "Repository: ", "Activity: ", "Size: ", "Status: "}
	for n, row := range rows {
		if n > 0 {
			if _, err := fmt.Fprintln(out); err != nil {
				return err
			}
		}
		for i, value := range row {
			if i < 2 {
				value = shorten(value, max(1, width-textWidth(labels[i])))
			}
			line := labels[i] + value
			// Keep diagnostics complete even when a single one cannot fit a table.
			for textWidth(line) > width {
				part, rest := takeColumns(line, width)
				if _, err := fmt.Fprintln(out, part); err != nil {
					return err
				}
				line = rest
			}
			if _, err := fmt.Fprintln(out, line); err != nil {
				return err
			}
		}
	}
	return nil
}

func textWidth(s string) int {
	width := 0
	for _, r := range s {
		width += runeColumns(r)
	}
	return width
}

// Combining marks occupy no cell; wide CJK characters and emoji occupy two.
func runeColumns(r rune) int {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || r == '\u200d' {
		return 0
	}
	if r >= 0x1100 && (r <= 0x115f || r == 0x2329 || r == 0x232a || r >= 0x2e80 && r <= 0xa4cf || r >= 0xac00 && r <= 0xd7a3 || r >= 0xf900 && r <= 0xfaff || r >= 0xfe10 && r <= 0xfe6f || r >= 0xff00 && r <= 0xff60 || r >= 0xffe0 && r <= 0xffe6 || r >= 0x1f000 && r <= 0x1faff || r >= 0x20000 && r <= 0x3fffd) {
		return 2
	}
	return 1
}

func takeColumns(s string, limit int) (string, string) {
	width := 0
	for i, r := range s {
		width += runeColumns(r)
		if width > limit {
			// Even a one-column terminal must make progress on a wide character.
			if i == 0 {
				return string(r), s[len(string(r)):]
			}
			return s[:i], s[i:]
		}
	}
	return s, ""
}
