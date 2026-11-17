package gcal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strconv"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

const testSub = "user-sub-1"

var testNow = time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

// memRecords is the store's behaviour with no DynamoDB: real field merging, per user, and nothing done once a call's
// context has ended.
type memRecords struct {
	mu      gosync.Mutex
	records map[string]map[string]sync.Change
	failing error
}

func (m *memRecords) List(ctx context.Context, sub, recordType string) ([]sync.Change, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return nil, m.failing
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var out []sync.Change
	for _, change := range m.records[sub] {
		if change.Type == recordType {
			out = append(out, change)
		}
	}
	return out, nil
}

func (m *memRecords) Push(ctx context.Context, sub string, _ int64, changes []sync.Change) (sync.Stats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return sync.Stats{}, m.failing
	}
	if err := ctx.Err(); err != nil {
		return sync.Stats{}, err
	}
	if m.records == nil {
		m.records = map[string]map[string]sync.Change{}
	}
	if m.records[sub] == nil {
		m.records[sub] = map[string]sync.Change{}
	}
	for _, change := range changes {
		key := change.Type + "#" + change.ID
		fields, _ := sync.MergeFields(m.records[sub][key].Fields, change.Fields)
		size, _ := json.Marshal(fields)
		if len(size) > sync.MaxRecordBytes {
			return sync.Stats{}, &sync.Rejection{Status: 413, Code: "record_too_large"}
		}
		m.records[sub][key] = sync.Change{Type: change.Type, ID: change.ID, Fields: fields}
	}
	return sync.Stats{}, nil
}

type memSecrets struct {
	mu     gosync.Mutex
	values map[string]string
}

func (m *memSecrets) Get(ctx context.Context, name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	value, ok := m.values[name]
	if !ok {
		return "", ErrNoSecret
	}
	return value, nil
}

func (m *memSecrets) Put(_ context.Context, name, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[name] = value
	return nil
}

func (m *memSecrets) Delete(_ context.Context, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.values, name)
	return nil
}

// memConnections is DynamoConnections' behaviour with no DynamoDB or KMS: a fresh sealed value on each put, so a delete of
// a connection that was replaced is refused, and one claim per Google account.
type memConnections struct {
	mu      gosync.Mutex
	conns   map[string]connection
	holders map[string]string
	seals   int
	failing error
}

func (m *memConnections) Get(ctx context.Context, sub string) (connection, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return connection{}, m.failing
	}
	if err := ctx.Err(); err != nil {
		return connection{}, err
	}
	conn, ok := m.conns[sub]
	if !ok {
		return connection{}, ErrNotConnected
	}
	return conn, nil
}

func (m *memConnections) Has(ctx context.Context, sub string) (bool, error) {
	_, err := m.Get(ctx, sub)
	if errors.Is(err, ErrNotConnected) {
		return false, nil
	}
	return err == nil, err
}

func (m *memConnections) Holder(_ context.Context, account string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.holders[account], m.failing
}

func (m *memConnections) Put(_ context.Context, conn connection, previous string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return m.failing
	}
	if holder := m.holders[conn.Account]; conn.Account != "" && holder != "" && holder != conn.Sub {
		return api.ErrAccountTaken
	}
	if previous != "" && previous != conn.Account && m.holders[previous] == conn.Sub {
		delete(m.holders, previous)
	}
	if conn.Account != "" {
		m.holders[conn.Account] = conn.Sub
	}
	m.seals++
	conn.sealed, conn.legacy = []byte(strconv.Itoa(m.seals)), false
	m.conns[conn.Sub] = conn
	return nil
}

func (m *memConnections) PutNew(ctx context.Context, conn connection) error {
	m.mu.Lock()
	_, exists := m.conns[conn.Sub]
	m.mu.Unlock()
	if exists {
		return errConnectionChanged
	}
	return m.Put(ctx, conn, "")
}

func (m *memConnections) Delete(_ context.Context, conn connection) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return m.failing
	}
	current, ok := m.conns[conn.Sub]
	if ok && conn.sealed != nil && string(current.sealed) != string(conn.sealed) {
		return errConnectionChanged
	}
	delete(m.conns, conn.Sub)
	if conn.Account != "" && m.holders[conn.Account] == conn.Sub {
		delete(m.holders, conn.Account)
	}
	return nil
}

func (m *memConnections) Each(_ context.Context, fn func(sub string) error) error {
	m.mu.Lock()
	subs := slices.Sorted(maps.Keys(m.conns))
	m.mu.Unlock()
	for _, sub := range subs {
		if err := fn(sub); err != nil {
			return err
		}
	}
	return nil
}

type memStates map[string]string

func (m memStates) Put(_ context.Context, sub, nonce string) error {
	m[sub] = nonce
	return nil
}

func (m memStates) Consume(_ context.Context, sub, nonce string) (bool, error) {
	if m[sub] != nonce || nonce == "" {
		return false, nil
	}
	delete(m, sub)
	return true, nil
}

type world struct {
	t        *testing.T
	g        *Google
	fake     *fakes.Google
	srv      *httptest.Server
	records  *memRecords
	secrets  *memSecrets
	conns    *memConnections
	queued   []Job
	logs     *bytes.Buffer
	now      time.Time
	triggers int
	// triggered is who each started run was for.
	triggered []string
	trigger   error
	devClock  int64
}

// queueFunc lets a test's function stand in for the queue.
type queueFunc func(ctx context.Context, jobs []Job) error

