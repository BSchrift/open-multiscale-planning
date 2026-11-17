package gcal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	gosync "sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamotypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/ssm/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
)

func TestSecretsThroughTheRealSDK(t *testing.T) {
	endpoint := os.Getenv("SSM_ENDPOINT")
	if endpoint == "" {
		t.Skip("SSM_ENDPOINT not set: start Moto to run this test")
	}
	client := ssm.New(ssm.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	ctx := context.Background()
	prefix := fmt.Sprintf("/multiscale/test-%d", time.Now().UnixNano())
	secrets := &SSMSecrets{Client: client, Prefix: prefix}

	if _, err := secrets.Get(ctx, SecretRefreshToken); !errors.Is(err, ErrNoSecret) {
		t.Fatalf("missing: %v", err)
	}
	for _, value := range []string{"first-value", "second-value"} {
		if err := secrets.Put(ctx, SecretRefreshToken, value); err != nil {
			t.Fatal(err)
		}
		got, err := secrets.Get(ctx, SecretRefreshToken)
		if err != nil || got != value {
			t.Fatalf("%q %v", got, err)
		}
	}
	name := prefix + "/" + SecretRefreshToken
	stored, err := client.GetParameter(ctx, &ssm.GetParameterInput{Name: aws.String(name)})
	if err != nil {
		t.Fatal(err)
	}
	if stored.Parameter.Type != types.ParameterTypeSecureString {
		t.Fatalf("stored as %s", stored.Parameter.Type)
	}
	if aws.ToString(stored.Parameter.Value) == "second-value" {
		t.Fatal("read back without decryption gave the plain value")
	}
}

func TestStatesAreSingleUseInDynamoDB(t *testing.T) {
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT not set: start DynamoDB Local to run this test")
	}
	client := dynamodb.New(dynamodb.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	ctx := context.Background()
	table := fmt.Sprintf("states-test-%d", time.Now().UnixNano())
	if err := fakes.CreateTable(ctx, client, table); err != nil {
		t.Fatal(err)
	}
	defer client.DeleteTable(ctx, &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	states := &DynamoStates{DB: client, Table: table}

	if ok, err := states.Consume(ctx, "one", "n1"); ok || err != nil {
		t.Fatalf("nothing stored: %v %v", ok, err)
	}
	if err := states.Put(ctx, "one", "n1"); err != nil {
		t.Fatal(err)
	}
	if ok, err := states.Consume(ctx, "two", "n1"); ok || err != nil {
		t.Fatalf("other user: %v %v", ok, err)
	}
	if ok, err := states.Consume(ctx, "one", "other"); ok || err != nil {
		t.Fatalf("other nonce: %v %v", ok, err)
	}
	if ok, err := states.Consume(ctx, "one", "n1"); !ok || err != nil {
		t.Fatalf("right nonce: %v %v", ok, err)
	}
	if ok, err := states.Consume(ctx, "one", "n1"); ok || err != nil {
		t.Fatalf("second use: %v %v", ok, err)
	}
	if err := states.Put(ctx, "one", "n2"); err != nil {
		t.Fatal(err)
	}
	if err := states.Put(ctx, "one", "n3"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := states.Consume(ctx, "one", "n2"); ok {
		t.Fatal("replaced nonce still works")
	}
}

// Each person's token is stored encrypted by KMS for them alone: a token copied to another person's item doesn't
// decrypt, the table holds no plain token, and a Google account stays with one person.
func TestConnectionsThroughDynamoDBAndKMS(t *testing.T) {
	dynamoEndpoint, motoEndpoint := os.Getenv("DYNAMODB_ENDPOINT"), os.Getenv("SSM_ENDPOINT")
	if dynamoEndpoint == "" || motoEndpoint == "" {
		t.Skip("DYNAMODB_ENDPOINT or SSM_ENDPOINT not set: start DynamoDB Local and Moto to run this test")
	}
	creds := credentials.NewStaticCredentialsProvider("dummy", "dummy", "")
	db := dynamodb.New(dynamodb.Options{Region: "us-west-2", BaseEndpoint: aws.String(dynamoEndpoint), Credentials: creds})
	keys := kms.New(kms.Options{Region: "us-west-2", BaseEndpoint: aws.String(motoEndpoint), Credentials: creds})
	ctx := context.Background()
	table := fmt.Sprintf("connections-test-%d", time.Now().UnixNano())
	if err := fakes.CreateTable(ctx, db, table); err != nil {
		t.Fatal(err)
	}
	defer db.DeleteTable(ctx, &dynamodb.DeleteTableInput{TableName: aws.String(table)})
	key, err := keys.CreateKey(ctx, &kms.CreateKeyInput{})
	if err != nil {
		t.Fatal(err)
	}
	conns := &DynamoConnections{DB: db, Table: table, KMS: keys, KeyID: aws.ToString(key.KeyMetadata.KeyId), Env: "staging", Now: time.Now}

	if _, err := conns.Get(ctx, "a"); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("none yet: %v", err)
	}
	const tokenA, tokenB = "refresh-token-of-a", "refresh-token-of-b"
	if err := conns.Put(ctx, connection{RefreshToken: tokenA, Sub: "a", Account: "acct-1"}, connection{}); err != nil {
		t.Fatal(err)
	}
	if err := conns.Put(ctx, connection{RefreshToken: tokenB, Sub: "b", Account: "acct-2"}, connection{}); err != nil {
		t.Fatal(err)
	}
	got, err := conns.Get(ctx, "a")
	if err != nil || got.RefreshToken != tokenA || got.Account != "acct-1" || got.Sub != "a" {
		t.Fatalf("%+v %v", got, err)
	}
	if has, err := conns.Has(ctx, "a"); !has || err != nil {
		t.Fatalf("has: %v %v", has, err)
	}

	// At rest, nothing in the table is the token.
	raw, err := db.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(table), Key: connectionKey("a")})
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range raw.Item {
		if b, ok := value.(*dynamotypes.AttributeValueMemberB); ok && strings.Contains(string(b.Value), tokenA) {
			t.Fatalf("%s holds the token in the clear", name)
		}
		if s, ok := value.(*dynamotypes.AttributeValueMemberS); ok && strings.Contains(s.Value, tokenA) {
			t.Fatalf("%s holds the token in the clear", name)
		}
	}

	// A's sealed token copied into B's item doesn't decrypt as B's.
	_, err = db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(table), Key: connectionKey("b"),
		UpdateExpression:          aws.String("SET #token = :token"),
		ExpressionAttributeNames:  map[string]string{"#token": "token"},
		ExpressionAttributeValues: map[string]dynamotypes.AttributeValue{":token": raw.Item["token"]},
	})
	if err != nil {
		t.Fatal(err)
	}
	if swapped, err := conns.Get(ctx, "b"); err == nil || swapped.RefreshToken == tokenA || strings.Contains(err.Error(), tokenA) {
		t.Fatalf("decrypted for the wrong person: %+v %v", swapped, err)
	}
	// What the swap left is still what's stored, so a new consent goes over it without opening it.
	swappedB, err := conns.Peek(ctx, "b")
	if err != nil {
		t.Fatal(err)
	}
	if err := conns.Put(ctx, connection{RefreshToken: tokenB, Sub: "b", Account: "acct-2"}, swappedB); err != nil {
		t.Fatal(err)
	}
	// Nor does it open for the same person in another environment.
	other := *conns
	other.Env = "prod"
	if _, err := other.Get(ctx, "a"); err == nil {
		t.Fatal("decrypted for another environment")
	}

	// The migration's copy goes in only where its person has none.
	if _, err := conns.PutNew(ctx, connection{RefreshToken: "copy", Sub: "a", Account: "acct-1"}); !errors.Is(err, errConnectionChanged) {
		t.Fatalf("copy over a connection: %v", err)
	}
	if got, _ := conns.Get(ctx, "a"); got.RefreshToken != tokenA {
		t.Fatalf("replaced by the copy: %+v", got)
	}
	sealed, err := conns.PutNew(ctx, connection{RefreshToken: "copy", Sub: "d", Account: "acct-4"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := conns.Get(ctx, "d"); got.RefreshToken != "copy" || string(got.sealed) != string(sealed) {
		t.Fatalf("%+v", got)
	}
	if err := conns.Delete(ctx, connection{Sub: "d", Account: "acct-4", sealed: sealed}); err != nil {
		t.Fatal(err)
	}

	// One person to a Google account.
	if holder, err := conns.Holder(ctx, "acct-1"); holder != "a" || err != nil {
		t.Fatalf("holder %q %v", holder, err)
	}
	if err := conns.Put(ctx, connection{RefreshToken: "c's", Sub: "c", Account: "acct-1"}, connection{}); !errors.Is(err, api.ErrAccountTaken) {
		t.Fatalf("second person: %v", err)
	}
	if _, err := conns.Get(ctx, "c"); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("refused person stored: %v", err)
	}

	// Moving to another account frees the first.
	// A put over a connection that has changed since it was read is refused; over the one read, it goes in.
	if err := conns.Put(ctx, connection{RefreshToken: tokenA + "-2", Sub: "a", Account: "acct-3"}, connection{}); !errors.Is(err, errConnectionChanged) {
		t.Fatalf("put over an unread connection: %v", err)
	}
	readA, _ := conns.Peek(ctx, "a")
	if readA.RefreshToken != "" || readA.Account != "acct-1" {
		t.Fatalf("peek opened the token or lost the account: %+v", readA)
	}
	if err := conns.Put(ctx, connection{RefreshToken: tokenA + "-2", Sub: "a", Account: "acct-3"}, readA); err != nil {
		t.Fatal(err)
	}
	if holder, _ := conns.Holder(ctx, "acct-1"); holder != "" {
		t.Fatalf("acct-1 still held by %q", holder)
	}

	var subs []string
	if err := conns.Each(ctx, func(sub string) error { subs = append(subs, sub); return nil }); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(subs, []string{"a", "b"}) {
		t.Fatalf("each: %v", subs)
	}

	// Marked revoked, it's kept, sealed, but out of the schedule's list and not counted as connected; a stale mark misses.
	readB, _ := conns.Peek(ctx, "b")
	if err := conns.MarkRevoked(ctx, readB); err != nil {
		t.Fatal(err)
	}
	if got, _ := conns.Get(ctx, "b"); !got.Revoked || got.RefreshToken != tokenB {
		t.Fatalf("revoked: %+v", got)
	}
	if has, _ := conns.Has(ctx, "b"); has {
		t.Fatal("a revoked connection counts as connected")
	}
	var listed []string
	conns.Each(ctx, func(sub string) error { listed = append(listed, sub); return nil })
	if slices.Contains(listed, "b") {
		t.Fatalf("each: %v", listed)
	}
	if err := conns.Put(ctx, connection{RefreshToken: tokenB + "-2", Sub: "b", Account: "acct-2"}, readB); err != nil {
		t.Fatal(err)
	}
	if err := conns.MarkRevoked(ctx, readB); err != nil {
		t.Fatal(err)
	}
	if got, _ := conns.Get(ctx, "b"); got.Revoked {
		t.Fatal("a stale mark landed on a new consent")
	}

	// A decrypt names the key, so a token sealed by another key doesn't open.
	otherKey, err := keys.CreateKey(ctx, &kms.CreateKeyInput{})
	if err != nil {
		t.Fatal(err)
	}
	rekeyed := *conns
	rekeyed.KeyID = aws.ToString(otherKey.KeyMetadata.KeyId)
	if got, err := rekeyed.Get(ctx, "b"); err == nil {
		t.Fatalf("opened with another key: %+v", got)
	}

	// A delete of a connection read before a reconnect leaves the new one.
	stale, _ := conns.Get(ctx, "a")
	if err := conns.Put(ctx, connection{RefreshToken: tokenA + "-3", Sub: "a", Account: "acct-3"}, stale); err != nil {
		t.Fatal(err)
	}
	if err := conns.Delete(ctx, stale); !errors.Is(err, errConnectionChanged) {
		t.Fatalf("stale delete: %v", err)
	}
	current, _ := conns.Get(ctx, "a")
	if current.RefreshToken != tokenA+"-3" {
		t.Fatalf("%+v", current)
	}
	if err := conns.Delete(ctx, current); err != nil {
		t.Fatal(err)
	}
	if err := conns.Delete(ctx, current); err != nil {
		t.Fatalf("again: %v", err)
	}
	if has, _ := conns.Has(ctx, "a"); has {
		t.Fatal("still there")
	}
	if holder, _ := conns.Holder(ctx, "acct-3"); holder != "" {
		t.Fatalf("account kept by %q", holder)
	}
}

