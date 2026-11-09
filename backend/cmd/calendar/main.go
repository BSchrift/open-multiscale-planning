// The calendar worker Lambda. Whatever wakes it, it does the same run.
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-lambda-go/lambdacontext"
	"github.com/aws/aws-sdk-go-v2/config"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/gcal"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	// A wrong ENV_NAME stops the worker as it starts, not at the first run that needs its settings.
	if _, err := appconfig.ForEnv(os.Getenv("ENV_NAME")); err != nil {
		log.Fatal(err)
	}
	retention, err := appconfig.LoadRetention(os.Getenv("ENV_NAME"))
	if err != nil {
		log.Fatal(err)
	}
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	worker := gcal.FromEnvironment(cfg, &sync.Expiry{Now: time.Now, Deleted: retention.Deleted}, nil)
	lambda.Start(func(ctx context.Context, payload json.RawMessage) error {
		requestID := ""
		if lc, ok := lambdacontext.FromContext(ctx); ok {
			requestID = lc.AwsRequestID
		}
		return worker.Run(ctx, triggerOf(payload), requestID)
	})
}

// triggerOf names what woke the worker, for its log line.
func triggerOf(payload json.RawMessage) string {
	var event struct {
		Records []json.RawMessage `json:"Records"`
		Trigger string            `json:"trigger"`
	}
	json.Unmarshal(payload, &event)
	switch {
	case len(event.Records) > 0:
		return "stream"
	case event.Trigger == "refresh":
		return "refresh"
	}
	return "schedule"
}