func (f queueFunc) Send(ctx context.Context, jobs []Job) error { return f(ctx, jobs) }

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, records: &memRecords{}, logs: &bytes.Buffer{}, now: testNow, devClock: testNow.UnixMilli() - 1000,
		conns: &memConnections{conns: map[string]connection{}, holders: map[string]string{}}}
	w.secrets = &memSecrets{values: map[string]string{SecretClientID: "cid", SecretClientSecret: "secret", SecretState: "state-key"}}
	now := func() time.Time { return w.now }
	w.fake = fakes.NewGoogle("cid", "secret", now)
	w.srv = httptest.NewServer(w.fake)
	t.Cleanup(w.srv.Close)
	w.g = &Google{
		Records: w.records, Secrets: w.secrets, Connections: w.conns, States: memStates{},
		Log: obs.NewLogger(w.logs), Env: "staging", Now: now,
		AuthURL: w.srv.URL + "/o/oauth2/auth", TokenURL: w.srv.URL + "/token", RevokeURL: w.srv.URL + "/revoke", APIURL: w.srv.URL + "/calendar/v3/",
		RedirectURL: "https://app.example.test/calendar/callback",
		Trigger: func(_ context.Context, sub string) error {
			w.triggers++
			w.triggered = append(w.triggered, sub)
			return w.trigger
		},
		Queue: queueFunc(func(_ context.Context, jobs []Job) error {
			w.queued = append(w.queued, jobs...)
			return nil
		}),
	}
	return w
}

// googleAccount is the Google account each person signs in to at consent: the stand-in's default for testSub, their
// own for anyone else.
func googleAccount(sub string) string {
	if sub == testSub {
		return fakes.DefaultGoogleAccount
	}
	return sub + "@example.test"
}

// connect goes through consent and the callback as the given user, signing in to their own Google account.
func (w *world) connect(sub string) {
	w.t.Helper()
	w.connectAs(sub, googleAccount(sub))
}

// connectAs goes through consent as sub, signing in to Google as account.
func (w *world) connectAs(sub, account string) {
	w.t.Helper()
	state, code := w.consentAs(sub, account)
	if err := w.g.Callback(context.Background(), state, code); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) consent(sub string) (state, code string) {
	w.t.Helper()
	return w.consentAs(sub, googleAccount(sub))
}

func (w *world) consentAs(sub, account string) (state, code string) {
	w.t.Helper()
	consentURL, err := w.g.Connect(context.Background(), sub)
	if err != nil {
		w.t.Fatal(err)
	}
	consentURL += "&login_hint=" + url.QueryEscape(account)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(consentURL)
	if err != nil {
		w.t.Fatal(err)
	}
	res.Body.Close()
	loc, err := res.Location()
	if err != nil {
		w.t.Fatal(err)
	}
	return loc.Query().Get("state"), loc.Query().Get("code")
}

// write pushes fields as a device would.
func (w *world) write(sub, recordType, id string, values map[string]any) {
	w.t.Helper()
	w.devClock = max(w.devClock+1, w.now.UnixMilli()) // A device has seen the worker's clock by the time it edits.
	fields := sync.Fields{}
	for name, value := range values {
		fields[name] = sync.Field{V: value, C: fmt.Sprintf("%013d-000000-device", w.devClock)}
	}
	if _, err := w.records.Push(context.Background(), sub, 0, []sync.Change{{Type: recordType, ID: id, Fields: fields}}); err != nil {
		w.t.Fatal(err)
	}
}

// block writes a time block for a new task of the given title.
func (w *world) block(id, title string, start, end time.Time) {
	w.t.Helper()
	w.write(testSub, "task", "task-"+id, map[string]any{"title": title})
	w.write(testSub, "time_block", id, map[string]any{
		"task_id": "task-" + id, "start": instant(start), "end": instant(end), "tz": "UTC",
	})
}

func (w *world) run() {
	w.t.Helper()
	w.runFor(testSub)
}

func (w *world) runFor(sub string) {
	w.t.Helper()
	if err := w.g.Run(context.Background(), sub, "schedule", "req-1"); err != nil {
		w.t.Fatal(err)
	}
}

// storedToken is the refresh token held for sub, or "".
func (w *world) storedToken(sub string) string {
	w.conns.mu.Lock()
	defer w.conns.mu.Unlock()
	return w.conns.conns[sub].RefreshToken
}

func (w *world) timeBlocks() string { return w.fake.CalendarNamed(CalendarName) }

// eventFor returns the event mirroring a block, or nil.
func (w *world) eventFor(blockID string) *calendar.Event {
	for _, e := range w.fake.Events(w.timeBlocks()) {
		if e.Id == EventID(blockID) {
			return e
		}
	}
	return nil
}

func (w *world) calendarRecord(sub string) sync.Fields {
	return w.records.records[sub]["calendar#"+CalendarRecordID].Fields
}

func (w *world) sources() map[string]sync.Fields {
	out := map[string]sync.Fields{}
	for _, change := range w.records.records[testSub] {
		if change.Type == "calendar_source" {
			if id, ok := change.Fields["google_id"].V.(string); ok {
				out[id] = change.Fields
			}
		}
	}
	return out
}

func (w *world) storedEvents() []map[string]any {
	w.t.Helper()
	raw, ok := w.calendarRecord(testSub)["events"].V.([]any)
	if !ok {
		w.t.Fatalf("no events in %v", w.calendarRecord(testSub))
	}
	out := make([]map[string]any, len(raw))
	for i, e := range raw {
		out[i] = e.(map[string]any)
	}
	return out
}

// logLines returns the worker's run lines, parsed.
func (w *world) runLines() []map[string]any {
	w.t.Helper()
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(w.logs.String()), "\n") {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			w.t.Fatalf("log %q: %v", line, err)
		}
		if decoded["msg"] == "calendar_run" {
			lines = append(lines, decoded)
		}
	}
	return lines
}

func at(hours int) time.Time { return testNow.Add(time.Duration(hours) * time.Hour) }

func sameInstant(t *testing.T, got *calendar.EventDateTime, want time.Time) {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, got.DateTime)
	if err != nil || !parsed.Equal(want) {
		t.Fatalf("got %q want %s", got.DateTime, want)
	}
}