type fakeSQS struct {
	mu      gosync.Mutex
	sent    map[string]int32
	batches int
	// refuse fails each body this many times.
	refuse map[string]int
}

func (f *fakeSQS) SendMessageBatch(_ context.Context, in *sqs.SendMessageBatchInput, _ ...func(*sqs.Options)) (*sqs.SendMessageBatchOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches++
	if len(in.Entries) > 10 {
		return nil, errors.New("too many entries")
	}
	out := &sqs.SendMessageBatchOutput{}
	for _, e := range in.Entries {
		body := aws.ToString(e.MessageBody)
		if f.refuse[body] > 0 {
			f.refuse[body]--
			out.Failed = append(out.Failed, sqstypes.BatchResultErrorEntry{Id: e.Id, Code: aws.String("InternalError")})
			continue
		}
		f.sent[body] = e.DelaySeconds
	}
	return out, nil
}

// The schedule's jobs go ten to a request, each with its delay, and a job SQS didn't take is sent once more.
func TestQueueSendsInBatchesWithDelaysAndRetriesWhatWasntTaken(t *testing.T) {
	client := &fakeSQS{sent: map[string]int32{}, refuse: map[string]int{`{"sub":"p7","trigger":"schedule"}`: 1}}
	q := &SQSQueue{Client: client, URL: "queue"}
	var jobs []Job
	for i := range 25 {
		jobs = append(jobs, Job{Sub: fmt.Sprintf("p%d", i), Trigger: "schedule", Delay: time.Duration(i) * time.Minute})
	}
	if err := q.Send(context.Background(), jobs); err != nil {
		t.Fatal(err)
	}
	if len(client.sent) != 25 || client.batches != 4 {
		t.Fatalf("%d sent in %d batches", len(client.sent), client.batches)
	}
	if client.sent[`{"sub":"p3","trigger":"schedule"}`] != 180 {
		t.Fatalf("%v", client.sent)
	}

	client.refuse[`{"sub":"p1","trigger":"schedule"}`] = 2
	if err := q.Send(context.Background(), jobs[:2]); err == nil {
		t.Fatal("a job SQS never took was dropped silently")
	}
}

// Every run needs the client's secrets, so they're kept for a while; never the legacy connection, which a disconnect can
// delete at any moment.
func TestCachedSecretsKeepTheClientButNeverTheLegacyConnection(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	inner := &memSecrets{values: map[string]string{SecretClientID: "cid", SecretRefreshToken: "legacy"}}
	cached := &cachedSecrets{Secrets: inner, ttl: 5 * time.Minute, now: func() time.Time { return now }, values: map[string]cachedSecret{}}
	ctx := context.Background()
	cached.Get(ctx, SecretClientID)
	inner.values[SecretClientID] = "rotated"
	if got, _ := cached.Get(ctx, SecretClientID); got != "cid" {
		t.Fatalf("not kept: %q", got)
	}
	now = now.Add(5 * time.Minute)
	if got, _ := cached.Get(ctx, SecretClientID); got != "rotated" {
		t.Fatalf("kept too long: %q", got)
	}
	cached.Get(ctx, SecretRefreshToken)
	delete(inner.values, SecretRefreshToken)
	if _, err := cached.Get(ctx, SecretRefreshToken); !errors.Is(err, ErrNoSecret) {
		t.Fatalf("legacy connection kept: %v", err)
	}
}
