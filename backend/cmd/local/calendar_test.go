package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// calendarStack is the running local stack with one user signed in and the clock fixed, driven only over HTTP.
type calendarStack struct {
	stack
	t     *testing.T
	token string
	now   time.Time
	seq   int64
}

func startCalendarStack(t *testing.T) *calendarStack {
	t.Helper()
	if os.Getenv("SSM_ENDPOINT") == "" {
		t.Skip("SSM_ENDPOINT not set: start Moto to run this test")
	}
	s := startStack(t)
	c := &calendarStack{stack: s, t: t, now: time.Now().UTC().Truncate(time.Second)}
	c.setClock(c.now)
	c.token = s.signIn(t, "one")["access_token"].(string)
	return c
}

func (c *calendarStack) setClock(at time.Time) {
	c.t.Helper()
	c.now = at
	if status, _ := c.post(c.t, "/_local/clock", "", fmt.Sprintf(`{"now":%q}`, at.Format(time.RFC3339))); status != 204 {
		c.t.Fatalf("set clock: %d", status)
	}
}

func (c *calendarStack) advance(by time.Duration) {
	c.t.Helper()
	c.setClock(c.now.Add(by))
	// The access token would expire across a long jump, and a real device would have refreshed by then.
	c.token = c.signIn(c.t, "one")["access_token"].(string)
}

func (c *calendarStack) connect() {
	c.t.Helper()
	status, res := c.post(c.t, "/calendar/connect", c.token, ``)
	if status != 200 {
		c.t.Fatalf("connect: %d %v", status, res)
	}
	page, err := http.Get(res["url"].(string))
	if err != nil {
		c.t.Fatal(err)
	}
	defer page.Body.Close()
	body, _ := io.ReadAll(page.Body)
	if page.StatusCode != 200 || !strings.Contains(string(body), "Calendar connected") {
		c.t.Fatalf("callback: %d %s", page.StatusCode, body)
	}
}

func instantOf(at time.Time) string { return at.UTC().Format("2006-01-02T15:04:05Z") }

// pushBlock syncs a task and a block for it, as a device does.
func (c *calendarStack) pushBlock(id, title string, start, end time.Time) {
	c.t.Helper()
	c.seq++
	clock := fmt.Sprintf(`"c":"%013d-%06d-dev"`, c.now.UnixMilli(), c.seq)
	body := fmt.Sprintf(`{"cursor":0,"changes":[
		{"type":"task","id":"task-%[1]s","fields":{"title":{"v":%[2]q,%[3]s}}},
		{"type":"time_block","id":%[1]q,"fields":{"task_id":{"v":"task-%[1]s",%[3]s},"start":{"v":%[4]q,%[3]s},"end":{"v":%[5]q,%[3]s},"tz":{"v":"UTC",%[3]s}}}
	]}`, id, title, clock, instantOf(start), instantOf(end))
	if status, res := c.post(c.t, "/sync", c.token, body); status != 200 {
		c.t.Fatalf("sync: %d %v", status, res)
	}
}

func (c *calendarStack) tick() string {
	c.t.Helper()
	status, res := c.post(c.t, "/_local/calendar/tick", "", ``)
	if status != 200 {
		c.t.Fatalf("tick: %d %v", status, res)
	}
	return res["ran"].(string)
}

// googleEvents returns the titles on a calendar, by the fake's own view of it.
func (c *calendarStack) googleEvents(name string) []string {
	c.t.Helper()
	res, err := http.Get(c.srv.URL + "/google/_test/calendars")
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	var state struct {
		Calendars []struct {
			Summary string
			Events  []struct{ Summary string }
		}
	}
	decodeJSON(c.t, res.Body, &state)
	titles := []string{}
	for _, cal := range state.Calendars {
		if cal.Summary == name {
			for _, e := range cal.Events {
				titles = append(titles, e.Summary)
			}
		}
	}
	return titles
}

// calendarFields pulls everything and returns the fields of the calendar record.
func (c *calendarStack) calendarFields() map[string]any {
	c.t.Helper()
	status, res := c.post(c.t, "/sync", c.token, `{"cursor":0}`)
	if status != 200 {
		c.t.Fatalf("pull: %d", status)
	}
	for _, change := range res["changes"].([]any) {
		record := change.(map[string]any)
		if record["type"] == "calendar" {
			return record["fields"].(map[string]any)
		}
	}
	return nil
}

func fieldValue(fields map[string]any, name string) any {
	field, _ := fields[name].(map[string]any)
	return field["v"]
}