func TestCreatesAnEventForEachBlock(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.write(testSub, "practice", "p1", map[string]any{"title": "Learn to bake bread"})
	w.write(testSub, "time_block", "b2", map[string]any{"practice_id": "p1", "start": instant(at(3)), "end": instant(at(4)), "tz": "UTC"})
	w.fake.PageSize = 1
	w.run()

	e := w.eventFor("b1")
	if e == nil {
		t.Fatalf("no event: %+v", w.fake.Events(w.timeBlocks()))
	}
	if e.Summary != "Paint the fence" || e.Description != "Edit in app" {
		t.Fatalf("%q %q", e.Summary, e.Description)
	}
	if e.Reminders == nil || e.Reminders.UseDefault || len(e.Reminders.Overrides) != 0 {
		t.Fatalf("reminders on: %+v", e.Reminders)
	}
	sameInstant(t, e.Start, at(1))
	sameInstant(t, e.End, at(2))
	if p := w.eventFor("b2"); p == nil || p.Summary != "Learn to bake bread" {
		t.Fatalf("practice block: %+v", p)
	}

	rec := w.calendarRecord(testSub)
	if rec["connected"].V != true || rec["calendar_id"].V != w.timeBlocks() || rec["synced_at"].V != instant(testNow) || rec["last_error"].V != nil {
		t.Fatalf("record %+v", rec)
	}
	if _, ok := rec["last_error"]; !ok {
		t.Fatal("last_error never written")
	}
}

func TestEventIDsAreValidForGoogleAndStable(t *testing.T) {
	for _, id := range []string{"a", "018f3a-with-dash", "UPPER#and@symbols", strings.Repeat("x", 200)} {
		got := EventID(id)
		if got != EventID(id) || len(got) < 5 || len(got) > 1024 || strings.Trim(got, "abcdefghijklmnopqrstuv0123456789") != "" {
			t.Fatalf("%q gives %q", id, got)
		}
	}
	if EventID("a") == EventID("b") {
		t.Fatal("ids collide")
	}
}

func TestMovesAndRemovesEventsToMatchThePlan(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("moved", "Write the report", at(1), at(2))
	w.block("cancelled", "Paint the fence", at(3), at(4))
	w.block("deleted", "Learn to bake bread", at(5), at(6))
	w.block("renamed", "Old name", at(7), at(8))
	w.block("beyond", "Plan the garden", at(9), at(10))
	w.run()

	w.write(testSub, "time_block", "moved", map[string]any{"start": instant(at(24)), "end": instant(at(25))})
	w.write(testSub, "time_block", "cancelled", map[string]any{"cancelled": true})
	w.write(testSub, "time_block", "deleted", map[string]any{"deleted_at": instant(testNow)})
	w.write(testSub, "task", "task-renamed", map[string]any{"title": "New name"})
	w.write(testSub, "time_block", "beyond", map[string]any{"start": instant(testNow.AddDate(0, 0, 57)), "end": instant(testNow.AddDate(0, 0, 57).Add(time.Hour))})
	w.run()

	moved := w.eventFor("moved")
	sameInstant(t, moved.Start, at(24))
	sameInstant(t, moved.End, at(25))
	if w.eventFor("cancelled") != nil || w.eventFor("deleted") != nil || w.eventFor("beyond") != nil {
		t.Fatalf("still there: %+v", w.fake.Events(w.timeBlocks()))
	}
	if w.eventFor("renamed").Summary != "New name" {
		t.Fatal("title not updated")
	}

	// Coming back into the plan, the ids of deleted events still work.
	w.write(testSub, "time_block", "cancelled", map[string]any{"cancelled": false})
	w.write(testSub, "time_block", "beyond", map[string]any{"start": instant(at(30)), "end": instant(at(31))})
	w.run()
	if w.eventFor("cancelled") == nil || w.eventFor("beyond") == nil {
		t.Fatalf("not restored: %+v", w.fake.Events(w.timeBlocks()))
	}
}

func TestEditsInGoogleAreOverwritten(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("title", "Paint the fence", at(1), at(2))
	w.block("time", "Write the report", at(3), at(4))
	w.block("note", "Learn to bake bread", at(5), at(6))
	w.block("alert", "Plan the garden", at(7), at(8))
	w.block("gone", "Tidy the shed", at(9), at(10))
	w.run()
	cal := w.timeBlocks()

	w.fake.EditEvent(cal, EventID("title"), func(e *calendar.Event) { e.Summary = "Changed in Google" })
	w.fake.EditEvent(cal, EventID("time"), func(e *calendar.Event) {
		e.Start = &calendar.EventDateTime{DateTime: at(20).Format(time.RFC3339)}
		e.End = &calendar.EventDateTime{DateTime: at(21).Format(time.RFC3339)}
	})
	w.fake.EditEvent(cal, EventID("note"), func(e *calendar.Event) { e.Description = "A note" })
	w.fake.EditEvent(cal, EventID("alert"), func(e *calendar.Event) { e.Reminders = &calendar.EventReminders{UseDefault: true} })
	w.fake.DeleteEvent(cal, EventID("gone"))
	stray := w.fake.AddEvent(cal, &calendar.Event{
		Summary: "Added in Google",
		Start:   &calendar.EventDateTime{DateTime: at(11).Format(time.RFC3339)},
		End:     &calendar.EventDateTime{DateTime: at(12).Format(time.RFC3339)},
	})
	w.run()

	if e := w.eventFor("title"); e.Summary != "Paint the fence" {
		t.Fatalf("title %q", e.Summary)
	}
	sameInstant(t, w.eventFor("time").Start, at(3))
	if e := w.eventFor("note"); e.Description != "Edit in app" {
		t.Fatalf("description %q", e.Description)
	}
	if e := w.eventFor("alert"); e.Reminders.UseDefault {
		t.Fatal("reminders stayed on")
	}
	if w.eventFor("gone") == nil {
		t.Fatal("deleted event not restored")
	}
	for _, e := range w.fake.Events(cal) {
		if e.Id == stray {
			t.Fatal("event added in Google stayed")
		}
	}
}

