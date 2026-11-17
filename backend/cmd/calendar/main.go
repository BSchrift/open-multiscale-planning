// The calendar worker Lambda. The schedule and the stream start people's runs through its queue, and the queue and the
// API run them: one run for one person.
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"slices"
	"strings"
	gosync "sync"
	"time"

	"github.com/aws/aws-lambda-go/events"
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
	worker := gcal.FromEnvironment(cfg, &sync.Expiry{Now: time.Now, Deleted: retention.Deleted})
	lambda.Start(func(ctx context.Context, payload json.RawMessage) (any, error) {
		requestID := ""
		if lc, ok := lambdacontext.FromContext(ctx); ok {
			requestID = lc.AwsRequestID
		}
		return handle(ctx, worker, payload, requestID)
	})
}

// worker is the part of gcal.Google the handler uses.
type worker interface {
	Run(ctx context.Context, sub, trigger, requestID string) error
	Dispatch(ctx context.Context, trigger, requestID string) error
	Wake(ctx context.Context, subs []string, requestID string) error
}

// event is any of what wakes the worker: the queue's or the stream's records, the API's refresh, or the schedule.
type event struct {
	Records []struct {
		EventSource string `json:"eventSource"`
		MessageID   string `json:"messageId"`
		Body        string `json:"body"`
		Dynamodb    struct {
			Keys map[string]struct {
				S string `json:"S"`
			} `json:"Keys"`
		} `json:"dynamodb"`
	} `json:"Records"`
	Trigger string `json:"trigger"`
	Sub     string `json:"sub"`
}

func handle(ctx context.Context, w worker, payload json.RawMessage, requestID string) (any, error) {
	var e event
	json.Unmarshal(payload, &e)
	switch {
	case len(e.Records) > 0 && e.Records[0].EventSource == "aws:sqs":
		return runQueued(ctx, w, e, requestID), nil
	case len(e.Records) > 0:
		var subs []string
		for _, record := range e.Records {
			if sub, ok := strings.CutPrefix(record.Dynamodb.Keys["pk"].S, "user#"); ok && !slices.Contains(subs, sub) {
				subs = append(subs, sub)
			}
		}
		return nil, w.Wake(ctx, subs, requestID)
	case e.Trigger == "refresh" && e.Sub != "":
		return nil, w.Run(ctx, e.Sub, "refresh", requestID)
	}
	return nil, w.Dispatch(ctx, "schedule", requestID)
}

// runQueued runs each person in a batch at once, so one person's slow Google holds up no one else, and hands back to the
// queue only the runs that failed in a way they couldn't record. A body that isn't a job is dropped: no retry fixes it.
// A person queued twice runs once, under the first job's trigger.
func runQueued(ctx context.Context, w worker, e event, requestID string) events.SQSEventResponse {
	var (
		mu       gosync.Mutex
		wg       gosync.WaitGroup
		response = events.SQSEventResponse{BatchItemFailures: []events.SQSBatchItemFailure{}}
	)
	seen := map[string]bool{}
	for _, record := range e.Records {
		var job gcal.Job
		if err := json.Unmarshal([]byte(record.Body), &job); err != nil || job.Sub == "" {
			log.Printf("calendar: dropped a queued message that isn't a job")
			continue
		}
		// One run does what any of a person's jobs in the batch would, and two at once would race each other.
		if seen[job.Sub] {
			continue
		}
		seen[job.Sub] = true
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := w.Run(ctx, job.Sub, job.Trigger, requestID); err != nil {
				mu.Lock()
				response.BatchItemFailures = append(response.BatchItemFailures, events.SQSBatchItemFailure{ItemIdentifier: record.MessageID})
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return response
}
