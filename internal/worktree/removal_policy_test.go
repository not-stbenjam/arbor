package worktree

import "testing"

func TestRemovalPolicyEveryReasonHasExplicitBehavior(t *testing.T) {
	allowed := map[reasonCode]bool{
		reasonDirty: true, reasonIgnored: true, reasonLocked: true,
		reasonDetached: true, reasonMissing: true, reasonEmpty: true,
		reasonDefaultBranch: true, reasonProtectedBranch: true,
		reasonUnchecked: true, reasonSubmodules: true,
		reasonOperation: true, reasonNested: true,
	}
	protected := []reasonCode{reasonPrimary, reasonBare, reasonOutside, reasonUnverifiedPath,
		reasonNoCommit, reasonStatus, reasonIndex, reasonSubmoduleInspection,
		reasonMetadata, reasonFiles}
	if len(allowed)+len(protected) != int(reasonCount) || len(reasonDescriptions) != int(reasonCount) {
		t.Fatal("a new policy reason needs an explicit behavior test")
	}
	seen := map[reasonCode]bool{}
	for reason := reasonCode(0); reason < reasonCount; reason++ {
		t.Run(reasonMessage(reason), func(t *testing.T) {
			decision := evaluateRemoval(removalFacts{verified: true, merged: true, reasons: []reasonCode{reason}})
			if decision.canRemove || decision.recommended || decision.canDiscard != allowed[reason] {
				t.Fatalf("wrong manual/automatic behavior: %+v", decision)
			}
			if allowed[reason] && reason != reasonDefaultBranch && reason != reasonProtectedBranch && len(decision.warnings) != 1 {
				t.Fatalf("manual disposal needs one explanatory warning: %+v", decision)
			}
			if !allowed[reason] && len(decision.warnings) != 0 {
				t.Fatalf("protected reason suggested disposal: %+v", decision)
			}
		})
		seen[reason] = true
	}
	for _, reason := range protected {
		if !seen[reason] || allowed[reason] {
			t.Fatalf("invalid protected reason coverage %v", reason)
		}
	}
}

func TestRemovalPolicyRequiresVerifiedInspectionAndConservativeRecommendations(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		facts                        removalFacts
		remove, discard, recommended bool
	}{
		{"unverified", removalFacts{}, false, false, false},
		{"inspection failure", removalFacts{verified: true, problems: true, merged: true}, false, false, false},
		{"clean unmerged", removalFacts{verified: true}, true, true, false},
		{"clean merged", removalFacts{verified: true, merged: true}, true, true, true},
		{"unknown reason", removalFacts{verified: true, reasons: []reasonCode{255}}, false, false, false},
		{"manual then structural", removalFacts{verified: true, reasons: []reasonCode{reasonDirty, reasonMetadata}}, false, false, false},
		{"multiple manual reasons", removalFacts{verified: true, merged: true, reasons: []reasonCode{reasonDirty, reasonIgnored, reasonLocked}}, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := evaluateRemoval(tc.facts)
			if got.canRemove != tc.remove || got.canDiscard != tc.discard || got.recommended != tc.recommended {
				t.Fatalf("wrong decision: %+v", got)
			}
			if !got.canDiscard && len(got.warnings) != 0 {
				t.Fatal("refused removal must not retain disposal warnings")
			}
		})
	}
}
