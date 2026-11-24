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

// One person removing access in Google is theirs alone: their run says so and marks their connection, without counting
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
	if conn := w.conns.conns[testSub]; !conn.Revoked {
		t.Fatal("not marked revoked")
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
	for _, sub := range []string{"a", "b", "c", "d"} {
		w.connect(sub)
	}
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
	if slices.Sort(subs); !slices.Equal(subs, []string{"a", "b", "c", "d"}) {
		t.Fatalf("%v", subs)
	}
	if offset("a") == offset("b") && offset("b") == offset("c") {
		t.Fatal("no spread")
	}
}

// The legacy connection, once its person has their own, goes; one whose person has none is never lost.
func TestTheScheduleRetiresTheLegacyConnectionOnceItsPersonHasTheirOwn(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; !ok {
		t.Fatal("deleted a legacy connection its person had no copy of")
	}
	if len(w.queued) != 0 {
		t.Fatalf("the legacy connection still runs: %+v", w.queued)
	}
	w.connect(testSub)
	if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
		t.Fatal(err)
	}
	if _, ok := w.secrets.values[SecretRefreshToken]; ok {
		t.Fatal("kept a legacy connection its person has their own of")
	}
	var outcomes []any
	for _, raw := range strings.Split(strings.TrimSpace(w.logs.String()), "\n") {
		var line map[string]any
		if json.Unmarshal([]byte(raw), &line); line["msg"] == "calendar_legacy_retirement" {
			outcomes = append(outcomes, line["outcome"], line["CalendarLegacyUnmigrated"])
		}
	}
	if !slices.Equal(outcomes, []any{"kept_unmigrated", float64(1), "retired", float64(0)}) {
		t.Fatalf("%v", outcomes)
	}
	if w.storedToken(testSub) == "" {
		t.Fatal("their own connection went too")
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
	w.connect("b")
	if err := w.g.Wake(context.Background(), []string{"a", "not-connected", "b"}, "r"); err != nil {
		t.Fatal(err)
	}
	want := []Job{{Sub: "a", Trigger: TriggerStream}, {Sub: "b", Trigger: TriggerStream}}
	if !slices.Equal(w.queued, want) {
		t.Fatalf("%+v", w.queued)
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
