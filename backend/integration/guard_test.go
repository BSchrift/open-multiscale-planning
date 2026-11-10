package integration

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

// These run with no target at all, as part of the ordinary backend tests. Nothing here calls AWS.

const goodStaging = `aws: {account: "111111111111", region: us-west-2, profile: multiscale-staging}
alarmEmail: you@example.test
auth: {cognitoDomainPrefix: multiscale-test, signInCallbackUrls: ["multiscale://auth/callback"]}
integration: {testUser: test@example.test, capabilities: [googleClient]}
`

const goodOutputs = `{"ApiUrl":"https://api.example.test","TestClientId":"abc","AppClientId":"app","Region":"us-west-2"}`

// configFolder writes <env>.yaml and <env>.outputs.json into a fresh config folder, leaving out any that are empty.
func configFolder(t *testing.T, env, file, outputs string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{env + ".yaml": file, env + ".outputs.json": outputs} {
		if body == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// fakeSSM stands in for the SSM parameters, and records what was read and as whom.
type fakeSSM struct {
	values map[string]string
	read   []string
	as     []appconfig.AWS
}

func (f *fakeSSM) get(account appconfig.AWS, name string) (string, error) {
	f.read = append(f.read, name)
	f.as = append(f.as, account)
	value, ok := f.values[name]
	if !ok {
		return "", errors.New("ParameterNotFound")
	}
	return value, nil
}

func passwords(env string) *fakeSSM {
	return &fakeSSM{values: map[string]string{
		"/multiscale/" + env + "/test-user-password":        "pw",
		"/multiscale/" + env + "/second-test-user-password": "pw2",
	}}
}

func TestConfigGuards(t *testing.T) {
	withSecond := strings.Replace(goodStaging, "[googleClient]", "[googleClient, secondUser], secondTestUser: other@example.test", 1)
	cases := []struct {
		name, env, confirm, file, outputs, api, wants string
		ssm                                           *fakeSSM
	}{
		{name: "unknown environment", env: "dev", wants: "ENV must be"},
		{name: "control is not a target", env: "control", wants: "ENV must be"},
		{name: "prod unconfirmed", env: "prod", file: goodStaging, outputs: goodOutputs, wants: "CONFIRM_PROD=yes"},
		{name: "prod half confirmed", env: "prod", confirm: "true", file: goodStaging, outputs: goodOutputs, wants: "CONFIRM_PROD=yes"},
		{name: "misspelt key", env: "staging", file: strings.Replace(goodStaging, "testUser", "testuser", 1), outputs: goodOutputs, wants: "testuser"},
		{name: "outputs not JSON", env: "staging", file: goodStaging, outputs: `{`, wants: "staging.outputs.json"},
		{name: "plain http", env: "staging", file: goodStaging, outputs: strings.Replace(goodOutputs, "https:", "http:", 1), wants: "ApiUrl"},
		{name: "no test client", env: "staging", file: goodStaging, outputs: strings.Replace(goodOutputs, `"abc"`, `""`, 1), wants: "TestClientId"},
		{name: "unknown capability", env: "staging", file: strings.Replace(goodStaging, "googleClient", "googleClinet", 1), outputs: goodOutputs, wants: "googleClinet"},
		{name: "emulator control on a deployment", env: "staging", file: strings.Replace(goodStaging, "googleClient", "fakeClock", 1), outputs: goodOutputs, wants: "fakeClock"},
		{name: "second user unnamed", env: "staging", file: strings.Replace(goodStaging, "googleClient", "secondUser", 1), outputs: goodOutputs, wants: "secondTestUser"},
		{name: "no password", env: "staging", file: goodStaging, outputs: goodOutputs, ssm: &fakeSSM{}, wants: "/multiscale/staging/test-user-password"},
		{name: "empty password", env: "staging", file: goodStaging, outputs: goodOutputs, ssm: &fakeSSM{values: map[string]string{"/multiscale/staging/test-user-password": ""}}, wants: "/multiscale/staging/test-user-password"},
		{name: "no second password", env: "staging", file: withSecond, outputs: goodOutputs, ssm: &fakeSSM{values: map[string]string{"/multiscale/staging/test-user-password": "pw"}}, wants: "/multiscale/staging/second-test-user-password"},
		{name: "local without an address", env: "local", wants: "INTEGRATION_API_URL"},
		{name: "local pointing away", env: "local", api: "https://api.example.test", wants: "loopback"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ssm := c.ssm
			if ssm == nil {
				ssm = passwords(c.env)
			}
			_, err := loadConfig(c.env, c.confirm, configFolder(t, c.env, c.file, c.outputs), c.api, ssm.get)
			if err == nil || !strings.Contains(err.Error(), c.wants) {
				t.Fatalf("got %v, want an error about %q", err, c.wants)
			}
			if strings.Contains(err.Error(), "pw") {
				t.Fatalf("the error quotes a password: %v", err)
			}
		})
	}
}

// A file that's wrong stops the run before it asks SSM for anything.
func TestBadConfigReadsNoSecrets(t *testing.T) {
	ssm := passwords("staging")
	for _, folder := range []string{
		configFolder(t, "staging", strings.Replace(goodStaging, "googleClient", "fakeClock", 1), goodOutputs),
		configFolder(t, "staging", goodStaging, strings.Replace(goodOutputs, "https:", "http:", 1)),
		configFolder(t, "staging", goodStaging, ""),
	} {
		if _, err := loadConfig("staging", "", folder, "", ssm.get); err == nil {
			t.Fatal("accepted")
		}
	}
	if len(ssm.read) != 0 {
		t.Fatalf("read %v", ssm.read)
	}
}

func TestConfigAccepted(t *testing.T) {
	ssm := passwords("staging")
	cfg, err := loadConfig("staging", "", configFolder(t, "staging", goodStaging, goodOutputs), "", ssm.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIURL != "https://api.example.test" || cfg.ClientID != "abc" || cfg.Region != "us-west-2" || cfg.SecondUser != nil ||
		*cfg.TestUser != (testUser{"test@example.test", "pw"}) || !cfg.has(googleClient) || cfg.has(secondUser) {
		t.Fatalf("%+v", cfg)
	}
	if !slices.Equal(ssm.read, []string{"/multiscale/staging/test-user-password"}) || ssm.as[0].Profile != "multiscale-staging" || ssm.as[0].Region != "us-west-2" {
		t.Fatalf("read %v as %+v", ssm.read, ssm.as)
	}

	ssm = passwords("prod")
	file := strings.Replace(goodStaging, "[googleClient]", "[googleClient, secondUser], secondTestUser: other@example.test", 1)
	cfg, err = loadConfig("prod", "yes", configFolder(t, "prod", file, goodOutputs), "https://ignored.example.test", ssm.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIURL != "https://api.example.test" {
		t.Fatalf("a deployed target took its address from outside its config folder: %s", cfg.APIURL)
	}
	if *cfg.SecondUser != (testUser{"other@example.test", "pw2"}) || len(ssm.read) != 2 {
		t.Fatalf("%+v read %v", cfg.SecondUser, ssm.read)
	}
}

// Local has no files at all: cmd/local's client, every capability, and the stack the script started.
func TestLocalUsesBuiltInDefaults(t *testing.T) {
	ssm := passwords("local")
	cfg, err := loadConfig("local", "", filepath.Join(t.TempDir(), "absent"), "http://127.0.0.1:9", ssm.get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIURL != "http://127.0.0.1:9" || cfg.ClientID != "local-client" || len(ssm.read) != 0 {
		t.Fatalf("%+v read %v", cfg, ssm.read)
	}
	for _, capability := range append(slices.Clone(capabilities), filesStored) {
		if !cfg.has(capability) {
			t.Errorf("local is missing %s", capability)
		}
	}
}

// A deployment stores files once make files-key has written its files section, and only then are the files tests run
// against it. The section decides, so the capability can't be listed by hand.
func TestFilesAreTestedWhereTheDeploymentStoresThem(t *testing.T) {
	stored := goodStaging + "files: {keys: {k1: a public key}, signWith: k1}\n"
	for file, want := range map[string]bool{goodStaging: false, stored: true} {
		cfg, err := loadConfig("staging", "", configFolder(t, "staging", file, goodOutputs), "", passwords("staging").get)
		if err != nil || cfg.has(filesStored) != want {
			t.Errorf("files section %v: %v %v", want, cfg, err)
		}
	}
	listed := strings.Replace(goodStaging, "[googleClient]", "[googleClient, filesStored]", 1)
	if _, err := loadConfig("staging", "", configFolder(t, "staging", listed, goodOutputs), "", passwords("staging").get); err == nil || !strings.Contains(err.Error(), "unknown capability") {
		t.Errorf("listed by hand: %v", err)
	}
}

func TestMissingFilesSayWhatToDo(t *testing.T) {
	dir := configFolder(t, "staging", "", "")
	_, err := loadConfig("staging", "", dir, "", passwords("staging").get)
	if err == nil || !strings.Contains(err.Error(), filepath.Join(dir, "staging.yaml")) || !strings.Contains(err.Error(), "staging.example.yaml") {
		t.Fatalf("%v", err)
	}
	dir = configFolder(t, "prod", goodStaging, "")
	_, err = loadConfig("prod", "yes", dir, "", passwords("prod").get)
	if err == nil || !strings.Contains(err.Error(), filepath.Join(dir, "prod.outputs.json")) || !strings.Contains(err.Error(), "make deploy ENV=prod") {
		t.Fatalf("%v", err)
	}
}

// The committed examples work with the suite once a deploy has written the outputs.
func TestCommittedExamples(t *testing.T) {
	for _, env := range []string{"staging", "prod"} {
		raw, err := os.ReadFile(filepath.Join("../../config", env+".example.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := loadConfig(env, "yes", configFolder(t, env, string(raw), goodOutputs), "", passwords(env).get); err != nil {
			t.Fatalf("%s example: %v", env, err)
		}
	}
}

// The script refuses before it starts anything or sends a request. It runs from an empty copy of the repo, so the
// missing-file cases still hold once the real files exist on this machine.
func TestScriptGuards(t *testing.T) {
	src, err := os.ReadFile("../../scripts/integration.sh")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	script := filepath.Join(root, "scripts", "integration.sh")
	if err := os.Mkdir(filepath.Dir(script), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, src, 0o755); err != nil {
		t.Fatal(err)
	}
	mine := configFolder(t, "staging", goodStaging, "")
	cases := []struct {
		name  string
		env   []string
		wants []string
	}{
		{"unknown environment", []string{"ENV=dev"}, []string{"ENV must be"}},
		{"control is not a target", []string{"ENV=control"}, []string{"ENV must be"}},
		{"prod unconfirmed", []string{"ENV=prod"}, []string{"CONFIRM_PROD=yes"}},
		{"prod half confirmed", []string{"ENV=prod", "CONFIRM_PROD=1"}, []string{"CONFIRM_PROD=yes"}},
		{"staging missing config", []string{"ENV=staging"}, []string{filepath.Join(root, "config/staging.yaml"), filepath.Join(root, "config/staging.example.yaml")}},
		{"prod missing config", []string{"ENV=prod", "CONFIRM_PROD=yes"}, []string{filepath.Join(root, "config/prod.yaml"), filepath.Join(root, "config/prod.example.yaml")}},
		{"own folder missing config", []string{"ENV=prod", "CONFIRM_PROD=yes", "MULTISCALE_CONFIG_DIR=" + mine}, []string{filepath.Join(mine, "prod.yaml")}},
		{"own folder missing outputs", []string{"ENV=staging", "MULTISCALE_CONFIG_DIR=" + mine}, []string{filepath.Join(mine, "staging.outputs.json"), "make deploy ENV=staging"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cmd := exec.Command(script)
			cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}, c.env...)
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatalf("it ran: %s", out)
			}
			for _, want := range c.wants {
				if !strings.Contains(string(out), want) {
					t.Fatalf("no %q in: %s", want, out)
				}
			}
		})
	}
}

// A deployed sign-in can't run here, so this checks the requests against what Cognito's API documents.
func TestDeployedSignInRequests(t *testing.T) {
	var targets []string
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targets = append(targets, r.Header.Get("X-Amz-Target"))
		if r.Header.Get("Content-Type") != "application/x-amz-json-1.1" || r.Header.Get("Authorization") != "" {
			t.Errorf("headers: %v", r.Header)
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		json.Unmarshal(raw, &body)
		bodies = append(bodies, body)
		if body["AuthParameters"].(map[string]any)["PASSWORD"] == "wrong" {
			w.WriteHeader(400)
			io.WriteString(w, `{"__type":"NotAuthorizedException"}`)
			return
		}
		io.WriteString(w, `{"AuthenticationResult":{"AccessToken":"access","RefreshToken":"refresh"}}`)
	}))
	defer srv.Close()
	cfg := &Config{ClientID: "abc", Region: "us-west-2", cognitoURL: srv.URL}

	got, err := cfg.passwordSignIn(&testUser{"someone", "pw"})
	if err != nil || got.access != "access" || got.refresh != "refresh" {
		t.Fatalf("%+v %v", got, err)
	}
	if bodies[0]["AuthFlow"] != "USER_PASSWORD_AUTH" || bodies[0]["ClientId"] != "abc" || bodies[0]["AuthParameters"].(map[string]any)["USERNAME"] != "someone" {
		t.Fatalf("%v", bodies[0])
	}
	refreshed, err := cfg.passwordRefresh("refresh")
	if err != nil || refreshed != "access" {
		t.Fatalf("%q %v", refreshed, err)
	}
	if bodies[1]["AuthFlow"] != "REFRESH_TOKEN_AUTH" || bodies[1]["AuthParameters"].(map[string]any)["REFRESH_TOKEN"] != "refresh" {
		t.Fatalf("%v", bodies[1])
	}
	if targets[0] != "AWSCognitoIdentityProviderService.InitiateAuth" {
		t.Fatalf("%v", targets)
	}
	if _, err := cfg.passwordSignIn(&testUser{"someone", "wrong"}); err == nil || strings.Contains(err.Error(), "wrong") {
		t.Fatalf("a refused sign-in must fail without quoting the password: %v", err)
	}
	if want := "https://cognito-idp.us-west-2.amazonaws.com/"; (&Config{Region: "us-west-2"}).cognitoEndpoint() != want {
		t.Fatalf("%s", (&Config{Region: "us-west-2"}).cognitoEndpoint())
	}
}
