package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	stdsync "sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodbstreams"
	streamtypes "github.com/aws/aws-sdk-go-v2/service/dynamodbstreams/types"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/fakes"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/gcal"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

const (
	// The deployed triggers: the stream's batch window and the schedule.
	streamWindow     = 60 * time.Second
	scheduleInterval = 30 * time.Minute
)

// buildCalendar wires the worker to Moto and the Google stand-in, with this server standing in for its triggers and its
// queue. Moto stands in for KMS too, with a key made at start.
func buildCalendar(ctx context.Context, cfg config, client *dynamodb.Client, store *sync.Store, clock *fakes.Clock, logs io.Writer) (*gcal.Google, *calendarLoop, *fakes.Google, error) {
	const clientID, clientSecret = "local-google-client", "local-google-secret"
	secrets := &gcal.SSMSecrets{
		Client: ssm.New(ssm.Options{
			Region: "us-west-2", BaseEndpoint: aws.String(cfg.SSMEndpoint),
			Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
		}),
		Prefix: cfg.SSMPrefix,
	}
	keys := kms.New(kms.Options{
		Region: "us-west-2", BaseEndpoint: aws.String(cfg.SSMEndpoint),
		Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
	})
	tokenKey, err := keys.CreateKey(ctx, &kms.CreateKeyInput{Description: aws.String("local Google tokens")})
	if err != nil {
		return nil, nil, nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, nil, nil, err
	}
	for name, value := range map[string]string{
		gcal.SecretClientID: clientID, gcal.SecretClientSecret: clientSecret, gcal.SecretState: hex.EncodeToString(key),
	} {
		if err := secrets.Put(ctx, name, value); err != nil {
			return nil, nil, nil, err
		}
	}

	base := strings.TrimSuffix(cfg.Issuer, "/cognito")
	loop := &calendarLoop{
		now: clock.Now, lastRun: clock.Now(),
		stream: &streamReader{
			tables: client, tableName: cfg.Table,
			client: dynamodbstreams.New(dynamodbstreams.Options{
				Region: "us-west-2", BaseEndpoint: aws.String(cfg.Endpoint),
				Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
			}),
			iterators: map[string]*string{}, closed: map[string]bool{}, last: map[string]*string{},
		},
		pending: map[string]time.Time{}, retryAt: map[string]time.Time{},
	}
	google := &gcal.Google{
		Records: store, Secrets: secrets, States: &gcal.DynamoStates{DB: client, Table: cfg.Table},
		Connections: &gcal.DynamoConnections{DB: client, Table: cfg.Table, KMS: keys, KeyID: aws.ToString(tokenKey.KeyMetadata.KeyId), Env: cfg.Env, Now: clock.Now},
		Log:         obs.NewLogger(logs), Env: cfg.Env, Now: clock.Now,
		AuthURL: base + "/google/o/oauth2/auth", TokenURL: base + "/google/token", RevokeURL: base + "/google/revoke", APIURL: base + "/google/calendar/v3/",
		RedirectURL: base + "/calendar/callback",
		Trigger:     func(ctx context.Context, sub string) error { return loop.run(ctx, sub, "refresh") },
		Queue:       loop,
		Retry:       loop.retryAfter,
	}
	loop.worker = google
	return google, loop, fakes.NewGoogle(clientID, clientSecret, clock.Now), nil
}

// calendarLoop decides when each person's run happens, from the local stream and the clock a test controls. It is the
// worker's queue too, running each job at once rather than after its delay, so the schedule's spread doesn't wait on the
// test's clock; only a retry waits, for a tick after its time.
type calendarLoop struct {
	worker *gcal.Google
	stream *streamReader
	now    func() time.Time

	mu stdsync.Mutex
	// pending is when each person's first change since their last run arrived.
	pending map[string]time.Time
	retryAt map[string]time.Time
	// lastRun is the last run of anyone's. Any run puts the schedule off, as it did with one connection, so a test's held
	// clock decides when the schedule comes.
	lastRun time.Time
	// runs counts runs, so a tick can tell whether the stream's wake ran anyone.
	runs int
}

