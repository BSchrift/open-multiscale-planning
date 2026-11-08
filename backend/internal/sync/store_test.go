package sync_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	gosync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	msync "github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

var tableSeq atomic.Int64

// newStore returns a store on a fresh table in a real DynamoDB Local, and the raw client underneath.
func newStore(t *testing.T) (*msync.Store, *dynamodb.Client) {
	t.Helper()
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT not set: start DynamoDB Local to run this test")
	}
	client := dynamodb.New(dynamodb.Options{
		Region:       "us-west-2",
		BaseEndpoint: aws.String(endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	table := fmt.Sprintf("store-test-%d-%d", os.Getpid(), tableSeq.Add(1))
	if err := fakes.CreateTable(context.Background(), client, table); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	})
	return &msync.Store{DB: client, Table: table}, client
}

// beforeWriteDB runs Before ahead of each transaction, then fails with Err if set.
type beforeWriteDB struct {
	msync.DB
	Before func()
	Err    error
}

func (d *beforeWriteDB) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	if d.Before != nil {
		d.Before()
	}
	if d.Err != nil {
		return nil, d.Err
	}
	return d.DB.TransactWriteItems(ctx, in, opts...)
}

// unprocessedDB leaves every key unprocessed for the next Remaining batch reads, as a throttled DynamoDB does.
type unprocessedDB struct {
	msync.DB
	Remaining atomic.Int64
}

func (d *unprocessedDB) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	if d.Remaining.Add(-1) < 0 {
		return d.DB.BatchGetItem(ctx, in, opts...)
	}
	return &dynamodb.BatchGetItemOutput{UnprocessedKeys: in.RequestItems}, nil
}

// spyDB records the requests it passes on.
type spyDB struct {
	msync.DB
	Reads   []*dynamodb.BatchGetItemInput
	Writes  []*dynamodb.TransactWriteItemsInput
	Queries []*dynamodb.QueryInput
}

func (d *spyDB) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	d.Reads = append(d.Reads, in)
	return d.DB.BatchGetItem(ctx, in, opts...)
}

func (d *spyDB) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	d.Writes = append(d.Writes, in)
	return d.DB.TransactWriteItems(ctx, in, opts...)
}

func (d *spyDB) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	d.Queries = append(d.Queries, in)
	return d.DB.Query(ctx, in, opts...)
}

func clock(ms int64, device string) string {
	return fmt.Sprintf("%013d-000000-%s", ms, device)
}

func task(id string, fields map[string]msync.Field) msync.Change {
	return msync.Change{Type: "task", ID: id, Fields: fields}
}

func title(value, c string) map[string]msync.Field {
	return map[string]msync.Field{"title": {V: value, C: c}}
}

func mustSync(t *testing.T, s *msync.Store, user string, cursor int64, changes ...msync.Change) msync.Response {
	t.Helper()
	res, _, err := s.Sync(context.Background(), user, msync.Request{Cursor: cursor, Changes: changes})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestPushThenPull(t *testing.T) {
	s, _ := newStore(t)
	res := mustSync(t, s, "abc", 0, msync.Change{Type: "task", ID: "r1", Fields: map[string]msync.Field{
		"title":    {V: "Write the report", C: clock(1000, "a")},
		"done_at":  {V: nil, C: clock(1000, "a")},
		"estimate": {V: json.Number("30"), C: clock(1000, "a")},
		"flag":     {V: false, C: clock(1000, "a")},
		"schedule": {V: map[string]any{"every": json.Number("2"), "days": []any{json.Number("1"), "x", nil, true}}, C: clock(1000, "a")},
	}})
	if res.Cursor != 1 || res.More || len(res.Changes) != 1 {
		t.Fatalf("got %+v", res)
	}
	got, _ := json.Marshal(res.Changes[0])
	want := `{"type":"task","id":"r1","fields":{"done_at":{"v":null,"c":"0000000001000-000000-a"},` +
		`"estimate":{"v":30,"c":"0000000001000-000000-a"},"flag":{"v":false,"c":"0000000001000-000000-a"},` +
		`"schedule":{"v":{"days":[1,"x",null,true],"every":2},"c":"0000000001000-000000-a"},` +
		`"title":{"v":"Write the report","c":"0000000001000-000000-a"}}}`
	if string(got) != want {
		t.Fatalf("round trip\n got %s\nwant %s", got, want)
	}
}

func TestIDWithHashesRoundTrips(t *testing.T) {
	s, _ := newStore(t)
	res := mustSync(t, s, "abc", 0, msync.Change{Type: "block_outcome", ID: "outcome:a#b#c", Fields: title("x", clock(1, "a"))})
	if got := res.Changes[0]; got.Type != "block_outcome" || got.ID != "outcome:a#b#c" {
		t.Fatalf("got %+v", got)
	}
}

func TestMergeKeepsOtherFieldsAndDropsLosers(t *testing.T) {
	s, _ := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", map[string]msync.Field{
		"title": {V: "Paint the fence", C: clock(1000, "a")},
		"order": {V: json.Number("1"), C: clock(1000, "a")},
	}))
	res := mustSync(t, s, "abc", 1, task("r1", title("Paint the gate", clock(2000, "b"))))
	if res.Cursor != 2 || len(res.Changes) != 1 {
		t.Fatalf("got %+v", res)
	}
	fields := res.Changes[0].Fields
	if fields["title"].V != "Paint the gate" || fields["order"].V != json.Number("1") {
		t.Fatalf("got %+v", fields)
	}

	// A resend of an older write changes nothing, so no new sequence and nothing to pull.
	res = mustSync(t, s, "abc", 2, task("r1", title("Paint the fence", clock(1000, "a"))))
	if res.Cursor != 2 || len(res.Changes) != 0 {
		t.Fatalf("got %+v", res)
	}
}