func TestPastEventsAreLeftAlone(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("past-edited", "Paint the fence", at(1), at(2))
	w.block("past-cancelled", "Write the report", at(3), at(4))
	w.run()
	cal := w.timeBlocks()

	w.now = at(5)
	w.fake.EditEvent(cal, EventID("past-edited"), func(e *calendar.Event) { e.Summary = "Edited after the fact" })
	w.write(testSub, "time_block", "past-cancelled", map[string]any{"cancelled": true})
	before := w.fake.Writes()
	// Earlier today, with no event: too late to add one.
	w.block("past-new", "Learn to bake bread", at(0), at(1))
	w.run()

	if w.fake.Writes() != before {
		t.Fatalf("wrote %d times", w.fake.Writes()-before)
	}
	if e := w.eventFor("past-edited"); e == nil || e.Summary != "Edited after the fact" {
		t.Fatalf("%+v", e)
	}
	if w.eventFor("past-cancelled") == nil || w.eventFor("past-new") != nil {
		t.Fatal("past events changed")
	}

	// A block moved from the past into the future still has to appear there.
	w.write(testSub, "time_block", "past-edited", map[string]any{"start": instant(at(10)), "end": instant(at(11))})
	w.run()
	sameInstant(t, w.eventFor("past-edited").Start, at(10))
}

func TestEndedAtIsTheEventsEnd(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("early", "Paint the fence", at(-1), at(2))
	w.block("long", "Write the report", at(-1), at(1))
	w.block("never-started", "Learn to bake bread", at(1), at(2))
	w.run()

	w.write(testSub, "time_block", "early", map[string]any{"ended_at": instant(testNow.Add(-10 * time.Minute))})
	w.write(testSub, "time_block", "long", map[string]any{"ended_at": instant(at(3))})
	w.write(testSub, "time_block", "never-started", map[string]any{"ended_at": instant(at(1))})
	w.run()

	sameInstant(t, w.eventFor("early").End, testNow.Add(-10*time.Minute))
	sameInstant(t, w.eventFor("long").End, at(3))
	if w.eventFor("never-started") != nil {
		t.Fatal("a block that took no time keeps its event")
	}
}

func TestInProgressAcrossMidnightStays(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("night", "Paint the fence", testNow.Add(-30*time.Hour), at(1))
	w.run()
	if w.eventFor("night") == nil {
		t.Fatal("a block still running has no event")
	}
}

// Every device downloads the calendar record again whenever it changes, so a run that finds nothing to do leaves it
// alone, synced_at included.
func TestARunWithNothingToDoWritesNothing(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.fake.AddCalendar("home@example.test", "Home")
	w.run()
	writes := w.fake.Writes()
	before := w.calendarRecord(testSub)
	nameClock := w.sources()["home@example.test"]["name"].C
	w.now = w.now.Add(time.Minute)
	w.run()
	if w.fake.Writes() != writes {
		t.Fatalf("%d writes", w.fake.Writes()-writes)
	}
	if !reflect.DeepEqual(w.calendarRecord(testSub), before) || w.sources()["home@example.test"]["name"].C != nameClock {
		t.Fatalf("unchanged fields rewritten: %+v", w.calendarRecord(testSub))
	}
}

// synced_at says when a run last changed something, in Google or in the record.
func TestSyncedAtMovesWhenARunChangesEventsOrTheMirror(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.fake.AddCalendar("home@example.test", "Home")
	w.run()
	syncedAt := func() any { return w.calendarRecord(testSub)["synced_at"].V }

	w.now = w.now.Add(time.Minute)
	w.write(testSub, "task", "task-b1", map[string]any{"title": "Paint the gate"})
	w.run()
	if w.eventFor("b1").Summary != "Paint the gate" || syncedAt() != instant(w.now) {
		t.Fatalf("an event changed: synced_at %v", syncedAt())
	}

	w.now = w.now.Add(time.Minute)
	w.fake.AddEvent("home@example.test", &calendar.Event{
		Summary: "Team lunch",
		Start:   &calendar.EventDateTime{DateTime: at(3).Format(time.RFC3339)},
		End:     &calendar.EventDateTime{DateTime: at(4).Format(time.RFC3339)},
	})
	w.run()
	if len(w.storedEvents()) != 1 || syncedAt() != instant(w.now) {
		t.Fatalf("the mirror changed: synced_at %v", syncedAt())
	}
}

// An event Google says is already gone was deleted by someone else, so the run counts no deletion and moves nothing.
func TestAnEventAlreadyGoneIsNotCountedAsDeleted(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.run()
	syncedAt := w.calendarRecord(testSub)["synced_at"].V
	cal := w.timeBlocks()
	// The person deletes the event in Google between the run's list and its delete.
	racing := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.fake.DeleteEvent(cal, EventID("b1"))
		}
		w.fake.ServeHTTP(rw, r)
	}))
	t.Cleanup(racing.Close)
	w.g.APIURL = racing.URL + "/calendar/v3/"
	w.write(testSub, "time_block", "b1", map[string]any{"deleted_at": instant(testNow)})
	w.now = w.now.Add(time.Minute)
	w.run()

	lines := w.runLines()
	if last := lines[len(lines)-1]; last["deleted"] != float64(0) || last["CalendarEventsChanged"] != float64(0) {
		t.Fatalf("%+v", last)
	}
	if got := w.calendarRecord(testSub)["synced_at"].V; got != syncedAt {
		t.Fatalf("synced_at %v then %v", syncedAt, got)
	}
}

func TestMalformedBlocksDoNotStopTheRun(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.write(testSub, "time_block", "no-times", map[string]any{"task_id": "x"})
	w.write(testSub, "time_block", "bad-times", map[string]any{"start": "soon", "end": 12})
	w.write(testSub, "time_block", "backwards", map[string]any{"start": instant(at(2)), "end": instant(at(1))})
	w.write(testSub, "time_block", "no-task", map[string]any{"task_id": "missing", "start": instant(at(3)), "end": instant(at(4))})
	long := strings.Repeat("é", 5000)
	w.block("long", long, at(5), at(6))
	w.run()
	if rec := w.calendarRecord(testSub); rec["last_error"].V != nil {
		t.Fatalf("%+v", rec)
	}
	if got := len(w.fake.Events(w.timeBlocks())); got != 2 {
		t.Fatalf("%d events", got)
	}
	if e := w.eventFor("no-task"); e.Summary != "Time block" {
		t.Fatalf("title %q", e.Summary)
	}
	if e := w.eventFor("long"); len([]rune(e.Summary)) > 1000 {
		t.Fatalf("title of %d", len([]rune(e.Summary)))
	}
}

