package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func example(t *testing.T, env string) string {
	t.Helper()
	raw, err := os.ReadFile(env + ".example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// folder writes each file under its real name into a fresh config folder.
func folder(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestCommittedExamplesLoad(t *testing.T) {
	dir := folder(t, map[string]string{
		"control.yaml": example(t, "control"), "staging.yaml": example(t, "staging"), "prod.yaml": example(t, "prod"),
	})
	control, err := LoadControl(dir)
	if err != nil {
		t.Fatal(err)
	}
	if control.AWS.Account != "333333333333" || control.AWS.Profile != "multiscale-control" || control.DNS == nil || control.DNS.Domain != "example.com" {
		t.Fatalf("%+v", control)
	}
	for _, env := range []string{"staging", "prod"} {
		got, err := Load(dir, env)
		if err != nil {
			t.Fatal(err)
		}
		if got.AWS.Region != "us-west-2" || got.AWS.Profile != "multiscale-"+env || got.AlarmEmail != "you@example.com" ||
			got.Auth.CognitoDomainPrefix != "multiscale-"+env+"-change-me" || len(got.Auth.SignInCallbackURLs) == 0 ||
			got.DNS == nil || !strings.HasSuffix(got.DNS.Zone, ".example.com") ||
			got.Integration.TestUser != "integration-test@example.com" || len(got.Integration.Capabilities) != 1 || got.App != nil {
			t.Fatalf("%s: %+v", env, got)
		}
	}
}

func TestOptionalParts(t *testing.T) {
	staging := strings.Replace(example(t, "staging"), "capabilities: [googleClient]",
		"capabilities: [googleClient, secondUser]\n  secondTestUser: second-test@example.com", 1)
	staging = strings.Replace(staging, "dns:\n  zone: staging.example.com", "app:\n  bundleId: com.example.planner", 1)
	got, err := Load(folder(t, map[string]string{"staging.yaml": staging}), "staging")
	if err != nil {
		t.Fatal(err)
	}
	if got.Integration.SecondTestUser != "second-test@example.com" || got.App == nil || got.App.BundleID != "com.example.planner" || got.DNS != nil {
		t.Fatalf("%+v", got)
	}

	control, err := LoadControl(folder(t, map[string]string{"control.yaml": withoutDNS(t)}))
	if err != nil || control.DNS != nil {
		t.Fatalf("%+v %v", control, err)
	}
}

func TestMissingFileSaysWhatToCopy(t *testing.T) {
	dir := t.TempDir()
	for env, load := range map[string]func() error{
		"staging": func() error { _, err := Load(dir, "staging"); return err },
		"prod":    func() error { _, err := Load(dir, "prod"); return err },
		"control": func() error { _, err := LoadControl(dir); return err },
	} {
		err := load()
		wantFile, wantExample := filepath.Join(dir, env+".yaml"), filepath.Join(examples, env+".example.yaml")
		if err == nil || !strings.Contains(err.Error(), wantFile) || !strings.Contains(err.Error(), wantExample) {
			t.Errorf("%s: %v", env, err)
		}
	}
	if _, err := os.Stat(filepath.Join(examples, "staging.example.yaml")); err != nil {
		t.Fatalf("the examples folder is wrong: %v", err)
	}
}

func TestOnlyStagingAndProdHaveEnvironmentFiles(t *testing.T) {
	dir := folder(t, map[string]string{"local.yaml": example(t, "staging"), "control.yaml": example(t, "staging")})
	for _, env := range []string{"local", "control", "dev", "", "../staging"} {
		if _, err := Load(dir, env); err == nil || !strings.Contains(err.Error(), "staging or prod") {
			t.Errorf("%q: %v", env, err)
		}
	}
}

// withoutDNS is the example control.yaml with its dns section, the last in the file, cut off.
func withoutDNS(t *testing.T) string {
	before, _, found := strings.Cut(example(t, "control"), "dns:\n")
	if !found {
		t.Fatal("the example no longer has a dns section")
	}
	return before
}

func TestInvalidFilesAreRefused(t *testing.T) {
	staging, control := example(t, "staging"), example(t, "control")
	edit := func(body, old, new string) string {
		t.Helper()
		if !strings.Contains(body, old) {
			t.Fatalf("the example no longer has %q", old)
		}
		return strings.Replace(body, old, new, 1)
	}
	cases := []struct{ name, file, body, wants string }{
		{"misspelt key", "staging", edit(staging, "alarmEmail:", "alarmEmial:"), "alarmEmial"},
		{"misspelt nested key", "staging", edit(staging, "profile:", "profiel:"), "profiel"},
		{"old bundleId key", "staging", staging + "bundleId: com.example.planner\n", "bundleId"},
		{"secret in the file", "staging", edit(staging, "  capabilities:", "  testUserPassword: hunter2\n  capabilities:"), "testUserPassword"},
		{"duplicate key", "staging", staging + "alarmEmail: other@example.com\n", "alarmEmail"},
		{"not YAML", "staging", "aws: [", "staging.yaml"},
		{"empty", "staging", "# nothing yet\n", "empty"},
		{"unquoted account", "staging", edit(staging, `"111111111111"`, "111111111111"), "aws.account"},
		{"short account", "staging", edit(staging, `"111111111111"`, `"1111"`), "aws.account"},
		{"no account", "staging", edit(staging, `  account: "111111111111" # may be the same account as prod or control`+"\n", ""), "aws.account"},
		{"no region", "staging", edit(staging, "region: us-west-2", "region: ''"), "aws.region"},
		{"no profile", "staging", edit(staging, "profile: multiscale-staging", "profile:"), "aws.profile"},
		{"no alarm email", "staging", edit(staging, "alarmEmail: you@example.com", "alarmEmail: ''"), "alarmEmail"},
		{"no domain prefix", "staging", edit(staging, "cognitoDomainPrefix: multiscale-staging-change-me", "cognitoDomainPrefix: ''"), "auth.cognitoDomainPrefix"},
		{"no callbacks", "staging", edit(staging, "    - multiscale-staging://auth/callback\n    - multiscale://auth/callback\n", ""), "auth.signInCallbackUrls"},
		{"dns without a zone", "staging", edit(staging, "zone: staging.example.com", "zone: ''"), "dns.zone"},
		{"app without a bundle id", "staging", staging + "app: {}\n", "app.bundleId"},
		{"no test user", "staging", edit(staging, "testUser: integration-test@example.com", "testUser: ''"), "integration.testUser"},
		{"second user without a name", "staging", edit(staging, "[googleClient]", "[googleClient, secondUser]"), "integration.secondTestUser"},
		{"control misspelt key", "control", edit(control, "domain:", "domian:"), "domian"},
		{"control with environment keys", "control", control + "alarmEmail: you@example.com\n", "alarmEmail"},
		{"control unquoted account", "control", edit(control, `"333333333333"`, "333333333333"), "aws.account"},
		{"control dns without a domain", "control", edit(control, "domain: example.com", "domain: ''"), "dns.domain"},
		{"control dns without a zone id", "control", edit(control, "hostedZoneId: Z0123456789EXAMPLE", "hostedZoneId: ''"), "dns.hostedZoneId"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := folder(t, map[string]string{c.file + ".yaml": c.body})
			var err error
			if c.file == "control" {
				_, err = LoadControl(dir)
			} else {
				_, err = Load(dir, c.file)
			}
			if err == nil || !strings.Contains(err.Error(), c.wants) {
				t.Fatalf("got %v, want an error about %q", err, c.wants)
			}
			if !strings.Contains(err.Error(), filepath.Join(dir, c.file+".yaml")) {
				t.Fatalf("the error doesn't name the file: %v", err)
			}
			if strings.Contains(err.Error(), "hunter2") {
				t.Fatalf("the error quotes a value: %v", err)
			}
		})
	}
}

func TestDir(t *testing.T) {
	t.Setenv("MULTISCALE_CONFIG_DIR", "")
	if Dir() != examples || !filepath.IsAbs(examples) {
		t.Fatalf("default %q, want this module's folder %q", Dir(), examples)
	}
	mine := t.TempDir()
	t.Setenv("MULTISCALE_CONFIG_DIR", mine)
	if Dir() != mine {
		t.Fatalf("%q", Dir())
	}
	t.Chdir(mine)
	t.Setenv("MULTISCALE_CONFIG_DIR", "private")
	if Dir() != filepath.Join(mine, "private") {
		t.Fatalf("a relative folder must come back absolute, got %q", Dir())
	}
}