func TestSameRecordTwiceInOneRequestMerges(t *testing.T) {
	s, _ := newStore(t)
	res := mustSync(t, s, "abc", 0,
		task("r1", title("Later", clock(2000, "a"))),
		task("r1", title("Earlier", clock(1000, "a"))),
		task("r1", map[string]msync.Field{"order": {V: json.Number("1"), C: clock(1000, "a")}}),
	)
	if res.Cursor != 1 || len(res.Changes) != 1 {
		t.Fatalf("got %+v", res)
	}
	fields := res.Changes[0].Fields
	if fields["title"].V != "Later" || fields["order"].C == "" {
		t.Fatalf("got %+v", fields)
	}
}

func TestEmptyStringAndEmptyContainers(t *testing.T) {
	s, _ := newStore(t)
	res := mustSync(t, s, "abc", 0, task("r1", map[string]msync.Field{
		"a": {V: "", C: clock(1, "a")},
		"b": {V: []any{}, C: clock(1, "a")},
		"c": {V: map[string]any{}, C: clock(1, "a")},
	}))
	got, _ := json.Marshal(res.Changes[0].Fields)
	want := `{"a":{"v":"","c":"0000000000001-000000-a"},"b":{"v":[],"c":"0000000000001-000000-a"},"c":{"v":{},"c":"0000000000001-000000-a"}}`
	if string(got) != want {
		t.Fatalf("got %s", got)
	}
}

func TestExtremeNumbersAreAccepted(t *testing.T) {
	s, _ := newStore(t)
	res := mustSync(t, s, "abc", 0, task("r1", map[string]msync.Field{
		"big":  {V: json.Number("9.9e125"), C: clock(1, "a")},
		"tiny": {V: json.Number("1e-130"), C: clock(1, "a")},
	}))
	if len(res.Changes) != 1 {
		t.Fatalf("got %+v", res)
	}
}

func TestPaging(t *testing.T) {
	s, _ := newStore(t)
	const total = 510
	var batch []msync.Change
	for i := range total {
		batch = append(batch, task(fmt.Sprintf("r%04d", i), title("x", clock(1, "a"))))
		if len(batch) == msync.MaxChanges || i == total-1 {
			if err := pushOnly(s, "abc", batch); err != nil {
				t.Fatal(err)
			}
			batch = nil
		}
	}
	page := mustSync(t, s, "abc", 0)
	if !page.More || len(page.Changes) != 500 || page.Cursor != 500 {
		t.Fatalf("first page: more=%v changes=%d cursor=%d", page.More, len(page.Changes), page.Cursor)
	}
	page = mustSync(t, s, "abc", page.Cursor)
	if page.More || len(page.Changes) != 10 || page.Cursor != total {
		t.Fatalf("second page: more=%v changes=%d cursor=%d", page.More, len(page.Changes), page.Cursor)
	}
	page = mustSync(t, s, "abc", page.Cursor)
	if page.More || len(page.Changes) != 0 || page.Cursor != total {
		t.Fatalf("drained: %+v", page)
	}
}

func pushOnly(s *msync.Store, user string, changes []msync.Change) error {
	_, err := s.Push(context.Background(), user, 0, changes)
	return err
}

func TestNoChangesIsAnEmptyListNotNull(t *testing.T) {
	s, _ := newStore(t)
	for name, res := range map[string]msync.Response{
		"nothing to pull": mustSync(t, s, "abc", 0),
		"reset":           mustSync(t, s, "abc", 5),
	} {
		got, _ := json.Marshal(res)
		if string(got) != `{"cursor":0,"more":false,"changes":[]}` {
			t.Errorf("%s: %s", name, got)
		}
	}
}

