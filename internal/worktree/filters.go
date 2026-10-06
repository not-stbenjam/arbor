package worktree

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Git runs a repository's filter programs when it compares a file with what
// is committed, which `git status` does for any file whose timestamp no
// longer matches Git's record of it. A repository's own configuration can
// name any program as a filter, and a folder copied or unpacked from
// somewhere else brings its configuration with it. Arbor looks into every
// repository beneath a folder without being asked about each, so it runs
// none of those programs: every filter the repository's own configuration
// names is switched off for Arbor's Git commands. Git LFS is the exception.
// Its filter is the person's own installed program, named in the standard
// way.
//
// With a filter off, a file it would have rewritten can look changed. That
// only ever keeps a worktree from being recommended, and the scan says so
// once for the repository.

// standardFilter is what `git lfs install` writes.
var standardFilter = regexp.MustCompile(`^git[- ]lfs (?:(?:clean|smudge)(?: --skip)? -- %f|filter-process(?: --skip)?)$`)

// filtersOff holds, for a worktree being inspected, the environment that
// switches its repository's filters off. Git commands run there pick it up.
var filtersOff sync.Map

// repositoryFilters reads which filter programs a repository's own
// configuration names, and returns the environment that switches each of
// them off along with their names. Settings from the person's own Git
// configuration, outside the repository, are left as they are.
func repositoryFilters(ctx context.Context, path string) (env []string, names []string) {
	// Reading configuration runs nothing. With none that matches, Git
	// exits unsuccessfully and prints nothing.
	out, _ := run(ctx, 30*time.Second, "git", "-C", path, "config", "--show-scope", "--null", "--get-regexp", `^filter\..*\.(clean|smudge|process)$`)
	// Each entry is its scope, then its key and value on two lines.
	fields := strings.Split(out, "\x00")
	found := map[string]bool{}
	for i := 0; i+1 < len(fields); i += 2 {
		scope := fields[i]
		key, value, _ := strings.Cut(fields[i+1], "\n")
		if scope != "local" && scope != "worktree" {
			continue
		}
		if standardFilter.MatchString(strings.TrimSpace(value)) {
			continue
		}
		name := strings.TrimPrefix(key, "filter.")
		name = name[:strings.LastIndex(name, ".")]
		found[name] = true
	}
	for name := range found {
		names = append(names, name)
	}
	sort.Strings(names)
	// Passed in the environment, where a name is taken as it is: on the
	// command line, one holding "=" would be read as a different setting.
	settings := 0
	set := func(key, value string) {
		n := strconv.Itoa(settings)
		env = append(env, "GIT_CONFIG_KEY_"+n+"="+key, "GIT_CONFIG_VALUE_"+n+"="+value)
		settings++
	}
	for _, name := range names {
		for _, kind := range []string{"clean", "smudge", "process"} {
			set("filter."+name+"."+kind, "")
		}
		// A filter that must succeed fails the command when it is off.
		set("filter."+name+".required", "false")
	}
	if settings > 0 {
		env = append(env, "GIT_CONFIG_COUNT="+strconv.Itoa(settings))
	}
	return env, names
}

// filterWarnings says, once for each repository, which of its filters
// Arbor did not run.
func filterWarnings(defaults map[string]*repositoryDefault) []string {
	var warnings []string
	for _, repository := range defaults {
		if len(repository.filterNames) > 0 {
			warnings = append(warnings, "Arbor does not run the filter programs "+repository.repository+" names in its own configuration ("+strings.Join(repository.filterNames, ", ")+"). A file one of them rewrites can look changed here until `git status` has been run in its worktree.")
		}
	}
	sort.Strings(warnings)
	return warnings
}