func TestCalendarThroughTheLocalStack(t *testing.T) {
	c := startCalendarStack(t)
	const marker = "MARKER-do-not-log"
	c.connect()
	if got := c.googleEvents("Time blocks"); len(got) != 0 {
		t.Fatalf("%v", got)
	}

	// The stream trigger waits out its batch window on the test's clock.
	start := c.now.Add(time.Hour)
	c.pushBlock("b1", marker, start, start.Add(time.Hour))
	if ran := c.tick(); ran != "" {
		t.Fatalf("ran %q inside the batch window", ran)
	}
	c.advance(61 * time.Second)
	if ran := c.tick(); ran != "stream" {
		t.Fatalf("ran %q", ran)
	}
	if got := c.googleEvents("Time blocks"); len(got) != 1 || got[0] != marker {
		t.Fatalf("%v", got)
	}
	// The worker's own write to the calendar record doesn't wake it.
	c.advance(61 * time.Second)
	if ran := c.tick(); ran != "" {
		t.Fatalf("woke on its own write: %q", ran)
	}

	// A calendar in Google reaches devices through sync, surviving a round trip through DynamoDB unchanged.
	if status, _ := c.post(t, "/google/_test/calendars", "", `{"id":"home@example.test","summary":"Home"}`); status != 204 {
		t.Fatalf("add calendar: %d", status)
	}
	event := fmt.Sprintf(`{"summary":"Team lunch","start":{"dateTime":%q},"end":{"dateTime":%q}}`, start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339))
	if status, _ := c.post(t, "/google/_test/calendars/home@example.test/events", "", event); status != 204 {
		t.Fatalf("add event: %d", status)
	}
	if status, _ := c.post(t, "/calendar/refresh", c.token, ``); status != 204 {
		t.Fatalf("refresh: %d", status)
	}
	fields := c.calendarFields()
	events := fieldValue(fields, "events").([]any)
	if len(events) != 1 || events[0].(map[string]any)["title"] != "Team lunch" || fieldValue(fields, "connected") != true {
		t.Fatalf("%+v", fields)
	}
	eventsClock := fields["events"].(map[string]any)["c"]
	if fieldValue(fields, "synced_at") != instantOf(c.now) {
		t.Fatalf("synced_at %v", fieldValue(fields, "synced_at"))
	}
	syncedAt := fieldValue(fields, "synced_at")

	// The schedule runs on the same clock, and a run with no differences leaves the record alone.
	c.advance(31 * time.Minute)
	if ran := c.tick(); ran == "" {
		t.Fatal("nothing ran after 30 minutes")
	}
	fields = c.calendarFields()
	if fields["events"].(map[string]any)["c"] != eventsClock || fieldValue(fields, "synced_at") != syncedAt {
		t.Fatalf("unchanged record rewritten: %+v", fields)
	}

	// Failure modes reach the app through the record.
	if status, _ := c.post(t, "/google/_test/rate_limit", "", `{"calls":1}`); status != 204 {
		t.Fatalf("rate limit: %d", status)
	}
	if status, _ := c.post(t, "/calendar/refresh", c.token, ``); status != 204 {
		t.Fatalf("refresh: %d", status)
	}
	if got := fieldValue(c.calendarFields(), "last_error"); got != "calendar_rate_limited" {
		t.Fatalf("%v", got)
	}
	if status, _ := c.post(t, "/calendar/refresh", c.token, ``); status != 204 {
		t.Fatalf("refresh: %d", status)
	}
	if got := fieldValue(c.calendarFields(), "last_error"); got != nil {
		t.Fatalf("%v", got)
	}
	if status, _ := c.post(t, "/google/_test/revoke", "", ``); status != 204 {
		t.Fatalf("revoke: %d", status)
	}
	if status, _ := c.post(t, "/calendar/refresh", c.token, ``); status != 204 {
		t.Fatalf("refresh: %d", status)
	}
	fields = c.calendarFields()
	if fieldValue(fields, "last_error") != "calendar_revoked" || fieldValue(fields, "connected") != false {
		t.Fatalf("%+v", fields)
	}

	logged := c.logs.String()
	for _, want := range []string{`"msg":"calendar_run"`, `"trigger":"stream"`, `"trigger":"schedule"`, `"trigger":"refresh"`, `"CalendarEventsChanged":1`, `"CalendarRunFailures":1`} {
		if !strings.Contains(logged, want) {
			t.Errorf("no %s in logs", want)
		}
	}
	for _, leak := range []string{marker, "Team lunch", "home@example.test", c.token} {
		if strings.Contains(logged, leak) {
			t.Errorf("%q in logs", leak)
		}
	}
}

func TestCallbackThroughTheLocalStackRefusesReplayAndForgery(t *testing.T) {
	c := startCalendarStack(t)
	status, res := c.post(t, "/calendar/connect", c.token, ``)
	if status != 200 {
		t.Fatalf("%d %v", status, res)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	consent, err := client.Get(res["url"].(string))
	if err != nil {
		t.Fatal(err)
	}
	consent.Body.Close()
	back := consent.Header.Get("Location")
	get := func(target string) int {
		t.Helper()
		page, err := http.Get(target)
		if err != nil {
			t.Fatal(err)
		}
		page.Body.Close()
		return page.StatusCode
	}
	if got := get(c.srv.URL + "/calendar/callback?state=forged.sig&code=c"); got != 400 {
		t.Fatalf("forged: %d", got)
	}
	if got := get(back); got != 200 {
		t.Fatalf("first: %d", got)
	}
	if got := get(back); got != 400 {
		t.Fatalf("replay: %d", got)
	}
}

func TestRefreshByAnotherUserDoesNotRunTheWorker(t *testing.T) {
	c := startCalendarStack(t)
	c.connect()
	c.tick()
	other := c.signIn(t, "two")["access_token"].(string)
	runs := strings.Count(c.logs.String(), `"msg":"calendar_run"`)
	if status, _ := c.post(t, "/calendar/refresh", other, ``); status != 204 {
		t.Fatalf("%d", status)
	}
	if got := strings.Count(c.logs.String(), `"msg":"calendar_run"`); got != runs {
		t.Fatalf("%d more runs", got-runs)
	}
}
