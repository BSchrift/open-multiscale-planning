package integration

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"
)

const instantForm = "2006-01-02T15:04:05Z"

func instantOf(at time.Time) string { return at.UTC().Format(instantForm) }

type googleTime struct {
	DateTime string `json:"dateTime,omitempty"`
	Date     string `json:"date,omitempty"`
}

type googleEvent struct {
	ID          string     `json:"id,omitempty"`
	Summary     string     `json:"summary"`
	Description string     `json:"description,omitempty"`
	Start       googleTime `json:"start"`
	End         googleTime `json:"end"`
	Reminders   *struct {
		UseDefault bool `json:"useDefault"`
	} `json:"reminders,omitempty"`
}

type googleCalendar struct {
	ID         string        `json:"id"`
	Summary    string        `json:"summary"`
	AppCreated bool          `json:"app_created"`
	Events     []googleEvent `json:"events"`
}

func googleControl(t *testing.T, path string, body any) {
	t.Helper()
	res := request(t, "POST", "/google/_test/"+path, "", mustJSON(t, body))
	if res.status != 204 {
		t.Fatalf("google %s: %d %s", path, res.status, res.body)
	}
}

func googleCalendars(t *testing.T) []googleCalendar {
	t.Helper()
	res := request(t, "GET", "/google/_test/calendars", "", nil)
	var state struct {
		Calendars []googleCalendar `json:"calendars"`
	}
	if err := json.Unmarshal(res.body, &state); err != nil || res.status != 200 {
		t.Fatalf("google state: %d %v", res.status, err)
	}
	return state.Calendars
}

// connectCalendar goes through consent as a person does, following Google's redirect back to the API.
func connectCalendar(t *testing.T, a *account) {
	t.Helper()
	res, err := http.Get(consentURL(t, a))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("consent: %d", res.StatusCode)
	}
	t.Cleanup(func() {
		if id, ok := calendarID(a); ok {
			request(t, "POST", "/google/_test/calendars/"+url.PathEscape(id)+"/delete", "", nil)
		}
	})
}

func consentURL(t *testing.T, a *account) string {
	t.Helper()
	res := request(t, "POST", "/calendar/connect", a.tokens.access, nil)
	var body struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil || res.status != 200 {
		t.Fatalf("connect: %d %s", res.status, res.body)
	}
	return body.URL
}

func runWorker(t *testing.T, a *account) {
	t.Helper()
	if res := request(t, "POST", "/calendar/refresh", a.tokens.access, nil); res.status != 204 {
		t.Fatalf("refresh: %d %s", res.status, res.body)
	}
}

func tick(t *testing.T) string {
	t.Helper()
	res := request(t, "POST", "/_local/calendar/tick", "", nil)
	var body struct {
		Ran string `json:"ran"`
	}
	if err := json.Unmarshal(res.body, &body); err != nil || res.status != 200 {
		t.Fatalf("tick: %d %s", res.status, res.body)
	}
	return body.Ran
}

// calendarFields is the calendar record's values, as a device receives them.
func calendarFields(t *testing.T, a *account) map[string]any {
	t.Helper()
	got, ok := a.get("calendar", "calendar")
	if !ok {
		t.Fatal("no calendar record")
	}
	values := map[string]any{}
	for name, f := range got.Fields {
		values[name] = f.V
	}
	return values
}

func calendarID(a *account) (string, bool) {
	a.reSignIn()
	got, ok := a.get("calendar", "calendar")
	if !ok {
		return "", false
	}
	id, ok := got.Fields["calendar_id"].V.(string)
	return id, ok
}

