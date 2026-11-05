package fakes

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	stdsync "sync"
	"time"

	"google.golang.org/api/calendar/v3"
)

const googleAccessTokenTTL = time.Hour

// Google's documented event id alphabet. Its length limit is 1024; 1000 is as far as a Go regexp counts.
var googleEventID = regexp.MustCompile(`^[a-v0-9]{5,1000}$`)

type googleCalendar struct {
	id, summary, zone string
	appCreated        bool
	events            map[string]*calendar.Event
}

// Google is a stand-in for Google's OAuth and Calendar APIs, with the behaviour the worker depends on: a deleted event
// keeps its id, reminders default to on, and the app can only write to calendars it created. Requests under /_test/ let
// a black-box test act as the person in Google and inject failures.
type Google struct {
	clientID, clientSecret string
	now                    func() time.Time
	mux                    *http.ServeMux

	// PageSize is how many items a list returns at once. A test lowers it to force paging.
	PageSize int

	mu          stdsync.Mutex
	codes       map[string]bool // code to whether offline access was asked for
	refresh     map[string]bool
	access      map[string]time.Time
	calendars   map[string]*googleCalendar
	rateLimited int
	writes      int
	ids         int
}

func NewGoogle(clientID, clientSecret string, now func() time.Time) *Google {
	g := &Google{
		clientID: clientID, clientSecret: clientSecret, now: now, PageSize: 250,
		codes: map[string]bool{}, refresh: map[string]bool{}, access: map[string]time.Time{}, calendars: map[string]*googleCalendar{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /o/oauth2/auth", g.authorize)
	mux.HandleFunc("POST /token", g.token)
	mux.HandleFunc("POST /revoke", g.revoke)

	api := func(pattern string, write bool, h func(http.ResponseWriter, *http.Request)) {
		mux.HandleFunc(pattern, g.authorized(write, h))
	}
	api("GET /calendar/v3/users/me/calendarList", false, g.listCalendars)
	api("POST /calendar/v3/calendars", true, g.createCalendar)
	api("GET /calendar/v3/calendars/{cal}", false, g.getCalendar)
	api("DELETE /calendar/v3/calendars/{cal}", true, g.deleteCalendar)
	api("GET /calendar/v3/calendars/{cal}/events", false, g.listEvents)
	api("POST /calendar/v3/calendars/{cal}/events", true, g.insertEvent)
	api("PUT /calendar/v3/calendars/{cal}/events/{id}", true, g.updateEvent)
	api("DELETE /calendar/v3/calendars/{cal}/events/{id}", true, g.deleteEvent)

	mux.HandleFunc("GET /_test/calendars", g.testState)
	mux.HandleFunc("POST /_test/calendars", g.testAddCalendar)
	mux.HandleFunc("POST /_test/calendars/{cal}/delete", g.testDeleteCalendar)
	mux.HandleFunc("POST /_test/calendars/{cal}/events", g.testAddEvent)
	mux.HandleFunc("POST /_test/calendars/{cal}/events/{id}/edit", g.testEditEvent)
	mux.HandleFunc("POST /_test/calendars/{cal}/events/{id}/delete", g.testDeleteEvent)
	mux.HandleFunc("POST /_test/revoke", func(w http.ResponseWriter, _ *http.Request) {
		g.Revoke()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /_test/rate_limit", g.testRateLimit)
	g.mux = mux
	return g
}

func (g *Google) ServeHTTP(w http.ResponseWriter, r *http.Request) { g.mux.ServeHTTP(w, r) }

// AddCalendar adds a calendar the person already has, which the app can read but not write.
func (g *Google) AddCalendar(id, summary string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calendars[id] = &googleCalendar{id: id, summary: summary, events: map[string]*calendar.Event{}}
}

// DeleteCalendar removes a calendar, as the person can in Google.
func (g *Google) DeleteCalendar(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.calendars, id)
}

// AddEvent adds an event as the person would in Google, returning its id.
func (g *Google) AddEvent(cal string, e *calendar.Event) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	if e.Id == "" {
		g.ids++
		e.Id = fmt.Sprintf("00person%d", g.ids)
	}
	if e.Status == "" {
		e.Status = "confirmed"
	}
	g.calendars[cal].events[e.Id] = e
	return e.Id
}

// EditEvent changes an event as the person would in Google.
func (g *Google) EditEvent(cal, id string, edit func(*calendar.Event)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	edit(g.calendars[cal].events[id])
}

// DeleteEvent deletes an event as the person would in Google.
func (g *Google) DeleteEvent(cal, id string) {
	g.EditEvent(cal, id, func(e *calendar.Event) { e.Status = "cancelled" })
}

// Events returns a calendar's events that aren't deleted.
func (g *Google) Events(cal string) []*calendar.Event {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calendars[cal].visible()
}

// CalendarNamed returns the id of the calendar with this name, or "".
func (g *Google) CalendarNamed(summary string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, c := range g.calendars {
		if c.summary == summary {
			return c.id
		}
	}
	return ""
}

// Writes counts changes made through the API, so a test can see a run that had nothing to do.
func (g *Google) Writes() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.writes
}

// Revoke does what removing the app's access in a Google account does.
func (g *Google) Revoke() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.refresh, g.access = map[string]bool{}, map[string]time.Time{}
}

