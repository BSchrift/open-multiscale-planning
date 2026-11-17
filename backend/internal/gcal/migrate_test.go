package gcal

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
)

func (w *world) migrate() string {
	w.t.Helper()
	outcome, _ := w.g.MigrateLegacy(context.Background(), "r")
	return outcome
}

// migrationLines are the migration's log lines, parsed.
func (w *world) migrationLines() []map[string]any {
	w.t.Helper()
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(w.logs.String()), "\n") {
		var decoded map[string]any
		if json.Unmarshal([]byte(line), &decoded) == nil && decoded["msg"] == "calendar_legacy_migration" {
			lines = append(lines, decoded)
		}
	}
	return lines
}

func (w *world) legacySecret() (connection, bool) {
	raw, ok := w.secrets.values[SecretRefreshToken]
	var conn connection
	json.Unmarshal([]byte(raw), &conn)
	return conn, ok
}

// The deployment's one connection from before becomes its person's own: sealed for them, claiming its Google account,
// verified with Google, and the legacy secret left where it was.
func TestMigrationCopiesTheLegacyConnectionAndKeepsTheSecret(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	token := w.legacy(testSub)
	if got := w.migrate(); got != migrationMigrated {
		t.Fatalf("%s", got)
	}
	conn := w.conns.conns[testSub]
	if conn.RefreshToken != token || conn.Account != accountID(fakes.DefaultGoogleAccount) || w.conns.holders[conn.Account] != testSub {
		t.Fatalf("%+v", conn)
	}
	if legacy, ok := w.legacySecret(); !ok || legacy.RefreshToken != token || legacy.Sub != testSub {
		t.Fatal("legacy secret changed")
	}
	line := w.migrationLines()[0]
	if line["outcome"] != migrationMigrated || line["CalendarLegacyUnmigrated"] != float64(0) {
		t.Fatalf("%+v", line)
	}
	for _, leak := range []string{token, testSub, fakes.DefaultGoogleAccount} {
		if strings.Contains(w.logs.String(), leak) {
			t.Fatalf("%q logged", leak)
		}
	}
}

func TestMigrationWithNoLegacyConnectionDoesNothing(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	before := w.conns.conns[testSub]
	if got := w.migrate(); got != migrationNone {
		t.Fatalf("%s", got)
	}
	if string(w.conns.conns[testSub].sealed) != string(before.sealed) {
		t.Fatal("touched a connection")
	}
}

// Run twice, or two at once, it makes one copy, and reports each time that the copy is good.
func TestMigrationRunsTwiceAndBesideItself(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	token := w.legacy(testSub)
	var wg gosync.WaitGroup
	outcomes := make([]string, 4)
	for i := range outcomes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outcomes[i], _ = w.g.MigrateLegacy(context.Background(), "r")
		}()
	}
	wg.Wait()
	for _, got := range outcomes {
		if got != migrationMigrated {
			t.Fatalf("%v", outcomes)
		}
	}
	if got := w.migrate(); got != migrationMigrated || w.conns.conns[testSub].RefreshToken != token || len(w.conns.conns) != 1 {
		t.Fatalf("%s %+v", got, w.conns.conns)
	}
}

// A step cut off before Google confirmed the copy reports it unmigrated, leaves a true copy, and the next one verifies it.
func TestAnInterruptedMigrationIsFinishedByTheNext(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	token := w.legacy(testSub)
	// The copy's own Google call gets through; the verifying refresh doesn't, in either of the ways oauth2 tries it.
	w.fake.Outage(fakes.GoogleOutage{Token: true, After: 1, Calls: 2, Status: http.StatusServiceUnavailable})
	if got := w.migrate(); got != migrationUnverified {
		t.Fatalf("%s", got)
	}
	if line := w.migrationLines()[0]; line["CalendarLegacyUnmigrated"] != float64(1) {
		t.Fatalf("%+v", line)
	}
	if w.conns.conns[testSub].RefreshToken != token {
		t.Fatal("no true copy left")
	}
	if got := w.migrate(); got != migrationMigrated {
		t.Fatalf("%s", got)
	}
}

// A consent of theirs since the legacy one is newer: it stays, and the legacy one is no longer needed.
func TestMigrationLeavesTheirNewerConnection(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.connect(testSub)
	newer := w.conns.conns[testSub]
	if got := w.migrate(); got != migrationSuperseded {
		t.Fatalf("%s", got)
	}
	if string(w.conns.conns[testSub].sealed) != string(newer.sealed) {
		t.Fatal("replaced their newer connection")
	}
}

func TestMigrationCopiesNoTokenGoogleRefuses(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.fake.Revoke()
	if got := w.migrate(); got != migrationRevoked {
		t.Fatalf("%s", got)
	}
	if _, copied := w.conns.conns[testSub]; copied {
		t.Fatal("copied a dead token")
	}
	if _, ok := w.legacySecret(); !ok {
		t.Fatal("legacy secret deleted")
	}
}

