package api

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

type fakeAccount struct {
	deleted   map[string]bool
	gone      map[string]bool
	asked     []string
	export    account.ExportState
	exportErr error
	err       error
}

func (f *fakeAccount) StartExport(_ context.Context, sub string) (account.ExportState, error) {
	f.asked = append(f.asked, "start-export:"+sub)
	return f.export, f.exportErr
}

func (f *fakeAccount) Export(_ context.Context, sub string) (account.ExportState, error) {
	f.asked = append(f.asked, "export:"+sub)
	return f.export, f.exportErr
}

func (f *fakeAccount) Delete(_ context.Context, sub string) error {
	f.asked = append(f.asked, "delete:"+sub)
	return f.err
}

func (f *fakeAccount) Deleted(_ context.Context, sub string) (bool, error) {
	return f.deleted[sub], f.err
}

func (f *fakeAccount) Gone(_ context.Context, sub string) (bool, error) {
	f.asked = append(f.asked, "gone:"+sub)
	return f.gone[sub], f.err
}

// fakeTokens takes "token-for-<sub>" as a token for sub, lapsed or not.
type fakeTokens struct{}

func (fakeTokens) Subject(_ context.Context, token string) (string, bool) {
	return strings.CutPrefix(token, "token-for-")
}

func accountServer(a *fakeAccount) *Server {
	s, _ := newServer(&fakeSyncer{res: sync.Response{Changes: []sync.Change{}}}, &fakeCalendar{})
	s.Account, s.Tokens, s.Files = a, fakeTokens{}, &fakeFiles{}
	return s
}

