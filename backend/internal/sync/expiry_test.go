package sync_test

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	msync "github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	"github.com/BSchrift/open-multiscale-planning/config"
)

var expiryNow = time.Date(2030, 6, 1, 12, 0, 0, 0, time.UTC)

// expiringStore is a store that leaves expired records out, as the API's does, and the cleanup on its table, both on a
// clock the test moves.
func expiringStore(t *testing.T) (*msync.Store, *msync.Cleanup, *time.Time, *dynamodb.Client) {
	t.Helper()
	s, client := newStore(t)
	deleted, err := config.ParsePeriod("P30D")
	if err != nil {
		t.Fatal(err)
	}
	now := expiryNow
	clockNow := func() time.Time { return now }
	s.Expiry = &msync.Expiry{Now: clockNow, Deleted: deleted}
	cleanup := &msync.Cleanup{DB: client, Table: s.Table, Now: clockNow, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: "test"}
	return s, cleanup, &now, client
}

func at(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z") }

func fresh(now time.Time, device string) string { return clock(now.UnixMilli(), device) }

func lowest(device string) string { return clock(0, device) }

func ids(changes []msync.Change) []string {
	var out []string
	for _, c := range changes {
		out = append(out, c.ID)
	}
	slices.Sort(out)
	return out
}

// device syncs as an app that takes a reset for expired records. mustSync is one from before.
func device(t *testing.T, s *msync.Store, user string, cursor int64, changes ...msync.Change) msync.Response {
	t.Helper()
	res, _, err := s.Sync(context.Background(), user, msync.Request{Cursor: cursor, Changes: changes, ExpiryReset: true})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func item(t *testing.T, client *dynamodb.Client, table, user, sk string) map[string]types.AttributeValue {
	t.Helper()
	out, err := client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(table), ConsistentRead: aws.Bool(true),
		Key: map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "user#" + user}, "sk": &types.AttributeValueMemberS{Value: sk}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return out.Item
}

func num(t *testing.T, value types.AttributeValue) int64 {
	t.Helper()
	n, ok := value.(*types.AttributeValueMemberN)
	if !ok {
		t.Fatalf("not a number: %#v", value)
	}
	v, err := strconv.ParseInt(n.Value, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func cleanUp(t *testing.T, c *msync.Cleanup) msync.CleanupStats {
	t.Helper()
	stats, err := c.Run(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	return stats
}

func TestEveryWriteCarriesTheExpiryAsTheTTLAttribute(t *testing.T) {
	s, _, now, client := expiringStore(t)
	c := fresh(*now, "a")
	expires := now.AddDate(2, 0, 0)
	mustSync(t, s, "abc", 0,
		msync.Change{Type: "time_block", ID: "b1", Fields: msync.Fields{"end": {V: at(*now), C: c}, "expires_at": {V: at(expires), C: c}}},
		task("open", title("Paint the fence", c)),
		// Deleted by an app from before expiry: deleted_at sets it.
		task("deleted", msync.Fields{"title": {V: "Oil the hinges", C: c}, "deleted_at": {V: at(*now), C: c}}),
	)
	if got := num(t, item(t, client, s.Table, "abc", "rec#time_block#b1")["expires_at"]); got != expires.Unix() {
		t.Fatalf("ttl %d", got)
	}
	if _, ok := item(t, client, s.Table, "abc", "rec#task#open")["expires_at"]; ok {
		t.Fatal("an open task got a TTL")
	}
	if got := num(t, item(t, client, s.Table, "abc", "rec#task#deleted")["expires_at"]); got != now.AddDate(0, 0, 30).Unix() {
		t.Fatalf("ttl %d", got)
	}
	// Cleared, as when a closed record is opened again, the attribute goes.
	mustSync(t, s, "abc", 3, msync.Change{Type: "time_block", ID: "b1", Fields: msync.Fields{"expires_at": {V: nil, C: fresh(now.Add(time.Second), "a")}}})
	if _, ok := item(t, client, s.Table, "abc", "rec#time_block#b1")["expires_at"]; ok {
		t.Fatal("a cleared expiry kept its TTL")
	}
}

func TestPullsLeaveOutWhatHasExpiredAndResetADeviceThatMayHoldIt(t *testing.T) {
	s, _, now, _ := expiringStore(t)
	c := fresh(*now, "a")
	mustSync(t, s, "abc", 0, task("keep", title("Paint the fence", c)))
	device(t, s, "abc", 1, task("closing", msync.Fields{"title": {V: "Oil the hinges", C: c}, "expires_at": {V: at(now.Add(time.Hour)), C: c}}))
	device(t, s, "abc", 2, task("later", title("Sand the boards", c)))
	*now = now.Add(2 * time.Hour)

	// A new device gets everything but it, and its cursor moves past it.
	res := device(t, s, "abc", 0)
	if got := ids(res.Changes); !slices.Equal(got, []string{"keep", "later"}) || res.Cursor != 3 || res.Reset != "" {
		t.Fatalf("%+v", res)
	}
	// One that synced before its last write may hold an older copy, so it pulls everything instead.
	if res := device(t, s, "abc", 1); res.Reset != msync.ResetExpired || len(res.Changes) != 0 {
		t.Fatalf("%+v", res)
	}
	if res := device(t, s, "abc", 2); res.Reset != "" {
		t.Fatalf("%+v", res)
	}
	// An app from before can't take a reset, and just doesn't get it.
	if res := mustSync(t, s, "abc", 1); res.Reset != "" || !slices.Equal(ids(res.Changes), []string{"later"}) || res.Cursor != 3 {
		t.Fatalf("%+v", res)
	}
}

func TestADeviceBehindTheMarkIsResetAndNothingMerges(t *testing.T) {
	s, _, now, client := expiringStore(t)
	c := fresh(*now, "a")
	mustSync(t, s, "abc", 0, task("keep", title("Paint the fence", c)))
	mustSync(t, s, "abc", 1, task("gone", title("Oil the hinges", c)))
	// What the Streams consumer does once TTL removes record 2.
	if err := msync.RaiseMark(context.Background(), client, s.Table, "user#abc", 2, *now); err != nil {
		t.Fatal(err)
	}

	edit := task("keep", title("Paint the gate", fresh(*now, "b")))
	res := device(t, s, "abc", 1, edit)
	if res.Reset != msync.ResetExpired || len(res.Changes) != 0 || res.Cursor != 0 {
		t.Fatalf("%+v", res)
	}
	if got := mustSync(t, s, "abc", 0).Changes; got[0].Fields["title"].V != "Paint the fence" {
		t.Fatalf("a reset merged: %+v", got)
	}
	// Its pull from 0 is answered, and so is a device that has seen everything.
	if res := device(t, s, "abc", 0); res.Reset != "" || len(res.Changes) != 2 {
		t.Fatalf("%+v", res)
	}
	if res := device(t, s, "abc", 2, edit); res.Reset != "" {
		t.Fatalf("%+v", res)
	}
	// An app from before merges, with the checks for stale changes.
	if res, _, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 1}); err != nil || res.Reset != "" {
		t.Fatalf("%+v %v", res, err)
	}
	// At 0 with something to send is behind too.
	if res := device(t, s, "abc", 0, task("new", title("x", fresh(*now, "c")))); res.Reset != msync.ResetExpired {
		t.Fatalf("%+v", res)
	}
}

func TestMarksOnlyGoUp(t *testing.T) {
	s, _, now, client := expiringStore(t)
	for _, seq := range []int64{5, 9, 3} {
		if err := msync.RaiseMark(context.Background(), client, s.Table, "user#abc", seq, *now); err != nil {
			t.Fatal(err)
		}
	}
	if got := num(t, item(t, client, s.Table, "abc", "meta#expired")["value"]); got != 9 {
		t.Fatalf("mark %d", got)
	}
}

func TestChangesThatWouldBringBackAnExpiredRecordAreDropped(t *testing.T) {
	s, _, now, _ := expiringStore(t)
	ctx := context.Background()
	old := clock(now.AddDate(0, 0, -31).UnixMilli(), "late")
	recent := fresh(now.Add(-time.Minute), "a")
	device(t, s, "abc", 0,
		task("expired", msync.Fields{"title": {V: "x", C: recent}, "expires_at": {V: at(now.Add(-time.Second)), C: recent}}),
		task("held", title("Held", old)),
	)
	if got := ids(mustSync(t, s, "abc", 0).Changes); !slices.Equal(got, []string{"held"}) {
		t.Fatalf("a record arriving expired was kept: %v", got)
	}

	push := func(who string, change msync.Change) msync.Stats {
		t.Helper()
		// A cursor above the counter is answered with it.
		cursor := mustSync(t, s, "abc", 1<<62).Cursor
		_, stats, err := s.Sync(ctx, "abc", msync.Request{Cursor: cursor, Changes: []msync.Change{change}, ExpiryReset: who == "device"})
		if err != nil {
			t.Fatal(err)
		}
		return stats
	}
	device(t, s, "abc", 1, task("closed", msync.Fields{"title": {V: "y", C: recent}, "expires_at": {V: at(now.Add(time.Minute)), C: recent}}))
	*now = now.Add(time.Hour)
	// In this order: the restore last, since it brings the record back.
	for _, c := range []struct {
		name   string
		who    string
		change msync.Change
		kept   bool
	}{
		{"an edit to a record that has expired", "device", task("closed", title("edited", fresh(*now, "b"))), false},
		{"the same from an older app", "old", task("closed", title("edited", fresh(*now, "b"))), false},
		{"an older app's late change to a removed record", "old", task("removed", title("late", old)), false},
		{"an older app's change to a new record", "old", task("new-old", title("new", fresh(*now, "c"))), true},
		{"a late change to a record still here", "old", task("held", map[string]msync.Field{"note": {V: "late", C: old}}), true},
		{"a device that takes resets is trusted on clocks", "device", task("new-device", title("new", old)), true},
		{"a new record that arrives with its expiry passed", "device", task("arrived", msync.Fields{"expires_at": {V: at(now.Add(-time.Minute)), C: fresh(*now, "d")}}), false},
		{"an old delete from an older app", "old", task("tombstone", msync.Fields{"deleted_at": {V: at(now.AddDate(0, 0, -31)), C: fresh(*now, "e")}}), false},
		{"an expiry alone for a record that isn't here", "device", task("removed", msync.Fields{"expires_at": {V: at(now.Add(time.Hour)), C: fresh(*now, "f")}}), false},
		{"a restore that clears the expiry", "device", task("closed", msync.Fields{"expires_at": {V: nil, C: fresh(*now, "b")}}), true},
	} {
		stats := push(c.who, c.change)
		if kept := stats.Merged == 1; kept != c.kept || stats.Dropped != map[bool]int{true: 0, false: 1}[c.kept] {
			t.Errorf("%s: %+v", c.name, stats)
		}
	}
	// The calendar worker's own writes never expire, and aren't checked for old clocks.
	if stats, err := s.Push(ctx, "abc", 0, []msync.Change{{Type: "calendar", ID: "calendar", Fields: msync.Fields{"connected": {V: true, C: old}}}}); err != nil || stats.Merged != 1 {
		t.Fatalf("%+v %v", stats, err)
	}
}

func TestAnAppFillingInExpiriesMovesNoSequenceNumbers(t *testing.T) {
	s, _, now, client := expiringStore(t)
	c := fresh(*now, "a")
	mustSync(t, s, "abc", 0,
		task("done", msync.Fields{"title": {V: "Paint the fence", C: c}, "done_at": {V: at(*now), C: c}}),
		task("gone", msync.Fields{"title": {V: "Oil the hinges", C: c}}),
		task("has", msync.Fields{"title": {V: "Sand the boards", C: c}, "expires_at": {V: at(now.AddDate(5, 0, 0)), C: c}}),
	)
	// Every app fills in what it held before records had an expiry, with the lowest clock. One for a record deleted long
	// ago has already passed, and still goes in, so TTL removes the record.
	_, stats, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 3, ExpiryReset: true, Changes: []msync.Change{
		task("done", msync.Fields{"expires_at": {V: at(now.AddDate(5, 0, 0)), C: lowest("a")}}),
		task("gone", msync.Fields{"expires_at": {V: at(now.AddDate(0, 0, -1)), C: lowest("a")}}),
		task("has", msync.Fields{"expires_at": {V: at(now.AddDate(1, 0, 0)), C: lowest("a")}}),
		task("unknown", msync.Fields{"expires_at": {V: at(now.AddDate(1, 0, 0)), C: lowest("a")}}),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Filled != 2 || stats.Merged != 0 || stats.Dropped != 1 || mustSync(t, s, "abc", 1<<62).Cursor != 3 {
		t.Fatalf("%+v", stats)
	}
	done := item(t, client, s.Table, "abc", "rec#task#done")
	if num(t, done["seq"]) != 1 || num(t, done["expires_at"]) != now.AddDate(5, 0, 0).Unix() {
		t.Fatalf("%+v", done)
	}
	if got := mustSync(t, s, "abc", 0).Changes; got[0].Fields["expires_at"].C != lowest("a") || got[0].Fields["title"].V != "Paint the fence" {
		t.Fatalf("%+v", got)
	}
	if got := ids(device(t, s, "abc", 0).Changes); !slices.Equal(got, []string{"done", "has"}) {
		t.Fatalf("the one that has passed is left out at once: %v", got)
	}
	if num(t, item(t, client, s.Table, "abc", "rec#task#has")["expires_at"]) != now.AddDate(5, 0, 0).Unix() {
		t.Fatal("a fill replaced an expiry")
	}
}

func TestCleanupMarksFirstThenRemovesOnceTheMarkHasSettled(t *testing.T) {
	s, cleanup, now, client := expiringStore(t)
	c := fresh(*now, "a")
	device(t, s, "abc", 0,
		task("open", title("Paint the fence", c)),
		msync.Change{Type: "time_block", ID: "past", Fields: msync.Fields{"end": {V: at(*now), C: c}, "expires_at": {V: at(now.Add(time.Hour)), C: c}}},
		task("deleted", msync.Fields{"title": {V: "Oil the hinges", C: c}, "deleted_at": {V: at(*now), C: c}}),
	)
	device(t, s, "other", 0, msync.Change{Type: "time_block", ID: "theirs", Fields: msync.Fields{"end": {V: at(*now), C: c}, "expires_at": {V: at(now.Add(time.Hour)), C: c}}})

	if stats := cleanUp(t, cleanup); stats != (msync.CleanupStats{}) {
		t.Fatalf("nothing has expired yet: %+v", stats)
	}
	*now = now.Add(2 * time.Hour)
	if stats := cleanUp(t, cleanup); stats.Marked != 2 || stats.Removed != 0 {
		t.Fatalf("the first run only marks: %+v", stats)
	}
	if got := num(t, item(t, client, s.Table, "abc", "meta#expired")["value"]); got != 2 {
		t.Fatalf("mark %d", got)
	}
	// Too soon for every sync that read the old mark to have finished.
	*now = now.Add(10 * time.Second)
	if stats := cleanUp(t, cleanup); stats.Removed != 0 {
		t.Fatalf("%+v", stats)
	}
	*now = now.Add(time.Minute)
	if stats := cleanUp(t, cleanup); stats.Removed != 2 || stats.Users != 2 {
		t.Fatalf("%+v", stats)
	}
	if item(t, client, s.Table, "abc", "rec#time_block#past") != nil || item(t, client, s.Table, "abc", "rec#task#open") == nil {
		t.Fatal("removed the wrong record")
	}

	*now = now.AddDate(0, 0, 31)
	cleanUp(t, cleanup)
	*now = now.Add(time.Minute)
	if stats := cleanUp(t, cleanup); stats.Removed != 1 {
		t.Fatalf("%+v", stats)
	}
	if got := num(t, item(t, client, s.Table, "abc", "meta#expired")["value"]); got != 3 {
		t.Fatalf("the mark is the highest sequence number removed: %d", got)
	}
}

func TestARecordWrittenAgainBeforeItsCleanupStays(t *testing.T) {
	s, cleanup, now, _ := expiringStore(t)
	c := fresh(*now, "a")
	device(t, s, "abc", 0, task("r1", msync.Fields{"deleted_at": {V: at(*now), C: c}, "expires_at": {V: at(now.Add(time.Minute)), C: c}}))
	*now = now.Add(time.Hour)
	cleanUp(t, cleanup)
	// Restored after the mark went up, so its expiry cleared.
	later := fresh(*now, "b")
	device(t, s, "abc", 1, task("r1", msync.Fields{"deleted_at": {V: nil, C: later}, "expires_at": {V: nil, C: later}}))
	*now = now.Add(time.Minute)
	if stats := cleanUp(t, cleanup); stats.Removed != 0 {
		t.Fatalf("%+v", stats)
	}
	if got := ids(mustSync(t, s, "abc", 0).Changes); !slices.Equal(got, []string{"r1"}) {
		t.Fatalf("%v", got)
	}
}

func TestWithoutExpiryNothingIsLeftOut(t *testing.T) {
	s, _ := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", msync.Fields{"title": {V: "x", C: clock(1, "a")}, "expires_at": {V: "2000-01-01T00:00:00Z", C: clock(1, "a")}}))
	if got := mustSync(t, s, "abc", 0).Changes; len(got) != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestAPullThatReachesTheEndMovesPastARemovedRecord(t *testing.T) {
	s, _, now, client := expiringStore(t)
	c := fresh(*now, "a")
	mustSync(t, s, "abc", 0, task("keep", title("Paint the fence", c)), task("gone", title("Oil the hinges", c)))
	// What TTL and the Streams consumer do.
	if _, err := client.DeleteItem(context.Background(), &dynamodb.DeleteItemInput{TableName: aws.String(s.Table), Key: map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: "user#abc"}, "sk": &types.AttributeValueMemberS{Value: "rec#task#gone"},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := msync.RaiseMark(context.Background(), client, s.Table, "user#abc", 2, *now); err != nil {
		t.Fatal(err)
	}
	// Otherwise its cursor would stay at 1, below the mark, and every sync after would be a reset.
	res := mustSync(t, s, "abc", 0)
	if res.Cursor != 2 || len(res.Changes) != 1 {
		t.Fatalf("%+v", res)
	}
	if res := device(t, s, "abc", res.Cursor, task("keep", title("Paint the gate", fresh(*now, "b")))); res.Reset != "" {
		t.Fatalf("%+v", res)
	}
}
