package config

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

// files is the built-in files with edits, each an old and a new string in one of them.
func files(t *testing.T, edits ...string) fstest.MapFS {
	t.Helper()
	out := fstest.MapFS{}
	paths := []string{"protocol.yaml"}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		out[path] = &fstest.MapFile{Data: raw}
	}
	for i := 0; i+1 < len(edits); i += 2 {
		found := false
		for _, file := range out {
			if bytes.Contains(file.Data, []byte(edits[i])) {
				file.Data = bytes.Replace(file.Data, []byte(edits[i]), []byte(edits[i+1]), 1)
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("no file has %q", edits[i])
		}
	}
	return out
}

func loadProblems(t *testing.T, fsys fstest.MapFS) string {
	t.Helper()
	_, err := load(fsys)
	if err == nil {
		t.Fatal("loaded")
	}
	return err.Error()
}

func TestBuiltInFilesLoad(t *testing.T) {
	if _, err := load(files(t)); err != nil {
		t.Fatal(err)
	}
	if Protocol.Sync.MaxChanges == 0 {
		t.Fatal("Protocol is empty")
	}
}

func TestRefusesUnknownAndMissingKeys(t *testing.T) {
	if problems := loadProblems(t, files(t, "  maxChanges:", "  maxChange:")); !strings.Contains(problems, "maxChange not found") {
		t.Errorf("a misspelt key: %s", problems)
	}
	if problems := loadProblems(t, files(t, "  maxClockAheadHours: 24\n", "")); !strings.Contains(problems, "protocol.yaml is missing sync.maxClockAheadHours") {
		t.Errorf("a missing key: %s", problems)
	}
}

func TestRules(t *testing.T) {
	for _, c := range []struct {
		name       string
		edits      []string
		wantInMsgs []string
	}{
		{"zero", []string{"mergedRoomBytes: 1024", "mergedRoomBytes: 0"}, []string{"sync.mergedRoomBytes must be positive"}},
		{"negative", []string{"maxClockAheadHours: 24", "maxClockAheadHours: -1"}, []string{"sync.maxClockAheadHours must be positive"}},
		{"a change past the transaction", []string{"maxChanges: 99", "maxChanges: 100"}, []string{"sync.maxChanges is 100"}},
		{"a batch past the body", []string{"clientBatchBytes: 4194304", "clientBatchBytes: 5242880"}, []string{"sync.maxBodyBytes is 5242880"}},
		{"a body past Lambda's", []string{"maxBodyBytes: 5242880", "maxBodyBytes: 6291456"}, []string{"sync.maxBodyBytes is 6291456"}},
		{"an id pattern Go can't read", []string{`idPattern: '^[\x21-\x7e]{1,200}$'`, `idPattern: '^[\x21-\x7e{1,200}$'`}, []string{"records.idPattern doesn't compile"}},
		{"an empty pattern", []string{`idPattern: '^[\x21-\x7e]{1,200}$'`, `idPattern: ''`}, []string{"records.idPattern must be set"}},
		{"a clock without its parts", []string{`pattern: '^(\d{13})-(\d{6})-([\x21-\x7e]+)$'`, `pattern: '^\d{13}-\d{6}-[\x21-\x7e]+$'`}, []string{"clock.pattern has 0 groups"}},
		{"no telemetry", []string{"maxBatchEvents: 200", "maxBatchEvents: 0"}, []string{"telemetry.maxBatchEvents must be positive"}},
		{
			"every problem at once",
			[]string{"maxChanges: 99", "maxChanges: 0", "maxRecordBytes: 102400", "maxRecordBytes: 2097152"},
			[]string{"sync.maxChanges must be positive", "sync.maxBodyBytes is 5242880"},
		},
	} {
		problems := loadProblems(t, files(t, c.edits...))
		for _, want := range c.wantInMsgs {
			if !strings.Contains(problems, want) {
				t.Errorf("%s: %q doesn't say %q", c.name, problems, want)
			}
		}
	}
}

// CI's check that app.gen.ts was regenerated after the YAML changed.
func TestTypeScriptIsCurrent(t *testing.T) {
	want, err := TypeScript()
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile("app.gen.ts")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("app.gen.ts is out of date: run go generate in config/")
	}
}