// Every number form a JSON body can carry within the validated limits must also be writable.
func TestNumberFormsDynamoDBTakes(t *testing.T) {
	s, _ := newStore(t)
	for _, n := range []string{"0", "-0", "0.0", "1E5", "1e+5", "1e-5", "-1.5", "0e999", "9.99e125", "1e-130", "12345678901234567890123456789012345678"} {
		_, _, err := s.Sync(context.Background(), "numbers", msync.Request{Cursor: 0, Changes: []msync.Change{task("r-"+n, map[string]msync.Field{
			"n": {V: json.Number(n), C: clock(1, "a")},
		})}})
		if err != nil {
			t.Errorf("%s: %v", n, err)
		}
	}
}

// Real DynamoDB refuses a zero spelt with an exponent out of its range, such as 0e999, though DynamoDB Local takes it.
func TestZeroIsWrittenPlainly(t *testing.T) {
	s, client := newStore(t)
	spy := &spyDB{DB: client}
	s.DB = spy
	for _, n := range []string{"0e999", "-0e-999", "0.000"} {
		if _, err := s.Push(context.Background(), "zeros", 0, []msync.Change{task("r-"+n, map[string]msync.Field{
			"n": {V: json.Number(n), C: clock(1, "a")},
		})}); err != nil {
			t.Fatal(err)
		}
		put := spy.Writes[len(spy.Writes)-1].TransactItems[0].Put
		field := put.Item["fields"].(*types.AttributeValueMemberM).Value["n"].(*types.AttributeValueMemberM)
		if got := field.Value["v"].(*types.AttributeValueMemberN).Value; got != "0" {
			t.Errorf("%s written as %s", n, got)
		}
	}
}

func TestConcurrentDevicesLoseNothing(t *testing.T) {
	s, _ := newStore(t)
	const devices = 6
	var wg gosync.WaitGroup
	for d := range devices {
		wg.Go(func() {
			name := fmt.Sprintf("field_%d", d)
			change := task("shared", map[string]msync.Field{name: {V: json.Number("1"), C: clock(1000, name)}})
			for {
				_, err := s.Push(context.Background(), "abc", 0, []msync.Change{change})
				if err == nil {
					return
				}
				if !errors.Is(err, msync.ErrConflict) {
					t.Error(err)
					return
				}
			}
		})
	}
	wg.Wait()
	res := mustSync(t, s, "abc", 0)
	if len(res.Changes) != 1 || len(res.Changes[0].Fields) != devices || res.Cursor != devices {
		t.Fatalf("cursor %d, fields %+v", res.Cursor, res.Changes)
	}
}

func TestUsersAreIsolated(t *testing.T) {
	s, _ := newStore(t)
	mustSync(t, s, "alice", 0, task("r1", title("Hers", clock(1, "a"))))
	res := mustSync(t, s, "bob", 0)
	if res.Cursor != 0 || len(res.Changes) != 0 {
		t.Fatalf("bob sees %+v", res)
	}
	res = mustSync(t, s, "bob", 0, task("r1", title("His", clock(1, "b"))))
	if res.Cursor != 1 || res.Changes[0].Fields["title"].V != "His" {
		t.Fatalf("got %+v", res)
	}
}

func TestCursorAboveCounterAsksTheDeviceToReset(t *testing.T) {
	s, _ := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", title("x", clock(1, "a"))))

	res := mustSync(t, s, "abc", 431, task("r2", title("y", clock(2, "a"))))
	if res.Cursor != 1 || res.More || len(res.Changes) != 0 {
		t.Fatalf("got %+v", res)
	}
	// The push waits for the re-send, so a device that resets gets a clean history.
	res = mustSync(t, s, "abc", 0)
	if res.Cursor != 1 || len(res.Changes) != 1 {
		t.Fatalf("got %+v", res)
	}
}

func TestCursorResetOnAnEmptyTable(t *testing.T) {
	s, _ := newStore(t)
	res := mustSync(t, s, "abc", 7)
	if res.Cursor != 0 || len(res.Changes) != 0 {
		t.Fatalf("got %+v", res)
	}
}

func putGeneration(t *testing.T, s *msync.Store, client *dynamodb.Client, value types.AttributeValue) {
	t.Helper()
	if _, err := client.PutItem(context.Background(), &dynamodb.PutItemInput{TableName: aws.String(s.Table), Item: map[string]types.AttributeValue{
		"pk":    &types.AttributeValueMemberS{Value: "meta"},
		"sk":    &types.AttributeValueMemberS{Value: "generation"},
		"value": value,
	}}); err != nil {
		t.Fatal(err)
	}
}

// After a restore, other devices can move the counter past a cursor from before it, so the counter alone can't tell that
// device to start over. The restore's last step writes a new generation, and every response carries it.
func TestEveryResponseCarriesTheTableGeneration(t *testing.T) {
	s, client := newStore(t)
	if res := mustSync(t, s, "abc", 0, task("r1", title("x", clock(1, "a")))); res.Generation != "" {
		t.Fatalf("a table never restored has no generation: %+v", res)
	}
	putGeneration(t, s, client, &types.AttributeValueMemberS{Value: "after-restore"})
	for name, res := range map[string]msync.Response{
		"push and pull":            mustSync(t, s, "abc", 0, task("r2", title("y", clock(2, "a")))),
		"nothing to pull":          mustSync(t, s, "abc", 2),
		"cursor above the counter": mustSync(t, s, "abc", 99),
	} {
		if res.Generation != "after-restore" {
			t.Errorf("%s: %+v", name, res)
		}
	}
	got, _ := json.Marshal(mustSync(t, s, "abc", 2))
	if string(got) != `{"cursor":2,"more":false,"changes":[],"generation":"after-restore"}` {
		t.Fatalf("got %s", got)
	}
}

