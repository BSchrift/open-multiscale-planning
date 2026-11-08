// Package integration is one black-box suite for the backend: real HTTP, real tokens, the real sync protocol. Only
// scripts/integration.sh gives it a target. With none, as in `go test ./...`, only the guard tests run.
package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

// What a test can declare it needs. The first group are emulator controls that a deployment never has.
const (
	fakeClock      = "fakeClock"
	faultInjection = "faultInjection"
	fakeGoogle     = "fakeGoogle"
	capturedLogs   = "capturedLogs"
	moto           = "moto"

	secondUser   = "secondUser"   // a second test user to prove isolation
	googleClient = "googleClient" // the deployment has its Google client secrets
	testCalendar = "testCalendar" // the test user is connected to a dedicated test Google account
)

var (
	emulatorOnly = []string{fakeClock, faultInjection, fakeGoogle, capturedLogs, moto}
	capabilities = append([]string{secondUser, googleClient, testCalendar}, emulatorOnly...)
)

type testUser struct{ Username, Password string }

// Config says where a run points and what that target can do.
type Config struct {
	Env          string
	APIURL       string
	Region       string
	ClientID     string
	TestUser     *testUser
	SecondUser   *testUser
	Capabilities []string
	cognitoURL   string
}

func (c *Config) has(capability string) bool { return slices.Contains(c.Capabilities, capability) }

func (c *Config) local() bool { return c.Env == "local" }

func (c *Config) cognitoEndpoint() string {
	if c.cognitoURL != "" {
		return c.cognitoURL
	}
	return "https://cognito-idp." + c.Region + ".amazonaws.com/"
}

// secretReader reads an SSM parameter in an environment's account.
type secretReader func(account appconfig.AWS, name string) (string, error)

// loadConfig is the last guard before any request. localAPI is the address of the stack the script started, and only a
// local target takes it, so nothing outside a deployed environment's config folder can redirect a run.
func loadConfig(env, confirm, dir, localAPI string, secret secretReader) (*Config, error) {
	switch env {
	case "local":
		// cmd/local's built-in client, with every capability.
		cfg := &Config{Env: env, ClientID: "local-client", Capabilities: capabilities}
		return cfg, cfg.checkLocal(localAPI)
	case "staging":
	case "prod":
		if confirm != "yes" {
			return nil, errors.New("running against prod needs CONFIRM_PROD=yes")
		}
	default:
		return nil, fmt.Errorf("ENV must be local, staging or prod, not %q", env)
	}
	file, err := appconfig.Load(dir, env)
	if err != nil {
		return nil, err
	}
	name := filepath.Join(dir, env+".outputs.json")
	raw, err := os.ReadFile(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("missing %s: run make deploy ENV=%s first", name, env)
	}
	if err != nil {
		return nil, err
	}
	var outputs map[string]string
	if err := json.Unmarshal(raw, &outputs); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	cfg := &Config{Env: env, APIURL: outputs["ApiUrl"], Region: file.AWS.Region, ClientID: outputs["TestClientId"], Capabilities: file.Integration.Capabilities}
	if !strings.HasPrefix(cfg.APIURL, "https://") {
		return nil, fmt.Errorf("%s: ApiUrl must be https", name)
	}
	if cfg.ClientID == "" {
		return nil, fmt.Errorf("%s: TestClientId is required", name)
	}
	for _, capability := range cfg.Capabilities {
		if !slices.Contains(capabilities, capability) {
			return nil, fmt.Errorf("%s: unknown capability %q", filepath.Join(dir, env+".yaml"), capability)
		}
		if slices.Contains(emulatorOnly, capability) {
			return nil, fmt.Errorf("%s: %q only exists on the local stack", filepath.Join(dir, env+".yaml"), capability)
		}
	}
	// Passwords come last, so a wrong file never reaches AWS.
	user := func(username, parameter string) (*testUser, error) {
		parameter = "/multiscale/" + env + "/" + parameter
		password, err := secret(file.AWS, parameter)
		if err != nil {
			return nil, fmt.Errorf("reading %s from SSM: %w", parameter, err)
		}
		if password == "" {
			return nil, fmt.Errorf("%s in SSM is empty", parameter)
		}
		return &testUser{username, password}, nil
	}
	if cfg.TestUser, err = user(file.Integration.TestUser, "test-user-password"); err != nil {
		return nil, err
	}
	if cfg.has(secondUser) {
		if cfg.SecondUser, err = user(file.Integration.SecondTestUser, "second-test-user-password"); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}

// ssmSecret reads a SecureString through the default credential chain, signed in as the environment file's profile in
// its region, whatever AWS_PROFILE the shell had.
func ssmSecret(account appconfig.AWS, name string) (string, error) {
	ctx := context.Background()
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithSharedConfigProfile(account.Profile), awsconfig.WithRegion(account.Region))
	if err != nil {
		return "", err
	}
	out, err := ssm.NewFromConfig(cfg).GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name), WithDecryption: aws.Bool(true)})
	if err != nil {
		return "", err
	}
	return aws.ToString(out.Parameter.Value), nil
}

