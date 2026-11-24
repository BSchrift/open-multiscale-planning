package gcal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/smithy-go"
	"google.golang.org/api/calendar/v3"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
)

// logLines returns the log lines with this msg, parsed.
func (w *world) logLines(msg string) []map[string]any {
	w.t.Helper()
	var lines []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(w.logs.String()), "\n") {
		var line map[string]any
		if json.Unmarshal([]byte(raw), &line) == nil && line["msg"] == msg {
			lines = append(lines, line)
		}
	}
	return lines
}

// googleError answers as the Calendar API does when it refuses a call.
func googleError(status int, reason string) func(http.ResponseWriter) {
	return func(rw http.ResponseWriter) {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(status)
		json.NewEncoder(rw).Encode(map[string]any{"error": map[string]any{
			"code": status, "message": reason, "errors": []map[string]string{{"reason": reason, "message": reason}},
		}})
	}
}

// Google refusing the token itself, invalid_grant from the token endpoint, is the person removing access: their
// connection is marked, its runs stop, and the sealed token stays until they connect again or disconnect.
func TestGoogleRefusingTheTokenMarksTheConnectionAndKeepsIt(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.connect(otherSub)
	w.fake.Revoke()
	w.run()
	conn, kept := w.conns.conns[testSub]
	if !kept || !conn.Revoked || conn.RefreshToken == "" {
		t.Fatalf("%+v %v", conn, kept)
	}
	if rec := w.calendarRecord(testSub); rec["connected"].V != false || rec["last_error"].V != ErrorRevoked {
		t.Fatalf("%+v", rec)
	}
	// The schedule leaves them out, a run of theirs asks Google nothing, and a refresh starts nothing.
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	if len(w.queued) != 1 || w.queued[0].Sub != otherSub {
		t.Fatalf("%+v", w.queued)
	}
	writes := w.fake.Writes()
	w.run()
	if lines := w.linesFor(testSub); lines[len(lines)-1]["outcome"] != "revoked" || w.fake.Writes() != writes {
		t.Fatalf("%+v", lines[len(lines)-1])
	}
	w.triggered = nil
	if err := w.g.Refresh(context.Background(), testSub); err != nil || len(w.triggered) != 0 {
		t.Fatalf("%v %v", err, w.triggered)
	}
	// Connecting again starts afresh.
	w.connect(testSub)
	w.run()
	if conn := w.conns.conns[testSub]; conn.Revoked || w.calendarRecord(testSub)["connected"].V != true {
		t.Fatalf("%+v", conn)
	}
}

// A 401 from the Calendar API, after Google has just honoured the token, isn't the token refused: the run fails, the
// connection stays as it is, and the next run tries again.
func TestA401FromTheCalendarAPILeavesTheConnection(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.failCalendarAPI(1, googleError(http.StatusUnauthorized, "authError"))
	w.run()
	if conn := w.conns.conns[testSub]; conn.Revoked || conn.RefreshToken == "" {
		t.Fatalf("%+v", conn)
	}
	if line := w.linesFor(testSub)[0]; line["outcome"] != "failed" {
		t.Fatalf("%+v", line)
	}
	w.run()
	if w.calendarRecord(testSub)["last_error"].V != nil || w.calendarRecord(testSub)["connected"].V != true {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
}

// Google refusing one person for good, for a permission they unticked, their quota or their organisation's policy, is
// theirs: counted apart from the worker's failures.
func TestAPersonsLastingRefusalIsTheirsNotAFailure(t *testing.T) {
	for name, c := range map[string]struct {
		fail    func(http.ResponseWriter)
		outcome string
		code    string
	}{
		"a permission unticked": {googleError(http.StatusForbidden, "insufficientPermissions"), "refused", ErrorRevoked},
		"their quota":           {googleError(http.StatusForbidden, "quotaExceeded"), "rate_limited", ErrorRateLimited},
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.connect(testSub)
			w.failCalendarAPI(1, c.fail)
			w.run()
			line := w.linesFor(testSub)[0]
			if line["outcome"] != c.outcome || line["CalendarRunFailures"] != float64(0) || w.calendarRecord(testSub)["last_error"].V != c.code {
				t.Fatalf("%+v", line)
			}
		})
	}
	t.Run("their organisation's policy", func(t *testing.T) {
		w := newWorld(t)
		w.connect(testSub)
		w.intercept(func(rw http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path != "/token" {
				return false
			}
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(http.StatusBadRequest)
			rw.Write([]byte(`{"error":"admin_policy_enforced"}`))
			return true
		})
		w.run()
		if line := w.linesFor(testSub)[0]; line["outcome"] != "refused" || line["CalendarRunFailures"] != float64(0) {
			t.Fatalf("%+v", line)
		}
		if conn := w.conns.conns[testSub]; conn.Revoked {
			t.Fatal("marked revoked for a policy an admin can change")
		}
	})
}

// A consent with one of the three permissions unticked is refused before anything is made or stored.
func TestACallbackWithAPermissionUntickedIsRefused(t *testing.T) {
	w := newWorld(t)
	w.fake.Account(googleAccount(testSub)).Withhold(Scopes[1])
	state, code := w.consent(testSub)
	if err := w.g.Callback(context.Background(), state, code); !errors.Is(err, api.ErrScopesMissing) {
		t.Fatalf("%v", err)
	}
	if w.storedToken(testSub) != "" || w.fake.Writes() != 0 {
		t.Fatal("stored or made something")
	}
}