// A generation written by hand in the wrong form must fail loudly: read as none, devices would miss the restore.
func TestAGenerationThatIsNotTextFailsTheSync(t *testing.T) {
	s, client := newStore(t)
	putGeneration(t, s, client, &types.AttributeValueMemberN{Value: "2"})
	if _, _, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 0, Changes: nil}); err == nil {
		t.Fatal("a malformed generation was ignored")
	}
}

func TestSizesAboveOneTransactionStillLand(t *testing.T) {
	s, _ := newStore(t)
	var changes []msync.Change
	for i := range msync.MaxChanges {
		// 90 KB of text across 99 records is far over what one 4 MB transaction carries.
		changes = append(changes, task(fmt.Sprintf("r%02d", i), title(strings.Repeat("x", 90*1024), clock(1, "a"))))
	}
	stats, err := s.Push(context.Background(), "abc", 0, changes)
	if err != nil {
		t.Fatal(err)
	}
	if stats.Merged != msync.MaxChanges {
		t.Fatalf("merged %d", stats.Merged)
	}
	seen := 0
	for cursor := int64(0); ; {
		page := mustSync(t, s, "abc", cursor)
		seen += len(page.Changes)
		cursor = page.Cursor
		if !page.More {
			break
		}
	}
	if seen != msync.MaxChanges {
		t.Fatalf("pulled %d", seen)
	}
}

func TestMergedRecordOverTheLimitIsRefused(t *testing.T) {
	s, _ := newStore(t)
	big := strings.Repeat("x", 60*1024)
	mustSync(t, s, "abc", 0, task("r1", map[string]msync.Field{"a": {V: big, C: clock(1, "a")}}))
	_, _, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 1, Changes: []msync.Change{
		task("r1", map[string]msync.Field{"b": {V: big, C: clock(1, "a")}}),
	}})
	var rejection *msync.Rejection
	if !errors.As(err, &rejection) || rejection.Code != "record_too_large" {
		t.Fatalf("got %v", err)
	}
	// Nothing changed.
	res := mustSync(t, s, "abc", 0)
	if len(res.Changes[0].Fields) != 1 {
		t.Fatalf("got %+v", res)
	}
}

func TestConflictRetriesThenWins(t *testing.T) {
	s, client := newStore(t)
	db := &fakes.ConflictDB{DB: client}
	db.Conflicts.Store(2)
	s.DB = db
	res, stats, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 0, Changes: []msync.Change{task("r1", title("x", clock(1, "a")))}})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Retries != 2 || stats.Merged != 1 || res.Cursor != 1 {
		t.Fatalf("stats %+v, res %+v", stats, res)
	}
}

func TestConflictGivesUpAfterThreeTries(t *testing.T) {
	s, client := newStore(t)
	db := &fakes.ConflictDB{DB: client}
	db.Conflicts.Store(3)
	s.DB = db
	_, stats, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 0, Changes: []msync.Change{task("r1", title("x", clock(1, "a")))}})
	if !errors.Is(err, msync.ErrConflict) {
		t.Fatalf("got %v", err)
	}
	if stats.Retries != 2 {
		t.Fatalf("retries %d", stats.Retries)
	}
	// Nothing was written, so the device's resend later is a first write.
	s.DB = client
	if res := mustSync(t, s, "abc", 0); res.Cursor != 0 {
		t.Fatalf("got %+v", res)
	}
}

func TestARealCounterMoveIsCaughtAndRemerged(t *testing.T) {
	s, client := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", title("First", clock(1000, "a"))))

	// Another device commits between this request's read and its write.
	other := &msync.Store{DB: client, Table: s.Table}
	moved := false
	s.DB = &beforeWriteDB{DB: client, Before: func() {
		if moved {
			return
		}
		moved = true
		if _, err := other.Push(context.Background(), "abc", 0, []msync.Change{
			task("r1", map[string]msync.Field{"order": {V: json.Number("5"), C: clock(1500, "b")}}),
		}); err != nil {
			t.Error(err)
		}
	}}
	res, stats, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 1, Changes: []msync.Change{task("r1", title("Second", clock(2000, "a")))}})
	if err != nil {
		t.Fatal(err)
	}
	if stats.Retries != 1 || res.Cursor != 3 {
		t.Fatalf("stats %+v res %+v", stats, res)
	}
	fields := res.Changes[0].Fields
	if fields["title"].V != "Second" || fields["order"].V != json.Number("5") {
		t.Fatalf("lost an update: %+v", fields)
	}
}

