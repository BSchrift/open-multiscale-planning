package sync

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

var testNow = time.UnixMilli(1800000000000)

const goodClock = "1800000000000-000000-laptop"

func TestParseRequestAcceptsAWellFormedBody(t *testing.T) {
	req, err := ParseRequest([]byte(`{"cursor":412,"changes":[
		{"type":"task","id":"018f-abc","fields":{
			"title":{"v":"Write the report","c":"`+goodClock+`"},
			"estimate_min":{"v":30,"c":"`+goodClock+`"},
			"done_at":{"v":null,"c":"`+goodClock+`"}}}]}`), testNow)
	if err != nil {
		t.Fatal(err)
	}
	if req.Cursor != 412 || len(req.Changes) != 1 || req.Changes[0].ID != "018f-abc" || req.Changes[0].Type != "task" {
		t.Fatalf("got %+v", req)
	}
	if got := req.Changes[0].Fields["estimate_min"].V; got != json.Number("30") {
		t.Fatalf("number lost its form: %#v", got)
	}
}

func TestParseRequestAcceptsAPullWithNoChanges(t *testing.T) {
	req, err := ParseRequest([]byte(`{}`), testNow)
	if err != nil || req.Cursor != 0 || len(req.Changes) != 0 {
		t.Fatalf("got %+v, %v", req, err)
	}
}

// An app with a record type this server has never seen can be released first, so any well-formed type is taken.
func TestAnyWellFormedRecordTypeIsAccepted(t *testing.T) {
	for _, recordType := range []string{"objective", "project", "milestone", "task", "task_completion", "time_block",
		"block_outcome", "week_plan", "week_pick", "away_period", "settings", "calendar", "calendar_source", "practice",
		"a_type_no_app_has_yet", "x", strings.Repeat("x", 64)} {
		body := fmt.Sprintf(`{"changes":[{"type":%q,"id":"a","fields":{}}]}`, recordType)
		if _, err := ParseRequest([]byte(body), testNow); err != nil {
			t.Errorf("%s: %v", recordType, err)
		}
	}
}

func change(recordType, id, fields string) string {
	return fmt.Sprintf(`{"changes":[{"type":%q,"id":%q,"fields":%s}]}`, recordType, id, fields)
}

func field(name, value, clock string) string {
	return fmt.Sprintf(`{%q:{"v":%s,"c":%q}}`, name, value, clock)
}

func nested(depth int) string {
	return strings.Repeat("[", depth) + strings.Repeat("]", depth)
}

func TestParseRequestRefuses(t *testing.T) {
	tooMany := make([]string, 100)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf(`{"type":"task","id":"r%d","fields":{}}`, i)
	}
	ahead := func(d time.Duration) string {
		return fmt.Sprintf("%013d-000000-laptop", testNow.Add(d).UnixMilli())
	}
	cases := map[string]struct {
		body, code string
	}{
		"not json":         {`nope`, "invalid_json"},
		"trailing data":    {`{}{}`, "invalid_json"},
		"array body":       {`[]`, "invalid_json"},
		"fractional":       {`{"cursor":1.5}`, "invalid_json"},
		"string cursor":    {`{"cursor":"1"}`, "invalid_json"},
		"negative cursor":  {`{"cursor":-1}`, "invalid_cursor"},
		"over 99 records":  {`{"changes":[` + strings.Join(tooMany, ",") + `]}`, "too_many_changes"},
		"type in capitals": {change("Task", "a", `{}`), "unknown_type"},
		"type with a hash": {change("task#x", "a", `{}`), "unknown_type"},
		"type with space":  {change("time block", "a", `{}`), "unknown_type"},
		"type over 64":     {change(strings.Repeat("x", 65), "a", `{}`), "unknown_type"},
		"empty type":       {change("", "a", `{}`), "unknown_type"},
		"empty id":         {change("task", "", `{}`), "invalid_id"},
		"id with space":    {change("task", "a b", `{}`), "invalid_id"},
		"id with newline":  {change("task", "a\n", `{}`), "invalid_id"},
		"id not ascii":     {change("task", "café", `{}`), "invalid_id"},
		"id over 200":      {change("task", strings.Repeat("a", 201), `{}`), "invalid_id"},
		"no fields":        {`{"changes":[{"type":"task","id":"a"}]}`, "invalid_field"},
		"null fields":      {`{"changes":[{"type":"task","id":"a","fields":null}]}`, "invalid_field"},
		"empty field name": {change("task", "a", field("", `1`, goodClock)), "invalid_field"},
		"field named id":   {change("task", "a", field("id", `"b"`, goodClock)), "invalid_field"},
		"no clock":         {change("task", "a", `{"title":{"v":"x"}}`), "invalid_clock"},
		"null entry":       {change("task", "a", `{"title":null}`), "invalid_clock"},
		"short wall":       {change("task", "a", field("t", `1`, "180000000000-000000-a")), "invalid_clock"},
		"short counter":    {change("task", "a", field("t", `1`, "1800000000000-00000-a")), "invalid_clock"},
		"no device":        {change("task", "a", field("t", `1`, "1800000000000-000000-")), "invalid_clock"},
		"device space":     {change("task", "a", field("t", `1`, "1800000000000-000000-a b")), "invalid_clock"},
		"clock newline":    {change("task", "a", field("t", `1`, "1800000000000-000000-a\n")), "invalid_clock"},
		"clock over 24h":   {change("task", "a", field("t", `1`, ahead(24*time.Hour+time.Millisecond))), "clock_ahead"},
		"huge number":      {change("task", "a", field("t", `1e126`, goodClock)), "invalid_value"},
		"tiny number":      {change("task", "a", field("t", `1e-131`, goodClock)), "invalid_value"},
		"long number":      {change("task", "a", field("t", `1234567890123456789012345678901234567890`, goodClock)), "invalid_value"},
		"too deep":         {change("task", "a", field("t", nested(26), goodClock)), "invalid_value"},
		"empty map key":    {change("task", "a", field("t", `{"":1}`, goodClock)), "invalid_value"},
		"empty nested key": {change("task", "a", field("t", `[{"":1}]`, goodClock)), "invalid_value"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseRequest([]byte(c.body), testNow)
			var rejection *Rejection
			if !errors.As(err, &rejection) {
				t.Fatalf("want a rejection, got %v", err)
			}
			if rejection.Code != c.code {
				t.Fatalf("code %q, want %q", rejection.Code, c.code)
			}
		})
	}
}

