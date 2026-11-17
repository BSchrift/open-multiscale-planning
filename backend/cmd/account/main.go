// The account function: builds an export, or carries a deletion on, as the API asks, and every few minutes, from its
// schedule, carries on every deletion under way. See internal/account.
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/gcal"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	env := os.Getenv("ENV_NAME")
	if _, err := appconfig.ForEnv(env); err != nil {
		log.Fatal(err)
	}
	retention, err := appconfig.LoadRetention(env)
	if err != nil {
		log.Fatal(err)
	}
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	db := dynamodb.NewFromConfig(cfg)
	store := &sync.Store{DB: db, Table: os.Getenv("TABLE_NAME"), Expiry: &sync.Expiry{Now: time.Now, Deleted: retention.Deleted}}
	svc := &account.Service{
		DB: db, Table: store.Table, Records: store, Identity: account.IdentityFromEnvironment(cfg),
		Google: gcal.FromEnvironment(cfg, store.Expiry, nil), Now: time.Now, Log: obs.NewLogger(os.Stdout), Env: env,
	}
	// Left nil where the environment stores no files, rather than a nil bucket that would look like one.
	if objects := account.ObjectsFromEnvironment(cfg); objects != nil {
		svc.Objects = objects
	}
	lambda.Start(func(ctx context.Context, payload json.RawMessage) error { return handle(ctx, svc, payload) })
}

// handle runs the job a payload names: the API's {"job":"export","sub":...} or {"job":"delete","sub":...}, and anything
// else, as the schedule sends, carries on every deletion. A failure is logged and counted where it happens, and not
// returned: the schedule tries a deletion again within minutes, the app asks for an export again, and a retry of this
// invocation would only add to either.
func handle(ctx context.Context, svc *account.Service, payload json.RawMessage) error {
	var job account.Job
	json.Unmarshal(payload, &job)
	if job.Kind != account.JobExport && job.Kind != account.JobDelete {
		job = account.Job{}
	}
	svc.Run(ctx, job)
	return nil
}
