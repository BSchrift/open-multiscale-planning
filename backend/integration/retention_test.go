package integration

import (
	"slices"
	"sort"
	"testing"
	"time"

	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

// Retention through the running API, as docs/retention.md describes it: once a record's expiry passes, pulls leave it
// out and the cleanup removes it, so a new device never gets it; a late change can't bring it back; and a device that may
// hold an older copy is reset. It moves the local stack's clock past each period and runs its cleanup, as staging's runs
// every minute. frontend/src/core/retention.stack.test.ts is the deployed suite, with the app's own client.

type expiringRecord struct {
	// deleted, scheduling, closed, or never.
	stage  string
	record record
}

type retentionRun struct {
	t      *testing.T
	a      *account
	policy appconfig.Retention
	start  time.Time
	// The counter before and after everything was written: where a device that has seen none of it, or all of it, is.
	before, after int64
	records       []expiringRecord
	now           func() time.Time
	// pass moves the clock past until and has the cleanup remove what has expired by then.
	pass func(until time.Time)
}

// write pushes one record of each kind, each with the expiry an app gives it, from an app that predates nothing.
func (r *retentionRun) write() {
	a, p := r.a, r.policy
	in := func(period appconfig.Period) string { return instantOf(period.After(r.start)) }
	now, day := instantOf(r.start), r.start.UTC().Format("2006-01-02")
	block, project, task := fresh("block"), fresh("project"), fresh("task")
	r.records = []expiringRecord{
		{"deleted", a.record("task", fresh("deleted"), "kind", "inbox", "title", "Oil the hinges", "deleted_at", now, "expires_at", in(p.Deleted))},
		// Deleted before records had an expiry: the deleted period alone removes it.
		{"deleted", a.record("task", fresh("legacy"), "kind", "inbox", "title", "Sand the boards", "deleted_at", now)},
		{"scheduling", a.record("time_block", block, "task_id", task, "start", instantOf(r.start.Add(-time.Hour)), "end", now, "tz", "UTC", "expires_at", in(p.Scheduling))},
		{"scheduling", a.record("block_outcome", "outcome:"+block, "result", "done", "answered_at", now, "expires_at", in(p.Scheduling))},
		{"scheduling", a.record("week_pick", fresh("pick"), "week_start", day, "task_id", task, "minutes", 30, "expires_at", in(p.Scheduling))},
		{"scheduling", a.record("week_plan", fresh("week"), "week_start", day, "finished_at", now, "expires_at", in(p.Scheduling))},
		{"scheduling", a.record("task_completion", fresh("finish"), "task_id", task, "done_at", now, "expires_at", in(p.Scheduling))},
		{"scheduling", a.record("away_period", fresh("away"), "start", day, "end", day, "expires_at", in(p.Scheduling))},
		{"closed", a.record("task", task, "kind", "one_off", "title", "Paint the fence", "done_at", now, "expires_at", in(p.Closed))},
		{"closed", a.record("project", project, "title", "Rebuild the shed", "state", "finished", "expires_at", in(p.Closed))},
		{"closed", a.record("milestone", fresh("milestone"), "project_id", project, "title", "Walls up", "expires_at", in(p.Closed))},
		{"closed", a.record("objective", fresh("goal"), "title", "Keep the house", "state", "archived", "expires_at", in(p.Closed))},
		{"never", a.record("task", fresh("open"), "kind", "inbox", "title", "Buy brushes")},
		{"never", a.record("project", fresh("active"), "title", "Learn to bake bread", "state", "active")},
		{"never", a.record("practice", fresh("practice"), "title", "Practise piano", "target_min", 30, "per", "day", "state", "active")},
	}
	// So a device can be somewhere before them.
	a.sync(a.startCursor(), a.record("task", fresh("first"), "kind", "inbox", "title", "Wash the brushes"))
	r.before = a.startCursor()
	changes := make([]record, len(r.records))
	for i, e := range r.records {
		changes[i] = e.record
	}
	a.appSync(r.before, changes...)
	r.after = a.startCursor()
	if r.after-r.before != int64(len(changes)) {
		r.t.Fatalf("wrote %d of %d", r.after-r.before, len(changes))
	}
}

// present is which of this run's records a device that has seen none of them still gets.
func (r *retentionRun) present() map[string]bool {
	all, _ := r.a.pullAll(r.before)
	got := map[string]bool{}
	for _, e := range r.records {
		if _, ok := find(all, e.record.Type, e.record.ID); ok {
			got[e.record.ID] = true
		}
	}
	return got
}

func (r *retentionRun) of(stage string) []record {
	var out []record
	for _, e := range r.records {
		if e.stage == stage {
			out = append(out, e.record)
		}
	}
	return out
}

// stages runs each period in the order they end, checking all three things at each.
func (r *retentionRun) stages(only ...string) {
	periods := map[string]appconfig.Period{"deleted": r.policy.Deleted, "scheduling": r.policy.Scheduling, "closed": r.policy.Closed}
	names := []string{"deleted", "scheduling", "closed"}
	sort.SliceStable(names, func(i, j int) bool { return periods[names[i]].After(r.start).Before(periods[names[j]].After(r.start)) })
	for i, name := range names {
		if len(only) > 0 && !slices.Contains(only, name) {
			continue
		}
		r.stage(name, periods[name].After(r.start), names[i+1:])
	}
}

func (r *retentionRun) stage(name string, until time.Time, later []string) {
	t, a := r.t, r.a
	t.Logf("%s: waiting until %s", name, until.Format(time.RFC3339))
	expiring := r.of(name)
	r.pass(until)

	// A device that has seen none of it gets nothing that has expired, and everything that hasn't.
	present := r.present()
	for _, e := range r.records {
		want := e.stage == "never" || slices.Contains(later, e.stage)
		if present[e.record.ID] != want && (e.stage == name || want) {
			t.Fatalf("%s: %s %s present %v, want %v", name, e.record.Type, e.record.ID, present[e.record.ID], want)
		}
	}
	for _, rec := range expiring {
		delete(a.pushed, [2]string{rec.Type, rec.ID})
	}

	// A late change can't bring one back: from an app from before, a change made back then; from a current app, any
	// change, since what it sends carries the expiry that has passed.
	first := expiring[0]
	late := record{first.Type, first.ID, map[string]field{"title": {"Late edit", clockAt(r.start, 999, "late-device")}}}
	a.sync(a.startCursor(), late)
	clock := clockAt(r.now(), 0, "current-device")
	edit := record{first.Type, first.ID, map[string]field{"title": {"Edit after expiry", clock}, "expires_at": first.Fields["expires_at"]}}
	if res := a.appSync(r.after, edit); res.Reset != "" {
		t.Fatalf("%s: a device that has seen everything was reset", name)
	}
	if r.present()[first.ID] {
		t.Fatalf("%s: a late change brought %s back", name, first.ID)
	}
	for _, rec := range []record{late, edit} {
		delete(a.pushed, [2]string{rec.Type, rec.ID})
	}

	// A device that missed a removal is reset rather than merged.
	open := r.of("never")[0]
	res := a.appSync(r.before, record{open.Type, open.ID, map[string]field{"title": {"Not merged", clock}}})
	if res.Reset != "expired" || len(res.Changes) != 0 {
		t.Fatalf("%s: a device behind the mark: %+v", name, res)
	}
	if got, _ := a.get(open.Type, open.ID); valueOf(t, got, "title") != "Buy brushes" {
		t.Fatalf("%s: a reset merged: %+v", name, got)
	}
}

func TestExpiredRecordsGoAndDevicesBehindAreReset(t *testing.T) {
	needs(t, fakeClock)
	clock := holdClock(t)
	a := signIn(t)
	policy, err := appconfig.LoadRetention("local")
	if err != nil {
		t.Fatal(err)
	}
	r := &retentionRun{t: t, a: a, policy: policy, start: clock.now, now: func() time.Time { return clock.now }}
	runCleanup := func() {
		t.Helper()
		if res := request(t, "POST", "/_local/cleanup", "", nil); res.status != 200 {
			t.Fatalf("cleanup: %d %s", res.status, res.body)
		}
	}
	r.pass = func(until time.Time) {
		clock.to(until.Add(time.Second))
		a.reSignIn()
		// Expired but not yet removed, as for the days TTL can take: pulls leave it out already, and a device that may
		// hold an older copy is reset.
		if res := a.appSync(r.before); res.Reset != "expired" {
			t.Fatalf("a device that may hold an expired record: %+v", res)
		}
		// One run marks what has expired, and one at least 30 seconds later removes it.
		runCleanup()
		clock.advance(time.Minute)
		runCleanup()
		a.reSignIn()
	}
	r.write()

	// Nothing goes before its time.
	clock.advance(time.Hour)
	runCleanup()
	clock.advance(time.Minute)
	runCleanup()
	a.reSignIn()
	if got := len(r.present()); got != len(r.records) {
		t.Fatalf("%d of %d left", got, len(r.records))
	}
	if res := a.appSync(r.before, record{"task", fresh("new"), map[string]field{"title": {"x", clockAt(clock.now, 0, "d")}}}); res.Reset != "" {
		t.Fatal("reset with nothing expired")
	}

	r.stages()
}
