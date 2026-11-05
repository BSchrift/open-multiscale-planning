package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	stdsync "sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodbstreams"
	streamtypes "github.com/aws/aws-sdk-go-v2/service/dynamodbstreams/types"
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

// buildCalendar wires the worker to Moto and the Google stand-in, with this server standing in for its triggers.
func buildCalendar(ctx context.Context, cfg config, client *dynamodb.Client, store *sync.Store, clock *fakes.Clock, logs io.Writer) (*gcal.Google, *calendarLoop, *fakes.Google, error) {
	const clientID, clientSecret = "local-google-client", "local-google-secret"
	secrets := &gcal.SSMSecrets{
		Client: ssm.New(ssm.Options{
			Region: "us-west-2", BaseEndpoint: aws.String(cfg.SSMEndpoint),
			Credentials: credentials.NewStaticCredentialsProvider("dummy", "dummy", ""),
		}),
		Prefix: cfg.SSMPrefix,
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
			iterators: map[string]*string{}, closed: map[string]bool{},
		},
	}
	google := &gcal.Google{
		Records: store, Secrets: secrets, States: &gcal.DynamoStates{DB: client, Table: cfg.Table},
		Log: obs.NewLogger(logs), Env: cfg.Env, Now: clock.Now,
		AuthURL: base + "/google/o/oauth2/auth", TokenURL: base + "/google/token", RevokeURL: base + "/google/revoke", APIURL: base + "/google/calendar/v3/",
		RedirectURL: base + "/calendar/callback",
		Trigger:     func(ctx context.Context) error { return loop.run(ctx, "refresh") },
	}
	loop.worker = google
	return google, loop, fakes.NewGoogle(clientID, clientSecret, clock.Now), nil
}

// calendarLoop decides when the worker runs, from the local stream and the clock a test controls.
type calendarLoop struct {
	worker *gcal.Google
	stream *streamReader
	now    func() time.Time

	mu           stdsync.Mutex
	pendingSince time.Time
	lastRun      time.Time
}

func (l *calendarLoop) run(ctx context.Context, trigger string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.runLocked(ctx, trigger)
}

func (l *calendarLoop) runLocked(ctx context.Context, trigger string) error {
	l.lastRun, l.pendingSince = l.now(), time.Time{}
	return l.worker.Run(ctx, trigger, "")
}

// tick runs the worker if a trigger is due, and returns which one ran.
func (l *calendarLoop) tick(ctx context.Context) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	woken, err := l.stream.poll(ctx)
	if err != nil {
		return "", err
	}
	now := l.now()
	if woken && l.pendingSince.IsZero() {
		l.pendingSince = now
	}
	trigger := ""
	switch {
	case !l.pendingSince.IsZero() && now.Sub(l.pendingSince) >= streamWindow:
		trigger = "stream"
	case now.Sub(l.lastRun) >= scheduleInterval:
		trigger = "schedule"
	}
	if trigger == "" {
		return "", nil
	}
	return trigger, l.runLocked(ctx, trigger)
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
	tables    *dynamodb.Client
	tableName string
	client    *dynamodbstreams.Client
	iterators map[string]*string
	closed    map[string]bool
}

func wakesWorker(record streamtypes.Record) bool {
	if record.Dynamodb == nil {
		return false
	}
	sk, ok := record.Dynamodb.Keys["sk"].(*streamtypes.AttributeValueMemberS)
	return ok && (strings.HasPrefix(sk.Value, "rec#time_block#") || strings.HasPrefix(sk.Value, "rec#calendar_source#"))
}

// poll reads all new stream records and reports whether any should wake the worker.
func (s *streamReader) poll(ctx context.Context) (bool, error) {
	described, err := s.tables.DescribeTable(ctx, &dynamodb.DescribeTableInput{TableName: aws.String(s.tableName)})
	if err != nil {
		return false, err
	}
	stream, err := s.client.DescribeStream(ctx, &dynamodbstreams.DescribeStreamInput{StreamArn: described.Table.LatestStreamArn})
	if err != nil {
		return false, err
	}
	woken := false
	for _, shard := range stream.StreamDescription.Shards {
		id := aws.ToString(shard.ShardId)
		if s.closed[id] {
			continue
		}
		iterator, seen := s.iterators[id]
		if !seen {
			out, err := s.client.GetShardIterator(ctx, &dynamodbstreams.GetShardIteratorInput{
				StreamArn: described.Table.LatestStreamArn, ShardId: shard.ShardId, ShardIteratorType: streamtypes.ShardIteratorTypeTrimHorizon,
			})
			if err != nil {
				return false, err
			}
			iterator = out.ShardIterator
		}
		for iterator != nil {
			out, err := s.client.GetRecords(ctx, &dynamodbstreams.GetRecordsInput{ShardIterator: iterator})
			if err != nil {
				return false, err
			}
			for _, record := range out.Records {
				woken = woken || wakesWorker(record)
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