func (c *Config) checkLocal(api string) error {
	if api == "" {
		return errors.New("INTEGRATION_API_URL is required for local: run this through make test-integration")
	}
	parsed, err := url.Parse(api)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(parsed.Hostname()); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("the local target must be a loopback address, not %s", api)
	}
	c.APIURL = api
	return nil
}

var target *Config

func TestMain(m *testing.M) {
	if env := os.Getenv("INTEGRATION_ENV"); env != "" {
		cfg, err := loadConfig(env, os.Getenv("CONFIRM_PROD"), appconfig.Dir(), os.Getenv("INTEGRATION_API_URL"), ssmSecret)
		if err != nil {
			fmt.Fprintln(os.Stderr, "integration:", err)
			os.Exit(2)
		}
		target = cfg
	}
	os.Exit(m.Run())
}

// needs goes first in every test against the target. A missing need skips, and the skip names it in the report.
func needs(t *testing.T, wanted ...string) {
	t.Helper()
	if target == nil {
		t.Skip("no target: run make test-integration")
	}
	for _, capability := range wanted {
		if !target.has(capability) {
			t.Skipf("needs: %s (not available on %s)", capability, target.Env)
		}
	}
}

// Ids are unique per run, so a run against a deployment can never collide with an earlier one or with real data.
var (
	runID    = fmt.Sprintf("it%d", time.Now().UnixNano())
	sequence atomic.Int64
)

func fresh(name string) string { return fmt.Sprintf("%s-%d-%s", runID, sequence.Add(1), name) }

type tokens struct{ access, refresh string }

// account is one signed-in user. Everything it pushes is tombstoned when the test ends.
type account struct {
	t        *testing.T
	login    func() tokens
	tokens   tokens
	device   string
	counter  int
	wall     time.Time
	pushed   map[[2]string]bool
	username string
	base     int64
}

// signIn returns the test's main user: on the local stack someone new, whose data starts empty; on a deployment the
// dedicated test user, whose earlier data each test steps over with startCursor.
func signIn(t *testing.T) *account {
	t.Helper()
	if target.local() {
		return signInLocal(t, fresh("user"))
	}
	return signInDeployed(t, target.TestUser)
}

func signInOther(t *testing.T) *account {
	t.Helper()
	needs(t, secondUser)
	if target.local() {
		return signInLocal(t, fresh("other"))
	}
	return signInDeployed(t, target.SecondUser)
}

func signInLocal(t *testing.T, username string) *account {
	t.Helper()
	return newAccount(t, username, func() tokens { return localTokens(t, username) })
}

func signInDeployed(t *testing.T, user *testUser) *account {
	t.Helper()
	return newAccount(t, user.Username, func() tokens {
		got, err := target.passwordSignIn(user)
		if err != nil {
			t.Fatal(err)
		}
		return got
	})
}

func newAccount(t *testing.T, username string, login func() tokens) *account {
	t.Helper()
	a := &account{t: t, login: login, tokens: login(), device: fresh("device"), pushed: map[[2]string]bool{}, username: username}
	t.Cleanup(a.cleanUp)
	a.base = a.startCursor()
	return a
}

// reSignIn is what a device does once time has moved past its token.
func (a *account) reSignIn() { a.tokens = a.login() }

const localRedirect = "multiscale://signed-in"