func (l *calendarLoop) run(ctx context.Context, sub, trigger string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.runLocked(ctx, sub, trigger)
}

// runLocked runs one person. Any run of theirs does what a waiting retry or stream run would, so it takes their place.
func (l *calendarLoop) runLocked(ctx context.Context, sub, trigger string) error {
	l.lastRun = l.now()
	l.runs++
	delete(l.pending, sub)
	delete(l.retryAt, sub)
	return l.worker.Run(ctx, sub, trigger, "")
}

// Send runs the jobs the worker queues, from inside a tick, which already holds l.mu.
func (l *calendarLoop) Send(ctx context.Context, jobs []gcal.Job) error {
	for _, job := range jobs {
		if err := l.runLocked(ctx, job.Sub, job.Trigger); err != nil {
			return err
		}
	}
	return nil
}

// retryAfter has a tick run the person again once after has passed. The worker asks from inside a run, which already
// holds l.mu.
func (l *calendarLoop) retryAfter(_ context.Context, sub string, after time.Duration) error {
	l.retryAt[sub] = l.now().Add(after)
	return nil
}

// tick runs whatever is due, the stream's runs first, then retries, then the schedule, and returns which kind ran.
func (l *calendarLoop) tick(ctx context.Context) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	woken, err := l.stream.poll(ctx)
	if err != nil {
		return "", err
	}
	now := l.now()
	for _, sub := range woken {
		if _, waiting := l.pending[sub]; !waiting {
			l.pending[sub] = now
		}
	}
	due := func(times map[string]time.Time, after time.Duration) []string {
		var subs []string
		for sub, at := range times {
			if !now.Before(at.Add(after)) {
				subs = append(subs, sub)
			}
		}
		slices.Sort(subs)
		return subs
	}
	// A wake for people no longer connected runs no one, and counts as nothing having run.
	if subs := due(l.pending, streamWindow); len(subs) > 0 {
		for _, sub := range subs {
			delete(l.pending, sub)
		}
		before := l.runs
		if err := l.worker.Wake(ctx, subs, ""); err != nil || l.runs > before {
			return gcal.TriggerStream, err
		}
	}
	if subs := due(l.retryAt, 0); len(subs) > 0 {
		for _, sub := range subs {
			if err := l.runLocked(ctx, sub, gcal.TriggerRetry); err != nil {
				return gcal.TriggerRetry, err
			}
		}
		return gcal.TriggerRetry, nil
	}
	if now.Sub(l.lastRun) >= scheduleInterval {
		l.lastRun = now
		return "schedule", l.worker.Dispatch(ctx, "schedule", "")
	}
	return "", nil
}

func (l *calendarLoop) tickEvery(every time.Duration) {
	for range time.Tick(every) {
		if _, err := l.tick(context.Background()); err != nil {
			log.Printf("calendar tick: %v", err)
		}
	}
}