func timeBlocks(t *testing.T, a *account) googleCalendar {
	t.Helper()
	id, _ := calendarFields(t, a)["calendar_id"].(string)
	for _, c := range googleCalendars(t) {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no calendar %q in Google", id)
	return googleCalendar{}
}

func (a *account) pushBlock(id, title string, start, end time.Time, extra ...any) {
	a.t.Helper()
	task := "task-" + id
	pairs := append([]any{"task_id", task, "start", instantOf(start), "end", instantOf(end), "tz", "UTC"}, extra...)
	a.sync(a.startCursor(), a.record("task", task, "title", title), a.record("time_block", id, pairs...))
}

func (a *account) setBlock(id string, pairs ...any) {
	a.t.Helper()
	a.sync(a.startCursor(), a.record("time_block", id, pairs...))
}

func connectedUser(t *testing.T) *account {
	t.Helper()
	a := signIn(t)
	connectCalendar(t, a)
	return a
}

func oneEvent(t *testing.T, a *account) (googleCalendar, googleEvent) {
	t.Helper()
	c := timeBlocks(t, a)
	if len(c.Events) != 1 {
		t.Fatalf("want one event, have %+v", c.Events)
	}
	return c, c.Events[0]
}

func sameInstant(t *testing.T, got googleTime, want time.Time) bool {
	t.Helper()
	at, err := time.Parse(time.RFC3339, got.DateTime)
	return err == nil && at.Equal(want)
}

func TestSmokeCalendarWorkerRunsForTheTestUser(t *testing.T) {
	needs(t, testCalendar)
	a := signIn(t)
	if target.has(fakeGoogle) {
		connectCalendar(t, a)
	}
	waitForRun := func(since string) {
		t.Helper()
		for deadline := time.Now().Add(90 * time.Second); ; time.Sleep(3 * time.Second) {
			values := calendarFields(t, a)
			synced, _ := values["synced_at"].(string)
			if synced >= since && values["last_error"] == nil && values["connected"] == true {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("no good run since %s: synced_at %v, last_error %v", since, synced, values["last_error"])
			}
		}
	}
	start := time.Now().Add(time.Hour).Truncate(time.Minute)
	block := fresh("smoke-block")
	since := instantOf(time.Now())
	a.pushBlock(block, "Write the report", start, start.Add(30*time.Minute))
	runWorker(t, a)
	waitForRun(since)
	if target.has(fakeGoogle) {
		if _, event := oneEvent(t, a); event.Summary != "Write the report" {
			t.Fatalf("%+v", event)
		}
	}

	// Takes the event back off the test calendar. The block's own clean-up is only a device's delete.
	since = instantOf(time.Now())
	a.setBlock(block, "deleted_at", since)
	runWorker(t, a)
	waitForRun(since)
	if target.has(fakeGoogle) && len(timeBlocks(t, a).Events) != 0 {
		t.Fatalf("%+v", timeBlocks(t, a).Events)
	}
}

func TestConsentMakesTimeBlocksAndConnects(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	values := calendarFields(t, a)
	if values["connected"] != true || values["last_error"] != nil {
		t.Fatalf("%+v", values)
	}
	c := timeBlocks(t, a)
	if c.Summary != "Time blocks" || !c.AppCreated || len(c.Events) != 0 {
		t.Fatalf("%+v", c)
	}
}

func TestBlockBecomesAnEvent(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(45*time.Minute))
	runWorker(t, a)
	_, event := oneEvent(t, a)
	if event.Summary != "Write the report" || event.Description != "Edit in app" {
		t.Fatalf("%+v", event)
	}
	if !sameInstant(t, event.Start, start) || !sameInstant(t, event.End, start.Add(45*time.Minute)) {
		t.Fatalf("%+v", event)
	}
	if event.Reminders == nil || event.Reminders.UseDefault {
		t.Fatalf("reminders should be off: %+v", event.Reminders)
	}
	values := calendarFields(t, a)
	if values["synced_at"] == nil || values["last_error"] != nil {
		t.Fatalf("%+v", values)
	}
	// Running again finds nothing to do.
	runWorker(t, a)
	_, again := oneEvent(t, a)
	if again.ID != event.ID {
		t.Fatalf("%s then %s", event.ID, again.ID)
	}
}