func TestOnlyTheConnectedUsersBlocksReachTheCalendar(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.write("someone-else", "time_block", "theirs", map[string]any{"start": instant(at(1)), "end": instant(at(2))})
	w.run()
	if len(w.fake.Events(w.timeBlocks())) != 0 {
		t.Fatal("another user's block on the calendar")
	}
	if w.records.records["someone-else"]["calendar#"+CalendarRecordID].ID != "" {
		t.Fatal("wrote to another user")
	}
}

func TestReadsCalendarsByMode(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.fake.PageSize = 1
	for id, name := range map[string]string{"office@example.test": "Office", "home@example.test": "Home", "noise@example.test": "Noise"} {
		w.fake.AddCalendar(id, name)
		w.fake.AddEvent(id, &calendar.Event{
			Id: "ev" + name, Summary: name + " event",
			Start: &calendar.EventDateTime{DateTime: at(1).In(time.FixedZone("x", -5*3600)).Format(time.RFC3339)},
			End:   &calendar.EventDateTime{DateTime: at(2).In(time.FixedZone("x", -5*3600)).Format(time.RFC3339)},
		})
	}
	w.run()

	sources := w.sources()
	if len(sources) != 3 {
		t.Fatalf("%+v", sources)
	}
	if s := sources["office@example.test"]; s["name"].V != "Office" || s["mode"].V != "block" {
		t.Fatalf("%+v", s)
	}
	if _, ownCalendar := sources[w.timeBlocks()]; ownCalendar {
		t.Fatal("Time blocks listed as a source")
	}
	if got := w.storedEvents(); len(got) != 3 {
		t.Fatalf("%+v", got)
	}
	first := w.storedEvents()[0]
	if first["start"] != instant(at(1)) || first["end"] != instant(at(2)) || first["title"] == "" || first["calendar"] == "" || first["id"] == "" {
		t.Fatalf("%+v", first)
	}

	setMode := func(id, mode string) {
		for key, change := range w.records.records[testSub] {
			if change.Type == "calendar_source" && change.Fields["google_id"].V == id {
				w.write(testSub, "calendar_source", strings.TrimPrefix(key, "calendar_source#"), map[string]any{"mode": mode})
			}
		}
	}
	setMode("home@example.test", "info")
	setMode("noise@example.test", "ignore")
	w.now = w.now.Add(time.Minute)
	w.run()
	got := map[string]string{}
	for _, e := range w.storedEvents() {
		got[e["calendar"].(string)] = e["title"].(string)
	}
	if got["office@example.test"] != "Office event" || got["home@example.test"] != "Home event" || got["noise@example.test"] != "" || len(got) != 2 {
		t.Fatalf("%+v", got)
	}

	// The worker's name and the device's mode merge. A rename keeps the mode.
	w.fake.AddCalendar("home@example.test", "Household")
	w.now = w.now.Add(time.Minute)
	w.run()
	if s := w.sources()["home@example.test"]; s["name"].V != "Household" || s["mode"].V != "info" {
		t.Fatalf("%+v", s)
	}

	// Gone from the list, its record is tombstoned; back again, it keeps its mode.
	w.fake.DeleteCalendar("home@example.test")
	w.now = w.now.Add(time.Minute)
	w.run()
	if s := w.sources()["home@example.test"]; s["deleted_at"].V != instant(w.now) {
		t.Fatalf("%+v", s)
	}
	w.fake.AddCalendar("home@example.test", "Household")
	w.now = w.now.Add(time.Minute)
	w.run()
	if s := w.sources()["home@example.test"]; s["deleted_at"].V != nil || s["mode"].V != "info" {
		t.Fatalf("%+v", s)
	}
}

func TestAllDayEventsUseTheirCalendarsZone(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.fake.AddCalendar("home@example.test", "Home")
	w.fake.SetTimeZone("home@example.test", "America/Chicago")
	w.fake.AddEvent("home@example.test", &calendar.Event{
		Id: "evday", Summary: "Street fair",
		Start: &calendar.EventDateTime{Date: "2026-11-03"}, End: &calendar.EventDateTime{Date: "2026-11-04"},
	})
	w.run()
	got := w.storedEvents()
	if len(got) != 1 || got[0]["all_day"] != true || got[0]["start"] != "2026-11-03T06:00:00Z" || got[0]["end"] != "2026-11-04T06:00:00Z" {
		t.Fatalf("%+v", got)
	}
}

func TestTooManyEventsKeepTheSoonestAndSaySo(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.fake.AddCalendar("crowded@example.test", "Crowded")
	title := strings.Repeat("x", 1000)
	for i := range 200 {
		start := at(i + 1)
		w.fake.AddEvent("crowded@example.test", &calendar.Event{
			Summary: title,
			Start:   &calendar.EventDateTime{DateTime: start.Format(time.RFC3339)},
			End:     &calendar.EventDateTime{DateTime: start.Add(time.Hour).Format(time.RFC3339)},
		})
	}
	w.run()
	got := w.storedEvents()
	if len(got) == 0 || len(got) == 200 {
		t.Fatalf("%d events", len(got))
	}
	if got[0]["start"] != instant(at(1)) {
		t.Fatalf("first is %v", got[0]["start"])
	}
	if rec := w.calendarRecord(testSub); rec["last_error"].V != ErrorTooManyEvents || rec["connected"].V != true {
		t.Fatalf("%+v", rec["last_error"])
	}
}

