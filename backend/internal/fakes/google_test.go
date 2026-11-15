package fakes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

const (
	validEventID = "0123456789abcdefghijklmnopqrstuv"
	otherEventID = "aaaaaaaaaaaaaaaa"
)

func googleConfig(srv *httptest.Server) *oauth2.Config {
	return &oauth2.Config{
		ClientID: "cid", ClientSecret: "secret", RedirectURL: srv.URL + "/back",
		Scopes:   []string{"calendar.app.created"},
		Endpoint: oauth2.Endpoint{AuthURL: srv.URL + "/o/oauth2/auth", TokenURL: srv.URL + "/token"},
	}
}

// consent walks the consent redirect and returns the code and state sent back.
func consent(t *testing.T, srv *httptest.Server, state string) (string, string) {
	t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(googleConfig(srv).AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.ApprovalForce))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusFound {
		t.Fatalf("consent: %d", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(loc.Path, "/back") {
		t.Fatalf("redirected to %s", loc)
	}
	return loc.Query().Get("code"), loc.Query().Get("state")
}

func newGoogle(t *testing.T) (*Google, *httptest.Server, *calendar.Service) {
	t.Helper()
	clock := &Clock{}
	g := NewGoogle("cid", "secret", clock.Now)
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	code, _ := consent(t, srv, "s")
	token, err := googleConfig(srv).Exchange(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	svc := serviceFor(t, srv, token.RefreshToken)
	return g, srv, svc
}

func serviceFor(t *testing.T, srv *httptest.Server, refresh string) *calendar.Service {
	t.Helper()
	ctx := context.Background()
	svc, err := calendar.NewService(ctx,
		option.WithHTTPClient(googleConfig(srv).Client(ctx, &oauth2.Token{RefreshToken: refresh})),
		option.WithEndpoint(srv.URL+"/calendar/v3/"))
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func event(id, title string, start, end time.Time) *calendar.Event {
	return &calendar.Event{
		Id: id, Summary: title,
		Start: &calendar.EventDateTime{DateTime: start.Format(time.RFC3339)},
		End:   &calendar.EventDateTime{DateTime: end.Format(time.RFC3339)},
	}
}

func googleCode(err error) int {
	var apiErr *googleapi.Error
	if errors.As(err, &apiErr) {
		return apiErr.Code
	}
	return 0
}

func TestGoogleConsentRefusesWrongClientAndReusedCode(t *testing.T) {
	g := NewGoogle("cid", "secret", time.Now)
	srv := httptest.NewServer(g)
	defer srv.Close()
	ctx := context.Background()

	code, state := consent(t, srv, "the-state")
	if state != "the-state" {
		t.Fatalf("state %q", state)
	}
	bad := googleConfig(srv)
	bad.ClientSecret = "wrong"
	if _, err := bad.Exchange(ctx, code); err == nil {
		t.Fatal("wrong secret accepted")
	}
	token, err := googleConfig(srv).Exchange(ctx, code)
	if err != nil {
		t.Fatal(err)
	}
	if token.RefreshToken == "" || token.AccessToken == "" {
		t.Fatalf("token %+v", token)
	}
	if _, err := googleConfig(srv).Exchange(ctx, code); err == nil {
		t.Fatal("code used twice")
	}

	// No offline access, no refresh token.
	res, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Get(googleConfig(srv).AuthCodeURL("s"))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	loc, _ := url.Parse(res.Header.Get("Location"))
	online, err := googleConfig(srv).Exchange(ctx, loc.Query().Get("code"))
	if err != nil {
		t.Fatal(err)
	}
	if online.RefreshToken != "" {
		t.Fatal("online consent returned a refresh token")
	}
}

func TestGoogleEventsBehaveLikeTheRealAPI(t *testing.T) {
	g, _, svc := newGoogle(t)
	ctx := context.Background()
	cal, err := svc.Calendars.Insert(&calendar.Calendar{Summary: "Time blocks"}).Context(ctx).Do()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)

	if _, err := svc.Events.Insert(cal.Id, event("UPPER-case", "x", at, at.Add(time.Hour))).Do(); googleCode(err) != 400 {
		t.Fatalf("bad id: %v", err)
	}
	if _, err := svc.Events.Insert(cal.Id, event(validEventID, "x", at, at.Add(-time.Hour))).Do(); googleCode(err) != 400 {
		t.Fatalf("end before start: %v", err)
	}

	created, err := svc.Events.Insert(cal.Id, event(validEventID, "Paint the fence", at, at.Add(time.Hour))).Do()
	if err != nil {
		t.Fatal(err)
	}
	if created.Status != "confirmed" {
		t.Fatalf("status %q", created.Status)
	}
	if created.Reminders == nil || !created.Reminders.UseDefault {
		t.Fatalf("reminders unset should default on: %+v", created.Reminders)
	}
	if _, err := svc.Events.Insert(cal.Id, event(validEventID, "again", at, at.Add(time.Hour))).Do(); googleCode(err) != 409 {
		t.Fatalf("duplicate: %v", err)
	}

	// A deleted event keeps its id: inserting it again conflicts, updating restores it.
	if err := svc.Events.Delete(cal.Id, validEventID).Do(); err != nil {
		t.Fatal(err)
	}
	if err := svc.Events.Delete(cal.Id, validEventID).Do(); googleCode(err) != 410 {
		t.Fatalf("second delete: %v", err)
	}
	if _, err := svc.Events.Insert(cal.Id, event(validEventID, "again", at, at.Add(time.Hour))).Do(); googleCode(err) != 409 {
		t.Fatalf("insert over deleted: %v", err)
	}
	if listed, _ := svc.Events.List(cal.Id).Do(); len(listed.Items) != 0 {
		t.Fatalf("deleted event listed: %d", len(listed.Items))
	}
	restored := event(validEventID, "again", at, at.Add(time.Hour))
	restored.Status = "confirmed"
	restored.Reminders = &calendar.EventReminders{UseDefault: false, ForceSendFields: []string{"UseDefault"}}
	updated, err := svc.Events.Update(cal.Id, validEventID, restored).Do()
	if err != nil {
		t.Fatal(err)
	}
	if updated.Reminders == nil || updated.Reminders.UseDefault {
		t.Fatalf("reminders %+v", updated.Reminders)
	}

	// The window keeps what overlaps it, and a long list comes in pages.
	if _, err := svc.Events.Insert(cal.Id, event(otherEventID, "later", at.AddDate(0, 1, 0), at.AddDate(0, 1, 0).Add(time.Hour))).Do(); err != nil {
		t.Fatal(err)
	}
	windowed, err := svc.Events.List(cal.Id).TimeMin(at.Add(30 * time.Minute).Format(time.RFC3339)).TimeMax(at.AddDate(0, 0, 7).Format(time.RFC3339)).Do()
	if err != nil || len(windowed.Items) != 1 || windowed.Items[0].Id != validEventID {
		t.Fatalf("window: %+v %v", windowed, err)
	}
	g.PageSize = 1
	pages, seen := 0, 0
	err = svc.Events.List(cal.Id).Pages(ctx, func(page *calendar.Events) error {
		pages++
		seen += len(page.Items)
		return nil
	})
	if err != nil || pages != 2 || seen != 2 {
		t.Fatalf("%d pages %d events %v", pages, seen, err)
	}
	if g.Writes() == 0 {
		t.Fatal("writes not counted")
	}
}

func TestGoogleWritesOnlyToCalendarsTheAppCreated(t *testing.T) {
	g, _, svc := newGoogle(t)
	g.AddCalendar("office@example.test", "Office")
	at := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	if _, err := svc.Events.Insert("office@example.test", event(validEventID, "x", at, at.Add(time.Hour))).Do(); googleCode(err) != 403 {
		t.Fatalf("insert: %v", err)
	}
	g.AddEvent("office@example.test", event("", "Team lunch", at, at.Add(time.Hour)))
	list, err := svc.Events.List("office@example.test").Do()
	if err != nil || len(list.Items) != 1 || list.Items[0].Id == "" {
		t.Fatalf("%+v %v", list, err)
	}
	if err := svc.Events.Delete("office@example.test", list.Items[0].Id).Do(); googleCode(err) != 403 {
		t.Fatalf("delete: %v", err)
	}
	cals, err := svc.CalendarList.List().Do()
	if err != nil || len(cals.Items) != 1 || cals.Items[0].Summary != "Office" {
		t.Fatalf("%+v %v", cals, err)
	}
	if _, err := svc.Calendars.Get("missing").Do(); googleCode(err) != 404 {
		t.Fatalf("missing calendar: %v", err)
	}
}

func TestGoogleFailureModes(t *testing.T) {
	g, srv, svc := newGoogle(t)
	g.RateLimit(1)
	_, err := svc.CalendarList.List().Do()
	var apiErr *googleapi.Error
	if !errors.As(err, &apiErr) || apiErr.Code != 403 || len(apiErr.Errors) != 1 || apiErr.Errors[0].Reason != "rateLimitExceeded" {
		t.Fatalf("rate limit: %v", err)
	}
	if _, err := svc.CalendarList.List().Do(); err != nil {
		t.Fatalf("after the limit: %v", err)
	}

	g.Revoke()
	_, err = serviceFor(t, srv, "whatever").CalendarList.List().Do()
	var retrieve *oauth2.RetrieveError
	if !errors.As(err, &retrieve) || retrieve.ErrorCode != "invalid_grant" {
		t.Fatalf("revoked: %v", err)
	}

	// A new consent works again.
	code, _ := consent(t, srv, "s")
	token, err := googleConfig(srv).Exchange(context.Background(), code)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serviceFor(t, srv, token.RefreshToken).CalendarList.List().Do(); err != nil {
		t.Fatal(err)
	}
}

// dropped says whether a call failed the way a lost connection fails: with no answer from Google at all.
func dropped(err error) bool {
	var urlErr *url.Error
	var retrieve *oauth2.RetrieveError
	return errors.As(err, &urlErr) && googleCode(err) == 0 && !errors.As(err, &retrieve)
}

func TestGoogleOutage(t *testing.T) {
	g, srv, svc := newGoogle(t)
	ctx := context.Background()
	cal, err := svc.Calendars.Insert(&calendar.Calendar{Summary: "Time blocks"}).Do()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	ids := 0
	// Inserts, since Go's transport sends a read again by itself when a reused connection drops, which would count twice.
	insert := func() (string, error) {
		ids++
		id := fmt.Sprintf("event%05d", ids)
		_, err := svc.Events.Insert(cal.Id, event(id, "Paint the fence", at, at.Add(time.Hour))).Do()
		return id, err
	}
	inGoogle := func() []string {
		var got []string
		for _, e := range g.Events(cal.Id) {
			got = append(got, e.Id)
		}
		return got
	}

	t.Run("after some calls, for some calls", func(t *testing.T) {
		g.Outage(GoogleOutage{After: 1, Calls: 2})
		first, err := insert()
		if err != nil {
			t.Fatalf("the call before the outage: %v", err)
		}
		for range 2 {
			if _, err := insert(); !dropped(err) {
				t.Fatalf("not dropped: %v", err)
			}
		}
		last, err := insert()
		if err != nil {
			t.Fatalf("the call after the outage: %v", err)
		}
		if got := inGoogle(); !slices.Equal(got, []string{first, last}) {
			t.Fatalf("dropped calls reached Google: %v", got)
		}
	})

	t.Run("applied", func(t *testing.T) {
		g.Outage(GoogleOutage{Calls: 1, Applied: true})
		id, err := insert()
		if !dropped(err) {
			t.Fatalf("not dropped: %v", err)
		}
		if !slices.Contains(inGoogle(), id) {
			t.Fatal("an applied drop didn't make the event")
		}
		_, err = svc.Events.Insert(cal.Id, event(id, "Paint the fence", at, at.Add(time.Hour))).Do()
		if googleCode(err) != http.StatusConflict {
			t.Fatalf("inserting again: %v", err)
		}
	})

	t.Run("answered with a status", func(t *testing.T) {
		g.Outage(GoogleOutage{Calls: 1, Status: http.StatusServiceUnavailable})
		if _, err := svc.CalendarList.List().Do(); googleCode(err) != http.StatusServiceUnavailable {
			t.Fatalf("%v", err)
		}
		if _, err := svc.CalendarList.List().Do(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("until lifted", func(t *testing.T) {
		g.Outage(GoogleOutage{Calls: -1})
		for range 3 {
			if _, err := insert(); !dropped(err) {
				t.Fatalf("not dropped: %v", err)
			}
		}
		// A read is sent again on a fresh connection, which drops too.
		if _, err := svc.CalendarList.List().Do(); !dropped(err) {
			t.Fatalf("not dropped: %v", err)
		}
		g.Outage(GoogleOutage{})
		if _, err := insert(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("token endpoints", func(t *testing.T) {
		code, _ := consent(t, srv, "s")
		token, err := googleConfig(srv).Exchange(ctx, code)
		if err != nil {
			t.Fatal(err)
		}
		g.Outage(GoogleOutage{Token: true, Calls: -1})
		// A client that already has an access token doesn't need the token endpoint.
		if _, err := svc.CalendarList.List().Do(); err != nil {
			t.Fatalf("the Calendar API dropped too: %v", err)
		}
		// One that has to refresh can't reach Google, which isn't Google refusing the token.
		if _, err := serviceFor(t, srv, token.RefreshToken).CalendarList.List().Do(); !dropped(err) {
			t.Fatalf("refresh not dropped: %v", err)
		}
		if _, err := http.PostForm(srv.URL+"/revoke", url.Values{"token": {token.RefreshToken}}); err == nil {
			t.Fatal("revoke not dropped")
		}

		// Until lifted, since a new oauth2.Config sends a refresh that fails a second time, with the client in the body.
		g.Outage(GoogleOutage{Token: true, Calls: -1, Status: http.StatusBadGateway})
		_, err = serviceFor(t, srv, token.RefreshToken).CalendarList.List().Do()
		var retrieve *oauth2.RetrieveError
		if !errors.As(err, &retrieve) || retrieve.Response.StatusCode != http.StatusBadGateway || retrieve.ErrorCode != "" {
			t.Fatalf("refresh not answered 502: %v", err)
		}
		g.Outage(GoogleOutage{Token: true})
		if _, err := serviceFor(t, srv, token.RefreshToken).CalendarList.List().Do(); err != nil {
			t.Fatalf("after the outage: %v", err)
		}
	})

	t.Run("over HTTP", func(t *testing.T) {
		res, err := http.Post(srv.URL+"/_test/outage", "application/json", strings.NewReader(`{"calls":-1,"status":502}`))
		if err != nil || res.StatusCode != http.StatusNoContent {
			t.Fatalf("%v %v", res, err)
		}
		res.Body.Close()
		if _, err := svc.CalendarList.List().Do(); googleCode(err) != http.StatusBadGateway {
			t.Fatalf("%v", err)
		}
		// The test controls are never part of an outage.
		res, err = http.Get(srv.URL + "/_test/calendars")
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("%v %v", res, err)
		}
		res.Body.Close()
		res, err = http.Post(srv.URL+"/_test/outage", "application/json", strings.NewReader(`{}`))
		if err != nil || res.StatusCode != http.StatusNoContent {
			t.Fatalf("%v %v", res, err)
		}
		res.Body.Close()
		if _, err := svc.CalendarList.List().Do(); err != nil {
			t.Fatal(err)
		}
	})
}

func TestGoogleEditsAndHTTPControls(t *testing.T) {
	g, srv, svc := newGoogle(t)
	cal, err := svc.Calendars.Insert(&calendar.Calendar{Summary: "Time blocks"}).Do()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 2, 15, 0, 0, 0, time.UTC)
	if _, err := svc.Events.Insert(cal.Id, event(validEventID, "Paint the fence", at, at.Add(time.Hour))).Do(); err != nil {
		t.Fatal(err)
	}
	writes := g.Writes()
	g.EditEvent(cal.Id, validEventID, func(e *calendar.Event) { e.Summary = "Edited in Google" })
	if g.Writes() != writes {
		t.Fatal("an edit in Google counted as the app writing")
	}
	if got := g.Events(cal.Id); len(got) != 1 || got[0].Summary != "Edited in Google" {
		t.Fatalf("%+v", got)
	}

	post := func(path, body string) int {
		t.Helper()
		res, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if status := post("/_test/calendars", `{"id":"home@example.test","summary":"Home"}`); status != 204 {
		t.Fatalf("add calendar: %d", status)
	}
	if status := post("/_test/calendars/home@example.test/events", `{"summary":"Team lunch","start":{"dateTime":"2026-11-03T10:00:00Z"},"end":{"dateTime":"2026-11-03T11:00:00Z"}}`); status != 204 {
		t.Fatalf("add event: %d", status)
	}
	if status := post("/_test/calendars/"+cal.Id+"/events/"+validEventID+"/edit", `{"summary":"Edited again"}`); status != 204 {
		t.Fatalf("edit event: %d", status)
	}
	res, err := http.Get(srv.URL + "/_test/calendars")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var state struct {
		Calendars []struct {
			ID, Summary string
			Events      []*calendar.Event
		}
	}
	if err := json.NewDecoder(res.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	titles := map[string]string{}
	for _, c := range state.Calendars {
		for _, e := range c.Events {
			titles[c.Summary] = e.Summary
		}
	}
	if titles["Time blocks"] != "Edited again" || titles["Home"] != "Team lunch" {
		t.Fatalf("%+v", titles)
	}

	if status := post("/_test/calendars/"+cal.Id+"/events/"+validEventID+"/delete", ``); status != 204 {
		t.Fatalf("delete event: %d", status)
	}
	if len(g.Events(cal.Id)) != 0 {
		t.Fatal("event still there")
	}
	if status := post("/_test/rate_limit", `{"calls":1}`); status != 204 {
		t.Fatalf("rate limit: %d", status)
	}
	if _, err := svc.Calendars.Get(cal.Id).Do(); googleCode(err) != 403 {
		t.Fatalf("limit not applied: %v", err)
	}
	if status := post("/_test/revoke", ``); status != 204 {
		t.Fatalf("revoke: %d", status)
	}
	if _, err := serviceFor(t, srv, "x").CalendarList.List().Do(); err == nil {
		t.Fatal("still authorised after revoke")
	}
}
