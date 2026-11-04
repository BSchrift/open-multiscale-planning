package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

var testNow = time.UnixMilli(1800000000000)

const testSub = "user-sub-1"

type fakeSyncer struct {
	sub     string
	cursor  int64
	changes []sync.Change
	res     sync.Response
	stats   sync.Stats
	err     error
}

func (f *fakeSyncer) Sync(_ context.Context, sub string, cursor int64, changes []sync.Change) (sync.Response, sync.Stats, error) {
	f.sub, f.cursor, f.changes = sub, cursor, changes
	return f.res, f.stats, f.err
}

type fakeCalendar struct {
	sub, state, code string
	url              string
	err              error
}

func (f *fakeCalendar) Connect(_ context.Context, sub string) (string, error) {
	f.sub = sub
	return f.url, f.err
}

func (f *fakeCalendar) Callback(_ context.Context, state, code string) error {
	f.state, f.code = state, code
	return f.err
}

func (f *fakeCalendar) Refresh(_ context.Context, sub string) error {
	f.sub = sub
	return f.err
}

func newServer(syncer Syncer, calendar Calendar) (*Server, *bytes.Buffer) {
	var logs bytes.Buffer
	return &Server{
		Sync: syncer, Calendar: calendar, Log: obs.NewLogger(&logs), Env: "staging",
		Now: func() time.Time { return testNow },
	}, &logs
}