func TestMovedBlockMovesItsEvent(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	block := fresh("b")
	a.pushBlock(block, "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	_, before := oneEvent(t, a)

	moved := start.Add(24 * time.Hour)
	a.setBlock(block, "start", instantOf(moved), "end", instantOf(moved.Add(time.Hour)))
	runWorker(t, a)
	_, after := oneEvent(t, a)
	if after.ID != before.ID || !sameInstant(t, after.Start, moved) || !sameInstant(t, after.End, moved.Add(time.Hour)) {
		t.Fatalf("%+v then %+v", before, after)
	}
}

func TestDeletedAndCancelledBlocksLoseTheirEvents(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	for name, remove := range map[string][]any{
		"deleted":   {"deleted_at", instantOf(time.Now())},
		"cancelled": {"cancelled", true},
	} {
		block := fresh(name)
		a.pushBlock(block, "Write the report", start, start.Add(time.Hour))
		runWorker(t, a)
		oneEvent(t, a)
		a.setBlock(block, remove...)
		runWorker(t, a)
		if events := timeBlocks(t, a).Events; len(events) != 0 {
			t.Fatalf("%s: %+v", name, events)
		}
		// Undoing it brings the event back, even though Google keeps a deleted id for good.
		a.setBlock(block, remove[0], nil)
		runWorker(t, a)
		oneEvent(t, a)
		a.setBlock(block, remove...)
		runWorker(t, a)
	}
}

func TestEditsInGoogleAreOverwritten(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	c, event := oneEvent(t, a)
	path := "calendars/" + url.PathEscape(c.ID) + "/events/"

	other := instantOf(start.Add(3 * time.Hour))
	for name, edit := range map[string]string{
		"title":     `{"summary":"Renamed in Google"}`,
		"text":      `{"description":"Notes"}`,
		"start":     fmt.Sprintf(`{"start":{"dateTime":%q}}`, other),
		"end":       fmt.Sprintf(`{"end":{"dateTime":%q}}`, other),
		"reminders": `{"reminders":{"useDefault":true}}`,
	} {
		t.Run(name, func(t *testing.T) {
			res := request(t, "POST", "/google/_test/"+path+event.ID+"/edit", "", []byte(edit))
			if res.status != 204 {
				t.Fatalf("%d", res.status)
			}
			runWorker(t, a)
			_, fixed := oneEvent(t, a)
			if fixed.Summary != "Write the report" || fixed.Description != "Edit in app" || !sameInstant(t, fixed.Start, start) ||
				!sameInstant(t, fixed.End, start.Add(time.Hour)) || fixed.Reminders == nil || fixed.Reminders.UseDefault {
				t.Fatalf("%+v", fixed)
			}
		})
	}
	t.Run("deleted", func(t *testing.T) {
		googleControl(t, path+event.ID+"/delete", nil)
		if len(timeBlocks(t, a).Events) != 0 {
			t.Fatal("control didn't delete")
		}
		runWorker(t, a)
		oneEvent(t, a)
	})
	t.Run("added by hand", func(t *testing.T) {
		googleControl(t, "calendars/"+url.PathEscape(c.ID)+"/events", googleEvent{
			Summary: "Added by hand", Start: googleTime{DateTime: other}, End: googleTime{DateTime: instantOf(start.Add(4 * time.Hour))},
		})
		if len(timeBlocks(t, a).Events) != 2 {
			t.Fatal("control didn't add")
		}
		runWorker(t, a)
		oneEvent(t, a)
	})
}

func TestEventTitlesComeFromTheTaskOrPractice(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	block := fresh("b")
	a.pushBlock(block, "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)

	a.sync(a.startCursor(), a.record("task", "task-"+block, "title", "Write the longer report"))
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != "Write the longer report" {
		t.Fatalf("%+v", event)
	}

	practice := fresh("practice")
	a.sync(a.startCursor(), a.record("practice", practice, "title", "Learn to bake bread"))
	a.setBlock(block, "task_id", nil, "practice_id", practice)
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != "Learn to bake bread" {
		t.Fatalf("%+v", event)
	}

	a.setBlock(block, "practice_id", "gone")
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != "Time block" {
		t.Fatalf("%+v", event)
	}

	long := strings.Repeat("é", 2000)
	a.sync(a.startCursor(), a.record("task", "task-"+block, "title", long))
	a.setBlock(block, "task_id", "task-"+block)
	runWorker(t, a)
	if _, event := oneEvent(t, a); len([]rune(event.Summary)) != 1000 {
		t.Fatalf("%d runes", len([]rune(event.Summary)))
	}
}

func TestOnlyTheWindowIsMirrored(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	near := time.Now().Add(7 * 7 * 24 * time.Hour).Truncate(time.Minute)
	far := time.Now().Add(9 * 7 * 24 * time.Hour).Truncate(time.Minute)
	inside, outside := fresh("inside"), fresh("outside")
	a.pushBlock(inside, "Write the report", near, near.Add(time.Hour))
	a.pushBlock(outside, "Paint the fence", far, far.Add(time.Hour))
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != "Write the report" {
		t.Fatalf("%+v", event)
	}
	// Moving out of the window removes the event, since the plan no longer wants it there.
	a.setBlock(inside, "start", instantOf(far), "end", instantOf(far.Add(time.Hour)))
	runWorker(t, a)
	if events := timeBlocks(t, a).Events; len(events) != 0 {
		t.Fatalf("%+v", events)
	}
}

func TestPastEventsAreLeftAlone(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(time.Hour)
	block := fresh("b")
	a.pushBlock(block, "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	_, before := oneEvent(t, a)

	clock.advance(3 * time.Hour)
	a.reSignIn()
	// History stays as it happened: renames and deletes of something over don't reach it.
	a.sync(a.startCursor(), a.record("task", "task-"+block, "title", "Renamed later"))
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != before.Summary {
		t.Fatalf("%+v", event)
	}
	a.setBlock(block, "deleted_at", instantOf(clock.now))
	runWorker(t, a)
	oneEvent(t, a)

	// A block that's already over when it arrives isn't added.
	late := clock.now.Add(-2 * time.Hour)
	a.pushBlock(fresh("late"), "Paint the fence", late, late.Add(time.Hour))
	runWorker(t, a)
	oneEvent(t, a)
}

func TestEndingABlockEarlyShortensItsEvent(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(-10 * time.Minute)
	block := fresh("b")
	a.pushBlock(block, "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	if _, event := oneEvent(t, a); !sameInstant(t, event.End, start.Add(time.Hour)) {
		t.Fatalf("%+v", event)
	}
	a.setBlock(block, "ended_at", instantOf(clock.now))
	runWorker(t, a)
	if _, event := oneEvent(t, a); !sameInstant(t, event.End, clock.now) {
		t.Fatalf("%+v", event)
	}
}

func TestBlocksThatMakeNoEventDontStopTheRest(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	a.setBlock(fresh("no-times"), "tz", "UTC")
	a.setBlock(fresh("bad-times"), "start", "tomorrow", "end", 5)
	a.setBlock(fresh("backwards"), "start", instantOf(start.Add(time.Hour)), "end", instantOf(start))
	a.pushBlock(fresh("good"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	if _, event := oneEvent(t, a); event.Summary != "Write the report" {
		t.Fatalf("%+v", event)
	}
	if got := calendarFields(t, a)["last_error"]; got != nil {
		t.Fatalf("%v", got)
	}
}

func TestAFailedRunIsRecordedAndTheNextOneFixesIt(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(2 * time.Hour)
	googleControl(t, "rate_limit", map[string]int{"calls": 1})
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	if got := calendarFields(t, a)["last_error"]; got != "calendar_rate_limited" {
		t.Fatalf("%v", got)
	}
	if events := timeBlocks(t, a).Events; len(events) != 0 {
		t.Fatalf("%+v", events)
	}
	runWorker(t, a)
	if got := calendarFields(t, a)["last_error"]; got != nil {
		t.Fatalf("%v", got)
	}
	oneEvent(t, a)
}

func TestRevokedTokenIsReportedAndReconnectingKeepsTheCalendar(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(2 * time.Hour)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	before, _ := oneEvent(t, a)

	googleControl(t, "revoke", nil)
	runWorker(t, a)
	values := calendarFields(t, a)
	if values["last_error"] != "calendar_revoked" || values["connected"] != false {
		t.Fatalf("%+v", values)
	}

	connectCalendar(t, a)
	values = calendarFields(t, a)
	if values["last_error"] != nil || values["connected"] != true || values["calendar_id"] != before.ID {
		t.Fatalf("%+v", values)
	}
	after, _ := oneEvent(t, a)
	if after.ID != before.ID {
		t.Fatalf("%s then %s", before.ID, after.ID)
	}
}

func TestDisconnectRemovesTimeBlocksAndReconnectingStartsAfresh(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	before := timeBlocks(t, a)
	if res := request(t, "POST", "/calendar/disconnect", a.tokens.access, nil); res.status != 204 {
		t.Fatalf("disconnect: %d %s", res.status, res.body)
	}
	if values := calendarFields(t, a); values["connected"] != false || values["calendar_id"] != nil {
		t.Fatalf("%+v", values)
	}
	for _, c := range googleCalendars(t) {
		if c.ID == before.ID {
			t.Fatal("Time blocks is still in Google")
		}
	}
	// Nothing is connected, so the worker has nothing to do.
	runWorker(t, a)
	connectCalendar(t, a)
	if values := calendarFields(t, a); values["connected"] != true || timeBlocks(t, a).ID == before.ID {
		t.Fatalf("%+v", values)
	}
}

func TestDeletedTimeBlocksCalendarIsMadeAgain(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	start := time.Now().Add(2 * time.Hour).Truncate(time.Minute)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	before, _ := oneEvent(t, a)
	googleControl(t, "calendars/"+url.PathEscape(before.ID)+"/delete", nil)
	runWorker(t, a)
	after, event := oneEvent(t, a)
	if after.ID == before.ID || event.Summary != "Write the report" {
		t.Fatalf("%+v", after)
	}
}

func addGoogleCalendar(t *testing.T, name string) string {
	t.Helper()
	id := fresh(strings.ToLower(name)) + "@example.test"
	googleControl(t, "calendars", map[string]string{"id": id, "summary": name})
	t.Cleanup(func() { request(t, "POST", "/google/_test/calendars/"+url.PathEscape(id)+"/delete", "", nil) })
	return id
}

func addGoogleEvent(t *testing.T, calendar, title string, start, end time.Time) {
	t.Helper()
	googleControl(t, "calendars/"+url.PathEscape(calendar)+"/events", googleEvent{
		Summary: title, Start: googleTime{DateTime: start.Format(time.RFC3339)}, End: googleTime{DateTime: end.Format(time.RFC3339)},
	})
}

func sourceOf(t *testing.T, a *account, googleID string) record {
	t.Helper()
	all, _ := a.pullAll(a.base)
	for _, r := range all {
		if r.Type == "calendar_source" && r.Fields["google_id"].V == googleID {
			return r
		}
	}
	t.Fatalf("no calendar_source for %s", googleID)
	return record{}
}

func mirrored(t *testing.T, a *account, googleID string) []map[string]any {
	t.Helper()
	var events []map[string]any
	list, _ := calendarFields(t, a)["events"].([]any)
	for _, item := range list {
		if event := item.(map[string]any); event["calendar"] == googleID {
			events = append(events, event)
		}
	}
	return events
}

func TestModesDecideWhatIsMirrored(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	home := addGoogleCalendar(t, "Home")
	start := time.Now().Add(3 * time.Hour).Truncate(time.Minute)
	addGoogleEvent(t, home, "Team lunch", start, start.Add(time.Hour))
	setMode := func(mode string) {
		t.Helper()
		source := sourceOf(t, a, home)
		a.sync(a.startCursor(), a.record("calendar_source", source.ID, "mode", mode))
		runWorker(t, a)
	}

	// A calendar not seen before starts as block.
	runWorker(t, a)
	source := sourceOf(t, a, home)
	if source.Fields["name"].V != "Home" || source.Fields["mode"].V != "block" {
		t.Fatalf("%+v", source)
	}
	events := mirrored(t, a, home)
	if len(events) != 1 || events[0]["title"] != "Team lunch" || events[0]["start"] != instantOf(start) || events[0]["end"] != instantOf(start.Add(time.Hour)) {
		t.Fatalf("%+v", events)
	}

	setMode("info")
	if got := mirrored(t, a, home); len(got) != 1 {
		t.Fatalf("info keeps events, since the device filters: %+v", got)
	}
	setMode("ignore")
	if got := mirrored(t, a, home); len(got) != 0 {
		t.Fatalf("ignore isn't read: %+v", got)
	}
	// The worker owns the name and the device the mode, so a rename keeps the choice.
	googleControl(t, "calendars", map[string]string{"id": home, "summary": "Family"})
	addGoogleEvent(t, home, "Team lunch", start, start.Add(time.Hour))
	runWorker(t, a)
	source = sourceOf(t, a, home)
	if source.Fields["name"].V != "Family" || source.Fields["mode"].V != "ignore" {
		t.Fatalf("%+v", source)
	}
	setMode("block")
	if got := mirrored(t, a, home); len(got) != 1 {
		t.Fatalf("%+v", got)
	}

	// Its own calendar is never a source.
	own := timeBlocks(t, a).ID
	all, _ := a.pullAll(a.base)
	for _, r := range all {
		if r.Type == "calendar_source" && r.Fields["google_id"].V == own {
			t.Fatalf("Time blocks became a source: %+v", r)
		}
	}

	// A calendar gone from Google is marked so, and comes back if it returns.
	googleControl(t, "calendars/"+url.PathEscape(home)+"/delete", nil)
	runWorker(t, a)
	if source := sourceOf(t, a, home); source.Fields["deleted_at"].V == nil {
		t.Fatalf("%+v", source)
	}
	if got := mirrored(t, a, home); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
	googleControl(t, "calendars", map[string]string{"id": home, "summary": "Family"})
	runWorker(t, a)
	if source := sourceOf(t, a, home); source.Fields["deleted_at"].V != nil {
		t.Fatalf("%+v", source)
	}
}

func TestAllDayEventsAreMirrored(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	home := addGoogleCalendar(t, "Home")
	day := time.Now().UTC().Add(48 * time.Hour)
	next := day.Add(24 * time.Hour)
	googleControl(t, "calendars/"+url.PathEscape(home)+"/events", googleEvent{
		Summary: "Day off", Start: googleTime{Date: day.Format(time.DateOnly)}, End: googleTime{Date: next.Format(time.DateOnly)},
	})
	runWorker(t, a)
	events := mirrored(t, a, home)
	if len(events) != 1 || events[0]["all_day"] != true || events[0]["start"] != day.Format(time.DateOnly)+"T00:00:00Z" {
		t.Fatalf("%+v", events)
	}
}

func TestTooManyEventsKeepsTheSoonestAndSaysSo(t *testing.T) {
	needs(t, fakeGoogle)
	a := connectedUser(t)
	busy := addGoogleCalendar(t, "Busy")
	start := time.Now().Add(time.Hour).Truncate(time.Minute)
	const total = 1200
	for i := total; i > 0; i-- {
		at := start.Add(time.Duration(i) * time.Minute)
		addGoogleEvent(t, busy, "Standing meeting", at, at.Add(time.Minute))
	}
	block := start.Add(24 * time.Hour)
	a.pushBlock(fresh("b"), "Write the report", block, block.Add(time.Hour))
	runWorker(t, a)
	values := calendarFields(t, a)
	if values["last_error"] != "too_many_events" || values["connected"] != true {
		t.Fatalf("%v %v", values["last_error"], values["connected"])
	}
	events := mirrored(t, a, busy)
	if len(events) == 0 || len(events) >= total {
		t.Fatalf("%d events", len(events))
	}
	starts := make([]string, len(events))
	for i, event := range events {
		starts[i] = event["start"].(string)
	}
	if !slices.IsSorted(starts) || starts[0] != instantOf(start.Add(time.Minute)) {
		t.Fatalf("not the soonest: %v...", starts[:3])
	}
	// The record being full doesn't hold up the plan.
	if _, event := oneEvent(t, a); event.Summary != "Write the report" {
		t.Fatalf("%+v", event)
	}
}

func TestWorkerWakesOnBlocksAfterItsWindowAndOnSchedule(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	syncedAt := func() any { return calendarFields(t, a)["synced_at"] }
	move := func(by time.Duration) {
		t.Helper()
		clock.advance(by)
		a.reSignIn()
	}
	start := clock.now.Add(2 * time.Hour)
	block := fresh("b")

	// Inside the batch window nothing runs, however often it's checked.
	a.pushBlock(block, "Write the report", start, start.Add(time.Hour))
	if ran := tick(t); ran != "" {
		t.Fatalf("ran %q inside the window", ran)
	}
	move(59 * time.Second)
	if ran := tick(t); ran != "" {
		t.Fatalf("ran %q inside the window", ran)
	}
	if len(timeBlocks(t, a).Events) != 0 {
		t.Fatal("ran inside the window")
	}
	// The background tick may get there first, so what counts is that the run happened.
	move(2 * time.Second)
	if ran := tick(t); ran != "" && ran != "stream" {
		t.Fatalf("ran %q", ran)
	}
	oneEvent(t, a)
	if got := syncedAt(); got != instantOf(clock.now) {
		t.Fatalf("%v", got)
	}

	// Its own write to the calendar record doesn't wake it, or it would run for ever.
	before := syncedAt()
	move(61 * time.Second)
	if ran := tick(t); ran != "" {
		t.Fatalf("woke on its own write: %q", ran)
	}
	if got := syncedAt(); got != before {
		t.Fatalf("%v then %v", before, got)
	}

	// Renaming the block's task wakes it, since the event takes its title from the task.
	a.sync(a.startCursor(), a.record("task", "task-"+block, "title", "Paint the fence"))
	if ran := tick(t); ran != "" {
		t.Fatalf("ran %q inside the window", ran)
	}
	move(61 * time.Second)
	if ran := tick(t); ran != "" && ran != "stream" {
		t.Fatalf("ran %q", ran)
	}
	if _, event := oneEvent(t, a); event.Summary != "Paint the fence" || syncedAt() != instantOf(clock.now) {
		t.Fatalf("a rename didn't wake it: %+v, synced_at %v", event, syncedAt())
	}

	// The schedule picks up what wakes nothing, such as an event added in Google.
	home := addGoogleCalendar(t, "Home")
	addGoogleEvent(t, home, "Team lunch", start, start.Add(time.Hour))
	move(30 * time.Minute)
	if ran := tick(t); ran != "" && ran != "schedule" {
		t.Fatalf("ran %q", ran)
	}
	if len(mirrored(t, a, home)) != 1 || syncedAt() != instantOf(clock.now) {
		t.Fatalf("the schedule didn't run: synced_at %v, want %s", syncedAt(), instantOf(clock.now))
	}

	// A device changing a calendar's mode also wakes it. By then the device has seen the worker's clock, which the held
	// clock puts ahead of this test's own, so its write is newer than the worker's.
	source := sourceOf(t, a, home)
	a.sync(a.startCursor(), record{"calendar_source", source.ID, map[string]field{"mode": {"ignore", clockAt(clock.now, 1, a.device)}}})
	tick(t)
	move(61 * time.Second)
	if ran := tick(t); ran != "" && ran != "stream" {
		t.Fatalf("ran %q", ran)
	}
	if len(mirrored(t, a, home)) != 0 || syncedAt() != instantOf(clock.now) {
		t.Fatalf("a mode change didn't wake it: synced_at %v", syncedAt())
	}
}

func callbackOf(t *testing.T, consent, code string) response {
	t.Helper()
	parsed, err := url.Parse(consent)
	if err != nil {
		t.Fatal(err)
	}
	return request(t, "GET", "/calendar/callback?"+url.Values{"state": {parsed.Query().Get("state")}, "code": {code}}.Encode(), "", nil)
}

func TestConsentStateIsSingleUseAndExpires(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := signIn(t)

	t.Run("a bad code uses it up", func(t *testing.T) {
		consent := consentURL(t, a)
		if res := callbackOf(t, consent, "not-a-code"); res.status != 502 {
			t.Fatalf("%d %s", res.status, res.body)
		}
		if res := callbackOf(t, consent, "not-a-code"); res.status != 400 {
			t.Fatalf("%d %s", res.status, res.body)
		}
	})
	t.Run("a newer consent replaces it", func(t *testing.T) {
		older := consentURL(t, a)
		newer := consentURL(t, a)
		if res := callbackOf(t, older, "any"); res.status != 400 {
			t.Fatalf("%d %s", res.status, res.body)
		}
		// Refusing the old one must not have cancelled the new one.
		if res, err := http.Get(newer); err != nil || res.StatusCode != 200 {
			t.Fatalf("%v %v", res, err)
		} else {
			res.Body.Close()
		}
	})
	t.Run("a used one can't be replayed", func(t *testing.T) {
		consent := consentURL(t, a)
		res, err := http.Get(consent)
		if err != nil || res.StatusCode != 200 {
			t.Fatalf("%v %v", res, err)
		}
		res.Body.Close()
		if res := callbackOf(t, consent, "any"); res.status != 400 {
			t.Fatalf("%d %s", res.status, res.body)
		}
	})
	t.Run("an old one expires", func(t *testing.T) {
		consent := consentURL(t, a)
		clock.advance(10*time.Minute + 2*time.Second)
		a.reSignIn()
		if res := callbackOf(t, consent, "any"); res.status != 400 {
			t.Fatalf("%d %s", res.status, res.body)
		}
	})
}

func TestOnlyTheConnectedUsersRefreshRunsTheWorker(t *testing.T) {
	needs(t, fakeGoogle, fakeClock, secondUser)
	clock := holdClock(t)
	a := connectedUser(t)
	other := signInOther(t)

	clock.advance(time.Minute)
	a.reSignIn()
	other.reSignIn()
	// A block waiting for the worker, so that a run shows.
	start := clock.now.Add(time.Hour)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, other)
	if events := timeBlocks(t, a).Events; len(events) != 0 {
		t.Fatalf("another user's refresh ran the worker: %+v", events)
	}
	if _, ok := other.get("calendar", "calendar"); ok {
		t.Fatal("another user's refresh wrote a calendar record for them")
	}
	// Starting a consent, without finishing it, changes nothing for the connected user.
	consentURL(t, other)
	runWorker(t, a)
	oneEvent(t, a)
	if got := calendarFields(t, a)["synced_at"]; got != instantOf(clock.now) {
		t.Fatalf("%v", got)
	}

	// Finishing it hands the one connection over. The first user's app shows it unconnected, keeping the id of their
	// Time blocks for a later consent of theirs, and from then on only the new user's refresh runs the worker.
	theirs, _ := calendarID(a)
	connectCalendar(t, other)
	values := calendarFields(t, a)
	if events, _ := values["events"].([]any); values["connected"] != false || values["calendar_id"] != theirs || len(events) != 0 || values["last_error"] != nil {
		t.Fatalf("the first user's app still shows a connection: %+v", values)
	}
	other.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	if events := timeBlocks(t, other).Events; len(events) != 0 {
		t.Fatalf("the first user's refresh still ran the worker: %+v", events)
	}
	runWorker(t, other)
	oneEvent(t, other)
}
