package account_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	gosync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

var tableSeq atomic.Int64

// world is a table in DynamoDB Local, with stand-ins for the bucket, the user pool and Google around the service.
type world struct {
	t        *testing.T
	client   *dynamodb.Client
	table    string
	store    *sync.Store
	bucket   *fakes.Bucket
	identity *identity
	google   *google
	svc      *account.Service
	now      time.Time
	logs     bytes.Buffer
	started  []account.Job
}

func newWorld(t *testing.T) *world {
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
	table := fmt.Sprintf("account-test-%d-%d", os.Getpid(), tableSeq.Add(1))
	if err := fakes.CreateTable(context.Background(), client, table); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.DeleteTable(context.Background(), &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	})
	w := &world{
		t: t, client: client, table: table,
		identity: &identity{users: map[string]bool{}},
		google:   &google{},
		now:      time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC),
	}
	clock := func() time.Time { return w.now }
	w.store = &sync.Store{DB: client, Table: table}
	w.bucket = &fakes.Bucket{Now: clock}
	w.svc = &account.Service{
		DB: client, Table: table, Records: w.store, Objects: w.bucket, Identity: w.identity, Google: w.google,
		Sign: func(_ context.Context, key string, expires time.Time) (string, error) {
			return fmt.Sprintf("https://files.test/%s?Expires=%d", key, expires.Unix()), nil
		},
		Start: func(_ context.Context, job account.Job) error { w.started = append(w.started, job); return nil },
		Now:   clock, Log: obs.NewLogger(&w.logs), Env: "test",
	}
	return w
}

func clockAt(at time.Time) string { return fmt.Sprintf("%013d-000000-dev", at.UnixMilli()) }

// seed gives a person what a real account has: records of several kinds, one an attachment whose file is in the bucket,
// the items internal/files and the calendar keep beside them, and an earlier export.
func (w *world) seed(sub string, records int) {
	w.t.Helper()
	ctx := context.Background()
	w.identity.add(sub)
	c := clockAt(w.now)
	f := func(v any) sync.Field { return sync.Field{V: v, C: c} }
	changes := []sync.Change{
		{Type: "settings", ID: "settings", Fields: sync.Fields{"week_start": f(json.Number("1"))}},
		{Type: "memo", ID: sub + "-m1", Fields: sync.Fields{"title": f("A note of " + sub)}},
		{Type: "attachment", ID: sub + "-a1", Fields: sync.Fields{"task_id": f(sub + "-t0"), "kind": f("photo"), "name": f("photo.jpg"), "type": f("image/jpeg")}},
		{Type: "task", ID: sub + "-gone", Fields: sync.Fields{"title": f("Deleted"), "deleted_at": f(w.now.Format(time.RFC3339))}},
	}
	for i := range records {
		changes = append(changes, sync.Change{Type: "task", ID: fmt.Sprintf("%s-t%d", sub, i), Fields: sync.Fields{"title": f(fmt.Sprintf("Task %d of %s", i, sub))}})
	}
	for start := 0; start < len(changes); start += 99 {
		if _, err := w.store.Push(ctx, sub, 0, changes[start:min(start+99, len(changes))]); err != nil {
			w.t.Fatal(err)
		}
	}
	hash := obs.HashSub(sub)
	object := "u/" + hash + "/0123456789abcdef"
	if err := w.bucket.Put(ctx, object, strings.NewReader("the photo of "+sub), "image/jpeg", ""); err != nil {
		w.t.Fatal(err)
	}
	w.bucket.Put(ctx, "exports/"+hash+"/earlier.zip", strings.NewReader("an earlier export"), "application/zip", "")
	w.put(sub, "file#"+sub+"-a1", map[string]types.AttributeValue{
		"key": &types.AttributeValueMemberS{Value: object}, "size": &types.AttributeValueMemberN{Value: "20"}, "type": &types.AttributeValueMemberS{Value: "image/jpeg"},
	})
	w.put(sub, "meta#storage", map[string]types.AttributeValue{"value": &types.AttributeValueMemberN{Value: "20"}})
	w.put(sub, "meta#calendar_state", map[string]types.AttributeValue{"nonce": &types.AttributeValueMemberS{Value: "n"}})
}

func (w *world) put(sub, sk string, attrs map[string]types.AttributeValue) {
	w.t.Helper()
	item := map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "user#" + sub}, "sk": &types.AttributeValueMemberS{Value: sk}}
	for k, v := range attrs {
		item[k] = v
	}
	if _, err := w.client.PutItem(context.Background(), &dynamodb.PutItemInput{TableName: aws.String(w.table), Item: item}); err != nil {
		w.t.Fatal(err)
	}
}

// partition is every sort key under pk, in order.
func (w *world) partition(pk string) []string {
	w.t.Helper()
	var sks []string
	var start map[string]types.AttributeValue
	for {
		out, err := w.client.Query(context.Background(), &dynamodb.QueryInput{
			TableName: aws.String(w.table), ExclusiveStartKey: start, KeyConditionExpression: aws.String("pk = :pk"),
			ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: pk}},
		})
		if err != nil {
			w.t.Fatal(err)
		}
		for _, item := range out.Items {
			sks = append(sks, item["sk"].(*types.AttributeValueMemberS).Value)
		}
		if len(out.LastEvaluatedKey) == 0 {
			return sks
		}
		start = out.LastEvaluatedKey
	}
}

