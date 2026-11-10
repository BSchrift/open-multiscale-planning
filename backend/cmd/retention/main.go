// The retention Lambda. DynamoDB's TTL removes expired records; this reads each removal from the table's stream and
// raises the user's expiry mark, so a device that never saw a removed record is reset, and takes a removed attachment's
// file with it. See internal/sync/expiry.go for why TTL and Streams rather than a job. On staging, whose periods are
// minutes, a schedule also runs the cleanup there, which removes what TTL hasn't reached yet, files included.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-lambda-go/lambdacontext"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/files"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	env := os.Getenv("ENV_NAME")
	retention, err := appconfig.LoadRetention(env)
	if err != nil {
		log.Fatal(err)
	}
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	db := dynamodb.NewFromConfig(cfg)
	table, logger := os.Getenv("TABLE_NAME"), obs.NewLogger(os.Stdout)
	// Nil where the environment stores no files.
	remover := files.RemoverFromEnvironment(cfg, db)
	var cleanup *sync.Cleanup
	if retention.Cleanup != nil {
		cleanup = &sync.Cleanup{DB: db, Table: table, Now: time.Now, Log: logger, Env: env, ReadUnitsPerSecond: retention.CleanupReadUnitsPerSecond}
		if remover != nil {
			cleanup.Removing = remover.Removing
		}
	}
	lambda.Start(func(ctx context.Context, payload json.RawMessage) error {
		requestID := ""
		if lc, ok := lambdacontext.FromContext(ctx); ok {
			requestID = lc.AwsRequestID
		}
		var stream events.DynamoDBEvent
		if json.Unmarshal(payload, &stream) == nil && len(stream.Records) > 0 {
			marks := marksFrom(stream.Records)
			for pk, seq := range marks {
				// An error retries the batch, which only raises marks again.
				if err := sync.RaiseMark(ctx, db, table, pk, seq, time.Now()); err != nil {
					logger.Info("marks", "request_id", requestID, "outcome", "failed", "records", len(stream.Records))
					return err
				}
			}
			if remover != nil {
				for _, removed := range attachmentsFrom(stream.Records) {
					// The same: a retried batch finds the files already gone and moves on.
					if err := remover.Removing(ctx, removed[0], removed[1]); err != nil {
						logger.Info("marks", "request_id", requestID, "outcome", "failed", "records", len(stream.Records), "error_type", "file_removal")
						return err
					}
				}
			}
			logger.Info("marks", "request_id", requestID, "outcome", "ok", "records", len(stream.Records), "users", len(marks))
			return nil
		}
		if cleanup == nil {
			return errors.New("retention: no cleanup in " + env)
		}
		_, err := cleanup.Run(ctx, requestID)
		return err
	})
}

// marksFrom is the highest sequence number TTL removed for each user, from a batch of stream records.
func marksFrom(records []events.DynamoDBEventRecord) map[string]int64 {
	marks := map[string]int64{}
	for _, record := range records {
		pk, _, seq, ok := expired(record)
		if ok && seq > marks[pk] {
			marks[pk] = seq
		}
	}
	return marks
}

// attachmentsFrom is the pk and sk of each attachment's record TTL removed, whose file goes with it.
func attachmentsFrom(records []events.DynamoDBEventRecord) [][2]string {
	var removed [][2]string
	for _, record := range records {
		if pk, sk, _, ok := expired(record); ok && strings.HasPrefix(sk, "rec#attachment#") {
			removed = append(removed, [2]string{pk, sk})
		}
	}
	return removed
}

// expired reads a record TTL removed: its user, sort key and sequence number. The event source passes only TTL's
// removals, and this checks again, since anything else deleting a record isn't expiry.
func expired(record events.DynamoDBEventRecord) (string, string, int64, bool) {
	who := record.UserIdentity
	if record.EventName != "REMOVE" || who == nil || who.Type != "Service" || who.PrincipalID != "dynamodb.amazonaws.com" {
		return "", "", 0, false
	}
	pk, sk, seq := record.Change.OldImage["pk"], record.Change.OldImage["sk"], record.Change.OldImage["seq"]
	if pk.DataType() != events.DataTypeString || sk.DataType() != events.DataTypeString || seq.DataType() != events.DataTypeNumber {
		return "", "", 0, false
	}
	if !strings.HasPrefix(pk.String(), "user#") || !strings.HasPrefix(sk.String(), "rec#") {
		return "", "", 0, false
	}
	n, err := strconv.ParseInt(seq.Number(), 10, 64)
	return pk.String(), sk.String(), n, err == nil
}
