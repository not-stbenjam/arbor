package main

import (
	"strings"
	"testing"
)

func TestFriendlyBooleanAndDurationErrors(t *testing.T) {
	isolatedCommandEnvironment(t)
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"list", "--json=maybe"}, `--json takes true or false, not "maybe"`},
		{[]string{"clean", "-y=perhaps"}, `--yes takes true or false, not "perhaps"`},
		{[]string{"list", "--strict=never"}, `--strict takes true or false, not "never"`},
		{[]string{"list", "--older-than=yesterday"}, `--older-than takes a positive duration (for example 30d, 12h or 2w), not "yesterday"`},
		{[]string{"clean", "--older-than=-1d"}, `--older-than takes a positive duration (for example 30d, 12h or 2w), not "-1d"`},
		{[]string{"list", "--older-than=0h"}, `--older-than takes a positive duration (for example 30d, 12h or 2w), not "0h"`},
		{[]string{"list", "--unknown"}, `unknown flag: --unknown`},
		{[]string{"list", "--path"}, `flag needs an argument: --path`},
	} {
		_, _, err := commandOutput(t, tc.args...)
		if exitStatus(err) != 2 || !strings.HasPrefix(err.Error(), tc.want+"\nRun '") {
			t.Errorf("%v: %v", tc.args, err)
		}
	}
}