func (w *world) objects(sub string) []string {
	var keys []string
	for _, prefix := range account.Prefixes(sub) {
		found, _ := w.bucket.List(context.Background(), prefix)
		keys = append(keys, found...)
	}
	return keys
}

func (w *world) run(job account.Job) error { return w.svc.Run(context.Background(), job) }

func (w *world) mustRun(job account.Job) {
	w.t.Helper()
	if err := w.run(job); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) mustDelete(sub string) {
	w.t.Helper()
	if err := w.svc.Delete(context.Background(), sub); err != nil {
		w.t.Fatal(err)
	}
}

type identity struct {
	mu          gosync.Mutex
	users       map[string]bool
	failDeletes int
}

func (i *identity) add(sub string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.users[sub] = true
}

func (i *identity) Exists(_ context.Context, sub string) (bool, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.users[sub], nil
}

func (i *identity) Delete(_ context.Context, sub string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.failDeletes > 0 {
		i.failDeletes--
		return errors.New("cognito unavailable")
	}
	delete(i.users, sub)
	return nil
}

type google struct{ forgot []string }

func (g *google) Forget(_ context.Context, sub string) error {
	g.forgot = append(g.forgot, sub)
	return nil
}

// failingDB fails BatchWriteItem once it has passed Allow of them, as an outage part way through does.
type failingDB struct {
	account.DB
	Allow int
}

func (d *failingDB) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	if d.Allow <= 0 {
		return nil, errors.New("dynamodb unavailable")
	}
	d.Allow--
	return d.DB.BatchWriteItem(ctx, in, opts...)
}

func TestDeletionRemovesEverythingOfThePersonAndNothingOfAnyoneElse(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 5)
	w.seed("bob", 5)
	bobItems, bobObjects := w.partition("user#bob"), w.objects("bob")

	w.mustDelete("alice")
	if len(w.started) != 1 || w.started[0] != (account.Job{Kind: account.JobDelete, Sub: "alice"}) {
		t.Fatalf("started %+v", w.started)
	}
	w.mustRun(w.started[0])
	w.now = w.now.Add(account.Settle)
	w.mustRun(account.Job{})

	if left := w.partition("user#alice"); len(left) != 0 {
		t.Fatalf("left in DynamoDB: %v", left)
	}
	if left := w.objects("alice"); len(left) != 0 {
		t.Fatalf("left in the bucket: %v", left)
	}
	if exists, _ := w.identity.Exists(context.Background(), "alice"); exists {
		t.Fatal("the sign-in is still there")
	}
	if !slices.Contains(w.google.forgot, "alice") || slices.Contains(w.google.forgot, "bob") {
		t.Fatalf("Google forgot %v", w.google.forgot)
	}
	if pending := w.partition("account#deleting"); len(pending) != 0 {
		t.Fatalf("still under way: %v", pending)
	}
	// Bob's account is as it was.
	if got := w.partition("user#bob"); !slices.Equal(got, bobItems) {
		t.Fatalf("bob's items changed: %v, want %v", got, bobItems)
	}
	if got := w.objects("bob"); !slices.Equal(got, bobObjects) {
		t.Fatalf("bob's files changed: %v, want %v", got, bobObjects)
	}
	if exists, _ := w.identity.Exists(context.Background(), "bob"); !exists {
		t.Fatal("bob's sign-in went")
	}
}

func TestADeletingAccountsDevicesAreRefusedAtOnce(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	w.seed("bob", 1)
	w.mustDelete("alice")

	_, _, err := w.store.Sync(context.Background(), "alice", sync.Request{Cursor: 0})
	if !errors.Is(err, sync.ErrAccountDeleted) {
		t.Fatalf("sync got %v", err)
	}
	for sub, want := range map[string]bool{"alice": true, "bob": false} {
		if deleted, err := w.svc.Deleted(context.Background(), sub); err != nil || deleted != want {
			t.Fatalf("Deleted(%s) = %v, %v", sub, deleted, err)
		}
		if gone, err := w.svc.Gone(context.Background(), sub); err != nil || gone != want {
			t.Fatalf("Gone(%s) = %v, %v", sub, gone, err)
		}
	}
}

func TestTheMarkStaysUntilEveryTokenHasLapsed(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	w.mustDelete("alice")
	w.mustRun(account.Job{Kind: account.JobDelete, Sub: "alice"})
	if left := w.partition("user#alice"); !slices.Equal(left, []string{sync.DeletedKey}) {
		t.Fatalf("left %v", left)
	}
	// A device still holding a token from before is refused until it lapses.
	w.now = w.now.Add(account.Settle - time.Minute)
	w.mustRun(account.Job{})
	if deleted, _ := w.svc.Deleted(context.Background(), "alice"); !deleted {
		t.Fatal("the mark went while a token could still be good")
	}
	w.now = w.now.Add(time.Minute)
	w.mustRun(account.Job{})
	if left := w.partition("user#alice"); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	// With the mark gone, the missing sign-in still tells a device its account was deleted.
	if gone, err := w.svc.Gone(context.Background(), "alice"); err != nil || !gone {
		t.Fatalf("Gone = %v, %v", gone, err)
	}
}