// throttledDB cancels the next Remaining transactions as DynamoDB does when one partition passes its write rate, or
// fails them with Err when it's set. Each takes Delay first, as the SDK's own retries do.
type throttledDB struct {
	msync.DB
	Remaining atomic.Int64
	Err       error
	Delay     time.Duration
}

func (d *throttledDB) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	if d.Remaining.Add(-1) < 0 {
		return d.DB.TransactWriteItems(ctx, in, opts...)
	}
	time.Sleep(d.Delay)
	if d.Err != nil {
		return nil, d.Err
	}
	reasons := make([]types.CancellationReason, len(in.TransactItems))
	for i := range reasons {
		reasons[i].Code = aws.String("ThrottlingError")
	}
	return nil, &types.TransactionCanceledException{CancellationReasons: reasons}
}

func TestThrottledTransactionsWaitAndLand(t *testing.T) {
	s, client := newStore(t)
	db := &throttledDB{DB: client}
	db.Remaining.Store(3)
	s.DB = db
	stats, err := s.Push(context.Background(), "abc", 0, []msync.Change{task("r1", title("x", clock(1, "a"))), task("r2", title("y", clock(1, "a")))})
	if err != nil || stats.Merged != 2 || stats.Retries != 0 {
		t.Fatalf("err %v, stats %+v", err, stats)
	}
}

// sdkGaveUp is how the SDK hands back an error it retried itself until its tries ran out.
func sdkGaveUp(err error) error {
	return fmt.Errorf("operation error DynamoDB: TransactWriteItems, %w", &retry.MaxAttemptsError{Attempt: 3, Err: err})
}

// A throttle doesn't always come back as a cancelled transaction. It can be an exception of its own, which the SDK
// retries first and then returns wrapped, and an SDK resend of a transaction still landing comes back as in progress.
// Each waits and lands like any other throttle, rather than failing the sync as an internal error.
func TestEveryFormOfThrottleWaitsAndLands(t *testing.T) {
	defer msync.SetThrottleWait(time.Millisecond)()
	for name, throttle := range map[string]error{
		"throttling exception":   sdkGaveUp(&types.ThrottlingException{Message: aws.String("Throughput exceeds the current capacity")}),
		"provisioned throughput": sdkGaveUp(&types.ProvisionedThroughputExceededException{}),
		"request limit":          sdkGaveUp(&types.RequestLimitExceeded{}),
		"in progress":            sdkGaveUp(&types.TransactionInProgressException{}),
		"one item of several": &types.TransactionCanceledException{CancellationReasons: []types.CancellationReason{
			{Code: aws.String("None")}, {Code: aws.String("ThrottlingError")}, {Code: aws.String("None")},
		}},
	} {
		t.Run(name, func(t *testing.T) {
			s, client := newStore(t)
			db := &throttledDB{DB: client, Err: throttle}
			db.Remaining.Store(2)
			s.DB = db
			stats, err := s.Push(context.Background(), "abc", 0, []msync.Change{task("r1", title("x", clock(1, "a"))), task("r2", title("y", clock(1, "a")))})
			if err != nil || stats.Merged != 2 || stats.Retries != 0 {
				t.Fatalf("err %v, stats %+v", err, stats)
			}
		})
	}
}

// A throttle the SDK already retried has spent its own backoff, a few seconds, before the store waits at all, so the
// count of waits alone could keep a push going past the API's timeout. A time budget ends it as a resend first.
func TestThrottleWaitsStopAtATimeBudget(t *testing.T) {
	defer msync.SetThrottleWait(time.Millisecond)()
	defer msync.SetThrottleBudget(150 * time.Millisecond)()
	s, client := newStore(t)
	db := &throttledDB{DB: client, Err: sdkGaveUp(&types.ThrottlingException{}), Delay: 100 * time.Millisecond}
	db.Remaining.Store(1000)
	s.DB = db
	_, err := s.Push(context.Background(), "abc", 0, []msync.Change{task("r1", title("x", clock(1, "a")))})
	if tries := 1000 - db.Remaining.Load(); !errors.Is(err, msync.ErrConflict) || tries > 3 {
		t.Fatalf("err %v after %d tries", err, tries)
	}
}

// An SDK resend that found its first try still landing may be followed by that try committing. The store's own resend is
// conditional on the same counter, so it then fails as a conflict, and the re-read finds the records already there.
func TestATransactionThatLandsAfterAnInProgressAnswerIsNotWrittenTwice(t *testing.T) {
	defer msync.SetThrottleWait(time.Millisecond)()
	s, client := newStore(t)
	landed := false
	s.DB = &landsLateDB{DB: client, landed: &landed}
	stats, err := s.Push(context.Background(), "abc", 0, []msync.Change{task("r1", title("x", clock(1, "a")))})
	if err != nil || !landed || stats.Retries != 1 {
		t.Fatalf("err %v, landed %v, stats %+v", err, landed, stats)
	}
	if res := mustSync(t, s, "abc", 0); res.Cursor != 1 || len(res.Changes) != 1 {
		t.Fatalf("written twice: %+v", res)
	}
}

