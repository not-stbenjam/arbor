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
// none of those programs: every filter the configuration of a repository or
// of one of its worktrees names is switched off for Arbor's Git commands.
// Git LFS is the exception. Its filter is the person's own installed
// program, named the way `git lfs install` names it.
//
// With a filter off, Git compares a file it would have rewritten as it
// lies. A changed file can then look unchanged as easily as the other way
// about, so a worktree whose configuration names such a filter is never a
// clean delete: what is in it could not all be checked. The scan says so
// once for the repository.

// standardFilter is what `git lfs install` writes. The program is named
// outright: spelled "git lfs", it would be found through Git, where a
// repository's configuration can make "lfs" mean anything.
var standardFilter = regexp.MustCompile(`^git-lfs (?:(?:clean|smudge)(?: --skip)? -- %f|filter-process(?: --skip)?)$`)

// filtersOff holds, for each worktree being inspected, the environment that
// switches its filters off, and how many inspections of it are under way:
// the last to finish is the one that lets go of it.
var filtersOff = struct {
	sync.Mutex
	held map[string]*heldFilters
}{held: map[string]*heldFilters{}}

type heldFilters struct {
	env   []string
	users int
}

// holdFilters switches a worktree's filters off for Git commands run there
// until the function it returns is called.
func holdFilters(path string, env []string) (release func()) {
	filtersOff.Lock()
	defer filtersOff.Unlock()
	entry := filtersOff.held[path]
	if entry == nil {
		entry = &heldFilters{}
		filtersOff.held[path] = entry
	}
	entry.env, entry.users = env, entry.users+1
	return func() {
		filtersOff.Lock()
		defer filtersOff.Unlock()
		if entry.users--; entry.users == 0 {
			delete(filtersOff.held, path)
		}
	}
}

// heldFor is the environment Git commands in a worktree are run with while
// it is being inspected.
func heldFor(path string) []string {
	filtersOff.Lock()
	defer filtersOff.Unlock()
	if entry := filtersOff.held[path]; entry != nil {
		return entry.env
	}
	return nil
}

// repositoryFilters reads which filter programs the configuration of a
// repository, or of the worktree at this path, names, and returns the
// environment that switches each of them off along with their names.
// Settings from the person's own Git configuration, outside the
// repository, are left as they are.
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

// noteFilters keeps the names of the filters left off in a repository's
// worktrees, for the one warning about them.
func (repository *repositoryDefault) noteFilters(names []string) {
	if repository == nil || len(names) == 0 {
		return
	}
	repository.filterMu.Lock()
	defer repository.filterMu.Unlock()
	if repository.filterNames == nil {
		repository.filterNames = map[string]bool{}
	}
	for _, name := range names {
		repository.filterNames[name] = true
	}
}

// filterWarnings says, once for each repository, which of its filters
// Arbor did not run, and what follows from that.
func filterWarnings(defaults map[string]*repositoryDefault) []string {
	var warnings []string
	for _, repository := range defaults {
		repository.filterMu.Lock()
		var names []string
		for name := range repository.filterNames {
			names = append(names, name)
		}
		repository.filterMu.Unlock()
		if len(names) == 0 {
			continue
		}
		sort.Strings(names)
		warnings = append(warnings, "Arbor does not run the filter programs "+repository.repository+" names in its own configuration ("+strings.Join(names, ", ")+"), so it cannot tell whether files they rewrite have changed. Its worktrees are not recommended, and deleting one asks first.")
	}
	sort.Strings(warnings)
	return warnings
}