// A connection that won't decrypt never locks its person out: they can disconnect, which deletes it without the revoke
// it can't make, connect again, and refresh.
func TestAConnectionThatWontDecryptDoesntLockItsPersonOut(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.connect(testSub)
	w.conns.unreadable = map[string]bool{testSub: true}
	w.triggered = nil
	if err := w.g.Refresh(ctx, testSub); err != nil || len(w.triggered) != 1 {
		t.Fatalf("refresh: %v %v", err, w.triggered)
	}
	w.connect(testSub)
	w.conns.unreadable = map[string]bool{testSub: true}
	if err := w.g.Disconnect(ctx, testSub); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if _, kept := w.conns.conns[testSub]; kept || len(w.conns.holders) != 0 {
		t.Fatal("kept the unreadable connection or its account")
	}
	if lines := w.logLines("calendar_disconnect"); len(lines) != 1 || !strings.Contains(fmtAny(lines[0]["google_failed"]), "unreadable") {
		t.Fatalf("%s", w.logs)
	}
}

// A connection made while a disconnect runs, by the migration's copy or a consent, goes too: the disconnect goes round.
func TestADisconnectGoesRoundForAConnectionMadeWhileItRan(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	token := w.legacy(testSub)
	w.g.Secrets = &hookedSecrets{memSecrets: w.secrets, onDelete: func() {
		w.conns.Put(context.Background(), connection{RefreshToken: token, Sub: testSub, Account: accountID(googleAccount(testSub))}, connection{})
	}}
	if err := w.g.Disconnect(context.Background(), testSub); err != nil {
		t.Fatal(err)
	}
	if _, kept := w.conns.conns[testSub]; kept || w.calendarRecord(testSub)["connected"].V != false {
		t.Fatal("a connection made during the disconnect survived it")
	}
}

type hookedSecrets struct {
	*memSecrets
	onDelete func()
	once     bool
}

func (h *hookedSecrets) Delete(ctx context.Context, name string) error {
	err := h.memSecrets.Delete(ctx, name)
	if !h.once {
		h.once = true
		h.onDelete()
	}
	return err
}

// A consent racing another of the same person's is stored over the connection it read, and goes round if that changed.
func TestACallbackStoresOverOnlyTheConnectionItRead(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	state, code := w.consent(testSub)
	raced := false
	w.g.Connections = racingConnections{w.conns, func() {
		if !raced {
			raced = true
			w.conns.Put(context.Background(), connection{RefreshToken: "another-consent", Sub: testSub, Account: accountID(googleAccount(testSub))}, w.conns.conns[testSub])
		}
	}}
	if err := w.g.Callback(context.Background(), state, code); err != nil {
		t.Fatal(err)
	}
	if got := w.storedToken(testSub); got == "another-consent" || got == "" {
		t.Fatalf("%q", got)
	}
}

// A failure in AWS names its code in the run's line, so the log says what failed without saying any value.
func TestARunsFailureNamesTheAWSErrorCode(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.conns.failing = &smithy.GenericAPIError{Code: "AccessDeniedException", Message: "not allowed"}
	w.g.Run(context.Background(), testSub, "schedule", "r")
	if line := w.linesFor(testSub)[0]; line["aws_error"] != "AccessDeniedException" || line["outcome"] != "failed" {
		t.Fatalf("%+v", line)
	}
}

func fmtAny(v any) string { b, _ := json.Marshal(v); return string(b) }

var _ = calendar.Event{}
var _ = fakes.DefaultGoogleAccount

// countingSecrets counts reads of each secret.
type countingSecrets struct {
	*memSecrets
	reads map[string]int
}

func (c *countingSecrets) Get(ctx context.Context, name string) (string, error) {
	c.reads[name]++
	return c.memSecrets.Get(ctx, name)
}

// When the connections can't be read, the schedule and the stream fail, so the Lambda's error alarm sees it, rather than
// quietly starting no one.
func TestDispatchAndWakeFailWhenConnectionsCantBeRead(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.conns.failing = &smithy.GenericAPIError{Code: "ProvisionedThroughputExceededException"}
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err == nil {
		t.Fatal("dispatch swallowed it")
	}
	if err := w.g.Wake(context.Background(), []string{testSub}, "r"); err == nil {
		t.Fatal("wake swallowed it")
	}
	if len(w.queued) != 0 {
		t.Fatalf("%+v", w.queued)
	}
}

// A connection that won't open, with no legacy one to fall back to, asks its person to connect again, once: it's marked,
// so its runs stop failing.
func TestAnUnreadableConnectionWithNoFallbackAsksToConnectAgain(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.conns.unreadable = map[string]bool{testSub: true}
	w.run()
	if rec := w.calendarRecord(testSub); rec["connected"].V != false || rec["last_error"].V != ErrorRevoked {
		t.Fatalf("%+v", rec)
	}
	if line := w.linesFor(testSub)[0]; line["outcome"] != "unreadable" || line["CalendarRunFailures"] != float64(1) {
		t.Fatalf("%+v", line)
	}
	if !w.conns.conns[testSub].Revoked {
		t.Fatal("not marked")
	}
	w.run()
	if line := w.linesFor(testSub)[1]; line["outcome"] != "revoked" || line["CalendarRunFailures"] != float64(0) {
		t.Fatalf("ran again: %+v", line)
	}
	// Connecting again starts afresh.
	w.conns.unreadable = nil
	w.connect(testSub)
	w.run()
	if w.calendarRecord(testSub)["connected"].V != true {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
}

// A refused consent's log line names the permissions left unticked, which name nothing about the person.
func TestAConsentWithAPermissionUntickedLogsWhich(t *testing.T) {
	w := newWorld(t)
	w.fake.Account(googleAccount(testSub)).Withhold(Scopes[2])
	state, code := w.consent(testSub)
	w.g.Callback(context.Background(), state, code)
	lines := w.logLines("calendar_connect_refused")
	if len(lines) != 1 || fmtAny(lines[0]["missing"]) != fmtAny([]string{Scopes[2]}) {
		t.Fatalf("%s", w.logs)
	}
}