func TestARunBeatsAClockAheadOfItsOwn(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	ahead := fmt.Sprintf("%013d-000000-device", testNow.Add(20*time.Hour).UnixMilli())
	if _, err := w.records.Push(context.Background(), testSub, 0, []sync.Change{{Type: "calendar", ID: CalendarRecordID, Fields: sync.Fields{
		"synced_at": {V: "stale", C: ahead},
	}}}); err != nil {
		t.Fatal(err)
	}
	w.run()
	if got := w.calendarRecord(testSub)["synced_at"].V; got != instant(testNow) {
		t.Fatalf("synced_at %v", got)
	}
}

func TestRateLimitIsRecordedAndTheNextRunFixesIt(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.fake.RateLimit(1)
	if err := w.g.Run(context.Background(), testSub, "stream", "req-2"); err != nil {
		t.Fatalf("a failure already recorded should not be retried by Lambda: %v", err)
	}
	rec := w.calendarRecord(testSub)
	if rec["last_error"].V != ErrorRateLimited || rec["connected"].V != true {
		t.Fatalf("%+v", rec)
	}
	lines := w.runLines()
	last := lines[len(lines)-1]
	// One person's quota is theirs: counted on its own, not as the worker failing, nor as it running.
	if last["outcome"] != "rate_limited" || last["error_type"] != ErrorRateLimited || last["CalendarRateLimited"] != float64(1) ||
		last["CalendarRunFailures"] != float64(0) || last["trigger"] != "stream" || last["request_id"] != "req-2" {
		t.Fatalf("%+v", last)
	}
	if _, success := last["CalendarEventsChanged"]; success {
		t.Fatal("a run held back by quota looks like a success to the 2-hour alarm")
	}

	w.now = w.now.Add(time.Minute)
	w.run()
	rec = w.calendarRecord(testSub)
	if rec["last_error"].V != nil || w.eventFor("b1") == nil {
		t.Fatalf("%+v", rec)
	}
}

func TestRevokedTokenIsRecordedUntilReconnected(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.run()
	w.fake.Revoke()
	w.now = w.now.Add(time.Minute)
	w.block("b2", "Write the report", at(3), at(4))
	w.run()
	rec := w.calendarRecord(testSub)
	if rec["last_error"].V != ErrorRevoked || rec["connected"].V != false {
		t.Fatalf("%+v", rec)
	}

	w.now = w.now.Add(time.Minute)
	w.connect(testSub)
	cal := w.timeBlocks()
	w.run()
	rec = w.calendarRecord(testSub)
	if rec["last_error"].V != nil || rec["connected"].V != true || rec["calendar_id"].V != cal {
		t.Fatalf("%+v", rec)
	}
	if w.eventFor("b2") == nil {
		t.Fatal("not caught up")
	}
}

func TestErrorCodes(t *testing.T) {
	for _, test := range []struct {
		err  error
		want string
	}{
		{errors.New("anything"), ErrorFailed},
		{fmt.Errorf("wrapped: %w", &oauth2.RetrieveError{ErrorCode: "invalid_grant"}), ErrorRevoked},
		{&oauth2.RetrieveError{ErrorCode: "invalid_client"}, ErrorFailed},
		{&googleapi.Error{Code: 401}, ErrorRevoked},
		{&googleapi.Error{Code: 429}, ErrorRateLimited},
		{&googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: "rateLimitExceeded"}}}, ErrorRateLimited},
		{&googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: "userRateLimitExceeded"}}}, ErrorRateLimited},
		{&googleapi.Error{Code: 403, Errors: []googleapi.ErrorItem{{Reason: "forbidden"}}}, ErrorFailed},
		{&googleapi.Error{Code: 500}, ErrorFailed},
	} {
		if got := errorCode(test.err); got != test.want {
			t.Errorf("%v: %s", test.err, got)
		}
	}
}

