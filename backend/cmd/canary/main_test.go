package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/codedeploy"
	codedeploytypes "github.com/aws/aws-sdk-go-v2/service/codedeploy/types"
	lambdasdk "github.com/aws/aws-sdk-go-v2/service/lambda"
)

// fakeAPI answers like the API Lambda: 401 with no user, and a sync that echoes what was pushed since the cursor.
type fakeAPI struct {
	t        *testing.T
	targets  []string
	subs     []string
	counter  int64
	record   *change
	version  string
	answer   func(event events.APIGatewayV2HTTPRequest) (int, string, bool)
	conflict int
}

func (f *fakeAPI) Invoke(_ context.Context, in *lambdasdk.InvokeInput, _ ...func(*lambdasdk.Options)) (*lambdasdk.InvokeOutput, error) {
	f.targets = append(f.targets, aws.ToString(in.FunctionName))
	var event events.APIGatewayV2HTTPRequest
	if err := json.Unmarshal(in.Payload, &event); err != nil {
		f.t.Fatal(err)
	}
	if event.RawPath != "/sync" || event.RequestContext.HTTP.Method != "POST" || event.RequestContext.RequestID == "" {
		f.t.Fatalf("not the event API Gateway sends: %+v", event)
	}
	reply := func(status int, body string) (*lambdasdk.InvokeOutput, error) {
		payload, _ := json.Marshal(events.APIGatewayV2HTTPResponse{StatusCode: status, Body: body})
		return &lambdasdk.InvokeOutput{Payload: payload, ExecutedVersion: aws.String(f.version)}, nil
	}
	if f.answer != nil {
		if status, body, crashed := f.answer(event); crashed {
			return &lambdasdk.InvokeOutput{FunctionError: aws.String("Unhandled"), Payload: []byte(`{"errorMessage":"boom"}`), ExecutedVersion: aws.String(f.version)}, nil
		} else if status != 0 {
			return reply(status, body)
		}
	}
	sub := ""
	if a := event.RequestContext.Authorizer; a != nil && a.JWT != nil {
		sub = a.JWT.Claims["sub"]
	}
	f.subs = append(f.subs, sub)
	if sub == "" {
		return reply(401, `{"error":"unauthorized"}`)
	}
	var req syncRequest
	if err := json.Unmarshal([]byte(event.Body), &req); err != nil {
		f.t.Fatal(err)
	}
	if len(req.Changes) > 0 && f.conflict > 0 {
		f.conflict--
		return reply(409, `{"error":"conflict"}`)
	}
	if len(req.Changes) > 0 {
		f.counter++
		f.record = &req.Changes[0]
	}
	res := syncResponse{Cursor: f.counter, Changes: []change{}}
	if f.record != nil && req.Cursor < f.counter {
		res.Changes = append(res.Changes, *f.record)
	}
	body, _ := json.Marshal(res)
	return reply(200, string(body))
}

type fakeDeploy struct {
	got []*codedeploy.PutLifecycleEventHookExecutionStatusInput
}

func (f *fakeDeploy) PutLifecycleEventHookExecutionStatus(_ context.Context, in *codedeploy.PutLifecycleEventHookExecutionStatusInput, _ ...func(*codedeploy.Options)) (*codedeploy.PutLifecycleEventHookExecutionStatusOutput, error) {
	f.got = append(f.got, in)
	return &codedeploy.PutLifecycleEventHookExecutionStatusOutput{}, nil
}

const (
	newVersion = "arn:aws:lambda:us-east-2:111111111111:function:api:8"
	liveAlias  = "arn:aws:lambda:us-east-2:111111111111:function:api:live"
	hook       = `{"DeploymentId":"d-1","LifecycleEventHookExecutionId":"h-1"}`
)

func run(t *testing.T, api *fakeAPI, payload string) (*fakeDeploy, error) {
	t.Helper()
	deploy := &fakeDeploy{}
	c := canary{API: api, Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) }, Wait: func(time.Duration) {}}
	err := handler(c, deploy, newVersion, liveAlias)(context.Background(), json.RawMessage(payload))
	return deploy, err
}

