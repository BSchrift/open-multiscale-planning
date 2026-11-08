// The retention Lambda. DynamoDB's TTL removes expired records; this reads each removal from the table's stream and
// raises the user's expiry mark, so a device that never saw a removed record is reset. See internal/sync/expiry.go for
// why TTL and Streams rather than a job. On staging, whose periods are minutes, a schedule also runs the cleanup there,
// which removes what TTL hasn't reached yet.
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
	var cleanup *sync.Cleanup
	if retention.Cleanup != nil {
		cleanup = &sync.Cleanup{DB: db, Table: table, Now: time.Now, Log: logger, Env: env}
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

// marksFrom is the highest sequence number TTL removed for each user, from a batch of stream records. The event source
// passes only TTL's removals, and this checks again, since anything else deleting a record isn't expiry.
func marksFrom(records []events.DynamoDBEventRecord) map[string]int64 {
	marks := map[string]int64{}
	for _, record := range records {
		who := record.UserIdentity
		if record.EventName != "REMOVE" || who == nil || who.Type != "Service" || who.PrincipalID != "dynamodb.amazonaws.com" {
			continue
		}
		pk, sk, seq := record.Change.OldImage["pk"], record.Change.OldImage["sk"], record.Change.OldImage["seq"]
		if pk.DataType() != events.DataTypeString || sk.DataType() != events.DataTypeString || seq.DataType() != events.DataTypeNumber {
			continue
		}
		if !strings.HasPrefix(pk.String(), "user#") || !strings.HasPrefix(sk.String(), "rec#") {
			continue
		}
		n, err := strconv.ParseInt(seq.Number(), 10, 64)
		if err == nil && n > marks[pk.String()] {
			marks[pk.String()] = n
		}
	}
	return marks
}