func TestDeletedTimeBlocksCalendarIsCreatedAgain(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.block("b1", "Paint the fence", at(1), at(2))
	w.run()
	old := w.timeBlocks()
	w.fake.DeleteCalendar(old)
	w.now = w.now.Add(time.Minute)
	w.run()
	cal := w.timeBlocks()
	if cal == "" || cal == old {
		t.Fatalf("calendar %q", cal)
	}
	if w.calendarRecord(testSub)["calendar_id"].V != cal || w.eventFor("b1") == nil {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
}

// Not connected is a state the person chose, by disconnecting or never connecting, so the worker-silent alarm stays quiet.
func TestNotConnectedDoesNothingAndCountsAsASuccess(t *testing.T) {
	w := newWorld(t)
	w.write(testSub, "time_block", "b1", map[string]any{"start": instant(at(1)), "end": instant(at(2))})
	w.run()
	if w.fake.Writes() != 0 || w.calendarRecord(testSub) != nil {
		t.Fatal("did something")
	}
	lines := w.runLines()
	if len(lines) != 1 || lines[0]["outcome"] != "not_connected" {
		t.Fatalf("%+v", lines)
	}
	if lines[0]["CalendarEventsChanged"] != float64(0) || lines[0]["CalendarRunFailures"] != float64(0) {
		t.Fatalf("%+v", lines[0])
	}
}

func TestRunEmitsEMFAndNoValues(t *testing.T) {
	w := newWorld(t)
	const marker = "MARKER-do-not-log"
	w.connect(testSub)
	token := w.storedToken(testSub)
	w.block("b1", marker, at(1), at(2))
	w.fake.AddCalendar("home@example.test", marker)
	w.fake.AddEvent("home@example.test", &calendar.Event{
		Summary: marker,
		Start:   &calendar.EventDateTime{DateTime: at(1).Format(time.RFC3339)},
		End:     &calendar.EventDateTime{DateTime: at(2).Format(time.RFC3339)},
	})
	w.run()
	w.fake.RateLimit(1)
	w.run()
	w.fake.Revoke()
	w.run()

	logged := w.logs.String()
	for _, leak := range []string{marker, token, "state-key", "secret", testSub, "home@example.test", fakes.DefaultGoogleAccount} {
		if strings.Contains(logged, leak) {
			t.Fatalf("%q in logs: %s", leak, logged)
		}
	}

	first := w.runLines()[0]
	if first["CalendarEventsChanged"] != float64(1) || first["CalendarRunFailures"] != float64(0) || first["inserted"] != float64(1) || first["user"] != obs.HashSub(testSub) {
		t.Fatalf("%+v", first)
	}
	emf := first["_aws"].(map[string]any)["CloudWatchMetrics"].([]any)[0].(map[string]any)
	if emf["Namespace"] != "Multiscale/staging" {
		t.Fatalf("%+v", emf)
	}
	var names []string
	for _, metric := range emf["Metrics"].([]any) {
		names = append(names, metric.(map[string]any)["Name"].(string))
	}
	if strings.Join(names, ",") != "CalendarEventsChanged,CalendarRunFailures" {
		t.Fatalf("%v", names)
	}
}

// hookedRecords calls before ahead of each List, so a test can act at a set point inside a run.
type hookedRecords struct {
	*memRecords
	before func(recordType string)
}

func (h hookedRecords) List(ctx context.Context, sub, recordType string) ([]sync.Change, error) {
	h.before(recordType)
	return h.memRecords.List(ctx, sub, recordType)
}

// A run reads the connection when it starts. The person can disconnect before the run's last writes, which has already
// shown them unconnected. Writing on would show them connected again, with events the app counts as busy time, or an
// error to fix.
func TestARunWritesNothingMoreOnceItsConnectionIsGone(t *testing.T) {
	disconnect := func(w *world) {
		if err := w.g.Disconnect(context.Background(), testSub); err != nil {
			w.t.Fatal(err)
		}
	}
	for name, c := range map[string]struct {
		during string
		gone   func(w *world)
	}{
		"disconnected":                  {"calendar_source", disconnect},
		"disconnected before a failure": {"time_block", func(w *world) { disconnect(w); w.fake.RateLimit(1) }},
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.connect(testSub)
			w.fake.AddCalendar("home@example.test", "Home")
			w.run()
			w.fake.AddEvent("home@example.test", &calendar.Event{
				Summary: "Team lunch",
				Start:   &calendar.EventDateTime{DateTime: at(1).Format(time.RFC3339)},
				End:     &calendar.EventDateTime{DateTime: at(2).Format(time.RFC3339)},
			})
			happened := false
			w.g.Records = hookedRecords{w.records, func(recordType string) {
				if recordType == c.during && !happened {
					happened = true
					c.gone(w)
				}
			}}
			w.now = w.now.Add(time.Minute)
			if err := w.g.Run(context.Background(), testSub, "schedule", "r"); err != nil || !happened {
				t.Fatalf("%v, happened %v", err, happened)
			}
			if rec := w.calendarRecord(testSub); rec["connected"].V != false || len(rec["events"].V.([]any)) != 0 || rec["last_error"].V != nil {
				t.Fatalf("%+v", rec)
			}
		})
	}
}

func TestStoreFailureThatCannotBeRecordedIsReturned(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.records.failing = errors.New("store down")
	if err := w.g.Run(context.Background(), testSub, "schedule", "r"); err == nil {
		t.Fatal("swallowed")
	}
	if lines := w.runLines(); lines[len(lines)-1]["CalendarRunFailures"] != float64(1) {
		t.Fatalf("%+v", lines)
	}
}

// shorten sets one of the worker's durations for the length of a test.
func shorten(t *testing.T, d *time.Duration, to time.Duration) {
	t.Helper()
	was := *d
	*d = to
	t.Cleanup(func() { *d = was })
}

// intercept puts answer in front of the fake Google for the worker's calls: the Calendar API and the token refresh.
// Calls it leaves alone, by returning false, go on to the fake.
func (w *world) intercept(answer func(rw http.ResponseWriter, r *http.Request) bool) {
	w.t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if !answer(rw, r) {
			w.fake.ServeHTTP(rw, r)
		}
	}))
	w.t.Cleanup(srv.Close)
	w.g.TokenURL, w.g.APIURL = srv.URL+"/token", srv.URL+"/calendar/v3/"
}

// hang leaves calls to Google under path unanswered until the caller gives up on them.
func (w *world) hang(path string) {
	w.t.Helper()
	release := make(chan struct{})
	w.intercept(func(_ http.ResponseWriter, r *http.Request) bool {
		if !strings.HasPrefix(r.URL.Path, path) {
			return false
		}
		select {
		case <-r.Context().Done():
		case <-release:
		}
		return true
	})
	// Before the server closes, which waits for every call to end.
	w.t.Cleanup(func() { close(release) })
}

// failCalendarAPI answers the next calls to the Calendar API with fail, every call when calls is negative.
func (w *world) failCalendarAPI(calls int, fail func(rw http.ResponseWriter)) {
	w.t.Helper()
	var mu gosync.Mutex
	w.intercept(func(rw http.ResponseWriter, r *http.Request) bool {
		mu.Lock()
		defer mu.Unlock()
		if calls == 0 || !strings.HasPrefix(r.URL.Path, "/calendar/v3/") {
			return false
		}
		calls--
		fail(rw)
		return true
	})
}

func unavailable(rw http.ResponseWriter) {
	http.Error(rw, "Service Unavailable", http.StatusServiceUnavailable)
}

// dropped closes the connection without an answer, as when the network goes.
func dropped(http.ResponseWriter) { panic(http.ErrAbortHandler) }

// runWithin runs the worker, and fails the test if the run is still going after limit.
func (w *world) runWithin(ctx context.Context, limit time.Duration) error {
	w.t.Helper()
	done := make(chan error, 1)
	go func() { done <- w.g.Run(ctx, testSub, "schedule", "r") }()
	select {
	case err := <-done:
		return err
	case <-time.After(limit):
		w.t.Fatalf("the run was still waiting on Google after %s", limit)
		return nil
	}
}

