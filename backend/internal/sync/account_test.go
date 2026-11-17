package sync_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	"github.com/BSchrift/open-multiscale-planning/config"
)

func markDeleted(t *testing.T, client *dynamodb.Client, table, user string) {
	t.Helper()
	_, err := client.PutItem(context.Background(), &dynamodb.PutItemInput{TableName: aws.String(table), Item: map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: "user#" + user}, "sk": &types.AttributeValueMemberS{Value: sync.DeletedKey},
	}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestSyncIsRefusedOnceTheAccountIsBeingDeleted(t *testing.T) {
	s, client := newStore(t)
	mustSync(t, s, "alice", 0, task("r1", title("Hers", clock(1, "a"))))
	mustSync(t, s, "bob", 0, task("r1", title("His", clock(1, "b"))))
	markDeleted(t, client, s.Table, "alice")

	// A device that still holds a good token can neither send nor pull, whether or not it takes expiry resets.
	for _, req := range []sync.Request{
		{Cursor: 1, Changes: []sync.Change{task("r2", title("Late", clock(2, "a")))}},
		{Cursor: 0},
		{Cursor: 1, ExpiryReset: true},
	} {
		if _, _, err := s.Sync(context.Background(), "alice", req); !errors.Is(err, sync.ErrAccountDeleted) {
			t.Fatalf("sync %+v: got %v, want ErrAccountDeleted", req, err)
		}
	}
	if _, found, err := s.Record(context.Background(), "alice", "task", "r2"); err != nil || found {
		t.Fatalf("the late change landed: found %v, %v", found, err)
	}
	// Someone else's account syncs as before.
	if res := mustSync(t, s, "bob", 0); len(res.Changes) != 1 {
		t.Fatalf("bob got %+v", res)
	}
}

// The calendar worker's write in flight as the deletion starts still lands: refusing it would count as a failed run.
// The deletion's later passes remove whatever it wrote.
func TestTheServersOwnWriteIsNotRefused(t *testing.T) {
	s, client := newStore(t)
	markDeleted(t, client, s.Table, "alice")
	if _, err := s.Push(context.Background(), "alice", 0, []sync.Change{task("r1", title("x", clock(1, "server")))}); err != nil {
		t.Fatal(err)
	}
}

func TestEachReadsEveryRecordOfEveryTypeAndLeavesOutWhatExpired(t *testing.T) {
	s, _ := newStore(t)
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	s.Expiry = &sync.Expiry{Now: func() time.Time { return now }, Deleted: config.Period{Days: 30}}
	// Clocks from now: an app from before retention can't bring back a record the server doesn't hold with older ones.
	at := clock(now.UnixMilli(), "a")
	field := func(v any) sync.Field { return sync.Field{V: v, C: at} }
	mustSync(t, s, "alice", 0,
		task("t1", title("Open", at)),
		sync.Change{Type: "task", ID: "t2", Fields: sync.Fields{"title": field("Deleted"), "deleted_at": field("2026-11-16T00:00:00.000Z")}},
		sync.Change{Type: "task", ID: "t3", Fields: sync.Fields{"title": field("Expired"), "expires_at": field("2026-11-01T00:00:00.000Z")}},
		// A type this server has never heard of, as notes will be: everything is read the same way.
		sync.Change{Type: "memo", ID: "m1", Fields: sync.Fields{"text": field("A note")}},
		sync.Change{Type: "settings", ID: "settings", Fields: sync.Fields{"week_start": field(json.Number("1"))}},
	)
	mustSync(t, s, "bob", 0, task("b1", title("His", clock(1, "b"))))

	var got []string
	err := s.Each(context.Background(), "alice", func(c sync.Change) error {
		got = append(got, c.Type+"/"+c.ID+"="+describe(c.Fields))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"memo/m1=text", "settings/settings=week_start", "task/t1=title", "task/t2=deleted_at,title"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestEachStopsAtTheCallbacksError(t *testing.T) {
	s, _ := newStore(t)
	mustSync(t, s, "alice", 0, task("t1", title("a", clock(1, "a"))), task("t2", title("b", clock(1, "a"))))
	stop := errors.New("stop")
	calls := 0
	err := s.Each(context.Background(), "alice", func(sync.Change) error { calls++; return stop })
	if !errors.Is(err, stop) || calls != 1 {
		t.Fatalf("got %v after %d calls", err, calls)
	}
}

func describe(fields sync.Fields) string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	slices.Sort(names)
	return strings.Join(names, ",")
}
