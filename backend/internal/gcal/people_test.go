package gcal

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

const otherSub = "someone-else"

// legacy turns sub's connection into the deployment's one connection from before: the token in SecretRefreshToken and
// none of their own, with their calendar record and Time blocks as a connection then left them.
func (w *world) legacy(sub string) string {
	w.t.Helper()
	conn := w.conns.conns[sub]
	encoded, _ := json.Marshal(connection{RefreshToken: conn.RefreshToken, Sub: sub})
	w.secrets.values[SecretRefreshToken] = string(encoded)
	delete(w.conns.conns, sub)
	delete(w.conns.holders, conn.Account)
	return conn.RefreshToken
}

func (w *world) linesFor(sub string) []map[string]any {
	var mine []map[string]any
	for _, line := range w.runLines() {
		if line["user"] == obs.HashSub(sub) {
			mine = append(mine, line)
		}
	}
	return mine
}

func (w *world) theirBlock(sub, id, title string, start, end time.Time) {
	w.t.Helper()
	w.write(sub, "task", "task-"+id, map[string]any{"title": title})
	w.write(sub, "time_block", id, map[string]any{"task_id": "task-" + id, "start": instant(start), "end": instant(end), "tz": "UTC"})
}

// One person removing access in Google is theirs alone: their run says so and drops the dead token, without counting
// as the worker failing, and the next person's run goes on as before.
func TestOnePersonsRevokedTokenLeavesTheOthersSyncing(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.connect(otherSub)
	w.fake.Account(googleAccount(testSub)).Revoke()
	w.theirBlock(otherSub, "b2", "Their block", at(1), at(2))

	w.runFor(testSub)
	w.runFor(otherSub)

	rec := w.calendarRecord(testSub)
	if rec["connected"].V != false || rec["last_error"].V != ErrorRevoked {
		t.Fatalf("%+v", rec)
	}
	if line := w.linesFor(testSub)[0]; line["outcome"] != "revoked" || line["CalendarRunFailures"] != float64(0) || line["CalendarRevoked"] != float64(1) {
		t.Fatalf("%+v", line)
	}
	if _, kept := w.conns.conns[testSub]; kept || w.conns.holders[accountID(googleAccount(testSub))] != "" {
		t.Fatal("kept a token Google refused, or its account")
	}
	theirs := w.calendarRecord(otherSub)
	if theirs["connected"].V != true || theirs["last_error"].V != nil {
		t.Fatalf("%+v", theirs)
	}
	if events := w.fake.Events(w.fake.Account(googleAccount(otherSub)).CalendarNamed(CalendarName)); len(events) != 1 {
		t.Fatalf("%+v", events)
	}
	// The schedule no longer starts runs for them.
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	if len(w.queued) != 1 || w.queued[0].Sub != otherSub {
		t.Fatalf("%+v", w.queued)
	}
}

// One person's quota and outage, a refusal or no answer from Google, are theirs: recorded for them, with the one retry
// asked for them alone, while the next person's run goes on.
func TestOnePersonsRateLimitAndOutageLeaveTheOthersAlone(t *testing.T) {
	for name, cut := range map[string]func(*fakes.GoogleAccount, *fakes.Google){
		"rate limit": func(a *fakes.GoogleAccount, _ *fakes.Google) { a.RateLimit(100) },
		"outage": func(a *fakes.GoogleAccount, g *fakes.Google) {
			g.Outage(fakes.GoogleOutage{Account: googleAccount(testSub), Calls: -1, Status: http.StatusServiceUnavailable})
		},
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			var retries []string
			w.g.Retry = func(_ context.Context, sub string, _ time.Duration) error {
				retries = append(retries, sub)
				return nil
			}
			w.connect(testSub)
			w.connect(otherSub)
			cut(w.fake.Account(googleAccount(testSub)), w.fake)
			w.theirBlock(otherSub, "b2", "Their block", at(1), at(2))

			w.runFor(testSub)
			w.runFor(otherSub)

			want := map[string]string{"rate limit": "rate_limited", "outage": "failed"}[name]
			if line := w.linesFor(testSub)[0]; line["outcome"] != want {
				t.Fatalf("%+v", line)
			}
			if w.calendarRecord(testSub)["last_error"].V == nil || w.calendarRecord(testSub)["connected"].V != true {
				t.Fatalf("%+v", w.calendarRecord(testSub))
			}
			if line := w.linesFor(otherSub)[0]; line["outcome"] != "ok" || w.calendarRecord(otherSub)["last_error"].V != nil {
				t.Fatalf("%+v", line)
			}
			if name == "outage" && !slices.Equal(retries, []string{testSub}) {
				t.Fatalf("retries for %v", retries)
			}
		})
	}
}

