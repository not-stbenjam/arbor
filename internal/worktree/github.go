package worktree

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var slugPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func githubRepo(remote string) string {
	var slug string
	if strings.HasPrefix(remote, "git@github.com:") {
		slug = strings.TrimPrefix(remote, "git@github.com:")
	} else {
		u, err := url.Parse(remote)
		if err != nil || !strings.EqualFold(u.Hostname(), "github.com") || (u.Scheme != "https" && u.Scheme != "ssh" && u.Scheme != "git") {
			return ""
		}
		slug = strings.TrimPrefix(u.Path, "/")
	}
	slug = strings.TrimSuffix(strings.TrimSuffix(slug, "/"), ".git")
	if !slugPattern.MatchString(slug) {
		return ""
	}
	return strings.ToLower(slug)
}

type githubPull struct {
	Number   int        `json:"number"`
	URL      string     `json:"html_url"`
	Title    string     `json:"title"`
	State    string     `json:"state"`
	MergedAt *time.Time `json:"merged_at"`
	Head     struct {
		SHA  string `json:"sha"`
		Ref  string `json:"ref"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref  string `json:"ref"`
		Repo struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"base"`
}

func matchingPull(p githubPull, w *Worktree, repos map[string]bool) bool {
	return p.Head.SHA == w.Head && p.Head.Ref == w.Branch && p.Head.Repo != nil && repos[strings.ToLower(p.Head.Repo.FullName)]
}

func ghAPI(ctx context.Context, endpoint string, target any) error {
	raw, err := run(ctx, 25*time.Second, "gh", "api", "--hostname", "github.com", "-H", "Accept: application/vnd.github+json", endpoint)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(raw), target)
}

func checkGitHub(ctx context.Context, w *Worktree) {
	repos := map[string]bool{}
	var ordered []string
	for _, remote := range strings.Fields(gitText(ctx, w.Path, "remote")) {
		slug := githubRepo(gitText(ctx, w.Path, "remote", "get-url", remote))
		if slug != "" && !repos[slug] {
			repos[slug] = true
			ordered = append(ordered, slug)
		}
	}
	if len(repos) == 0 {
		w.GitHubState = "not_github"
		return
	}
	w.GitHubState = "no_pr"
	anySuccess := false
	for _, repo := range ordered {
		var pulls []githubPull
		if err := ghAPI(ctx, "repos/"+repo+"/commits/"+w.Head+"/pulls?per_page=100", &pulls); err != nil {
			continue
		}
		anySuccess = true
		for _, p := range pulls {
			if !matchingPull(p, w, repos) {
				continue
			}
			w.GitHubState = "verified"
			w.Published = true
			w.PR = &PullRequest{Number: p.Number, URL: p.URL, Title: p.Title, State: p.State, Merged: p.MergedAt != nil}
			if p.MergedAt != nil && repos[strings.ToLower(p.Base.Repo.FullName)] {
				var base struct {
					DefaultBranch string `json:"default_branch"`
				}
				if err := ghAPI(ctx, "repos/"+p.Base.Repo.FullName, &base); err == nil && base.DefaultBranch != "" && p.Base.Ref == base.DefaultBranch {
					w.Merged = true
					w.MergeReason = "GitHub PR #" + strconv.Itoa(p.Number) + " merged this exact commit into " + p.Base.Ref
					return
				}
			}
		}
	}
	if !anySuccess {
		w.GitHubState = "unavailable"
	}
}
