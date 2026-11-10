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
	paths := []string{"protocol.yaml", "env/local.yaml", "env/staging.yaml", "env/prod.yaml"}
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
	_, _, err := load(fsys)
	if err == nil {
		t.Fatal("loaded")
	}
	return err.Error()
}

func TestBuiltInFilesLoad(t *testing.T) {
	if _, _, err := load(files(t)); err != nil {
		t.Fatal(err)
	}
	if Protocol.Sync.MaxChanges == 0 {
		t.Fatal("Protocol is empty")
	}
}

func TestForEnv(t *testing.T) {
	prod, err := ForEnv("prod")
	if err != nil || !prod.Stack.TerminationProtection {
		t.Fatalf("prod: %+v, %v", prod, err)
	}
	for _, name := range []string{"", "dev", "Prod"} {
		if _, err := ForEnv(name); err == nil || !strings.Contains(err.Error(), "use local, staging or prod") {
			t.Errorf("%q: %v", name, err)
		}
	}
}

func TestCanaryIsOneCodeDeployAccepts(t *testing.T) {
	staging, _ := ForEnv("staging")
	prod, _ := ForEnv("prod")
	if staging.Stack.CanaryPercent != 5 || staging.Stack.CanaryMinutes != 10 {
		t.Errorf("staging's canary is short, so a release there is quick to test: %+v", staging.Stack)
	}
	if prod.Stack.CanaryPercent != 10 || prod.Stack.CanaryMinutes != 90 {
		t.Errorf("prod's canary is 10%% for 90 minutes: %+v", prod.Stack)
	}
	// CodeDeploy shifts at most 99% in one step, and CloudFormation waits about 2 hours for the whole deployment.
	if problems := loadProblems(t, files(t, "canaryPercent: 5", "canaryPercent: 100")); !strings.Contains(problems, ".yaml: stack.canaryPercent is 100") {
		t.Errorf("all traffic in the first step: %s", problems)
	}
	if problems := loadProblems(t, files(t, "canaryMinutes: 90", "canaryMinutes: 101")); !strings.Contains(problems, "env/prod.yaml: stack.canaryMinutes is 101") {
		t.Errorf("longer than CloudFormation waits: %s", problems)
	}
}

func TestThrottlesStopReleasesOnlyOnProd(t *testing.T) {
	// Staging's test load goes through the API, so its throttles can come from a test rather than a release.
	for name, want := range map[string]bool{"local": false, "staging": false, "prod": true} {
		if env, _ := ForEnv(name); env.Stack.ThrottleReleaseAlarm != want {
			t.Errorf("%s: throttleReleaseAlarm %v", name, env.Stack.ThrottleReleaseAlarm)
		}
	}
}

func TestEveryEnvironmentHasACompleteFile(t *testing.T) {
	missing := files(t)
	delete(missing, "env/staging.yaml")
	if problems := loadProblems(t, missing); !strings.Contains(problems, "env/staging.yaml is missing") {
		t.Errorf("a missing file: %s", problems)
	}
	extra := files(t)
	extra["env/dev.yaml"] = extra["env/local.yaml"]
	if problems := loadProblems(t, extra); !strings.Contains(problems, "env/dev.yaml is not an environment") {
		t.Errorf("an extra file: %s", problems)
	}
	// Nothing is inherited, so a key one file leaves out is an error, not a default.
	if problems := loadProblems(t, files(t, "  terminationProtection: true\n", "")); !strings.Contains(problems, "env/prod.yaml is missing stack.terminationProtection") {
		t.Errorf("a missing key: %s", problems)
	}
	if problems := loadProblems(t, files(t, "stack:\n", "stack:\n  removalPolicy: retain\n")); !strings.Contains(problems, "field removalPolicy not found") {
		t.Errorf("an unknown key: %s", problems)
	}
	both := files(t)
	delete(both, "env/prod.yaml")
	both["protocol.yaml"].Data = bytes.Replace(both["protocol.yaml"].Data, []byte("maxChanges: 99"), []byte("maxChanges: 0"), 1)
	if problems := loadProblems(t, both); !strings.Contains(problems, "env/prod.yaml is missing") || !strings.Contains(problems, "sync.maxChanges must be positive") {
		t.Errorf("every file's problems at once: %s", problems)
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
