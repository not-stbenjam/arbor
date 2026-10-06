package worktree

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// ShellArgument writes one argument of a command that someone is given to
// paste into a shell, so that the shell reads back exactly what it stands
// for. Most are written as they are, or in single quotes. One with a
// character that cannot be printed, such as a line break in a folder's name,
// is written in the $'…' form that bash, zsh and ksh read, with those
// characters as escapes: printed as it is, it could not be told from another
// name, and what was pasted would be a different argument.
func ShellArgument(value string) string {
	if value != "" && strings.IndexFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("/_-.@:", r))
	}) < 0 {
		return value
	}
	if utf8.ValidString(value) && strings.IndexFunc(value, func(r rune) bool { return r < 32 || r == 127 }) < 0 {
		return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
	}
	var quoted strings.Builder
	quoted.WriteString("$'")
	for len(value) > 0 {
		r, size := utf8.DecodeRuneInString(value)
		switch {
		case r == '\\' || r == '\'':
			quoted.WriteByte('\\')
			quoted.WriteRune(r)
		case r == '\n':
			quoted.WriteString(`\n`)
		case r == '\t':
			quoted.WriteString(`\t`)
		case r < 32 || r == 127 || r == utf8.RuneError && size == 1:
			fmt.Fprintf(&quoted, `\x%02x`, value[0])
		default:
			quoted.WriteString(value[:size])
		}
		value = value[size:]
	}
	quoted.WriteByte('\'')
	return quoted.String()
}
