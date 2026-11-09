// The release canary Lambda: a sync round trip through the API Lambda, invoked directly with the event API Gateway
// would send. Two things run it:
//   - CodeDeploy, before a new API version takes any traffic, against that version alone. A failure stops the deploy
//     with nothing shifted.
//   - A schedule, every 5 minutes, against the live alias, so a new version's 5% share sees real requests even with one
//     real user. A failure is an error, which its alarm counts as a release alarm and rolls the canary back.
//
// It syncs as a made-up user of its own rather than the test user, so its writes never race the integration suite's,
// and it writes one record, again each time, so what it keeps never grows.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/codedeploy"
	codedeploytypes "github.com/aws/aws-sdk-go-v2/service/codedeploy/types"
	lambdasdk "github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/smithy-go"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	appconfig "github.com/BSchrift/open-multiscale-planning/config"
)

const (
	// The canary's own user: no one signs in as it, and only this function, invoking the API directly, can act as it.
	canaryUser = "release-canary"
	recordType = "canary"
	recordID   = "round-trip"
	device     = "canary"
	// A 409 means other writers moved the user's counter, and a device sends again. Only this function writes as it.
	conflictTries = 5
	// IAM takes a few seconds to apply a grant, and the deploy that first adds this function grants it what it calls.
	// So a refusal for permission is tried again, for a minute, before it counts.
	deniedTries = 13
	deniedWait  = 5 * time.Second
)

func main() {
	if _, err := appconfig.ForEnv(os.Getenv("ENV_NAME")); err != nil {
		log.Fatal(err)
	}
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	c := canary{API: lambdasdk.NewFromConfig(cfg), Now: time.Now, Wait: time.Sleep}
	lambda.Start(handler(c, codedeploy.NewFromConfig(cfg), os.Getenv("API_VERSION"), os.Getenv("API_ALIAS")))
}

type invoker interface {
	Invoke(context.Context, *lambdasdk.InvokeInput, ...func(*lambdasdk.Options)) (*lambdasdk.InvokeOutput, error)
}

type hookReporter interface {
	PutLifecycleEventHookExecutionStatus(context.Context, *codedeploy.PutLifecycleEventHookExecutionStatusInput, ...func(*codedeploy.Options)) (*codedeploy.PutLifecycleEventHookExecutionStatusOutput, error)
}

// hookEvent is what CodeDeploy sends a lifecycle hook. A scheduled run sends neither field.
type hookEvent struct {
	DeploymentID                  string `json:"DeploymentId"`
	LifecycleEventHookExecutionID string `json:"LifecycleEventHookExecutionId"`
}

func handler(c canary, deploy hookReporter, version, alias string) func(context.Context, json.RawMessage) error {
	logger := obs.NewLogger(os.Stdout)
	return func(ctx context.Context, payload json.RawMessage) error {
		var hook hookEvent
		_ = json.Unmarshal(payload, &hook)
		if hook.DeploymentID != "" {
			versions, err := c.roundTrip(ctx, version)
			status := codedeploytypes.LifecycleEventStatusSucceeded
			if err != nil {
				status = codedeploytypes.LifecycleEventStatusFailed
				logger.Error("canary failed before traffic", "target", version, "versions", versions, "error", err.Error())
			} else {
				logger.Info("canary passed before traffic", "target", version, "versions", versions)
			}
			// The deploy waits on this status, and a failure here is CodeDeploy's to report, not an alarm's.
			return c.permitted(func() error {
				_, err := deploy.PutLifecycleEventHookExecutionStatus(ctx, &codedeploy.PutLifecycleEventHookExecutionStatusInput{
					DeploymentId:                  aws.String(hook.DeploymentID),
					LifecycleEventHookExecutionId: aws.String(hook.LifecycleEventHookExecutionID),
					Status:                        status,
				})
				return err
			})
		}
		versions, err := c.roundTrip(ctx, alias)
		if err != nil {
			logger.Error("canary failed", "target", alias, "versions", versions, "error", err.Error())
			return err
		}
		logger.Info("canary passed", "target", alias, "versions", versions)
		return nil
	}
}

type canary struct {
	API  invoker
	Now  func() time.Time
	Wait func(time.Duration)
}

type field struct {
	V any    `json:"v"`
	C string `json:"c"`
}

type change struct {
	Type   string           `json:"type"`
	ID     string           `json:"id"`
	Fields map[string]field `json:"fields"`
}

type syncRequest struct {
	Cursor  int64    `json:"cursor"`
	Changes []change `json:"changes"`
}

type syncResponse struct {
	Cursor  int64    `json:"cursor"`
	Changes []change `json:"changes"`
}