func TestBeforeTrafficItChecksTheNewVersionAloneAndTellsCodeDeploy(t *testing.T) {
	api := &fakeAPI{t: t, version: "8"}
	deploy, err := run(t, api, hook)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range api.targets {
		if target != newVersion {
			t.Fatalf("called %s: only the new version, before any traffic reaches it", target)
		}
	}
	if len(api.targets) != 3 {
		t.Fatalf("no user, then the cursor, then the push: %v", api.targets)
	}
	if strings.Join(api.subs, ",") != ",release-canary,release-canary" {
		t.Fatalf("as no one, then its own user: %v", api.subs)
	}
	if len(deploy.got) != 1 || deploy.got[0].Status != codedeploytypes.LifecycleEventStatusSucceeded ||
		aws.ToString(deploy.got[0].DeploymentId) != "d-1" || aws.ToString(deploy.got[0].LifecycleEventHookExecutionId) != "h-1" {
		t.Fatalf("%+v", deploy.got)
	}
	if api.record.Type != "canary" || api.record.ID != "round-trip" {
		t.Fatalf("one record, written again each time: %+v", api.record)
	}
}

func TestBeforeTrafficAFailureStopsTheDeployWithoutAnError(t *testing.T) {
	for name, answer := range map[string]func(events.APIGatewayV2HTTPRequest) (int, string, bool){
		"a 500":   func(events.APIGatewayV2HTTPRequest) (int, string, bool) { return 500, "{}", false },
		"a crash": func(events.APIGatewayV2HTTPRequest) (int, string, bool) { return 0, "", true },
		"no user let in": func(e events.APIGatewayV2HTTPRequest) (int, string, bool) {
			return 200, `{"cursor":0,"changes":[]}`, false
		},
		"the push not echoed": func(e events.APIGatewayV2HTTPRequest) (int, string, bool) {
			return pushOnly(e, 200, `{"cursor":9,"changes":[]}`)
		},
		"the cursor left in place": func(e events.APIGatewayV2HTTPRequest) (int, string, bool) {
			return pushOnly(e, 200, `{"cursor":0,"changes":[]}`)
		},
	} {
		t.Run(name, func(t *testing.T) {
			deploy, err := run(t, &fakeAPI{t: t, version: "8", answer: answer}, hook)
			if err != nil {
				t.Fatalf("CodeDeploy reports it, so it isn't also a Lambda error: %v", err)
			}
			if len(deploy.got) != 1 || deploy.got[0].Status != codedeploytypes.LifecycleEventStatusFailed {
				t.Fatalf("%+v", deploy.got)
			}
		})
	}
}

// pushOnly answers the request that carries changes, and leaves the others to the fake.
func pushOnly(e events.APIGatewayV2HTTPRequest, status int, body string) (int, string, bool) {
	if strings.Contains(e.Body, `"changes":[{`) {
		return status, body, false
	}
	return 0, "", false
}

func TestOnScheduleItGoesThroughTheLiveAliasAndAFailureIsAnError(t *testing.T) {
	api := &fakeAPI{t: t, version: "7"}
	deploy, err := run(t, api, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if len(deploy.got) != 0 {
		t.Fatalf("not a hook: %+v", deploy.got)
	}
	for _, target := range api.targets {
		if target != liveAlias {
			t.Fatalf("called %s: the alias, which shares traffic between the versions", target)
		}
	}

	broken := &fakeAPI{t: t, version: "8", answer: func(events.APIGatewayV2HTTPRequest) (int, string, bool) { return 0, "", true }}
	_, err = run(t, broken, `{}`)
	if err == nil || !strings.Contains(err.Error(), "version 8 failed") {
		t.Fatalf("its alarm counts errors, naming the version that failed: %v", err)
	}
}

func TestItSendsAgainOnAConflictAsADeviceDoes(t *testing.T) {
	api := &fakeAPI{t: t, version: "7", conflict: 2}
	if _, err := run(t, api, `{}`); err != nil {
		t.Fatal(err)
	}
	stuck := &fakeAPI{t: t, version: "7", conflict: conflictTries}
	if _, err := run(t, stuck, `{}`); err == nil || !strings.Contains(err.Error(), "409") {
		t.Fatalf("gives up after %d tries: %v", conflictTries, err)
	}
}

func TestAnInvokeThatFailsIsAFailure(t *testing.T) {
	c := canary{API: failingInvoker{}, Now: time.Now, Wait: func(time.Duration) {}}
	if _, err := c.roundTrip(context.Background(), liveAlias); err == nil || !strings.Contains(err.Error(), "invoking") {
		t.Fatal(err)
	}
}

type failingInvoker struct{}

func (failingInvoker) Invoke(context.Context, *lambdasdk.InvokeInput, ...func(*lambdasdk.Options)) (*lambdasdk.InvokeOutput, error) {
	return nil, errors.New("AccessDenied")
}