func localTokens(t *testing.T, username string) tokens {
	t.Helper()
	const verifier = "a-verifier-long-enough-to-meet-the-pkce-minimum-length"
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type": {"code"}, "client_id": {target.ClientID}, "redirect_uri": {localRedirect},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"username": {username},
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(target.APIURL + "/cognito/oauth2/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	location, err := url.Parse(res.Header.Get("Location"))
	if err != nil || location.Query().Get("code") == "" {
		t.Fatalf("authorize: %d %q", res.StatusCode, res.Header.Get("Location"))
	}
	body := localTokenRequest(t, url.Values{
		"grant_type": {"authorization_code"}, "client_id": {target.ClientID}, "code": {location.Query().Get("code")},
		"redirect_uri": {localRedirect}, "code_verifier": {verifier},
	})
	return tokens{access: body["access_token"], refresh: body["refresh_token"]}
}

func localTokenRequest(t *testing.T, form url.Values) map[string]string {
	t.Helper()
	res, err := http.PostForm(target.APIURL+"/cognito/oauth2/token", form)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{"status": strconv.Itoa(res.StatusCode)}
	for key, value := range body {
		if text, ok := value.(string); ok {
			out[key] = text
		}
	}
	return out
}

// cognitoAuth calls Cognito's public InitiateAuth, which takes no AWS credentials. Errors carry Cognito's type only,
// so a password or token never reaches test output.
func (c *Config) cognitoAuth(flow string, params map[string]string) (tokens, error) {
	body, err := json.Marshal(map[string]any{"AuthFlow": flow, "ClientId": c.ClientID, "AuthParameters": params})
	if err != nil {
		return tokens{}, err
	}
	req, err := http.NewRequest("POST", c.cognitoEndpoint(), bytes.NewReader(body))
	if err != nil {
		return tokens{}, err
	}
	req.Header.Set("Content-Type", "application/x-amz-json-1.1")
	req.Header.Set("X-Amz-Target", "AWSCognitoIdentityProviderService.InitiateAuth")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return tokens{}, err
	}
	defer res.Body.Close()
	var out struct {
		Type   string `json:"__type"`
		Result struct {
			AccessToken  string `json:"AccessToken"`
			RefreshToken string `json:"RefreshToken"`
		} `json:"AuthenticationResult"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return tokens{}, fmt.Errorf("cognito %s: status %d", flow, res.StatusCode)
	}
	if res.StatusCode != 200 || out.Result.AccessToken == "" {
		return tokens{}, fmt.Errorf("cognito %s: status %d %s", flow, res.StatusCode, out.Type)
	}
	return tokens{access: out.Result.AccessToken, refresh: out.Result.RefreshToken}, nil
}

func (c *Config) passwordSignIn(user *testUser) (tokens, error) {
	return c.cognitoAuth("USER_PASSWORD_AUTH", map[string]string{"USERNAME": user.Username, "PASSWORD": user.Password})
}

func (c *Config) passwordRefresh(refresh string) (string, error) {
	got, err := c.cognitoAuth("REFRESH_TOKEN_AUTH", map[string]string{"REFRESH_TOKEN": refresh})
	return got.access, err
}

// refreshAccess swaps a refresh token for an access token on whichever kind of target this is.
func refreshAccess(t *testing.T, refresh string) (string, error) {
	t.Helper()
	if !target.local() {
		return target.passwordRefresh(refresh)
	}
	body := localTokenRequest(t, url.Values{"grant_type": {"refresh_token"}, "client_id": {target.ClientID}, "refresh_token": {refresh}})
	if body["status"] != "200" {
		return "", fmt.Errorf("refresh refused: %s %s", body["status"], body["error"])
	}
	return body["access_token"], nil
}

type response struct {
	status int
	body   []byte
	header http.Header
}

func (r response) errorCode() string {
	var decoded struct {
		Error string `json:"error"`
	}
	json.Unmarshal(r.body, &decoded)
	return decoded.Error
}

func request(t *testing.T, method, path, token string, body []byte, headers ...string) response {
	t.Helper()
	req, err := http.NewRequest(method, target.APIURL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{res.StatusCode, raw, res.Header}
}

// The wire format, spelled out here rather than imported, so the suite only knows what a device knows.
type field struct {
	V any    `json:"v"`
	C string `json:"c"`
}

type record struct {
	Type   string           `json:"type"`
	ID     string           `json:"id"`
	Fields map[string]field `json:"fields"`
}

type syncRequest struct {
	Cursor  int64    `json:"cursor"`
	Changes []record `json:"changes"`
}

type syncResponse struct {
	Cursor  int64    `json:"cursor"`
	More    bool     `json:"more"`
	Changes []record `json:"changes"`
}

func clockAt(wall time.Time, counter int, device string) string {
	return fmt.Sprintf("%013d-%06d-%s", wall.UnixMilli(), counter, device)
}

// clock is this device's next clock. It only ever goes up, as a device's does, whatever the fake clock is doing.
func (a *account) clock() string {
	a.counter++
	if now := time.Now(); now.After(a.wall) {
		a.wall = now
	}
	return clockAt(a.wall, a.counter, a.device)
}

// fields builds a change's fields from name, value pairs, all at this device's next clock.
func (a *account) fields(pairs ...any) map[string]field {
	clock := a.clock()
	fields := map[string]field{}
	for i := 0; i+1 < len(pairs); i += 2 {
		fields[pairs[i].(string)] = field{V: pairs[i+1], C: clock}
	}
	return fields
}

func (a *account) record(recordType, id string, pairs ...any) record {
	return record{recordType, id, a.fields(pairs...)}
}

// send posts a sync and returns the raw response, for tests that expect it to fail.
func (a *account) send(cursor int64, changes ...record) response {
	a.t.Helper()
	if changes == nil {
		changes = []record{}
	}
	res := a.sendRaw(mustJSON(a.t, syncRequest{cursor, changes}))
	// A refused request wrote nothing. Anything else may have, in part.
	if res.status < 400 || res.status >= 500 {
		for _, change := range changes {
			a.pushed[[2]string{change.Type, change.ID}] = true
		}
	}
	return res
}

func (a *account) sendRaw(body []byte) response {
	a.t.Helper()
	return request(a.t, "POST", "/sync", a.tokens.access, body)
}

// sync posts a sync that must work. A 409 means another writer kept moving the counter, so it resends as a device does.
func (a *account) sync(cursor int64, changes ...record) syncResponse {
	a.t.Helper()
	for try := 0; ; try++ {
		res := a.send(cursor, changes...)
		if res.status == 409 && try < 20 {
			time.Sleep(time.Duration(try+1) * 20 * time.Millisecond)
			continue
		}
		if res.status != 200 {
			a.t.Fatalf("sync: %d %s", res.status, truncated(res.body))
		}
		return decodeSync(a.t, res)
	}
}

func decodeSync(t *testing.T, res response) syncResponse {
	t.Helper()
	var out syncResponse
	decoder := json.NewDecoder(bytes.NewReader(res.body))
	decoder.UseNumber()
	if err := decoder.Decode(&out); err != nil {
		t.Fatalf("sync response: %v in %s", err, truncated(res.body))
	}
	return out
}

func truncated(body []byte) string {
	if len(body) > 400 {
		return string(body[:400]) + "..."
	}
	return string(body)
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// startCursor is this user's counter now: a cursor above the counter writes nothing and answers with it.
func (a *account) startCursor() int64 {
	a.t.Helper()
	return a.sync(math.MaxInt64).Cursor
}

// pullAll follows pages from a cursor, as a device does, and returns every change with where it ended.
func (a *account) pullAll(from int64) ([]record, int64) {
	a.t.Helper()
	var all []record
	cursor := from
	for {
		page := a.sync(cursor)
		if page.More && page.Cursor <= cursor {
			a.t.Fatalf("more pages promised, but the cursor stayed at %d", cursor)
		}
		all = append(all, page.Changes...)
		cursor = page.Cursor
		if !page.More {
			return all, cursor
		}
	}
}

func find(records []record, recordType, id string) (record, bool) {
	for _, r := range records {
		if r.Type == recordType && r.ID == id {
			return r, true
		}
	}
	return record{}, false
}

// get reads one record as it stands, among what's changed since this account signed in. That leaves out earlier runs'
// rows, which on a deployment build up in the test user's partition.
func (a *account) get(recordType, id string) (record, bool) {
	a.t.Helper()
	all, _ := a.pullAll(a.base)
	return find(all, recordType, id)
}

// cleanUp tombstones what the test pushed and empties its fields. There's no hard delete in the API, so these rows stay
// as deleted records in the test user's own partition, where unique ids keep them out of any later run's way. Emptied,
// they stay small: every new device pulls them all, and the large-record tests alone left tens of megabytes before.
func (a *account) cleanUp() {
	if len(a.pushed) == 0 {
		return
	}
	a.reSignIn()
	stamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	written, _ := a.pullAll(a.base)
	var batch []record
	// An update is billed at the size it replaces, so emptying large records goes a few at a time, paced under the
	// partition's write rate.
	size := 0
	for key := range a.pushed {
		pairs := []any{"deleted_at", stamp}
		if stored, ok := find(written, key[0], key[1]); ok {
			size += len(mustJSON(a.t, stored.Fields))
			for name := range stored.Fields {
				if name != "deleted_at" {
					pairs = append(pairs, name, nil)
				}
			}
		}
		batch = append(batch, a.record(key[0], key[1], pairs...))
		if len(batch) == 99 || size >= 200<<10 {
			a.sync(a.startCursor(), batch...)
			if size >= 200<<10 {
				time.Sleep(500 * time.Millisecond)
			}
			batch, size = nil, 0
		}
	}
	if len(batch) > 0 {
		a.sync(a.startCursor(), batch...)
	}
}
