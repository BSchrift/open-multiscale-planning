package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	gosync "sync"
	"testing"
	"time"
)

const verifier = "a-verifier-long-enough-to-meet-the-pkce-minimum-length"

type stack struct {
	srv  *httptest.Server
	logs *lockedBuffer
}

// lockedBuffer holds log lines written by the server's goroutines and read by the test's.
type lockedBuffer struct {
	mu  gosync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startStack(t *testing.T) stack {
	t.Helper()
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT not set: start DynamoDB Local to run this test")
	}
	logs := &lockedBuffer{}
	// The issuer has to be known before the server is, so serve through a handler set once it's built.
	var handler http.Handler
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	t.Cleanup(srv.Close)
	h, err := build(config{
		Endpoint: endpoint,
		Table:    fmt.Sprintf("local-test-%d-%d", os.Getpid(), time.Now().UnixNano()),
		Issuer:   srv.URL + "/cognito",
		ClientID: "local-client",
		Env:      "local",
		// Empty leaves the calendar routes unconfigured, as they are for anyone running without Moto.
		SSMEndpoint: os.Getenv("SSM_ENDPOINT"),
		SSMPrefix:   fmt.Sprintf("/multiscale/local-test-%d", time.Now().UnixNano()),
	}, logs)
	if err != nil {
		t.Fatal(err)
	}
	handler = h
	return stack{srv, logs}
}