// Someone else connected the legacy person's Google account since: it isn't taken from them, and the fallback keeps the
// legacy person syncing.
func TestMigrationWontTakeAGoogleAccountSomeoneElseHas(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	w.connectAs(otherSub, googleAccount(testSub))
	if got := w.migrate(); got != migrationAccountTaken {
		t.Fatalf("%s", got)
	}
	if _, copied := w.conns.conns[testSub]; copied || w.conns.holders[accountID(googleAccount(testSub))] != otherSub {
		t.Fatal("took the account")
	}
}

// hookedConnections runs a step of a test's at a set point inside a migration.
type hookedConnections struct {
	*memConnections
	beforeHolder, afterPutNew func()
}

func (h hookedConnections) Holder(ctx context.Context, account string) (string, error) {
	if h.beforeHolder != nil {
		h.beforeHolder()
	}
	return h.memConnections.Holder(ctx, account)
}

func (h hookedConnections) PutNew(ctx context.Context, conn connection) error {
	err := h.memConnections.PutNew(ctx, conn)
	if h.afterPutNew != nil {
		h.afterPutNew()
	}
	return err
}

// A disconnect at any point while the step runs stays a disconnect: the copy doesn't connect them again.
func TestADisconnectDuringMigrationIsNotUndone(t *testing.T) {
	for name, at := range map[string]func(h *hookedConnections, disconnect func()){
		"before the copy": func(h *hookedConnections, disconnect func()) { h.beforeHolder = disconnect },
		"after the copy":  func(h *hookedConnections, disconnect func()) { h.afterPutNew = disconnect },
	} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.connect(testSub)
			w.legacy(testSub)
			hooked := &hookedConnections{memConnections: w.conns}
			once := gosync.Once{}
			at(hooked, func() {
				once.Do(func() {
					if err := w.g.Disconnect(context.Background(), testSub); err != nil {
						t.Fatal(err)
					}
				})
			})
			w.g.Connections = hooked
			if got := w.migrate(); got != migrationDisconnected {
				t.Fatalf("%s", got)
			}
			if _, kept := w.conns.conns[testSub]; kept {
				t.Fatal("connected again")
			}
			if w.calendarRecord(testSub)["connected"].V != false {
				t.Fatalf("%+v", w.calendarRecord(testSub))
			}
		})
	}
}

// From a deployment holding only the legacy connection, through a migration cut off partway and one that finishes, the
// person's sync never stops: the same Time blocks, no second one, no consent asked again, their calendars still read.
func TestSyncCarriesOnUnchangedThroughTheMigration(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	mine := w.fake.Account(googleAccount(testSub))
	mine.AddCalendar("home", "Home")
	w.run()
	timeBlocks := w.calendarRecord(testSub)["calendar_id"].V
	triggers := len(w.triggered)
	// Each step is a schedule, which migrates first, then the person's run, or only a run.
	step := func(name string, schedule bool) {
		t.Helper()
		w.now = w.now.Add(time.Minute)
		w.block(name, name, at(1), at(2))
		if schedule {
			if err := w.g.Dispatch(context.Background(), "schedule", "r"); err != nil {
				t.Fatal(err)
			}
		}
		w.run()
		rec := w.calendarRecord(testSub)
		if rec["connected"].V != true || rec["last_error"].V != nil || rec["calendar_id"].V != timeBlocks || w.eventFor(name) == nil {
			t.Fatalf("%s: %+v", name, rec)
		}
		if _, ok := w.sources()["home"]; !ok {
			t.Fatalf("%s: calendars no longer read", name)
		}
	}
	step("before", false)
	if line := w.runLines()[len(w.runLines())-1]; line["legacy"] != true {
		t.Fatalf("not the legacy connection: %+v", line)
	}
	w.fake.Outage(fakes.GoogleOutage{Token: true, After: 1, Calls: 2, Status: http.StatusServiceUnavailable})
	if got := w.migrate(); got != migrationUnverified {
		t.Fatalf("%s", got)
	}
	step("cut-off", false)
	step("finished", true)
	step("after", true)
	if got := w.migrationLines(); got[len(got)-1]["outcome"] != migrationMigrated {
		t.Fatalf("%+v", got[len(got)-1])
	}
	if _, ok := w.legacySecret(); !ok || w.conns.conns[testSub].RefreshToken == "" {
		t.Fatal("legacy secret gone or no copy")
	}
	if mine.CalendarNamed(CalendarName) != timeBlocks || len(w.triggered) != triggers {
		t.Fatal("a second Time blocks, or a consent asked again")
	}
}

// A consent of theirs landing while the step runs is newer than the copy, and the copy never replaces it.
func TestAConsentDuringMigrationIsNotReplaced(t *testing.T) {
	w := newWorld(t)
	w.connect(testSub)
	w.legacy(testSub)
	// Not a sync.Once: the consent's own check of the account comes through the hook too.
	consented := false
	w.g.Connections = hookedConnections{memConnections: w.conns, beforeHolder: func() {
		if !consented {
			consented = true
			w.connect(testSub)
		}
	}}
	if got := w.migrate(); got != migrationSuperseded {
		t.Fatalf("%s", got)
	}
	if legacy, _ := w.legacySecret(); w.conns.conns[testSub].RefreshToken == legacy.RefreshToken {
		t.Fatal("the copy replaced their newer connection")
	}
}
