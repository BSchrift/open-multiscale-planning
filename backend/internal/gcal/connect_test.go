package gcal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
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
	if !slices.Equal(w.triggered, []string{testSub}) {
		t.Fatalf("runs started for %v", w.triggered)
	}
	conn := w.conns.conns[testSub]
	if conn.RefreshToken == "" || conn.Account != accountID(fakes.DefaultGoogleAccount) {
		t.Fatalf("stored %+v", conn)
	}
	if _, legacy := w.secrets.values[SecretRefreshToken]; legacy {
		t.Fatal("stored as the deployment's one connection")
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

// Each person connects their own Google account and keeps it: a second person's consent leaves the first connected, and
// each person's blocks and calendars stay in their own account and record.
func TestEachPersonConnectsTheirOwnGoogleAccount(t *testing.T) {
	w := newWorld(t)
	const other = "someone-else"
	w.connect(testSub)
	w.connect(other)
	mine, theirs := w.fake.Account(googleAccount(testSub)), w.fake.Account(googleAccount(other))
	mine.AddCalendar("home-mine", "Home")
	theirs.AddCalendar("work-theirs", "Work")
	w.block("b1", "Paint the fence", at(1), at(2))
	w.write(other, "task", "task-b2", map[string]any{"title": "Their block"})
	w.write(other, "time_block", "b2", map[string]any{"task_id": "task-b2", "start": instant(at(3)), "end": instant(at(4)), "tz": "UTC"})
	w.runFor(testSub)
	w.runFor(other)

	for sub, account := range map[string]*fakes.GoogleAccount{testSub: mine, other: theirs} {
		rec := w.calendarRecord(sub)
		if rec["connected"].V != true || rec["calendar_id"].V != account.CalendarNamed(CalendarName) || rec["last_error"].V != nil {
			t.Fatalf("%s: %+v", sub, rec)
		}
		if !w.refreshWorks(w.storedToken(sub)) {
			t.Fatalf("%s's access was revoked", sub)
		}
	}
	if events := w.fake.Events(mine.CalendarNamed(CalendarName)); len(events) != 1 || events[0].Summary != "Paint the fence" {
		t.Fatalf("mine: %+v", events)
	}
	if events := w.fake.Events(theirs.CalendarNamed(CalendarName)); len(events) != 1 || events[0].Summary != "Their block" {
		t.Fatalf("theirs: %+v", events)
	}
	if _, ok := w.sources()["home-mine"]; !ok || len(w.sources()) != 1 {
		t.Fatalf("my sources: %v", w.sources())
	}
	if w.storedToken(testSub) == w.storedToken(other) {
		t.Fatal("one token for two people")
	}
}

// A Google account connects to one person: revoking it, by either, would end both, and each would make a Time blocks of
// their own in it. A second person is refused before anything is made there, and the first stays connected.
func TestASecondPersonCannotConnectAGoogleAccountSomeoneElseHas(t *testing.T) {
	w := newWorld(t)
	const other = "someone-else"
	w.connect(testSub)
	writes := w.fake.Writes()
	state, code := w.consentAs(other, googleAccount(testSub))
	if err := w.g.Callback(context.Background(), state, code); !errors.Is(err, api.ErrAccountTaken) {
		t.Fatalf("%v", err)
	}
	if w.fake.Writes() != writes {
		t.Fatal("made something in their Google")
	}
	if w.storedToken(other) != "" || w.calendarRecord(other)["connected"].V == true {
		t.Fatalf("connected: %+v", w.calendarRecord(other))
	}
	if !w.refreshWorks(w.storedToken(testSub)) || w.calendarRecord(testSub)["connected"].V != true {
		t.Fatal("the first person lost their connection")
	}
	if len(w.triggered) != 1 {
		t.Fatalf("runs started for %v", w.triggered)
	}

	// Once the first disconnects, it's free.
	if err := w.g.Disconnect(context.Background(), testSub); err != nil {
		t.Fatal(err)
	}
	w.connectAs(other, googleAccount(testSub))
	if w.calendarRecord(other)["connected"].V != true {
		t.Fatalf("%+v", w.calendarRecord(other))
	}
}

// Connecting again with another Google account frees the first for someone else.
func TestReconnectingToAnotherGoogleAccountFreesTheFirst(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.connectAs(testSub, "second@example.test")
	if got := w.conns.conns[testSub].Account; got != accountID("second@example.test") {
		t.Fatalf("account %s", got)
	}
	w.connectAs("someone-else", googleAccount(testSub))
}

// A consent racing another person's for the same Google account loses at the store, and takes back the calendar it made.
func TestALostRaceForAGoogleAccountTakesBackItsCalendar(t *testing.T) {
	w := newWorld(t)
	state, code := w.consent(testSub)
	// Someone else's consent lands between the check and the store.
	w.g.Connections = racingConnections{w.conns, func() {
		w.conns.holders[accountID(googleAccount(testSub))] = "someone-else"
	}}
	if err := w.g.Callback(context.Background(), state, code); !errors.Is(err, api.ErrAccountTaken) {
		t.Fatalf("%v", err)
	}
	if w.timeBlocks() != "" {
		t.Fatal("left a second Time blocks")
	}
}

type racingConnections struct {
	*memConnections
	before func()
}

func (r racingConnections) Put(ctx context.Context, conn connection, previous connection) error {
	r.before()
	return r.memConnections.Put(ctx, conn, previous)
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
	if w.storedToken(testSub) != "" {
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
	if _, stored := w.conns.conns[testSub]; stored {
		t.Fatal("stored an empty token")
	}
}

func TestACallbackStillSucceedsWhenTheFirstRunCannotStart(t *testing.T) {
	w := newWorld(t)
	w.trigger = errors.New("invoke failed")
	w.connect(testSub)
	if w.storedToken(testSub) == "" {
		t.Fatal("not connected")
	}
}

func TestRefreshOnlyRunsForAConnectedPerson(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	if err := w.g.Refresh(ctx, testSub); err != nil || w.triggers != 0 {
		t.Fatalf("nobody connected: %v %d", err, w.triggers)
	}
	w.connect(testSub)
	w.triggers, w.triggered = 0, nil
	if err := w.g.Refresh(ctx, "someone-else"); err != nil || w.triggers != 0 {
		t.Fatalf("another user: %v %d", err, w.triggers)
	}
	if err := w.g.Refresh(ctx, testSub); err != nil || !slices.Equal(w.triggered, []string{testSub}) {
		t.Fatalf("connected user: %v %v", err, w.triggered)
	}
	w.trigger = errors.New("invoke failed")
	if err := w.g.Refresh(ctx, testSub); err == nil {
		t.Fatal("failure to start swallowed")
	}
}

// refreshWorks reports whether Google still honours a refresh token.
func (w *world) refreshWorks(token string) bool {
	w.t.Helper()
	res, err := http.PostForm(w.srv.URL+"/token", url.Values{
		"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {"cid"}, "client_secret": {"secret"},
	})
	if err != nil {
		w.t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

func TestDisconnectRevokesAccessRemovesTimeBlocksAndShowsItUnconnected(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Write the report", at(1), at(2))
	w.run()
	stored := w.storedToken(testSub)
	if err := w.g.Disconnect(context.Background(), testSub); err != nil {
		t.Fatal(err)
	}
	if w.timeBlocks() != "" {
		t.Fatal("Time blocks is still in Google")
	}
	if w.refreshWorks(stored) {
		t.Fatal("Google still honours the token")
	}
	if _, ok := w.conns.conns[testSub]; ok || len(w.conns.holders) != 0 {
		t.Fatal("token or account claim kept")
	}
	rec := w.calendarRecord(testSub)
	if rec["connected"].V != false || rec["calendar_id"].V != nil || len(rec["events"].V.([]any)) != 0 || rec["last_error"].V != nil {
		t.Fatalf("%+v", rec)
	}
	// Connecting again starts afresh.
	w.connect(testSub)
	if w.timeBlocks() == "" || w.calendarRecord(testSub)["connected"].V != true {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
}

func TestDisconnectLeavesAnotherPersonsConnectionAlone(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.connect("someone-else")
	stored := w.storedToken(testSub)
	if err := w.g.Disconnect(context.Background(), "someone-else"); err != nil {
		t.Fatal(err)
	}
	if w.storedToken(testSub) != stored || w.timeBlocks() == "" || !w.refreshWorks(stored) {
		t.Fatal("another person's disconnect reached the connection")
	}
	if w.storedToken("someone-else") != "" || w.fake.Account(googleAccount("someone-else")).CalendarNamed(CalendarName) != "" {
		t.Fatal("their own connection stayed")
	}
}

// DeleteConnection is what deleting an account calls: it revokes, then deletes, and can run again.
func TestDeleteConnectionRevokesThenDeletesAndCanRunAgain(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	if err := w.g.DeleteConnection(ctx, testSub); err != nil {
		t.Fatalf("with no connection: %v", err)
	}
	w.connect(testSub)
	stored := w.storedToken(testSub)
	if err := w.g.DeleteConnection(ctx, testSub); err != nil {
		t.Fatal(err)
	}
	if w.refreshWorks(stored) || w.storedToken(testSub) != "" || w.timeBlocks() != "" {
		t.Fatal("token still honoured, kept, or Time blocks left")
	}
	if err := w.g.DeleteConnection(ctx, testSub); err != nil {
		t.Fatalf("again: %v", err)
	}
}

// A failure to delete leaves the token stored, so a second try still has it to revoke and delete.
func TestDeleteConnectionThatFailsCanBeTriedAgain(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.connect(testSub)
	w.conns.failing = errors.New("store down")
	if err := w.g.DeleteConnection(ctx, testSub); err == nil {
		t.Fatal("swallowed")
	}
	w.conns.failing = nil
	if err := w.g.DeleteConnection(ctx, testSub); err != nil || w.storedToken(testSub) != "" {
		t.Fatalf("second try: %v", err)
	}
}

func TestDisconnectStillDisconnectsWhenGoogleAccessIsAlreadyGone(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.fake.Revoke()
	if err := w.g.Disconnect(context.Background(), testSub); err != nil {
		t.Fatal(err)
	}
	if w.storedToken(testSub) != "" || w.calendarRecord(testSub)["connected"].V != false {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
}

var _ api.Calendar = (*Google)(nil)