// landsLateDB commits the first transaction but answers that it's still in progress, as the SDK does after resending it
// with the same token while the first try was landing.
type landsLateDB struct {
	msync.DB
	landed *bool
}

func (d *landsLateDB) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	out, err := d.DB.TransactWriteItems(ctx, in, opts...)
	if err != nil || *d.landed {
		return out, err
	}
	*d.landed = true
	return nil, sdkGaveUp(&types.TransactionInProgressException{})
}

// Past the wait it's a resend like a counter conflict, a 409 that stays out of the 5xx alarm, and what landed stays.
func TestThrottlingThatOutlastsTheWaitAsksTheDeviceToResend(t *testing.T) {
	defer msync.SetThrottleWait(time.Millisecond)()
	s, client := newStore(t)
	db := &throttledDB{DB: client}
	db.Remaining.Store(1000)
	s.DB = db
	if _, err := s.Push(context.Background(), "abc", 0, []msync.Change{task("r1", title("x", clock(1, "a")))}); !errors.Is(err, msync.ErrConflict) {
		t.Fatalf("err %v", err)
	}
}

// All of a user's records share one partition, which takes about 1,000 write units a second, and a transactional write
// costs two per KB. A transaction much bigger than that is refused however long it waits.
func TestTransactionsFitOnePartitionsWriteRate(t *testing.T) {
	s, client := newStore(t)
	spy := &spyDB{DB: client}
	s.DB = spy
	var changes []msync.Change
	for i := range 12 {
		changes = append(changes, task(fmt.Sprintf("r%02d", i), title(strings.Repeat("x", 90*1024), clock(1, "a"))))
	}
	if _, err := s.Push(context.Background(), "abc", 0, changes); err != nil {
		t.Fatal(err)
	}
	for i, write := range spy.Writes {
		// Two 90 KB records and the counter.
		if len(write.TransactItems) > 3 {
			t.Errorf("transaction %d carries %d items", i, len(write.TransactItems))
		}
	}
}

// sizeReportingDB answers every read as an empty table and accepts every transaction, reporting the user's item
// collection at the next of Sizes, as DynamoDB does and DynamoDB Local never does. A nil size reports nothing.
type sizeReportingDB struct {
	msync.DB
	Sizes  [][]float64
	Writes []*dynamodb.TransactWriteItemsInput
}

func (d *sizeReportingDB) BatchGetItem(context.Context, *dynamodb.BatchGetItemInput, ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	return &dynamodb.BatchGetItemOutput{}, nil
}

func (d *sizeReportingDB) TransactWriteItems(_ context.Context, in *dynamodb.TransactWriteItemsInput, _ ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	d.Writes = append(d.Writes, in)
	size := d.Sizes[len(d.Writes)-1]
	if size == nil {
		return &dynamodb.TransactWriteItemsOutput{}, nil
	}
	put := in.TransactItems[0].Put
	return &dynamodb.TransactWriteItemsOutput{ItemCollectionMetrics: map[string][]types.ItemCollectionMetrics{
		aws.ToString(put.TableName): {{ItemCollectionKey: map[string]types.AttributeValue{"pk": put.Item["pk"]}, SizeEstimateRangeGB: size}},
	}}, nil
}

// The by_seq index caps each user's records at 10 GB, so every write asks for their size, and a push reports the upper
// bound of the largest estimate across its transactions.
func TestWritesReportTheUsersItemCollectionSize(t *testing.T) {
	// Four 90 KB records go in two transactions.
	var changes []msync.Change
	for i := range 4 {
		changes = append(changes, task(fmt.Sprintf("r%d", i), title(strings.Repeat("x", 90*1024), clock(1, "a"))))
	}
	for name, c := range map[string]struct {
		sizes [][]float64
		want  float64
	}{
		// Estimates can move either way between transactions.
		"largest upper bound": {[][]float64{{2, 3}, {1, 2}}, 3},
		"none reported":       {[][]float64{nil, nil}, 0},
	} {
		t.Run(name, func(t *testing.T) {
			db := &sizeReportingDB{Sizes: c.sizes}
			s := &msync.Store{DB: db, Table: "records"}
			stats, err := s.Push(context.Background(), "abc", 0, changes)
			if err != nil {
				t.Fatal(err)
			}
			if len(db.Writes) != 2 || stats.Merged != 4 {
				t.Fatalf("%d transactions, stats %+v", len(db.Writes), stats)
			}
			for i, in := range db.Writes {
				if in.ReturnItemCollectionMetrics != types.ReturnItemCollectionMetricsSize {
					t.Errorf("transaction %d asks for %q", i, in.ReturnItemCollectionMetrics)
				}
			}
			if stats.ItemCollectionGB != c.want {
				t.Fatalf("size %v, want %v", stats.ItemCollectionGB, c.want)
			}
		})
	}
}