func TestParseRequestLimits(t *testing.T) {
	maxed := make([]string, 99)
	for i := range maxed {
		maxed[i] = fmt.Sprintf(`{"type":"task","id":"r%d","fields":{}}`, i)
	}
	atLimit := fmt.Sprintf("%013d-000000-laptop", testNow.Add(24*time.Hour).UnixMilli())
	for name, body := range map[string]string{
		"99 records":      `{"changes":[` + strings.Join(maxed, ",") + `]}`,
		"id of 200":       change("task", strings.Repeat("a", 200), `{}`),
		"clock at 24h":    change("task", "a", field("t", `1`, atLimit)),
		"past clock":      change("task", "a", field("t", `1`, "0000000000001-000000-a")),
		"ordinary float":  change("task", "a", field("t", `1.5e10`, goodClock)),
		"zero":            change("task", "a", field("t", `0`, goodClock)),
		"nested ok":       change("task", "a", field("t", nested(25), goodClock)),
		"id with symbols": change("task", "outcome:occ-block:018f:2027-01-15", `{}`),
		"empty string":    change("task", "a", field("t", `""`, goodClock)),
		"unknown fields":  `{"extra":true,"changes":[{"type":"task","id":"a","fields":{},"more":1}]}`,
	} {
		if _, err := ParseRequest([]byte(body), testNow); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestRecordSizeLimit(t *testing.T) {
	// The body of one record is its fields as JSON: {"t":{"v":"...","c":"<clock>"}}.
	overhead := len(field("t", `""`, goodClock))
	fits := strings.Repeat("x", MaxRecordBytes-overhead)
	if _, err := ParseRequest([]byte(change("task", "a", field("t", `"`+fits+`"`, goodClock))), testNow); err != nil {
		t.Fatalf("a record of exactly the limit: %v", err)
	}
	_, err := ParseRequest([]byte(change("task", "a", field("t", `"`+fits+`x"`, goodClock))), testNow)
	var rejection *Rejection
	if !errors.As(err, &rejection) || rejection.Code != "record_too_large" {
		t.Fatalf("got %v", err)
	}
	if rejection.Status != 413 {
		t.Fatalf("status %d", rejection.Status)
	}
}

func TestSizeIgnoresHTMLEscaping(t *testing.T) {
	overhead := len(field("t", `""`, goodClock))
	fits := strings.Repeat("<", MaxRecordBytes-overhead)
	if _, err := ParseRequest([]byte(change("task", "a", field("t", `"`+fits+`"`, goodClock))), testNow); err != nil {
		t.Fatalf("%v", err)
	}
}

// Lambda refuses a request over 6 MB before any code runs, so a higher limit could never answer 413 on AWS.
func TestBodyLimitIsUnderLambdasRequestLimit(t *testing.T) {
	if MaxBodyBytes > 6<<20-256<<10 {
		t.Fatalf("MaxBodyBytes %d leaves no room under Lambda's 6 MB", MaxBodyBytes)
	}
}

// A task's notes stop at MaxNotesChars characters, counted as code points, so an emoji is one. Released apps never send
// notes, and apps that do stop at the same count of UTF-16 units, which is never fewer.
func TestNotesLimit(t *testing.T) {
	notes := func(recordType, value string) error {
		_, err := ParseRequest([]byte(change(recordType, "a", field("notes", value, goodClock))), testNow)
		return err
	}
	text := func(s string) string { return fmt.Sprintf("%q", s) }
	for name, value := range map[string]string{
		"at the limit":         text(strings.Repeat("x", MaxNotesChars)),
		"emoji at the limit":   text(strings.Repeat("🌲", MaxNotesChars)),
		"accents at the limit": text(strings.Repeat("é", MaxNotesChars)),
		"cleared":              `null`,
		"empty":                `""`,
	} {
		if err := notes("task", value); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	for name, c := range map[string]struct{ value, code string }{
		"one over":       {text(strings.Repeat("x", MaxNotesChars+1)), "notes_too_long"},
		"one emoji over": {text(strings.Repeat("🌲", MaxNotesChars+1)), "notes_too_long"},
		"a number":       {`1`, "invalid_value"},
		"a list":         {`["x"]`, "invalid_value"},
	} {
		var rejection *Rejection
		if err := notes("task", c.value); !errors.As(err, &rejection) || rejection.Code != c.code {
			t.Errorf("%s: got %v, want %s", name, err, c.code)
		}
	}
	// Other record types have no notes yet, so the name means nothing there.
	if err := notes("project", `1`); err != nil {
		t.Errorf("a project's notes: %v", err)
	}
}
