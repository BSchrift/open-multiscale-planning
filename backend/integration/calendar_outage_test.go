package integration

import (
	"fmt"
	"net/url"
	"reflect"
	"testing"
	"time"
)

// outage is the fake Google's connection drop, as fakes.GoogleOutage describes it.
type outage struct {
	Token   bool `json:"token,omitempty"`
	After   int  `json:"after,omitempty"`
	Calls   int  `json:"calls"`
	Status  int  `json:"status,omitempty"`
	Applied bool `json:"applied,omitempty"`
}

// cutGoogle drops calls to Google as the outage says, until liftOutage or the end of the test.
func cutGoogle(t *testing.T, o outage) {
	t.Helper()
	t.Cleanup(func() { liftOutage(t) })
	googleControl(t, "outage", o)
}

func liftOutage(t *testing.T) {
	t.Helper()
	googleControl(t, "outage", outage{})
	googleControl(t, "outage", outage{Token: true})
}

// eventTimes is what Time blocks should hold, by title.
type eventTimes map[string][2]time.Time

// holdsExactly checks that Time blocks has one event for each title and nothing else.
func holdsExactly(t *testing.T, a *account, want eventTimes) {
	t.Helper()
	events := timeBlocks(t, a).Events
	seen := map[string]bool{}
	for _, e := range events {
		times, ok := want[e.Summary]
		if !ok || seen[e.Summary] || !sameInstant(t, e.Start, times[0]) || !sameInstant(t, e.End, times[1]) {
			t.Fatalf("Time blocks should hold %v, holds %+v", want, events)
		}
		seen[e.Summary] = true
	}
	if len(seen) != len(want) {
		t.Fatalf("Time blocks should hold %v, holds %+v", want, events)
	}
}

// settled checks that a run left nothing for a later one: another finds nothing to change, so synced_at stays put.
func settled(t *testing.T, a *account, clock *heldClock) {
	t.Helper()
	before := calendarFields(t, a)["synced_at"]
	clock.advance(time.Second)
	runWorker(t, a)
	if after := calendarFields(t, a); after["synced_at"] != before || after["last_error"] != nil {
		t.Fatalf("a later run still had work: synced_at %v then %v, last_error %v", before, after["synced_at"], after["last_error"])
	}
}

// failedRunChangesNothing has a run meet the outage, checks it's recorded with nothing else changed in the app or in
// Google, and then that the next run, with Google back, mirrors every block.
func failedRunChangesNothing(t *testing.T, cut outage) {
	t.Helper()
	clock := holdClock(t)
	a := connectedUser(t)
	home := addGoogleCalendar(t, "Home")
	start := clock.now.Add(2 * time.Hour)
	addGoogleEvent(t, home, "Team lunch", start, start.Add(time.Hour))
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	before := calendarFields(t, a)
	_, first := oneEvent(t, a)
	if len(mirrored(t, a, home)) != 1 {
		t.Fatalf("%+v", before["events"])
	}

	later := start.Add(2 * time.Hour)
	a.pushBlock(fresh("b"), "Paint the fence", later, later.Add(time.Hour))
	addGoogleEvent(t, home, "Dentist", later, later.Add(time.Hour))
	cutGoogle(t, cut)
	// A second on, so that a run that wrote anything would move synced_at.
	clock.advance(time.Second)
	runWorker(t, a)
	after := calendarFields(t, a)
	if after["last_error"] != "calendar_failed" || after["connected"] != true {
		t.Fatalf("last_error %v, connected %v", after["last_error"], after["connected"])
	}
	for _, name := range []string{"calendar_id", "events", "synced_at"} {
		if !reflect.DeepEqual(after[name], before[name]) {
			t.Fatalf("%s: %v then %v", name, before[name], after[name])
		}
	}
	if _, event := oneEvent(t, a); !reflect.DeepEqual(event, first) {
		t.Fatalf("Google changed: %+v then %+v", first, event)
	}

	liftOutage(t)
	clock.advance(time.Second)
	runWorker(t, a)
	if values := calendarFields(t, a); values["last_error"] != nil || values["connected"] != true || values["synced_at"] != instantOf(clock.now) {
		t.Fatalf("%+v", values)
	}
	holdsExactly(t, a, eventTimes{
		"Write the report": {start, start.Add(time.Hour)},
		"Paint the fence":  {later, later.Add(time.Hour)},
	})
	if events := mirrored(t, a, home); len(events) != 2 {
		t.Fatalf("%+v", events)
	}
	settled(t, a, clock)
}

func TestARunWhileGoogleIsUnreachableIsRecordedAndTheNextCatchesUp(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	for _, c := range []struct {
		name string
		cut  outage
	}{
		{"the connection drops", outage{Calls: -1}},
		{"a proxy answers 503", outage{Calls: -1, Status: 503}},
	} {
		t.Run(c.name, func(t *testing.T) { failedRunChangesNothing(t, c.cut) })
	}
}

// A refresh that can't reach Google is not Google refusing the token, so the app mustn't ask the person to connect again.
func TestATokenRefreshThatCannotReachGoogleLeavesTheCalendarConnected(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	for _, c := range []struct {
		name string
		cut  outage
	}{
		{"the connection drops", outage{Token: true, Calls: -1}},
		{"a proxy answers 502", outage{Token: true, Calls: -1, Status: 502}},
	} {
		t.Run(c.name, func(t *testing.T) { failedRunChangesNothing(t, c.cut) })
	}
}

