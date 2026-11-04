package main

import (
	"encoding/json"
	"testing"
)

func TestTriggerOf(t *testing.T) {
	for payload, want := range map[string]string{
		`{"Records":[{"eventName":"MODIFY"}]}`: "stream",
		`{"trigger":"refresh"}`:                "refresh",
		`{}`:                                   "schedule",
		`{"version":"0","source":"aws.scheduler"}`: "schedule",
		`null`:     "schedule",
		`not json`: "schedule",
	} {
		if got := triggerOf(json.RawMessage(payload)); got != want {
			t.Errorf("%s: %s", payload, got)
		}
	}
}