func TestAnInterruptedDeletionCarriesOn(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 120)
	w.mustDelete("alice")

	// The user pool fails: the run stops there, and says so in a count.
	w.identity.failDeletes = 1
	if err := w.run(account.Job{Kind: account.JobDelete, Sub: "alice"}); err == nil {
		t.Fatal("no error")
	}
	if !strings.Contains(w.logs.String(), `"AccountDeletionFailures":1`) {
		t.Fatalf("no failure counted: %s", w.logs.String())
	}
	// DynamoDB fails part way through the records.
	w.svc.DB = &failingDB{DB: w.client, Allow: 2}
	if err := w.run(account.Job{}); err == nil {
		t.Fatal("no error")
	}
	if left := len(w.partition("user#alice")); left <= 1 || left >= 120 {
		t.Fatalf("expected a partial deletion, %d items left", left)
	}
	// The schedule's next runs finish it.
	w.svc.DB = w.client
	w.mustRun(account.Job{})
	w.now = w.now.Add(account.Settle)
	w.mustRun(account.Job{})
	if left := w.partition("user#alice"); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	if left := w.objects("alice"); len(left) != 0 {
		t.Fatalf("left in the bucket: %v", left)
	}
}

func TestWhatLandsDuringTheDeletionGoesInALaterRun(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	w.mustDelete("alice")
	w.mustRun(account.Job{Kind: account.JobDelete, Sub: "alice"})
	// A calendar run in flight, and an upload whose link was granted just before.
	c := clockAt(w.now)
	if _, err := w.store.Push(context.Background(), "alice", 0, []sync.Change{{Type: "calendar", ID: "calendar", Fields: sync.Fields{"connected": {V: true, C: c}}}}); err != nil {
		t.Fatal(err)
	}
	w.bucket.Put(context.Background(), "u/"+obs.HashSub("alice")+"/late", strings.NewReader("late"), "image/jpeg", "")

	w.now = w.now.Add(account.Settle)
	w.mustRun(account.Job{})
	if left := w.partition("user#alice"); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
	if left := w.objects("alice"); len(left) != 0 {
		t.Fatalf("left in the bucket: %v", left)
	}
}

func TestResumeCarriesOnEveryDeletionUnderWay(t *testing.T) {
	w := newWorld(t)
	for _, sub := range []string{"alice", "bob", "carol"} {
		w.seed(sub, 2)
	}
	w.mustDelete("alice")
	w.mustDelete("carol")
	w.now = w.now.Add(account.Settle)
	w.mustRun(account.Job{})
	for _, sub := range []string{"alice", "carol"} {
		if left := w.partition("user#" + sub); len(left) != 0 {
			t.Fatalf("%s: left %v", sub, left)
		}
	}
	if len(w.partition("user#bob")) == 0 {
		t.Fatal("bob's account went")
	}
}

// A job names a person, but does nothing for one who hasn't asked through their own signed-in request.
func TestAJobForSomeoneWhoDidntAskDoesNothing(t *testing.T) {
	w := newWorld(t)
	w.seed("bob", 2)
	before := w.partition("user#bob")
	w.mustRun(account.Job{Kind: account.JobDelete, Sub: "bob"})
	if got := w.partition("user#bob"); !slices.Equal(got, before) {
		t.Fatalf("bob's items changed: %v", got)
	}
	if exists, _ := w.identity.Exists(context.Background(), "bob"); !exists || len(w.google.forgot) != 0 {
		t.Fatal("bob's sign-in or Google connection was touched")
	}
}

func TestAskingAgainKeepsTheFirstStart(t *testing.T) {
	w := newWorld(t)
	w.seed("alice", 1)
	w.mustDelete("alice")
	w.now = w.now.Add(30 * time.Minute)
	w.mustDelete("alice")
	w.now = w.now.Add(account.Settle - 30*time.Minute)
	w.mustRun(account.Job{})
	if left := w.partition("user#alice"); len(left) != 0 {
		t.Fatalf("left %v", left)
	}
}

func TestADeletionIsCountedNeverNamed(t *testing.T) {
	w := newWorld(t)
	w.seed("alice-sub", 1)
	w.mustDelete("alice-sub")
	w.now = w.now.Add(account.Settle)
	w.mustRun(account.Job{})
	logs := w.logs.String()
	if !strings.Contains(logs, `"AccountsDeleted":1`) {
		t.Fatalf("not counted: %s", logs)
	}
	if strings.Contains(logs, "alice-sub") || strings.Contains(logs, obs.HashSub("alice-sub")) {
		t.Fatalf("a log line names the person: %s", logs)
	}
}