// The drop lands on each of a run's calls to Google in turn, with the call lost on the way there or only its answer lost
// on the way back, until it lands after the run's last call.
func TestADropPartwayThroughARunLeavesEachBlockOneEvent(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	for after := 0; ; after++ {
		if after > 30 {
			t.Fatal("the drop never missed the run")
		}
		finished := false
		for _, applied := range []bool{false, true} {
			name := fmt.Sprintf("after %d calls, lost on the way there", after)
			if applied {
				name = fmt.Sprintf("after %d calls, answer lost", after)
			}
			if !t.Run(name, func(t *testing.T) { finished = dropAfter(t, after, applied) }) {
				return
			}
		}
		if finished {
			return
		}
	}
}

// dropAfter runs a run that inserts, updates and deletes events into a drop after some calls, and reports whether the
// run finished before it.
func dropAfter(t *testing.T, after int, applied bool) bool {
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(2 * time.Hour)
	hour := func(n int) time.Time { return start.Add(time.Duration(n) * time.Hour) }
	moved, removed := fresh("moved"), fresh("removed")
	a.pushBlock(moved, "Move me", hour(0), hour(1))
	a.pushBlock(removed, "Remove me", hour(1), hour(2))
	a.pushBlock(fresh("kept"), "Keep me", hour(2), hour(3))
	runWorker(t, a)

	a.pushBlock(fresh("added"), "Add me", hour(3), hour(4))
	a.pushBlock(fresh("added"), "Add me too", hour(4), hour(5))
	a.setBlock(moved, "start", instantOf(hour(5)), "end", instantOf(hour(6)))
	a.setBlock(removed, "deleted_at", instantOf(clock.now))
	want := eventTimes{
		"Keep me": {hour(2), hour(3)}, "Add me": {hour(3), hour(4)}, "Add me too": {hour(4), hour(5)}, "Move me": {hour(5), hour(6)},
	}

	cutGoogle(t, outage{After: after, Calls: -1, Applied: applied})
	runWorker(t, a)
	values := calendarFields(t, a)
	if values["last_error"] == nil {
		// The drop missed the run, which must then have done all its work.
		holdsExactly(t, a, want)
		return true
	}
	if values["last_error"] != "calendar_failed" || values["connected"] != true {
		t.Fatalf("last_error %v, connected %v", values["last_error"], values["connected"])
	}

	liftOutage(t)
	clock.advance(time.Second)
	runWorker(t, a)
	if values := calendarFields(t, a); values["last_error"] != nil || values["connected"] != true {
		t.Fatalf("last_error %v, connected %v", values["last_error"], values["connected"])
	}
	holdsExactly(t, a, want)
	settled(t, a, clock)
	return false
}

// Only a calendar Google says is gone is made again, so a look-up that fails can't leave the person with two.
func TestAFailedLookUpOfTimeBlocksMakesNoSecondCalendar(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(2 * time.Hour)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	before, _ := oneEvent(t, a)
	others := map[string]bool{}
	for _, c := range googleCalendars(t) {
		others[c.ID] = c.ID != before.ID
	}
	made := func() []string {
		var ids []string
		for _, c := range googleCalendars(t) {
			if c.Summary == "Time blocks" && !others[c.ID] {
				ids = append(ids, c.ID)
			}
		}
		return ids
	}
	t.Cleanup(func() {
		for _, id := range made() {
			request(t, "POST", "/google/_test/calendars/"+url.PathEscape(id)+"/delete", "", nil)
		}
	})

	// One call, the look-up, answered as unavailable: a dropped connection would be sent again by Go's transport.
	cutGoogle(t, outage{Calls: 1, Status: 503})
	runWorker(t, a)
	if got := calendarFields(t, a)["last_error"]; got != "calendar_failed" {
		t.Fatalf("%v", got)
	}
	runWorker(t, a)
	if after, _ := oneEvent(t, a); after.ID != before.ID || len(made()) != 1 {
		t.Fatalf("Time blocks was %s, is %s, and the test's are %v", before.ID, after.ID, made())
	}
}

// Google is best effort when disconnecting, so a disconnect still works with Google out of reach.
func TestDisconnectWhileGoogleIsUnreachableStillDisconnects(t *testing.T) {
	needs(t, fakeGoogle, fakeClock)
	clock := holdClock(t)
	a := connectedUser(t)
	start := clock.now.Add(2 * time.Hour)
	a.pushBlock(fresh("b"), "Write the report", start, start.Add(time.Hour))
	runWorker(t, a)
	c, _ := oneEvent(t, a)
	// Google never hears of the disconnect, which leaves Time blocks there. The record forgets its id, so it's removed here.
	t.Cleanup(func() { request(t, "POST", "/google/_test/calendars/"+url.PathEscape(c.ID)+"/delete", "", nil) })

	cutGoogle(t, outage{Calls: -1})
	cutGoogle(t, outage{Token: true, Calls: -1})
	if res := request(t, "POST", "/calendar/disconnect", a.tokens.access, nil); res.status != 204 {
		t.Fatalf("disconnect: %d %s", res.status, res.body)
	}
	disconnected := func() {
		t.Helper()
		values := calendarFields(t, a)
		if events, _ := values["events"].([]any); values["connected"] != false || values["calendar_id"] != nil || values["last_error"] != nil || len(events) != 0 {
			t.Fatalf("%+v", values)
		}
	}
	disconnected()
	// With nothing connected, a run doesn't try Google and record a failure.
	runWorker(t, a)
	disconnected()
}
