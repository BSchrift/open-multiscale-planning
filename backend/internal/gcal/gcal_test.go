package gcal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

const testSub = "user-sub-1"

var testNow = time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

// memRecords is the store's behaviour with no DynamoDB: real field merging, per user.
type memRecords struct {
	mu      gosync.Mutex
	records map[string]map[string]sync.Change
	failing error
}

func (m *memRecords) List(_ context.Context, sub, recordType string) ([]sync.Change, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return nil, m.failing
	}
	var out []sync.Change
	for _, change := range m.records[sub] {
		if change.Type == recordType {
			out = append(out, change)
		}
	}
	return out, nil
}

func (m *memRecords) Push(_ context.Context, sub string, _ int64, changes []sync.Change) (sync.Stats, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failing != nil {
		return sync.Stats{}, m.failing
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

func (m *memSecrets) Get(_ context.Context, name string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
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
	logs     *bytes.Buffer
	now      time.Time
	triggers int
	trigger  error
	devClock int64
}

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, records: &memRecords{}, logs: &bytes.Buffer{}, now: testNow, devClock: testNow.UnixMilli() - 1000}
	w.secrets = &memSecrets{values: map[string]string{SecretClientID: "cid", SecretClientSecret: "secret", SecretState: "state-key"}}
	now := func() time.Time { return w.now }
	w.fake = fakes.NewGoogle("cid", "secret", now)
	w.srv = httptest.NewServer(w.fake)
	t.Cleanup(w.srv.Close)
	w.g = &Google{
		Records: w.records, Secrets: w.secrets, States: memStates{},
		Log: obs.NewLogger(w.logs), Env: "staging", Now: now,
		AuthURL: w.srv.URL + "/o/oauth2/auth", TokenURL: w.srv.URL + "/token", RevokeURL: w.srv.URL + "/revoke", APIURL: w.srv.URL + "/calendar/v3/",
		RedirectURL: "https://app.example.test/calendar/callback",
		Trigger: func(context.Context) error {
			w.triggers++
			return w.trigger
		},
	}
	return w
}

// connect goes through consent and the callback as the given user.
func (w *world) connect(sub string) {
	w.t.Helper()
	state, code := w.consent(sub)
	if err := w.g.Callback(context.Background(), state, code); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) consent(sub string) (state, code string) {
	w.t.Helper()
	consentURL, err := w.g.Connect(context.Background(), sub)
	if err != nil {
		w.t.Fatal(err)
	}
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
	if err := w.g.Run(context.Background(), "schedule", "req-1"); err != nil {
		w.t.Fatal(err)
	}
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
	if err := w.g.Run(context.Background(), "stream", "req-2"); err != nil {
		t.Fatalf("a failure already recorded should not be retried by Lambda: %v", err)
	}
	rec := w.calendarRecord(testSub)
	if rec["last_error"].V != ErrorRateLimited || rec["connected"].V != true {
		t.Fatalf("%+v", rec)
	}
	lines := w.runLines()
	last := lines[len(lines)-1]
	if last["error_type"] != ErrorRateLimited || last["CalendarRunFailures"] != float64(1) || last["trigger"] != "stream" || last["request_id"] != "req-2" {
		t.Fatalf("%+v", last)
	}
	if _, success := last["CalendarEventsChanged"]; success {
		t.Fatal("a failed run looks like a success to the 2-hour alarm")
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
	token := w.secrets.values[SecretRefreshToken]
	for _, leak := range []string{marker, token, "state-key", "secret", testSub, "home@example.test"} {
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

func TestStoreFailureThatCannotBeRecordedIsReturned(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.records.failing = errors.New("store down")
	if err := w.g.Run(context.Background(), "schedule", "r"); err == nil {
		t.Fatal("swallowed")
	}
	if lines := w.runLines(); lines[len(lines)-1]["CalendarRunFailures"] != float64(1) {
		t.Fatalf("%+v", lines)
	}
}