// tickHandler lets a test run what's due now rather than wait for the background tick.
func (l *calendarLoop) tickHandler(w http.ResponseWriter, r *http.Request) {
	ran, err := l.tick(r.Context())
	if err != nil {
		http.Error(w, "tick failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"ran": ran})
}

// streamReader follows the table's stream through every shard, keeping what the deployed trigger's filter keeps.
type streamReader struct {
	tables    tableDescriber
	tableName string
	client    streamsAPI
	iterators map[string]*string
	closed    map[string]bool
	// last is the sequence number of the last record read from each shard, where a new iterator carries on from.
	last map[string]*string
}

// tableDescriber is the part of DynamoDB the reader uses, to find the table's stream.
type tableDescriber interface {
	DescribeTable(context.Context, *dynamodb.DescribeTableInput, ...func(*dynamodb.Options)) (*dynamodb.DescribeTableOutput, error)
}

// streamsAPI is the part of DynamoDB Streams the reader uses.
type streamsAPI interface {
	DescribeStream(context.Context, *dynamodbstreams.DescribeStreamInput, ...func(*dynamodbstreams.Options)) (*dynamodbstreams.DescribeStreamOutput, error)
	GetShardIterator(context.Context, *dynamodbstreams.GetShardIteratorInput, ...func(*dynamodbstreams.Options)) (*dynamodbstreams.GetShardIteratorOutput, error)
	GetRecords(context.Context, *dynamodbstreams.GetRecordsInput, ...func(*dynamodbstreams.Options)) (*dynamodbstreams.GetRecordsOutput, error)
}

// wakePrefixes are the deployed filter's: the worker's inputs, never the calendar record it writes.
var wakePrefixes = []string{"rec#time_block#", "rec#task#", "rec#practice#", "rec#calendar_source#"}

// wakesWorker returns whose record a stream record changed, if it is one that wakes the worker.
func wakesWorker(record streamtypes.Record) (string, bool) {
	if record.Dynamodb == nil {
		return "", false
	}
	pk, _ := record.Dynamodb.Keys["pk"].(*streamtypes.AttributeValueMemberS)
	sk, ok := record.Dynamodb.Keys["sk"].(*streamtypes.AttributeValueMemberS)
	if pk == nil || !ok || !slices.ContainsFunc(wakePrefixes, func(prefix string) bool { return strings.HasPrefix(sk.Value, prefix) }) {
		return "", false
	}
	return strings.CutPrefix(pk.Value, "user#")
}

// poll reads all new stream records and returns whose should wake the worker.
func (s *streamReader) poll(ctx context.Context) ([]string, error) {
	described, err := s.tables.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(s.tableName)})
	if err != nil {
		return nil, err
	}
	stream, err := s.client.DescribeStream(ctx, &dynamodbstreams.DescribeStreamInput{StreamArn: described.Table.LatestStreamArn})
	if err != nil {
		return nil, err
	}
	var woken []string
	for _, shard := range stream.StreamDescription.Shards {
		id := aws.ToString(shard.ShardId)
		if s.closed[id] {
			continue
		}
		iterator, seen := s.iterators[id]
		if !seen {
			if iterator, err = s.open(ctx, described.Table.LatestStreamArn, shard.ShardId, nil); err != nil {
				return nil, err
			}
		}
		reopened := false
		for iterator != nil {
			out, err := s.client.GetRecords(ctx, &dynamodbstreams.GetRecordsInput{ShardIterator: iterator})
			// An iterator lasts 15 minutes, which a laptop's sleep outlasts, so one is opened again after the last record
			// read. Once per poll: a new one that expires at once is something else.
			var expired *streamtypes.ExpiredIteratorException
			if errors.As(err, &expired) && !reopened {
				reopened = true
				if iterator, err = s.open(ctx, described.Table.LatestStreamArn, shard.ShardId, s.last[id]); err != nil {
					return nil, err
				}
				continue
			}
			if err != nil {
				return nil, err
			}
			for _, record := range out.Records {
				if sub, ok := wakesWorker(record); ok && !slices.Contains(woken, sub) {
					woken = append(woken, sub)
				}
				if record.Dynamodb != nil && record.Dynamodb.SequenceNumber != nil {
					s.last[id] = record.Dynamodb.SequenceNumber
				}
			}
			iterator = out.NextShardIterator
			if len(out.Records) == 0 {
				break
			}
		}
		if iterator == nil {
			s.closed[id] = true
		}
		s.iterators[id] = iterator
	}
	return woken, nil
}

// open returns an iterator on a shard from just after the record numbered after, or from its start when nothing has
// been read from it.
func (s *streamReader) open(ctx context.Context, stream, shard, after *string) (*string, error) {
	in := &dynamodbstreams.GetShardIteratorInput{StreamArn: stream, ShardId: shard, ShardIteratorType: streamtypes.ShardIteratorTypeTrimHorizon}
	if after != nil {
		in.ShardIteratorType, in.SequenceNumber = streamtypes.ShardIteratorTypeAfterSequenceNumber, after
	}
	out, err := s.client.GetShardIterator(ctx, in)
	if err != nil {
		return nil, err
	}
	return out.ShardIterator, nil
}
