// The API Lambda: the shared handlers behind API Gateway, which has already checked the token.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	lambdasdk "github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/files"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/gcal"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	// A wrong ENV_NAME stops the function as it starts, not at the first request that needs its settings.
	env, err := appconfig.ForEnv(os.Getenv("ENV_NAME"))
	if err != nil {
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
	db := dynamodb.NewFromConfig(cfg)
	invoker := lambdasdk.NewFromConfig(cfg)
	store := &sync.Store{DB: db, Table: os.Getenv("TABLE_NAME"), Expiry: &sync.Expiry{Now: time.Now, Deleted: retention.Deleted}}
	logger := obs.NewLogger(os.Stdout)
	server := &api.Server{
		Sync:     store,
		Calendar: gcal.FromEnvironment(cfg, store.Expiry),
		Tokens:   account.TokensFromEnvironment(cfg),
		Log:      logger,
		Env:      os.Getenv("ENV_NAME"),
		Now:      time.Now,
	}
	accounts := &account.Service{
		DB: db, Table: store.Table, Records: store, Identity: account.IdentityFromEnvironment(cfg),
		Start: startJob(invoker, os.Getenv("ACCOUNT_FUNCTION_NAME")), Now: time.Now, Log: logger, Env: server.Env,
	}
	// The integration suite's users, which its requests never delete.
	if emails := os.Getenv("PROTECTED_EMAILS"); emails != "" {
		accounts.Protected = strings.Split(emails, ",")
	}
	// Nil where the environment stores no files, so the routes say so, and there's nowhere to build an export.
	if service := files.FromEnvironment(cfg, store, files.LimitsFor(env)); service != nil {
		server.Files = service
		accounts.Sign = service.SignURL
	}
	server.Account = accounts
	lambda.Start(adapter(server.Handler()))
}

// startJob runs an export or a deletion in the account function without waiting, since either can far outlast this
// function's timeout.
func startJob(client invoker, name string) func(context.Context, account.Job) error {
	return func(ctx context.Context, job account.Job) error {
		payload, err := json.Marshal(job)
		if err != nil {
			return err
		}
		_, err = client.Invoke(ctx, &lambdasdk.InvokeInput{
			FunctionName: aws.String(name), InvocationType: lambdatypes.InvocationTypeEvent, Payload: payload,
		})
		return err
	}
}

type invoker interface {
	Invoke(context.Context, *lambdasdk.InvokeInput, ...func(*lambdasdk.Options)) (*lambdasdk.InvokeOutput, error)
}

type lambdaHandler func(context.Context, events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error)

// adapter turns a gateway event into a plain HTTP request, with the sub from the claims the authorizer verified.
func adapter(next http.Handler) lambdaHandler {
	return func(ctx context.Context, event events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
		body := []byte(event.Body)
		if event.IsBase64Encoded {
			decoded, err := base64.StdEncoding.DecodeString(event.Body)
			if err != nil {
				return events.APIGatewayV2HTTPResponse{StatusCode: http.StatusBadRequest}, nil
			}
			body = decoded
		}
		target := event.RawPath
		if event.RawQueryString != "" {
			target += "?" + event.RawQueryString
		}
		ctx = api.WithRequestID(ctx, event.RequestContext.RequestID)
		if authorizer := event.RequestContext.Authorizer; authorizer != nil && authorizer.JWT != nil {
			ctx = api.WithSub(ctx, authorizer.JWT.Claims["sub"])
			if at, ok := api.AuthTimeClaim(authorizer.JWT.Claims["auth_time"]); ok {
				ctx = api.WithAuthTime(ctx, at)
			}
		}
		req, err := http.NewRequestWithContext(ctx, event.RequestContext.HTTP.Method, target, bytes.NewReader(body))
		if err != nil {
			return events.APIGatewayV2HTTPResponse{StatusCode: http.StatusBadRequest}, nil
		}
		for name, value := range event.Headers {
			req.Header.Set(name, value)
		}
		res := &response{header: http.Header{}, status: http.StatusOK}
		next.ServeHTTP(res, req)

		headers := make(map[string]string, len(res.header))
		for name, values := range res.header {
			headers[name] = strings.Join(values, ", ")
		}
		return events.APIGatewayV2HTTPResponse{StatusCode: res.status, Headers: headers, Body: res.body.String()}, nil
	}
}

type response struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (r *response) Header() http.Header         { return r.header }
func (r *response) WriteHeader(status int)      { r.status = status }
func (r *response) Write(b []byte) (int, error) { return r.body.Write(b) }