// roundTrip checks that target refuses a request with no user, then pushes the canary's record and gets it back. It
// returns the versions that answered: an alias may send each request to either version.
func (c canary) roundTrip(ctx context.Context, target string) ([]string, error) {
	var versions []string
	answered := func(version string) {
		if !slices.Contains(versions, version) {
			versions = append(versions, version)
		}
	}

	status, _, version, err := c.call(ctx, target, "", syncRequest{Changes: []change{}})
	if err != nil {
		return versions, err
	}
	answered(version)
	if status != 401 {
		return versions, fmt.Errorf("a sync with no user got %d, not 401", status)
	}

	// A cursor past the end answers with the end, where the push below has to move it from.
	start, err := c.sync(ctx, target, syncRequest{Cursor: math.MaxInt64, Changes: []change{}}, answered)
	if err != nil {
		return versions, err
	}
	now := c.Now()
	value := json.Number(fmt.Sprint(now.UnixMilli()))
	push := syncRequest{Cursor: start.Cursor, Changes: []change{{
		Type: recordType, ID: recordID,
		Fields: map[string]field{"at": {V: value, C: fmt.Sprintf("%013d-%06d-%s", now.UnixMilli(), 1, device)}},
	}}}
	res, err := c.sync(ctx, target, push, answered)
	if err != nil {
		return versions, err
	}
	if res.Cursor <= start.Cursor {
		return versions, fmt.Errorf("the push left the cursor at %d", res.Cursor)
	}
	for _, got := range res.Changes {
		if got.Type == recordType && got.ID == recordID && fmt.Sprint(got.Fields["at"].V) == value.String() {
			return versions, nil
		}
	}
	return versions, fmt.Errorf("the push didn't come back: %d changes from %d", len(res.Changes), start.Cursor)
}

// sync posts as the canary's user, sending again on a 409 as a device does.
func (c canary) sync(ctx context.Context, target string, req syncRequest, answered func(string)) (syncResponse, error) {
	for try := 1; ; try++ {
		status, body, version, err := c.call(ctx, target, canaryUser, req)
		if err != nil {
			return syncResponse{}, err
		}
		answered(version)
		if status == 409 && try < conflictTries {
			c.Wait(time.Duration(try) * 100 * time.Millisecond)
			continue
		}
		if status != 200 {
			return syncResponse{}, fmt.Errorf("sync got %d: %.200s", status, body)
		}
		var res syncResponse
		// As numbers, so the value pushed compares equal to the one that comes back.
		dec := json.NewDecoder(strings.NewReader(body))
		dec.UseNumber()
		if err := dec.Decode(&res); err != nil {
			return syncResponse{}, fmt.Errorf("sync answered %.200q: %w", body, err)
		}
		return res, nil
	}
}

// call invokes target with the event API Gateway sends for POST /sync once its authorizer has checked a token for sub.
func (c canary) call(ctx context.Context, target, sub string, req syncRequest) (status int, body, version string, err error) {
	raw, err := json.Marshal(req)
	if err != nil {
		return 0, "", "", err
	}
	event := events.APIGatewayV2HTTPRequest{
		Version:  "2.0",
		RouteKey: "POST /sync",
		RawPath:  "/sync",
		Headers:  map[string]string{"content-type": "application/json"},
		Body:     string(raw),
		RequestContext: events.APIGatewayV2HTTPRequestContext{
			RequestID: fmt.Sprintf("canary-%d", c.Now().UnixNano()),
			HTTP:      events.APIGatewayV2HTTPRequestContextHTTPDescription{Method: "POST", Path: "/sync"},
		},
	}
	if sub != "" {
		event.RequestContext.Authorizer = &events.APIGatewayV2HTTPRequestContextAuthorizerDescription{
			JWT: &events.APIGatewayV2HTTPRequestContextAuthorizerJWTDescription{Claims: map[string]string{"sub": sub}},
		}
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return 0, "", "", err
	}
	var out *lambdasdk.InvokeOutput
	err = c.permitted(func() (err error) {
		out, err = c.API.Invoke(ctx, &lambdasdk.InvokeInput{FunctionName: aws.String(target), Payload: payload})
		return err
	})
	if err != nil {
		return 0, "", "", fmt.Errorf("invoking %s: %w", target, err)
	}
	version = aws.ToString(out.ExecutedVersion)
	if out.FunctionError != nil {
		return 0, "", version, fmt.Errorf("version %s failed: %s: %.200s", version, aws.ToString(out.FunctionError), out.Payload)
	}
	var res events.APIGatewayV2HTTPResponse
	if err := json.Unmarshal(out.Payload, &res); err != nil {
		return 0, "", version, errors.Join(fmt.Errorf("version %s answered %.200q", version, out.Payload), err)
	}
	return res.StatusCode, res.Body, version, nil
}

// permitted runs call, and runs it again while AWS refuses it for permission, for up to deniedTries.
func (c canary) permitted(call func() error) error {
	for try := 1; ; try++ {
		err := call()
		var api smithy.APIError
		if try >= deniedTries || !errors.As(err, &api) || api.ErrorCode() != "AccessDeniedException" {
			return err
		}
		c.Wait(deniedWait)
	}
}
