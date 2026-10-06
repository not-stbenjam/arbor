package worktree

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestSafeIgnoredMatching(t *testing.T) {
	for _, tc := range []struct {
		rule, entry string
		want        bool
	}{
		{"node_modules", "node_modules/", true}, {"node_modules", "a/b/node_modules/", true},
		{"*.pyc", "a/b/file.pyc", true}, {"*.pyc", "a/file.PYC", false},
		{"./build", "build/", true}, {"./build", "a/build/", false},
		{"build/out", "build/out/", true}, {"build/out", "a/build/out/", false},
		{"**/build", "build/", true}, {"**/build", "a/b/build/", true},
		{"a/**/out", "a/out/", true}, {"a/**/out", "a/b/c/out/", true},
		{"file?.[a-z]", "x/file1.c", true}, {"file?.[a-z]", "x/file12.c", false},
		{"node_modules/*", "node_modules/", false}, {"node_modules", "node_modules/private.env", false},
		{"cache/", "a/cache/", true}, {`literal\*`, "literal*", true},
	} {
		t.Run(tc.rule+":"+tc.entry, func(t *testing.T) {
			match, err := compileSafeIgnored([]string{tc.rule})
			if err != nil {
				t.Fatal(err)
			}
			if got := match(tc.entry) != ""; got != tc.want {
				t.Fatalf("matched=%v want=%v", got, tc.want)
			}
		})
	}
	for _, rule := range []string{"", "[", "x\\", "/tmp", "~/tmp", "../tmp", ".", "a//b"} {
		if ValidateSafeIgnored([]string{rule}) == nil {
			t.Fatalf("accepted %q", rule)
		}
	}
}

func TestSafeIgnoredDefaults(t *testing.T) {
	want := []string{"node_modules", ".venv", "venv", "__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".gradle", ".next", ".nuxt", ".turbo", ".cache", "coverage", ".DS_Store", "dist", "build", "target"}
	if !slices.Equal(DefaultSafeIgnored(), want) {
		t.Fatal(DefaultSafeIgnored())
	}
	match, err := compileSafeIgnored(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range []string{".env", ".env.local", ".env.production", "config.local", ".idea/", ".vscode/", "data.db", "id_rsa", "credentials.json", "app.log", "logs/"} {
		if match(entry) != "" {
			t.Fatalf("unsafe default for %s", entry)
		}
	}
	rules := DefaultSafeIgnored()
	rules[0] = "changed"
	if DefaultSafeIgnored()[0] == "changed" {
		t.Fatal("shared defaults")
	}
}

func TestSafeIgnoredPolicyAndFreshRemoval(t *testing.T) {
	for _, kind := range []string{"covered", "disabled", "mixed", "nested", "changes", "unchecked", "arrives", "custom"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			repo := testRepo(t, filepath.Join(root, "repo"))
			wt := testLinked(t, repo, filepath.Join(root, "topic"), "topic")
			testWrite(t, filepath.Join(repo, ".git/info/exclude"), "node_modules/\n.env\ncustom-output/\n")
			folder := "node_modules"
			var rules []string
			if kind == "disabled" {
				rules = []string{}
			}
			if kind == "custom" {
				folder = "custom-output"
				rules = []string{"custom-*"}
			}
			if err := os.MkdirAll(filepath.Join(wt, folder), 0700); err != nil {
				t.Fatal(err)
			}
			testWrite(t, filepath.Join(wt, folder, "generated"), "output")
			switch kind {
			case "mixed":
				testWrite(t, filepath.Join(wt, ".env"), "secret")
			case "nested":
				testRepo(t, filepath.Join(wt, folder, "clone"))
			case "changes":
				testWrite(t, filepath.Join(wt, "tracked.txt"), "changed")
			case "unchecked":
				testGit(t, wt, "update-index", "--assume-unchanged", "tracked.txt")
			}
			report, err := Scan(context.Background(), Options{Root: root, SafeIgnored: rules})
			if err != nil {
				t.Fatal(err)
			}
			w := testTree(t, report, wt)
			clean := kind == "covered" || kind == "arrives" || kind == "custom"
			if !w.Ignored || w.CanRemove != clean || w.Recommended != clean {
				t.Fatalf("policy: %+v", w)
			}
			covered := kind != "disabled" && kind != "mixed"
			if w.AllIgnoredSafe != covered || slices.Contains(w.Losses, "ignored") == covered {
				t.Fatalf("coverage: %+v", w)
			}
			if kind == "nested" && !slices.Contains(w.Losses, "nested") {
				t.Fatal("nested repository hidden")
			}
			raw, _ := json.Marshal(w)
			if !strings.Contains(string(raw), `"allIgnoredSafe":`) || !strings.Contains(string(raw), `"matchedSafeIgnored":`) {
				t.Fatal(string(raw))
			}
			inventory, err := FilesWithRules(context.Background(), wt, repo, 200, rules)
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range inventory.Entries {
				if entry.Kind == "ignored" && entry.SafeIgnored != (entry.Path != ".env" && kind != "disabled") {
					t.Fatalf("entry: %+v", entry)
				}
			}
			if kind == "arrives" {
				testWrite(t, filepath.Join(wt, ".env"), "arrived after scan")
				clean = false
			}
			_, err = RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, SafeIgnored: rules})
			if (err == nil) != clean {
				t.Fatalf("remove: clean=%v error=%v", clean, err)
			}
			if !clean {
				if _, err := os.Stat(filepath.Join(wt, folder, "generated")); err != nil {
					t.Fatal("refused removal touched files", err)
				}
			}
		})
	}
}