func (s stack) signIn(t *testing.T, username string) map[string]any {
	t.Helper()
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{
		"response_type": {"code"}, "client_id": {"local-client"}, "redirect_uri": {"multiscale://signed-in"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"},
		"username": {username},
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(s.srv.URL + "/cognito/oauth2/authorize?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	loc, _ := url.Parse(res.Header.Get("Location"))
	tokenRes, err := http.PostForm(s.srv.URL+"/cognito/oauth2/token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {"local-client"}, "code": {loc.Query().Get("code")},
		"redirect_uri": {"multiscale://signed-in"}, "code_verifier": {verifier},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer tokenRes.Body.Close()
	var tokens map[string]any
	if err := json.NewDecoder(tokenRes.Body).Decode(&tokens); err != nil {
		t.Fatal(err)
	}
	return tokens
}

func (s stack) post(t *testing.T, path, token, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", s.srv.URL+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var decoded map[string]any
	json.NewDecoder(res.Body).Decode(&decoded)
	return res.StatusCode, decoded
}

func decodeJSON(t *testing.T, r io.Reader, into any) {
	t.Helper()
	if err := json.NewDecoder(r).Decode(into); err != nil {
		t.Fatal(err)
	}
}

func pushBody(id, title string, ms int64) string {
	return fmt.Sprintf(`{"cursor":0,"changes":[{"type":"task","id":%q,"fields":{"title":{"v":%q,"c":"%013d-000000-a"}}}]}`, id, title, ms)
}

// The settings are local's, as a Lambda's are its ENV_NAME's, so a name with no settings stops it before anything else.
func TestBuildRefusesAnEnvironmentWithNoSettings(t *testing.T) {
	if _, err := build(config{Env: "dev"}, io.Discard); err == nil || !strings.Contains(err.Error(), `no environment "dev"`) {
		t.Fatalf("got %v", err)
	}
}

func TestSyncThroughTokens(t *testing.T) {
	s := startStack(t)
	token := s.signIn(t, "one")["access_token"].(string)

	status, res := s.post(t, "/sync", token, pushBody("r1", "Write the report", time.Now().UnixMilli()))
	if status != 200 || res["cursor"] != float64(1) || len(res["changes"].([]any)) != 1 {
		t.Fatalf("%d %v", status, res)
	}

	other := s.signIn(t, "two")["access_token"].(string)
	status, res = s.post(t, "/sync", other, `{}`)
	if status != 200 || res["cursor"] != float64(0) {
		t.Fatalf("user two sees %d %v", status, res)
	}
}

func TestRoutesFollowTheGatewayRules(t *testing.T) {
	s := startStack(t)
	for _, path := range []string{"/sync", "/calendar/connect", "/calendar/refresh"} {
		if status, res := s.post(t, path, "", `{}`); status != 401 || res["message"] != "Unauthorized" {
			t.Errorf("%s: %d %v", path, status, res)
		}
		if status, _ := s.post(t, path, "nope", `{}`); status != 401 {
			t.Errorf("%s with a bad token: %d", path, status)
		}
	}
	if status, res := s.post(t, "/nope", "", `{}`); status != 404 || res["message"] != "Not Found" {
		t.Errorf("unknown route: %d %v", status, res)
	}

	// The callback carries no token. With no calendar wired in yet it says so, instead of 401.
	res, err := http.Get(s.srv.URL + "/calendar/callback?state=s&code=c")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == 401 {
		t.Fatalf("callback got %d", res.StatusCode)
	}
}

func TestClockControlExpiresTokensAndMovesTheClockLimit(t *testing.T) {
	s := startStack(t)
	token := s.signIn(t, "one")["access_token"].(string)
	later := time.Now().Add(2 * time.Hour)
	if status, _ := s.post(t, "/_local/clock", "", fmt.Sprintf(`{"now":%q}`, later.Format(time.RFC3339))); status != 204 {
		t.Fatalf("set clock: %d", status)
	}
	if status, _ := s.post(t, "/sync", token, `{}`); status != 401 {
		t.Fatalf("an expired token got %d", status)
	}

	fresh := s.signIn(t, "one")["access_token"].(string)
	withinLimit := pushBody("r1", "x", later.Add(23*time.Hour).UnixMilli())
	if status, res := s.post(t, "/sync", fresh, withinLimit); status != 200 {
		t.Fatalf("%d %v", status, res)
	}
	tooFar := pushBody("r2", "x", later.Add(25*time.Hour).UnixMilli())
	if status, res := s.post(t, "/sync", fresh, tooFar); status != 400 || res["error"] != "clock_ahead" {
		t.Fatalf("%d %v", status, res)
	}

	if status, _ := s.post(t, "/_local/clock", "", `{"now":""}`); status != 204 {
		t.Fatalf("reset clock: %d", status)
	}
	if status, _ := s.post(t, "/sync", s.signIn(t, "one")["access_token"].(string), `{}`); status != 200 {
		t.Fatalf("after reset: %d", status)
	}
	if status, _ := s.post(t, "/_local/clock", "", `{"now":"yesterday"}`); status != 400 {
		t.Fatalf("bad clock: %d", status)
	}
}

func TestFaultControlInjectsConflicts(t *testing.T) {
	s := startStack(t)
	token := s.signIn(t, "one")["access_token"].(string)
	if status, _ := s.post(t, "/_local/faults", "", `{"sync_conflicts":3}`); status != 204 {
		t.Fatalf("set faults: %d", status)
	}
	status, res := s.post(t, "/sync", token, pushBody("r1", "x", time.Now().UnixMilli()))
	if status != 409 || res["error"] != "conflict" {
		t.Fatalf("%d %v", status, res)
	}
	if status, _ := s.post(t, "/sync", token, pushBody("r1", "x", time.Now().UnixMilli())); status != 200 {
		t.Fatalf("after the faults ran out: %d", status)
	}
	if !strings.Contains(s.logs.String(), `"SyncConflictRetries":2`) {
		t.Fatalf("retries not logged: %s", s.logs)
	}
}

func TestLogLinesCarryNoTokenOrValue(t *testing.T) {
	s := startStack(t)
	const marker = "MARKER-do-not-log"
	token := s.signIn(t, "one")["access_token"].(string)
	if status, _ := s.post(t, "/sync", token, pushBody("r1", marker, time.Now().UnixMilli())); status != 200 {
		t.Fatalf("%d", status)
	}
	if status, _ := s.post(t, "/sync", "nope"+marker, `{}`); status != 401 {
		t.Fatalf("%d", status)
	}
	logged := s.logs.String()
	if !strings.Contains(logged, `"route":"POST /sync"`) {
		t.Fatalf("no request line: %s", logged)
	}
	if strings.Contains(logged, marker) || strings.Contains(logged, token) {
		t.Fatalf("leak: %s", logged)
	}
}
