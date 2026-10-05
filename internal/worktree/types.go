package worktree

import "time"

type Options struct {
	Root   string `json:"root"`
	GitHub bool   `json:"github"`
	Fetch  bool   `json:"fetch"`
	// Nil uses DefaultExcludes; an explicit empty slice scans every directory.
	Excludes []string `json:"excludes"`
	// LinkedOnly lists linked worktrees, not ordinary repository roots.
	LinkedOnly bool `json:"linkedOnly"`
	// TargetOnly resolves one exact registered checkout, without a discovery walk.
	// Removal still performs its own complete, fresh safety inspection.
	TargetOnly bool `json:"-"`
	// Repository locates a missing target's Git registration without discovery.
	Repository string `json:"-"`
	// Progress is optional. Scan serializes callbacks, including inspection workers.
	Progress func(Progress) `json:"-"`
}

const ProgressPrefix = "@arbor-progress "

// Progress reports actual completed work. Total is zero while it is unknown.
type Progress struct {
	Stage      string    `json:"stage"`
	Path       string    `json:"path"`
	Discovered int       `json:"discovered"`
	Completed  int       `json:"completed"`
	Total      int       `json:"total"`
	Worktree   *Worktree `json:"worktree,omitempty"`
	Pending    bool      `json:"pending"`
}

type Report struct {
	Root       string     `json:"root"`
	ScannedAt  time.Time  `json:"scannedAt"`
	DurationMS int64      `json:"durationMs"`
	Worktrees  []Worktree `json:"worktrees"`
	Warnings   []string   `json:"warnings"`
	GitHub     bool       `json:"github"`
	Fetched    bool       `json:"fetched"`
}

type Worktree struct {
	ID              string       `json:"id"`
	Path            string       `json:"path"`
	Repo            string       `json:"repo"`
	CommonDir       string       `json:"commonDir"`
	Branch          string       `json:"branch"`
	Head            string       `json:"head"`
	Subject         string       `json:"subject"`
	Author          string       `json:"author"`
	CommitAt        time.Time    `json:"commitAt"`
	ActivityAt      time.Time    `json:"activityAt"`
	SizeBytes       int64        `json:"sizeBytes"`
	Main            bool         `json:"main"`
	Bare            bool         `json:"bare"`
	Detached        bool         `json:"detached"`
	Locked          bool         `json:"locked"`
	LockReason      string       `json:"lockReason"`
	Missing         bool         `json:"missing"`
	Empty           bool         `json:"empty"`
	OutsideRoot     bool         `json:"outsideRoot"`
	Dirty           bool         `json:"dirty"`
	ChangedFiles    int          `json:"changedFiles"`
	Ignored         bool         `json:"ignored"`
	Upstream        string       `json:"upstream"`
	Ahead           int          `json:"ahead"`
	Behind          int          `json:"behind"`
	Published       bool         `json:"published"`
	PublishedRefs   []string     `json:"publishedRefs"`
	DefaultRef      string       `json:"defaultRef"`
	Merged          bool         `json:"merged"`
	MergeReason     string       `json:"mergeReason"`
	Fresh           bool         `json:"fresh"`
	GitHubState     string       `json:"githubState"`
	PR              *PullRequest `json:"pr,omitempty"`
	Recommended     bool         `json:"recommended"`
	CanRemove       bool         `json:"canRemove"`
	CanDiscard      bool         `json:"canDiscard"`
	DiscardWarnings []string     `json:"discardWarnings"`
	Blockers        []string     `json:"blockers"`
	Problems        []string     `json:"problems"`
}

type PullRequest struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Merged bool   `json:"merged"`
}

type Removal struct {
	ID   string `json:"id"`
	Head string `json:"head"`
}

type RemovalResult struct {
	Path           string `json:"path"`
	Removed        bool   `json:"removed"`
	Error          string `json:"error,omitempty"`
	RetainedBranch string `json:"retainedBranch,omitempty"`
}
