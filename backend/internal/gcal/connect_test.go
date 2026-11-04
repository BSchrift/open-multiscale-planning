package gcal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
)

func TestConsentURLAsksForOfflineAccessAndTheThreeScopes(t *testing.T) {
	w := newWorld(t)
	raw, err := w.g.Connect(context.Background(), testSub)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("access_type") != "offline" || q.Get("prompt") != "consent" || q.Get("client_id") != "cid" || q.Get("response_type") != "code" {
		t.Fatalf("%v", q)
	}
	if q.Get("redirect_uri") != "https://app.example.test/calendar/callback" {
		t.Fatalf("%v", q)
	}
	want := "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly"
	if q.Get("scope") != want {
		t.Fatalf("%q", q.Get("scope"))
	}
	if strings.Contains(q.Get("state"), testSub) {
		t.Fatal("state shows the user id")
	}
}

func TestConnectFailsWithoutClientSecrets(t *testing.T) {
	w := newWorld(t)
	delete(w.secrets.values, SecretClientID)
	if _, err := w.g.Connect(context.Background(), testSub); err == nil {
		t.Fatal("no error")
	}
}

func TestCallbackStoresTheTokenAndCreatesTheCalendar(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)

	cal := w.timeBlocks()
	if cal == "" {
		t.Fatal("no Time blocks calendar")
	}
	rec := w.calendarRecord(testSub)
	if rec["connected"].V != true || rec["calendar_id"].V != cal || rec["last_error"].V != nil {
		t.Fatalf("%+v", rec)
	}
	if w.triggers != 1 {
		t.Fatalf("%d runs started", w.triggers)
	}
	if stored := w.secrets.values[SecretRefreshToken]; stored == "" || !strings.Contains(stored, testSub) {
		t.Fatalf("stored %q", stored)
	}
}

func TestReconnectingKeepsTheCalendar(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	cal := w.timeBlocks()
	writes := w.fake.Writes()
	w.connect(testSub)
	if w.fake.Writes() != writes || w.timeBlocks() != cal {
		t.Fatalf("a second calendar: %d writes", w.fake.Writes()-writes)
	}
}

func TestCallbackRefusesBadStates(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	state, code := w.consent(testSub)

	tampered := func() string {
		payload, sig, _ := strings.Cut(state, ".")
		decoded, _ := base64.RawURLEncoding.DecodeString(payload)
		var claims map[string]any
		json.Unmarshal(decoded, &claims)
		claims["sub"] = "someone-else"
		forged, _ := json.Marshal(claims)
		return base64.RawURLEncoding.EncodeToString(forged) + "." + sig
	}()
	for name, bad := range map[string]string{"empty": "", "junk": "junk", "no signature": strings.SplitN(state, ".", 2)[0] + ".", "forged": tampered, "not base64": "%%%.%%%"} {
		if err := w.g.Callback(ctx, bad, code); !errors.Is(err, api.ErrInvalidState) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if w.fake.Writes() != 0 {
		t.Fatal("Google called for a bad state")
	}

	// Signed with another key.
	other := newWorld(t)
	other.secrets.values[SecretState] = "another-key"
	foreign, _ := other.consent(testSub)
	if err := w.g.Callback(ctx, foreign, code); !errors.Is(err, api.ErrInvalidState) {
		t.Errorf("other key: %v", err)
	}

	// Short-lived.
	w.now = w.now.Add(StateTTL + time.Second)
	if err := w.g.Callback(ctx, state, code); !errors.Is(err, api.ErrInvalidState) {
		t.Errorf("expired: %v", err)
	}
	w.now = testNow

	// Single-use, and the failed tries above did not use it up.
	if err := w.g.Callback(ctx, state, code); err != nil {
		t.Fatalf("good state refused: %v", err)
	}
	if err := w.g.Callback(ctx, state, code); !errors.Is(err, api.ErrInvalidState) {
		t.Errorf("replayed: %v", err)
	}
}

func TestOnlyTheLatestConsentCounts(t *testing.T) {
	w := newWorld(t)
	first, code := w.consent(testSub)
	second, _ := w.consent(testSub)
	if err := w.g.Callback(context.Background(), first, code); !errors.Is(err, api.ErrInvalidState) {
		t.Fatalf("older state: %v", err)
	}
	if err := w.g.Callback(context.Background(), second, code); err != nil {
		t.Fatal(err)
	}
}

func TestCallbackReportsAFailedExchangeWithoutStoringAnything(t *testing.T) {
	w := newWorld(t)
	state, _ := w.consent(testSub)
	err := w.g.Callback(context.Background(), state, "not-a-code")
	if err == nil || errors.Is(err, api.ErrInvalidState) {
		t.Fatalf("%v", err)
	}
	if _, stored := w.secrets.values[SecretRefreshToken]; stored {
		t.Fatal("stored a token")
	}
}

func TestCallbackRefusesAGrantWithNoRefreshToken(t *testing.T) {
	w := newWorld(t)
	consentURL, err := w.g.Connect(context.Background(), testSub)
	if err != nil {
		t.Fatal(err)
	}
	// The same consent, but with no offline access, so the code gets a working access token and nothing to keep.
	u, _ := url.Parse(consentURL)
	q := u.Query()
	state := q.Get("state")
	q.Del("access_type")
	u.RawQuery = q.Encode()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(u.String())
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, err := res.Location()
	if err != nil {
		t.Fatal(err)
	}
	if err := w.g.Callback(context.Background(), state, loc.Query().Get("code")); err == nil {
		t.Fatal("no error")
	}
	if _, stored := w.secrets.values[SecretRefreshToken]; stored {
		t.Fatal("stored an empty token")
	}
}

func TestACallbackStillSucceedsWhenTheFirstRunCannotStart(t *testing.T) {
	w := newWorld(t)
	w.trigger = errors.New("invoke failed")
	w.connect(testSub)
	if w.secrets.values[SecretRefreshToken] == "" {
		t.Fatal("not connected")
	}
}

func TestRefreshOnlyRunsForTheConnectedUser(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	if err := w.g.Refresh(ctx, testSub); err != nil || w.triggers != 0 {
		t.Fatalf("nobody connected: %v %d", err, w.triggers)
	}
	w.connect(testSub)
	w.triggers = 0
	if err := w.g.Refresh(ctx, "someone-else"); err != nil || w.triggers != 0 {
		t.Fatalf("another user: %v %d", err, w.triggers)
	}
	if err := w.g.Refresh(ctx, testSub); err != nil || w.triggers != 1 {
		t.Fatalf("connected user: %v %d", err, w.triggers)
	}
	w.trigger = errors.New("invoke failed")
	if err := w.g.Refresh(ctx, testSub); err == nil {
		t.Fatal("failure to start swallowed")
	}
}

var _ api.Calendar = (*Google)(nil)
