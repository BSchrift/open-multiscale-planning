// The API Lambda: the shared handlers behind API Gateway, which has already checked the token.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
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

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/gcal"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

func main() {
	// A wrong ENV_NAME stops the function as it starts, not at the first request that needs its settings.
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
	store := &sync.Store{
		DB: dynamodb.NewFromConfig(cfg), Table: os.Getenv("TABLE_NAME"),
		Expiry: &sync.Expiry{Now: time.Now, Deleted: retention.Deleted},
	}
	server := &api.Server{
		Sync:     store,
		Calendar: gcal.FromEnvironment(cfg, startWorker(lambdasdk.NewFromConfig(cfg), os.Getenv("CALENDAR_FUNCTION_NAME"))),
		Log:      obs.NewLogger(os.Stdout),
		Env:      os.Getenv("ENV_NAME"),
		Now:      time.Now,
	}
	lambda.Start(adapter(server.Handler()))
}

// startWorker runs the calendar worker without waiting, since a run can far outlast this function's timeout.
func startWorker(client invoker, name string) func(context.Context) error {
	return func(ctx context.Context) error {
		_, err := client.Invoke(ctx, &lambdasdk.InvokeInput{
			FunctionName:   aws.String(name),
			InvocationType: lambdatypes.InvocationTypeEvent,
			Payload:        []byte(`{"trigger":"refresh"}`),
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
