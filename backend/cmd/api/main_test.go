package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	lambdasdk "github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

func gatewayEvent(method, path, query, body string, claims map[string]string) events.APIGatewayV2HTTPRequest {
	event := events.APIGatewayV2HTTPRequest{RawPath: path, RawQueryString: query, Body: body}
	event.Headers = map[string]string{"content-type": "application/json"}
	event.RequestContext.RequestID = "req-1"
	event.RequestContext.HTTP.Method = method
	if claims != nil {
		event.RequestContext.Authorizer = &events.APIGatewayV2HTTPRequestContextAuthorizerDescription{
			JWT: &events.APIGatewayV2HTTPRequestContextAuthorizerJWTDescription{Claims: claims},
		}
	}
	return event
}

func TestAdapterPassesTheRequestThrough(t *testing.T) {
	var got struct{ method, path, query, body, sub, contentType string }
	handle := adapter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		got.method, got.path, got.query, got.body = r.Method, r.URL.Path, r.URL.RawQuery, string(raw)
		got.sub, got.contentType = api.SubFrom(r.Context()), r.Header.Get("Content-Type")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		io.WriteString(w, `{"ok":`)
		io.WriteString(w, `true}`)
	}))
	res, err := handle(context.Background(), gatewayEvent("POST", "/sync", "a=1", `{"x":1}`, map[string]string{"sub": "user-1"}))
	if err != nil {
		t.Fatal(err)
	}
	if got.method != "POST" || got.path != "/sync" || got.query != "a=1" || got.body != `{"x":1}` || got.sub != "user-1" || got.contentType != "application/json" {
		t.Fatalf("%+v", got)
	}
	if res.StatusCode != 201 || res.Body != `{"ok":true}` || res.Headers["Content-Type"] != "application/json" {
		t.Fatalf("%+v", res)
	}
}

func TestAdapterDecodesABase64Body(t *testing.T) {
	var body string
	handle := adapter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
	}))
	event := gatewayEvent("POST", "/sync", "", base64.StdEncoding.EncodeToString([]byte("hello")), nil)
	event.IsBase64Encoded = true
	res, err := handle(context.Background(), event)
	if err != nil || body != "hello" || res.StatusCode != 200 {
		t.Fatalf("%q %+v %v", body, res, err)
	}

	event.Body = "not base64!"
	res, err = handle(context.Background(), event)
	if err != nil || res.StatusCode != 400 {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestAdapterGivesNoSubWithoutAnAuthorizer(t *testing.T) {
	sub := "unset"
	handle := adapter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { sub = api.SubFrom(r.Context()) }))
	if _, err := handle(context.Background(), gatewayEvent("GET", "/calendar/callback", "state=s", "", nil)); err != nil {
		t.Fatal(err)
	}
	if sub != "" {
		t.Fatalf("sub %q", sub)
	}
}

func TestAdapterOverTheRealRoutesFailsClosedWithoutASub(t *testing.T) {
	server := &api.Server{Log: obs.NewLogger(io.Discard), Now: time.Now}
	res, err := adapter(server.Handler())(context.Background(), gatewayEvent("POST", "/sync", "", "{}", nil))
	if err != nil || res.StatusCode != 401 {
		t.Fatalf("%+v %v", res, err)
	}
}

type fakeInvoker struct {
	in  *lambdasdk.InvokeInput
	err error
}

func (f *fakeInvoker) Invoke(_ context.Context, in *lambdasdk.InvokeInput, _ ...func(*lambdasdk.Options)) (*lambdasdk.InvokeOutput, error) {
	f.in = in
	return &lambdasdk.InvokeOutput{}, f.err
}

func TestWorkerStartsWithoutWaitingForIt(t *testing.T) {
	invoker := &fakeInvoker{}
	if err := startWorker(invoker, "the-worker")(context.Background()); err != nil {
		t.Fatal(err)
	}
	if aws.ToString(invoker.in.FunctionName) != "the-worker" || invoker.in.InvocationType != lambdatypes.InvocationTypeEvent {
		t.Fatalf("%+v", invoker.in)
	}
	if string(invoker.in.Payload) != `{"trigger":"refresh"}` {
		t.Fatalf("payload %s", invoker.in.Payload)
	}
	invoker.err = errors.New("no")
	if err := startWorker(invoker, "the-worker")(context.Background()); err == nil {
		t.Fatal("failure swallowed")
	}
}