func TestOtherTransactionFailuresAreNotRetried(t *testing.T) {
	s, client := newStore(t)
	s.DB = &beforeWriteDB{DB: client, Err: &types.TransactionCanceledException{
		CancellationReasons: []types.CancellationReason{{Code: aws.String("ValidationError")}},
	}}
	_, stats, err := s.Sync(context.Background(), "abc", msync.Request{Cursor: 0, Changes: []msync.Change{task("r1", title("x", clock(1, "a")))}})
	if err == nil || errors.Is(err, msync.ErrConflict) || stats.Retries != 0 {
		t.Fatalf("err %v, stats %+v", err, stats)
	}
}

func TestUnprocessedKeysAreRetried(t *testing.T) {
	s, client := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", map[string]msync.Field{
		"title": {V: "First", C: clock(1000, "a")},
		"order": {V: json.Number("1"), C: clock(1000, "a")},
	}))
	db := &unprocessedDB{DB: client}
	db.Remaining.Store(2)
	s.DB = db
	res := mustSync(t, s, "abc", 1, task("r1", title("Second", clock(2000, "a"))))
	if res.Cursor != 2 || res.Changes[0].Fields["order"].V != json.Number("1") {
		t.Fatalf("a record read as missing would lose its other fields: %+v", res)
	}
}

func TestRequestShapes(t *testing.T) {
	s, client := newStore(t)
	spy := &spyDB{DB: client}
	s.DB = spy
	mustSync(t, s, "abc", 0, task("r1", title("x", clock(1, "a"))))
	mustSync(t, s, "abc", 1, task("r2", title("y", clock(2, "a"))))

	// The counter's read also takes the user's expiry mark and the table's generation, and the record's read comes after it.
	for i, in := range spy.Reads[:2] {
		if read := in.RequestItems[s.Table]; !aws.ToBool(read.ConsistentRead) || len(read.Keys) != []int{3, 1}[i] {
			t.Fatalf("read %+v", read)
		}
	}
	if sk := spy.Reads[0].RequestItems[s.Table].Keys[0]["sk"].(*types.AttributeValueMemberS).Value; sk != "meta#counter" {
		t.Fatalf("read the record first: %s", sk)
	}
	if key := spy.Reads[0].RequestItems[s.Table].Keys[1]; key["pk"].(*types.AttributeValueMemberS).Value != "user#abc" ||
		key["sk"].(*types.AttributeValueMemberS).Value != "meta#expired" {
		t.Fatalf("mark key %+v", key)
	}
	if key := spy.Reads[0].RequestItems[s.Table].Keys[2]; key["pk"].(*types.AttributeValueMemberS).Value != "meta" ||
		key["sk"].(*types.AttributeValueMemberS).Value != "generation" {
		t.Fatalf("generation key %+v", key)
	}
	if pk := spy.Reads[1].RequestItems[s.Table].Keys[0]["pk"].(*types.AttributeValueMemberS).Value; pk != "user#abc" {
		t.Fatalf("pk %q", pk)
	}

	first := spy.Writes[0].TransactItems
	put := first[0].Put.Item
	if put["sk"].(*types.AttributeValueMemberS).Value != "rec#task#r1" || put["seq"].(*types.AttributeValueMemberN).Value != "1" {
		t.Fatalf("put %+v", put)
	}
	counter := first[1].Update
	if aws.ToString(counter.ConditionExpression) != "attribute_not_exists(#value)" {
		t.Fatalf("first condition %q", aws.ToString(counter.ConditionExpression))
	}
	next := spy.Writes[1].TransactItems[1].Update
	if aws.ToString(next.ConditionExpression) != "#value = :old" ||
		next.ExpressionAttributeValues[":old"].(*types.AttributeValueMemberN).Value != "1" ||
		next.ExpressionAttributeValues[":new"].(*types.AttributeValueMemberN).Value != "2" {
		t.Fatalf("next %+v", next)
	}

	pull := spy.Queries[len(spy.Queries)-1]
	if aws.ToString(pull.IndexName) != "by_seq" || !aws.ToBool(pull.ConsistentRead) || aws.ToInt32(pull.Limit) != 500 {
		t.Fatalf("pull %+v", pull)
	}
}

