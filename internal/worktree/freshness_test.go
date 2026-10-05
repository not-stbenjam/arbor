package worktree

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A branch that still points at its starting commit is trivially an ancestor
// of the default branch. That must not make a checkout someone just created
// eligible for one-click cleanup.
func TestNewUnusedWorktreeIsNotRecommended(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	created := testNewLinked(t, repo, filepath.Join(root, "created"), "new-session")
	established := testLinked(t, repo, filepath.Join(root, "established"), "old-session")
	report := testScan(t, root)
	w := testTree(t, report, created)
	if !w.Fresh || !w.Merged || w.Recommended || !w.CanRemove || len(w.Blockers) != 0 {
		t.Fatalf("new checkout must stay removable but not recommended: %+v", w)
	}
	if old := testTree(t, report, established); old.Fresh || !old.Recommended {
		t.Fatalf("established unused checkout should be recommended: %+v", old)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head, RecommendedOnly: true}); err == nil {
		t.Fatal("recommended cleanup removed a checkout created moments ago")
	}
	if _, err := os.Stat(created); err != nil {
		t.Fatalf("new checkout must remain: %v", err)
	}
	if _, err := RemoveWorktree(context.Background(), w, RemovalOptions{ExpectedHead: w.Head}); err != nil {
		t.Fatalf("explicit removal of a new checkout refused: %v", err)
	}
}

func TestNewWorktreeWithMergedWorkIsRecommended(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := testNewLinked(t, repo, filepath.Join(root, "linked"), "topic")
	testWrite(t, filepath.Join(wt, "tracked.txt"), "finished\n")
	testGit(t, wt, "commit", "-am", "Finish topic")
	testGit(t, repo, "merge", "--no-ff", "-m", "Merge topic", "topic")
	// Same-day work that was committed here and merged is finished, not new.
	if w := testTree(t, testScan(t, root), wt); w.Fresh || !w.Merged || !w.Recommended {
		t.Fatalf("merged work in a recent checkout should be recommended: %+v", w)
	}
}

func TestWorktreeWithoutCreationEvidenceIsNotFresh(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := filepath.Join(root, "linked")
	testGit(t, repo, "-c", "core.logAllRefUpdates=false", "worktree", "add", "-b", "topic", wt)
	if w := testTree(t, testScan(t, root), wt); w.Fresh || !w.Recommended {
		t.Fatalf("age is unknown without a HEAD reflog: %+v", w)
	}
}

// A repository can ask Git to print signature verification above every log
// entry. Arbor parses log output, so that text must not reach it: it would
// hide a new checkout's age and every commit's subject, author, and date.
func TestSignatureDisplayDoesNotDisturbParsedGitOutput(t *testing.T) {
	keygen, err := exec.LookPath("ssh-keygen")
	if err != nil {
		t.Skip("ssh-keygen is required to sign a fixture commit")
	}
	keys := t.TempDir()
	key := filepath.Join(keys, "signing")
	if out, err := exec.Command(keygen, "-q", "-t", "ed25519", "-N", "", "-C", "arbor-test", "-f", key).CombinedOutput(); err != nil {
		t.Skipf("cannot create a signing key: %v %s", err, out)
	}
	public, err := os.ReadFile(key + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	signers := filepath.Join(keys, "allowed_signers")
	testWrite(t, signers, "arbor@example.invalid "+string(public))
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	for key, value := range map[string]string{"gpg.format": "ssh", "user.signingkey": key + ".pub", "gpg.ssh.allowedSignersFile": signers, "log.showSignature": "true"} {
		testGit(t, repo, "config", key, value)
	}
	testWrite(t, filepath.Join(repo, "tracked.txt"), "signed\n")
	testGit(t, repo, "commit", "-S", "-am", "Signed commit")
	decorated := exec.Command("git", "-C", repo, "log", "-1", "--format=%H")
	decorated.Env = append(commandEnv(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := decorated.Output(); err != nil || !strings.Contains(string(out), "Good") {
		t.Skipf("this Git does not print SSH signature verification: %q %v", out, err)
	}
	wt := testNewLinked(t, repo, filepath.Join(root, "linked"), "topic")
	w := testTree(t, testScan(t, root), wt)
	if !w.Fresh || w.Recommended {
		t.Fatalf("signature output hid a new checkout's age: %+v", w)
	}
	if w.Subject != "Signed commit" || w.Author != "Arbor Test" || w.CommitAt.IsZero() {
		t.Fatalf("signature output hid commit metadata: subject %q, author %q, at %v", w.Subject, w.Author, w.CommitAt)
	}
}

// A creation time far in the future is a clock error. It must not withhold a
// checkout from recommendations until that date arrives.
func TestWorktreeStampedFarInTheFutureIsNotFresh(t *testing.T) {
	root := t.TempDir()
	repo := testRepo(t, filepath.Join(root, "repo"))
	wt := filepath.Join(root, "linked")
	future := time.Now().AddDate(5, 0, 0).Format(time.RFC3339)
	testGitEnv(t, repo, []string{"GIT_COMMITTER_DATE=" + future}, "worktree", "add", "-b", "topic", wt)
	if w := testTree(t, testScan(t, root), wt); w.Fresh || !w.Recommended {
		t.Fatalf("clock error withheld a checkout indefinitely: %+v", w)
	}
}