// signedInAt is a request from testSub, who last signed in at.
func signedInAt(s *Server, method, target, body string, at time.Time) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req = req.WithContext(WithAuthTime(WithSub(req.Context(), testSub), at))
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestDeletingTakesARecentSignInAndTheTypedConfirmation(t *testing.T) {
	a := &fakeAccount{}
	s := accountServer(a)
	confirm := `{"confirm":"DELETE"}`
	for _, c := range []struct {
		name, body string
		signedIn   time.Time
		status     int
		code       string
	}{
		{"no confirmation", `{}`, testNow, 400, "invalid_request"},
		{"the wrong confirmation", `{"confirm":"delete"}`, testNow, 400, "invalid_request"},
		{"no sign-in time", confirm, time.Time{}, 403, "sign_in_again"},
		{"a sign-in too long ago", confirm, testNow.Add(-maxSignInAge - time.Second), 403, "sign_in_again"},
	} {
		rec := signedInAt(s, "POST", "/account/delete", c.body, c.signedIn)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), c.code) {
			t.Fatalf("%s: %d %s", c.name, rec.Code, rec.Body)
		}
	}
	if len(a.asked) != 0 {
		t.Fatalf("deleted after a refusal: %v", a.asked)
	}
	rec := signedInAt(s, "POST", "/account/delete", confirm, testNow.Add(-maxSignInAge))
	if rec.Code != 202 || strings.TrimSpace(rec.Body.String()) != `{"state":"deleting"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	// Only ever the token's own user, whatever the body says.
	if len(a.asked) != 1 || a.asked[0] != "delete:"+testSub {
		t.Fatalf("asked %v", a.asked)
	}
}

func TestTheAccountRoutesNeedASignInAndNameNoOne(t *testing.T) {
	a := &fakeAccount{export: account.ExportState{State: account.ExportBuilding}}
	s, logs := newServer(&fakeSyncer{}, nil)
	s.Account, s.Tokens = a, fakeTokens{}
	for _, route := range [][2]string{{"POST", "/account/export"}, {"GET", "/account/export"}, {"POST", "/account/delete"}} {
		if rec := do(s, route[0], route[1], `{"confirm":"DELETE"}`, ""); rec.Code != 401 {
			t.Fatalf("%v without a sign-in: %d", route, rec.Code)
		}
	}
	if len(a.asked) != 0 {
		t.Fatalf("asked %v", a.asked)
	}
	logs.Reset()
	if rec := do(s, "POST", "/account/export", "", testSub); rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if strings.Contains(logs.String(), obs.HashSub(testSub)) || strings.Contains(logs.String(), testSub) {
		t.Fatalf("the log line names who: %s", logs)
	}
}

func TestExportRoutes(t *testing.T) {
	expires := testNow.Add(5 * time.Minute).UTC()
	a := &fakeAccount{export: account.ExportState{State: account.ExportReady, URL: "https://files.test/x.zip", ExpiresAt: &expires}}
	s := accountServer(a)
	rec := do(s, "GET", "/account/export", "", testSub)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"url":"https://files.test/x.zip"`) || !strings.Contains(rec.Body.String(), `"state":"ready"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if a.asked[0] != "export:"+testSub {
		t.Fatalf("asked %v", a.asked)
	}
	a.exportErr = account.ErrNoFiles
	if rec := do(s, "POST", "/account/export", "", testSub); rec.Code != 501 || !strings.Contains(rec.Body.String(), "export_not_configured") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	s.Account = nil
	if rec := do(s, "GET", "/account/export", "", testSub); rec.Code != 501 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

// A device that still holds a good token after its account's deletion started can't write anything back.
func TestADeletedAccountIsRefusedEverywhereItCouldWrite(t *testing.T) {
	a := &fakeAccount{deleted: map[string]bool{testSub: true}}
	s := accountServer(a)
	for _, route := range [][2]string{
		{"POST", "/calendar/connect"}, {"POST", "/calendar/refresh"}, {"POST", "/calendar/disconnect"},
		{"POST", "/files/upload"}, {"POST", "/files/download"}, {"GET", "/files/usage"},
		{"POST", "/account/export"}, {"GET", "/account/export"},
	} {
		rec := do(s, route[0], route[1], `{"id":"a1","ids":["a1"]}`, testSub)
		if rec.Code != 401 || !strings.Contains(rec.Body.String(), `"error":"account_deleted"`) {
			t.Fatalf("%v: %d %s", route, rec.Code, rec.Body)
		}
	}
	// Someone else's account works as before.
	if rec := do(s, "GET", "/files/usage", "", "someone-else"); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	// Asking again while it's under way is fine.
	if rec := signedInAt(s, "POST", "/account/delete", `{"confirm":"DELETE"}`, testNow); rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestADeletedAccountsSyncIsRefusedWithItsOwnCode(t *testing.T) {
	s, logs := newServer(&fakeSyncer{err: sync.ErrAccountDeleted}, nil)
	rec := do(s, "POST", "/sync", goodBody, testSub)
	if rec.Code != 401 || strings.TrimSpace(rec.Body.String()) != `{"error":"account_deleted"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if line := logLine(t, logs); line["error_type"] != "account_deleted" {
		t.Fatalf("%+v", line)
	}
}

func TestStatusAnswersOnlyForTheTokensOwnAccount(t *testing.T) {
	a := &fakeAccount{gone: map[string]bool{"gone-user": true}}
	s := accountServer(a)
	ask := func(header string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/account/status", strings.NewReader(`{"sub":"someone-else"}`))
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		rec := httptest.NewRecorder()
		s.Handler().ServeHTTP(rec, req)
		return rec
	}
	if rec := ask("Bearer token-for-gone-user"); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"deleted":true}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := ask("Bearer token-for-kept-user"); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"deleted":false}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	for _, header := range []string{"", "Bearer not-a-token", "token-for-gone-user"} {
		if rec := ask(header); rec.Code != 401 {
			t.Fatalf("%q: %d %s", header, rec.Code, rec.Body)
		}
	}
	// The body's sub is never read.
	for _, asked := range a.asked {
		if asked == "gone:someone-else" {
			t.Fatal("answered for the body's sub")
		}
	}
}

func TestAccountFailuresAreInternal(t *testing.T) {
	a := &fakeAccount{err: errors.New("dynamodb down")}
	s := accountServer(a)
	if rec := do(s, "GET", "/files/usage", "", testSub); rec.Code != 500 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := signedInAt(s, "POST", "/account/delete", `{"confirm":"DELETE"}`, testNow); rec.Code != 500 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestAuthTimeClaim(t *testing.T) {
	if at, ok := AuthTimeClaim("1800000000"); !ok || !at.Equal(time.Unix(1800000000, 0)) {
		t.Fatalf("%v %v", at, ok)
	}
	for _, bad := range []string{"", "soon", "-5", "0"} {
		if _, ok := AuthTimeClaim(bad); ok {
			t.Fatalf("%q read as a time", bad)
		}
	}
}