// RateLimit makes the next calls to the Calendar API fail as over quota.
func (g *Google) RateLimit(calls int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.rateLimited = calls
}

func (c *googleCalendar) visible() []*calendar.Event {
	var events []*calendar.Event
	for _, e := range c.events {
		if e.Status != "cancelled" {
			events = append(events, e)
		}
	}
	slices.SortFunc(events, func(a, b *calendar.Event) int {
		if d := googleTime(a.Start).Compare(googleTime(b.Start)); d != 0 {
			return d
		}
		return cmpStrings(a.Id, b.Id)
	})
	return events
}

func cmpStrings(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func googleTime(at *calendar.EventDateTime) time.Time {
	if at == nil {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, at.DateTime); err == nil {
		return t
	}
	t, _ := time.Parse(time.DateOnly, at.Date)
	return t
}

func randomGoogleToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (g *Google) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	redirect, err := url.Parse(q.Get("redirect_uri"))
	if q.Get("client_id") != g.clientID || q.Get("response_type") != "code" || q.Get("scope") == "" || err != nil || redirect.Scheme == "" {
		http.Error(w, "invalid_request", http.StatusBadRequest)
		return
	}
	code := randomGoogleToken()
	g.mu.Lock()
	g.codes[code] = q.Get("access_type") == "offline"
	g.mu.Unlock()
	back := redirect.Query()
	back.Set("code", code)
	back.Set("state", q.Get("state"))
	redirect.RawQuery = back.Encode()
	http.Redirect(w, r, redirect.String(), http.StatusFound)
}