func do(s *Server, method, target, body, sub string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	if sub != "" {
		req = req.WithContext(WithSub(req.Context(), sub))
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func logLine(t *testing.T, logs *bytes.Buffer) map[string]any {
	t.Helper()
	var line map[string]any
	if err := json.Unmarshal(logs.Bytes(), &line); err != nil {
		t.Fatalf("log %q: %v", logs.String(), err)
	}
	return line
}

const goodBody = `{"cursor":3,"changes":[{"type":"task","id":"r1","fields":{"title":{"v":"Write the report","c":"1800000000000-000000-a"}}}]}`

func TestSyncPassesTheTokenSubAndReturnsTheResponse(t *testing.T) {
	syncer := &fakeSyncer{res: sync.Response{Cursor: 9, Changes: []sync.Change{}}}
	s, _ := newServer(syncer, nil)
	// A user id in the body is ignored: the token decides whose data this is.
	rec := do(s, "POST", "/sync", `{"sub":"someone-else","user":"someone-else",`+goodBody[1:], testSub)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if syncer.sub != testSub || syncer.cursor != 3 || len(syncer.changes) != 1 {
		t.Fatalf("%+v", syncer)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != `{"cursor":9,"more":false,"changes":[]}` {
		t.Fatalf("body %s", got)
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("headers %v", rec.Header())
	}
}

func TestProtectedRoutesRefuseWithoutASub(t *testing.T) {
	s, _ := newServer(&fakeSyncer{}, &fakeCalendar{})
	for _, target := range []string{"/sync", "/calendar/connect", "/calendar/refresh"} {
		if rec := do(s, "POST", target, "{}", ""); rec.Code != 401 {
			t.Errorf("%s: %d", target, rec.Code)
		}
	}
}

func TestSyncRejectionsCarryTheCode(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	rec := do(s, "POST", "/sync", `{"changes":[{"type":"task","id":"r1","fields":{"t":{"v":1,"c":"9999999999999-000000-a"}}}]}`, testSub)
	if rec.Code != 400 || strings.TrimSpace(rec.Body.String()) != `{"error":"clock_ahead"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	line := logLine(t, logs)
	if line["error_type"] != "clock_ahead" || line["SyncRequestsRejected"] != float64(1) {
		t.Fatalf("%v", line)
	}
}

func TestSyncRejectsAnOversizedBody(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, nil)
	rec := do(s, "POST", "/sync", `{"pad":"`+strings.Repeat("x", sync.MaxBodyBytes)+`"}`, testSub)
	if rec.Code != 413 || strings.TrimSpace(rec.Body.String()) != `{"error":"request_too_large"}` {
		t.Fatalf("%d %.100s", rec.Code, rec.Body)
	}
	if logLine(t, logs)["SyncRequestsRejected"] != float64(1) {
		t.Fatal("not counted as rejected")
	}
}

func TestSyncErrors(t *testing.T) {
	for name, c := range map[string]struct {
		err      error
		status   int
		code     string
		logged   string
		rejected float64
	}{
		// A conflict is a designed "send it again", not a server fault, so it stays out of the 5xx alarm and isn't a
		// rejection either.
		"conflict":    {sync.ErrConflict, 409, "conflict", "conflict", 0},
		"merged size": {&sync.Rejection{Status: 413, Code: "record_too_large"}, 413, "record_too_large", "record_too_large", 1},
		"anything":    {errors.New("secret detail"), 500, "internal", "internal", 0},
	} {
		t.Run(name, func(t *testing.T) {
			s, logs := newServer(&fakeSyncer{err: c.err}, nil)
			rec := do(s, "POST", "/sync", goodBody, testSub)
			want, _ := json.Marshal(map[string]string{"error": c.code})
			if rec.Code != c.status || strings.TrimSpace(rec.Body.String()) != string(want) {
				t.Fatalf("%d %s", rec.Code, rec.Body)
			}
			if got := logLine(t, logs)["error_type"]; got != c.logged {
				t.Fatalf("error_type %v", got)
			}
			if got := logLine(t, logs)["SyncRequestsRejected"]; got != c.rejected {
				t.Fatalf("SyncRequestsRejected %v", got)
			}
			if strings.Contains(logs.String(), "secret detail") || strings.Contains(rec.Body.String(), "secret detail") {
				t.Fatal("an error's text escaped")
			}
		})
	}
}

func TestSyncLogLine(t *testing.T) {
	syncer := &fakeSyncer{
		res:   sync.Response{Cursor: 9, Changes: []sync.Change{}},
		stats: sync.Stats{Merged: 2, Retries: 1, Pulled: 4},
	}
	s, logs := newServer(syncer, nil)
	req := httptest.NewRequest("POST", "/sync", strings.NewReader(goodBody))
	req = req.WithContext(WithRequestID(WithSub(req.Context(), testSub), "req-1"))
	s.Handler().ServeHTTP(httptest.NewRecorder(), req)

	if strings.Count(logs.String(), "\n") != 1 {
		t.Fatalf("want one line: %s", logs)
	}
	line := logLine(t, logs)
	for key, want := range map[string]any{
		"msg": "request", "request_id": "req-1", "route": "POST /sync", "status": float64(200), "user": obs.HashSub(testSub),
		"changes": float64(1), "pulled": float64(4),
		"SyncRecordsMerged": float64(2), "SyncConflictRetries": float64(1), "SyncRequestsRejected": float64(0),
	} {
		if line[key] != want {
			t.Errorf("%s: got %v, want %v", key, line[key], want)
		}
	}
	if _, ok := line["duration_ms"]; !ok {
		t.Error("no duration")
	}
	aws := line["_aws"].(map[string]any)["CloudWatchMetrics"].([]any)[0].(map[string]any)
	if aws["Namespace"] != "Multiscale/staging" || len(aws["Metrics"].([]any)) != 3 {
		t.Fatalf("%v", aws)
	}
}

func TestLogsNeverCarryValuesTitlesOrTokens(t *testing.T) {
	const marker = "MARKER-do-not-log"
	bodies := map[string]string{
		"accepted":      `{"changes":[{"type":"task","id":"` + marker + `","fields":{"` + marker + `":{"v":"` + marker + `","c":"1800000000000-000000-` + marker + `"}}}]}`,
		"bad type":      `{"changes":[{"type":"` + marker + `","id":"a","fields":{}}]}`,
		"bad clock":     `{"changes":[{"type":"task","id":"a","fields":{"t":{"v":"` + marker + `","c":"` + marker + `"}}}]}`,
		"not even json": marker,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			s, logs := newServer(&fakeSyncer{err: errors.New(marker)}, nil)
			req := httptest.NewRequest("POST", "/sync?token="+marker, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+marker)
			req = req.WithContext(WithSub(req.Context(), marker))
			s.Handler().ServeHTTP(httptest.NewRecorder(), req)
			if logs.Len() == 0 {
				t.Fatal("no log line")
			}
			if strings.Contains(logs.String(), marker) {
				t.Fatalf("leak: %s", logs)
			}
		})
	}
}

func TestCalendarConnect(t *testing.T) {
	calendar := &fakeCalendar{url: "https://consent.example.test/start"}
	s, _ := newServer(&fakeSyncer{}, calendar)
	rec := do(s, "POST", "/calendar/connect", "", testSub)
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"url":"https://consent.example.test/start"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if calendar.sub != testSub {
		t.Fatalf("sub %q", calendar.sub)
	}
}

func TestCalendarRefresh(t *testing.T) {
	calendar := &fakeCalendar{}
	s, _ := newServer(&fakeSyncer{}, calendar)
	if rec := do(s, "POST", "/calendar/refresh", "", testSub); rec.Code != 204 || calendar.sub != testSub {
		t.Fatalf("%d %q", rec.Code, calendar.sub)
	}
}

func TestCalendarCallbackNeedsNoTokenAndChecksItsInput(t *testing.T) {
	calendar := &fakeCalendar{}
	s, logs := newServer(&fakeSyncer{}, calendar)
	rec := do(s, "GET", "/calendar/callback?state=signed-state&code=google-code", "", "")
	if rec.Code != 200 || calendar.state != "signed-state" || calendar.code != "google-code" {
		t.Fatalf("%d %+v", rec.Code, calendar)
	}
	if strings.Contains(logs.String(), "google-code") || strings.Contains(logs.String(), "signed-state") {
		t.Fatalf("leak: %s", logs)
	}
	for _, target := range []string{"/calendar/callback", "/calendar/callback?state=s", "/calendar/callback?code=c", "/calendar/callback?state=s&error=access_denied"} {
		if rec := do(s, "GET", target, "", ""); rec.Code != 400 {
			t.Errorf("%s: %d", target, rec.Code)
		}
	}
}

func TestCalendarCallbackErrors(t *testing.T) {
	cases := map[string]struct {
		err    error
		status int
	}{
		"forged state": {ErrInvalidState, 400},
		"google down":  {errors.New("upstream"), 502},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			s, _ := newServer(&fakeSyncer{}, &fakeCalendar{err: c.err})
			if rec := do(s, "GET", "/calendar/callback?state=s&code=c", "", ""); rec.Code != c.status {
				t.Fatalf("%d", rec.Code)
			}
		})
	}
}

func TestCalendarFailuresAndAbsence(t *testing.T) {
	s, logs := newServer(&fakeSyncer{}, &fakeCalendar{err: errors.New("secret detail")})
	for _, target := range []string{"/calendar/connect", "/calendar/refresh"} {
		if rec := do(s, "POST", target, "", testSub); rec.Code != 502 || strings.Contains(rec.Body.String(), "secret") {
			t.Errorf("%s: %d %s", target, rec.Code, rec.Body)
		}
	}
	if strings.Contains(logs.String(), "secret detail") {
		t.Fatalf("leak: %s", logs)
	}

	bare, _ := newServer(&fakeSyncer{}, nil)
	for method, target := range map[string]string{"POST": "/calendar/connect", "GET": "/calendar/callback?state=s&code=c"} {
		sub := testSub
		if rec := do(bare, method, target, "", sub); rec.Code != 501 {
			t.Errorf("%s: %d", target, rec.Code)
		}
	}
}

func TestUnknownRoutesAndMethods(t *testing.T) {
	s, _ := newServer(&fakeSyncer{}, nil)
	if rec := do(s, "GET", "/nope", "", testSub); rec.Code != 404 {
		t.Errorf("unknown route: %d", rec.Code)
	}
	if rec := do(s, "GET", "/sync", "", testSub); rec.Code != 405 {
		t.Errorf("wrong method: %d", rec.Code)
	}
}