func TestDispatchStartsEveryConnectedPersonSpreadAcrossTheWindow(t *testing.T) {
	w := newWorld(t)
	for _, sub := range []string{"a", "b", "c", "legacy-person"} {
		w.connect(sub)
	}
	w.legacy("legacy-person")
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	var subs []string
	for _, job := range w.queued {
		subs = append(subs, job.Sub)
		if job.Trigger != "schedule" || job.Delay < 0 || job.Delay >= spreadOver || job.Delay != offset(job.Sub) {
			t.Fatalf("%+v", job)
		}
	}
	if slices.Sort(subs); !slices.Equal(subs, []string{"a", "b", "c", "legacy-person"}) {
		t.Fatalf("%v", subs)
	}
	if offset("a") == offset("b") && offset("b") == offset("c") {
		t.Fatal("no spread")
	}

	// Once the legacy person has a connection of their own, they're started once.
	w.queued = nil
	w.connect("legacy-person")
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	if len(w.queued) != 4 {
		t.Fatalf("%+v", w.queued)
	}
}

func TestDispatchWithNoOneConnectedStillCountsAsTheWorkerRunning(t *testing.T) {
	w := newWorld(t)
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	var line map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(w.logs.String()), "\n") {
		if json.Unmarshal([]byte(raw), &line); line["msg"] == "calendar_dispatch" {
			break
		}
	}
	if line["msg"] != "calendar_dispatch" || line["people"] != float64(0) || line["CalendarEventsChanged"] != float64(0) {
		t.Fatalf("%s", w.logs)
	}
}

func TestWakeStartsOnlyThosePeopleWhoAreConnected(t *testing.T) {
	w := newWorld(t)
	w.connect("a")
	w.connect("legacy-person")
	w.legacy("legacy-person")
	if err := w.g.Wake(context.Background(), []string{"a", "not-connected", "legacy-person"}, "r"); err != nil {
		t.Fatal(err)
	}
	want := []Job{{Sub: "a", Trigger: TriggerStream}, {Sub: "legacy-person", Trigger: TriggerStream}}
	if !slices.Equal(w.queued, want) {
		t.Fatalf("%+v", w.queued)
	}
}

// Until the migration copies it, the deployment's one connection from before keeps working, for the person it names
// and no one else.
func TestTheLegacyConnectionKeepsRunningForItsPersonOnly(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.connect(testSub)
	w.legacy(testSub)
	w.block("b1", "Write the report", at(1), at(2))

	w.run()
	if w.eventFor("b1") == nil || w.calendarRecord(testSub)["connected"].V != true {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
	if line := w.linesFor(testSub)[0]; line["outcome"] != "ok" || line["legacy"] != true {
		t.Fatalf("%+v", line)
	}
	w.runFor(otherSub)
	if line := w.linesFor(otherSub)[0]; line["outcome"] != "not_connected" {
		t.Fatalf("%+v", line)
	}
	if err := w.g.Refresh(ctx, otherSub); err != nil || len(w.triggered) != 1 {
		t.Fatalf("%v %v", err, w.triggered)
	}
	if err := w.g.Refresh(ctx, testSub); err != nil || len(w.triggered) != 2 || w.triggered[1] != testSub {
		t.Fatalf("%v %v", err, w.triggered)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; !ok {
		t.Fatal("the run touched the legacy secret")
	}
}

// Their own connection, once they have one, comes first: the legacy token may be one Google no longer honours.
func TestTheirOwnConnectionComesBeforeTheLegacyOne(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.fake.Revoke()
	w.connect(testSub)
	w.block("b1", "Write the report", at(1), at(2))
	w.run()
	if w.eventFor("b1") == nil || w.calendarRecord(testSub)["last_error"].V != nil {
		t.Fatalf("%+v", w.calendarRecord(testSub))
	}
	// Connecting leaves the legacy secret as it was, so a release rolled back still finds it.
	if _, ok := w.secrets.values[SecretRefreshToken]; !ok {
		t.Fatal("legacy secret gone")
	}
}

// A refused legacy token is recorded as any is, and left for a disconnect to remove: the worker never deletes the
// legacy secret.
func TestARevokedLegacyTokenIsRecordedAndKept(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.fake.Revoke()
	w.run()
	if rec := w.calendarRecord(testSub); rec["last_error"].V != ErrorRevoked || rec["connected"].V != false {
		t.Fatalf("%+v", rec)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; !ok {
		t.Fatal("legacy secret deleted by the worker")
	}
}

// Disconnecting, or deleting the account, ends the legacy connection too when it's theirs, and only then.
func TestDisconnectEndsTheLegacyConnectionWhenItIsTheirs(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.connect(testSub)
	token := w.legacy(testSub)
	if err := w.g.Disconnect(ctx, otherSub); err != nil {
		t.Fatal(err)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; !ok || !w.refreshWorks(token) {
		t.Fatal("another person's disconnect ended it")
	}
	if err := w.g.Disconnect(ctx, testSub); err != nil {
		t.Fatal(err)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; ok || w.refreshWorks(token) || w.timeBlocks() != "" {
		t.Fatal("legacy connection survived its person's disconnect")
	}
}