func (g *Google) token(w http.ResponseWriter, r *http.Request) {
	id, secret, basic := r.BasicAuth()
	if !basic {
		id, secret = r.PostFormValue("client_id"), r.PostFormValue("client_secret")
	}
	if id != g.clientID || secret != g.clientSecret {
		writeGoogleJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	body := map[string]any{"token_type": "Bearer", "expires_in": int(googleAccessTokenTTL.Seconds())}
	switch r.PostFormValue("grant_type") {
	case "authorization_code":
		offline, ok := g.codes[r.PostFormValue("code")]
		if !ok {
			writeGoogleJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		delete(g.codes, r.PostFormValue("code"))
		if offline {
			refresh := randomGoogleToken()
			g.refresh[refresh] = true
			body["refresh_token"] = refresh
		}
	case "refresh_token":
		if !g.refresh[r.PostFormValue("refresh_token")] {
			writeGoogleJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
	default:
		writeGoogleJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
		return
	}
	access := randomGoogleToken()
	g.access[access] = g.now().Add(googleAccessTokenTTL)
	body["access_token"] = access
	writeGoogleJSON(w, http.StatusOK, body)
}

// authorized holds the lock for the handler, since every handler reads or changes shared state.
func (g *Google) authorized(write bool, next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		defer g.mu.Unlock()
		const prefix = "Bearer "
		header := r.Header.Get("Authorization")
		if len(header) <= len(prefix) || g.now().After(g.access[header[len(prefix):]]) {
			writeGoogleError(w, http.StatusUnauthorized, "authError", "Invalid Credentials")
			return
		}
		if g.rateLimited > 0 {
			g.rateLimited--
			writeGoogleError(w, http.StatusForbidden, "rateLimitExceeded", "Rate Limit Exceeded")
			return
		}
		if write {
			g.writes++
		}
		next(w, r)
	}
}

func writeGoogleJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeGoogleError(w http.ResponseWriter, status int, reason, message string) {
	writeGoogleJSON(w, status, map[string]any{"error": map[string]any{
		"code": status, "message": message,
		"errors": []map[string]string{{"reason": reason, "message": message}},
	}})
}

// page returns one page of items and the token of the next.
func page[T any](g *Google, r *http.Request, items []T) ([]T, string) {
	from, _ := strconv.Atoi(r.URL.Query().Get("pageToken"))
	from = min(from, len(items))
	to := min(from+g.PageSize, len(items))
	if to == len(items) {
		return items[from:to], ""
	}
	return items[from:to], strconv.Itoa(to)
}

func (g *Google) listCalendars(w http.ResponseWriter, r *http.Request) {
	var items []*calendar.CalendarListEntry
	for _, c := range g.calendars {
		items = append(items, &calendar.CalendarListEntry{Id: c.id, Summary: c.summary, TimeZone: c.zone})
	}
	slices.SortFunc(items, func(a, b *calendar.CalendarListEntry) int { return cmpStrings(a.Id, b.Id) })
	items, next := page(g, r, items)
	writeGoogleJSON(w, http.StatusOK, calendar.CalendarList{Items: items, NextPageToken: next})
}

func (g *Google) createCalendar(w http.ResponseWriter, r *http.Request) {
	var body calendar.Calendar
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Summary == "" {
		writeGoogleError(w, http.StatusBadRequest, "required", "Missing title.")
		return
	}
	g.ids++
	id := fmt.Sprintf("app%d@group.calendar.example.test", g.ids)
	g.calendars[id] = &googleCalendar{id: id, summary: body.Summary, appCreated: true, events: map[string]*calendar.Event{}}
	writeGoogleJSON(w, http.StatusOK, calendar.Calendar{Id: id, Summary: body.Summary})
}

func (g *Google) getCalendar(w http.ResponseWriter, r *http.Request) {
	c, ok := g.calendarOf(w, r)
	if ok {
		writeGoogleJSON(w, http.StatusOK, calendar.Calendar{Id: c.id, Summary: c.summary})
	}
}

func (g *Google) deleteCalendar(w http.ResponseWriter, r *http.Request) {
	if c, ok := g.writable(w, r); ok {
		delete(g.calendars, c.id)
		w.WriteHeader(http.StatusNoContent)
	}
}

// revoke takes a refresh token, as Google's revoke endpoint does, and answers 400 for one it doesn't know.
func (g *Google) revoke(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	token := r.PostFormValue("token")
	if !g.refresh[token] {
		writeGoogleJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_token"})
		return
	}
	delete(g.refresh, token)
	w.WriteHeader(http.StatusOK)
}

func (g *Google) calendarOf(w http.ResponseWriter, r *http.Request) (*googleCalendar, bool) {
	c, ok := g.calendars[r.PathValue("cal")]
	if !ok {
		writeGoogleError(w, http.StatusNotFound, "notFound", "Not Found")
	}
	return c, ok
}

// writable also answers the request when the answer is no.
func (g *Google) writable(w http.ResponseWriter, r *http.Request) (*googleCalendar, bool) {
	c, ok := g.calendarOf(w, r)
	if ok && !c.appCreated {
		writeGoogleError(w, http.StatusForbidden, "forbidden", "Forbidden")
		return nil, false
	}
	return c, ok
}

func (g *Google) listEvents(w http.ResponseWriter, r *http.Request) {
	c, ok := g.calendarOf(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	var items []*calendar.Event
	for _, e := range c.visible() {
		if from, err := time.Parse(time.RFC3339, q.Get("timeMin")); err == nil && !googleTime(e.End).After(from) {
			continue
		}
		if to, err := time.Parse(time.RFC3339, q.Get("timeMax")); err == nil && !googleTime(e.Start).Before(to) {
			continue
		}
		items = append(items, e)
	}
	items, next := page(g, r, items)
	writeGoogleJSON(w, http.StatusOK, calendar.Events{Items: items, NextPageToken: next})
}

// decodeEvent applies what Google does to an event it receives, and answers the request when it refuses one.
func decodeEvent(w http.ResponseWriter, r *http.Request) (*calendar.Event, bool) {
	var e calendar.Event
	var raw struct {
		Reminders *struct {
			UseDefault *bool `json:"useDefault"`
		} `json:"reminders"`
	}
	data := json.NewDecoder(r.Body)
	var body json.RawMessage
	if err := data.Decode(&body); err != nil || json.Unmarshal(body, &e) != nil || json.Unmarshal(body, &raw) != nil {
		writeGoogleError(w, http.StatusBadRequest, "parseError", "Parse Error")
		return nil, false
	}
	start, end := googleTime(e.Start), googleTime(e.End)
	if start.IsZero() || end.IsZero() {
		writeGoogleError(w, http.StatusBadRequest, "required", "Missing start or end.")
		return nil, false
	}
	if end.Before(start) {
		writeGoogleError(w, http.StatusBadRequest, "timeRangeEmpty", "The specified time range is empty.")
		return nil, false
	}
	if raw.Reminders == nil || raw.Reminders.UseDefault == nil {
		e.Reminders = &calendar.EventReminders{UseDefault: true}
	}
	if e.Status == "" {
		e.Status = "confirmed"
	}
	return &e, true
}

func (g *Google) insertEvent(w http.ResponseWriter, r *http.Request) {
	c, ok := g.writable(w, r)
	if !ok {
		return
	}
	e, ok := decodeEvent(w, r)
	if !ok {
		return
	}
	if !googleEventID.MatchString(e.Id) {
		writeGoogleError(w, http.StatusBadRequest, "invalid", "Invalid resource id value.")
		return
	}
	if _, exists := c.events[e.Id]; exists {
		writeGoogleError(w, http.StatusConflict, "duplicate", "The requested identifier already exists.")
		return
	}
	c.events[e.Id] = e
	writeGoogleJSON(w, http.StatusOK, e)
}

func (g *Google) updateEvent(w http.ResponseWriter, r *http.Request) {
	c, ok := g.writable(w, r)
	if !ok {
		return
	}
	e, ok := decodeEvent(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if _, exists := c.events[id]; !exists {
		writeGoogleError(w, http.StatusNotFound, "notFound", "Not Found")
		return
	}
	e.Id = id
	c.events[id] = e
	writeGoogleJSON(w, http.StatusOK, e)
}

func (g *Google) deleteEvent(w http.ResponseWriter, r *http.Request) {
	c, ok := g.writable(w, r)
	if !ok {
		return
	}
	e, exists := c.events[r.PathValue("id")]
	switch {
	case !exists:
		writeGoogleError(w, http.StatusNotFound, "notFound", "Not Found")
	case e.Status == "cancelled":
		writeGoogleError(w, http.StatusGone, "deleted", "Resource has been deleted")
	default:
		e.Status = "cancelled"
		w.WriteHeader(http.StatusNoContent)
	}
}

func (g *Google) testState(w http.ResponseWriter, _ *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	type state struct {
		ID         string            `json:"id"`
		Summary    string            `json:"summary"`
		AppCreated bool              `json:"app_created"`
		Events     []*calendar.Event `json:"events"`
	}
	all := []state{}
	for _, c := range g.calendars {
		all = append(all, state{c.id, c.summary, c.appCreated, c.visible()})
	}
	slices.SortFunc(all, func(a, b state) int { return cmpStrings(a.ID, b.ID) })
	writeGoogleJSON(w, http.StatusOK, map[string]any{"calendars": all})
}

func (g *Google) testAddCalendar(w http.ResponseWriter, r *http.Request) {
	var body struct{ ID, Summary string }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ID == "" {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	g.AddCalendar(body.ID, body.Summary)
	w.WriteHeader(http.StatusNoContent)
}

func (g *Google) testDeleteCalendar(w http.ResponseWriter, r *http.Request) {
	g.DeleteCalendar(r.PathValue("cal"))
	w.WriteHeader(http.StatusNoContent)
}

func (g *Google) testHas(w http.ResponseWriter, cal, id string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	c, ok := g.calendars[cal]
	if ok && id != "" {
		_, ok = c.events[id]
	}
	if !ok {
		http.Error(w, "no such calendar or event", http.StatusNotFound)
	}
	return ok
}

func (g *Google) testAddEvent(w http.ResponseWriter, r *http.Request) {
	cal := r.PathValue("cal")
	if !g.testHas(w, cal, "") {
		return
	}
	var e calendar.Event
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	g.AddEvent(cal, &e)
	w.WriteHeader(http.StatusNoContent)
}

// testEditEvent applies the fields in the body over the event.
func (g *Google) testEditEvent(w http.ResponseWriter, r *http.Request) {
	cal, id := r.PathValue("cal"), r.PathValue("id")
	if !g.testHas(w, cal, id) {
		return
	}
	var err error
	g.EditEvent(cal, id, func(e *calendar.Event) { err = json.NewDecoder(r.Body).Decode(e) })
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (g *Google) testDeleteEvent(w http.ResponseWriter, r *http.Request) {
	cal, id := r.PathValue("cal"), r.PathValue("id")
	if !g.testHas(w, cal, id) {
		return
	}
	g.DeleteEvent(cal, id)
	w.WriteHeader(http.StatusNoContent)
}

func (g *Google) testRateLimit(w http.ResponseWriter, r *http.Request) {
	var body struct{ Calls int }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	g.RateLimit(body.Calls)
	w.WriteHeader(http.StatusNoContent)
}

// SetTimeZone sets the zone a calendar's all-day events fall in.
func (g *Google) SetTimeZone(id, zone string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calendars[id].zone = zone
}