// A call that never answers would hold the run until Lambda stopped it at its own limit, with nothing recorded, so the
// app would show the calendar as fine.
func TestACallToGoogleThatHangsFailsTheRunAndIsRecorded(t *testing.T) {
	for name, path := range map[string]string{"the Calendar API": "/calendar/v3/", "the token refresh": "/token"} {
		t.Run(name, func(t *testing.T) {
			shorten(t, &callTimeout, 100*time.Millisecond)
			w := newWorld(t)
			w.connect(testSub)
			w.g.Retry = func(context.Context, string, time.Duration) error { return nil }
			w.hang(path)
			if err := w.runWithin(context.Background(), 10*time.Second); err != nil {
				t.Fatal(err)
			}
			if rec := w.calendarRecord(testSub); rec["last_error"].V != ErrorFailed || rec["connected"].V != true {
				t.Fatalf("%+v", rec)
			}
		})
	}
}

// Lambda's deadline ends the run's context. The failure is still recorded, on a context of its own.
func TestARunWhoseContextEndsStillRecordsTheFailure(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.hang("/calendar/v3/")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := w.runWithin(ctx, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if rec := w.calendarRecord(testSub); rec["last_error"].V != ErrorFailed {
		t.Fatalf("%+v", rec)
	}
	if lines := w.runLines(); len(lines) != 1 {
		t.Fatalf("no time was left for a follow-up run, yet: %+v", lines)
	}
}

func TestARunThatCannotReachGoogleIsFollowedByOneMoreAMinuteLater(t *testing.T) {
	for name, c := range map[string]struct {
		calls int
		fail  func(http.ResponseWriter)
		want  []time.Duration
	}{
		"Google answers 503":           {1, unavailable, []time.Duration{time.Minute}},
		"the connection drops":         {-1, dropped, []time.Duration{time.Minute}},
		"Google refuses: rate limited": {0, nil, nil},
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.connect(testSub)
			var asked []time.Duration
			w.g.Retry = func(_ context.Context, sub string, after time.Duration) error {
				if sub != testSub {
					t.Fatalf("retry for %s", sub)
				}
				asked = append(asked, after)
				return nil
			}
			if c.fail != nil {
				w.failCalendarAPI(c.calls, c.fail)
			} else {
				w.fake.RateLimit(1)
			}
			w.run()
			if !reflect.DeepEqual(asked, c.want) {
				t.Fatalf("asked for %v, want %v", asked, c.want)
			}
			if lines := w.runLines(); len(lines) != 1 {
				t.Fatalf("ran again itself rather than asking: %+v", lines)
			}
		})
	}
}

func TestTheFollowUpRunAsksForNoOther(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.g.Retry = func(context.Context, string, time.Duration) error {
		t.Fatal("asked again")
		return nil
	}
	w.failCalendarAPI(-1, unavailable)
	if err := w.g.Run(context.Background(), testSub, TriggerRetry, "r"); err != nil {
		t.Fatal(err)
	}
	if rec := w.calendarRecord(testSub); rec["last_error"].V != ErrorFailed {
		t.Fatalf("%+v", rec)
	}
}

// With nothing to ask, as in the Lambda, the run waits and runs again itself.
func TestWithNothingToAskTheRunWaitsAndRunsAgainItself(t *testing.T) {
	t.Run("and the follow-up catches up", func(t *testing.T) {
		shorten(t, &retryDelay, 10*time.Millisecond)
		w := newWorld(t)
		w.connect(testSub)
		w.block("b1", "Paint the fence", at(1), at(2))
		w.failCalendarAPI(1, unavailable)
		w.run()
		if rec := w.calendarRecord(testSub); rec["last_error"].V != nil || w.eventFor("b1") == nil {
			t.Fatalf("%+v", rec)
		}
		lines := w.runLines()
		if len(lines) != 2 || lines[0]["outcome"] != "failed" || lines[1]["outcome"] != "ok" || lines[1]["trigger"] != TriggerRetry {
			t.Fatalf("%+v", lines)
		}
	})
	t.Run("only once", func(t *testing.T) {
		shorten(t, &retryDelay, 10*time.Millisecond)
		w := newWorld(t)
		w.connect(testSub)
		w.failCalendarAPI(-1, unavailable)
		w.run()
		if rec := w.calendarRecord(testSub); rec["last_error"].V != ErrorFailed {
			t.Fatalf("%+v", rec)
		}
		if lines := w.runLines(); len(lines) != 2 || lines[1]["trigger"] != TriggerRetry {
			t.Fatalf("%+v", lines)
		}
	})
	t.Run("not when Lambda's time would run out first", func(t *testing.T) {
		w := newWorld(t)
		w.connect(testSub)
		w.failCalendarAPI(-1, unavailable)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := w.runWithin(ctx, 10*time.Second); err != nil {
			t.Fatal(err)
		}
		if lines := w.runLines(); len(lines) != 1 {
			t.Fatalf("%+v", lines)
		}
	})
}

func TestUnreachable(t *testing.T) {
	refused := func(status int) *http.Response { return &http.Response{StatusCode: status} }
	for _, test := range []struct {
		err  error
		want bool
	}{
		{&url.Error{Op: "Get", URL: "https://www.googleapis.com", Err: errors.New("connection reset by peer")}, true},
		{&googleapi.Error{Code: 500}, true},
		{&googleapi.Error{Code: 503}, true},
		{fmt.Errorf("wrapped: %w", &googleapi.Error{Code: 502}), true},
		{&url.Error{Op: "Post", URL: "https://oauth2.googleapis.com/token", Err: &oauth2.RetrieveError{Response: refused(502)}}, true},
		{&url.Error{Op: "Post", URL: "https://oauth2.googleapis.com/token", Err: &oauth2.RetrieveError{Response: refused(400), ErrorCode: "invalid_grant"}}, false},
		{&googleapi.Error{Code: 401}, false},
		{&googleapi.Error{Code: 404}, false},
		{&googleapi.Error{Code: 429}, false},
		{errors.New("store down"), false},
	} {
		if got := unreachable(test.err); got != test.want {
			t.Errorf("%v: %v", test.err, got)
		}
	}
}