func TestListFollowsPagesAndStaysInOneTypeAndUser(t *testing.T) {
	store, _ := newStore(t)
	ctx := context.Background()
	clock := "1800000000000-000000-a"
	// Big enough that a full read crosses DynamoDB's 1 MB page.
	big := strings.Repeat("x", 60*1024)
	var want []msync.Change
	for i := range 30 {
		change := msync.Change{Type: "time_block", ID: fmt.Sprintf("b%02d", i), Fields: msync.Fields{"note": {V: big, C: clock}}}
		want = append(want, change)
	}
	if _, err := store.Push(ctx, "one", 0, want); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Push(ctx, "one", 0, []msync.Change{{Type: "time_block_other", ID: "x", Fields: msync.Fields{"note": {V: "x", C: clock}}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Push(ctx, "two", 0, []msync.Change{{Type: "time_block", ID: "theirs", Fields: msync.Fields{"note": {V: "x", C: clock}}}}); err != nil {
		t.Fatal(err)
	}

	got, err := store.List(ctx, "one", "time_block")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 30 {
		t.Fatalf("got %d records", len(got))
	}
	for i, change := range got {
		if change.Type != "time_block" || change.ID != fmt.Sprintf("b%02d", i) || change.Fields["note"].V != big {
			t.Fatalf("record %d: %s %s", i, change.Type, change.ID)
		}
	}
}

// interleavingDB reads a batch's records before its counter, with another writer's commit in between, which DynamoDB is
// free to do since a batch read isn't one snapshot.
type interleavingDB struct {
	msync.DB
	Between func()
	once    gosync.Once
}

func (d *interleavingDB) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	merged := &dynamodb.BatchGetItemOutput{Responses: map[string][]map[string]types.AttributeValue{}}
	read := func(counter bool) error {
		for table, request := range in.RequestItems {
			var keys []map[string]types.AttributeValue
			for _, key := range request.Keys {
				if key["sk"].(*types.AttributeValueMemberS).Value == "meta#counter" == counter {
					keys = append(keys, key)
				}
			}
			if len(keys) == 0 {
				continue
			}
			request.Keys = keys
			out, err := d.DB.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: map[string]types.KeysAndAttributes{table: request}}, opts...)
			if err != nil {
				return err
			}
			merged.Responses[table] = append(merged.Responses[table], out.Responses[table]...)
		}
		return nil
	}
	if err := read(false); err != nil {
		return nil, err
	}
	d.once.Do(d.Between)
	return merged, read(true)
}

// The counter has to be read before the records: it's all the write is conditional on, so a commit between reading a
// record and reading the counter would otherwise go unnoticed and be overwritten.
func TestWriteBetweenReadsIsNotLost(t *testing.T) {
	s, client := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", map[string]msync.Field{"a": {V: "first", C: clock(1000, "a")}}))
	other := &msync.Store{DB: client, Table: s.Table}
	s.DB = &interleavingDB{DB: client, Between: func() {
		mustSync(t, other, "abc", 1, task("r1", map[string]msync.Field{"b": {V: "from the other device", C: clock(2000, "b")}}))
	}}
	res := mustSync(t, s, "abc", 1, task("r1", map[string]msync.Field{"c": {V: "from this device", C: clock(3000, "c")}}))
	var fields map[string]msync.Field
	for _, change := range res.Changes {
		fields = change.Fields
	}
	if fields["b"].V != "from the other device" || fields["c"].V != "from this device" {
		t.Fatalf("an update was lost: %+v", fields)
	}
}

// partialCommitDB answers one query as if another writer's transaction were still landing: committed, but with one of
// its records not visible yet, which a query is allowed to show. DynamoDB Local never does this on its own.
type partialCommitDB struct {
	msync.DB
	Commit func()
	Hide   string
	once   gosync.Once
}

func (d *partialCommitDB) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	first := false
	d.once.Do(func() {
		first = true
		d.Commit()
	})
	out, err := d.DB.Query(ctx, in, opts...)
	if err != nil || !first {
		return out, err
	}
	var kept []map[string]types.AttributeValue
	for _, item := range out.Items {
		if item["sk"].(*types.AttributeValueMemberS).Value != d.Hide {
			kept = append(kept, item)
		}
	}
	out.Items = kept
	return out, nil
}

// A cursor only ever moves forward, so a pull that sees a later record but not an earlier one would lose that one for good.
func TestPullStopsAtTheCounterItRead(t *testing.T) {
	s, client := newStore(t)
	mustSync(t, s, "abc", 0, task("r1", title("first", clock(1000, "a"))))
	other := &msync.Store{DB: client, Table: s.Table}
	s.DB = &partialCommitDB{DB: client, Hide: "rec#task#r2", Commit: func() {
		mustSync(t, other, "abc", 1, task("r2", title("second", clock(2000, "b"))), task("r3", title("third", clock(2000, "b"))))
	}}
	seen := map[string]bool{}
	cursor := int64(0)
	for range 3 {
		res := mustSync(t, s, "abc", cursor)
		for _, change := range res.Changes {
			seen[change.ID] = true
		}
		cursor = res.Cursor
	}
	if !seen["r1"] || !seen["r2"] || !seen["r3"] {
		t.Fatalf("a device never got everything: %v", seen)
	}
}
