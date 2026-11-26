package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	lambdasdk "github.com/aws/aws-sdk-go-v2/service/lambda"
	lambdatypes "github.com/aws/aws-sdk-go-v2/service/lambda/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/api"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
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

func TestAdapterPassesOnWhenTheSignInWas(t *testing.T) {
	var got time.Time
	handle := adapter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = api.AuthTimeFrom(r.Context()) }))
	handle(context.Background(), gatewayEvent("POST", "/account/delete", "", "{}", map[string]string{"sub": "user-1", "auth_time": "1800000000"}))
	if !got.Equal(time.Unix(1800000000, 0)) {
		t.Fatalf("got %v", got)
	}
	handle(context.Background(), gatewayEvent("POST", "/account/delete", "", "{}", map[string]string{"sub": "user-1", "auth_time": "soon"}))
	if !got.IsZero() {
		t.Fatalf("got %v from a claim that isn't a time", got)
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

// API Gateway reads a response body as text unless it's marked as base64, so a gzipped one goes base64 and arrives as
// the bytes the handler wrote.
func TestAdapterSendsAnEncodedBodyAsBase64(t *testing.T) {
	compressed := []byte{0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe}
	handle := adapter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(compressed)
	}))
	res, err := handle(context.Background(), gatewayEvent("POST", "/sync", "", "{}", nil))
	if err != nil || !res.IsBase64Encoded || res.Headers["Content-Encoding"] != "gzip" {
		t.Fatalf("%+v %v", res, err)
	}
	if got, err := base64.StdEncoding.DecodeString(res.Body); err != nil || !bytes.Equal(got, compressed) {
		t.Fatalf("body %q %v", res.Body, err)
	}
}

func TestAdapterOverTheRealSyncRouteGzipsWhenAsked(t *testing.T) {
	changes := make([]sync.Change, 50)
	for i := range changes {
		changes[i] = sync.Change{Type: "task", ID: fmt.Sprintf("r%02d", i), Fields: sync.Fields{"title": {V: "Paint the fence", C: "1800000000000-000000-a"}}}
	}
	server := &api.Server{Sync: fixedSync{sync.Response{Cursor: 50, Changes: changes}}, Log: obs.NewLogger(io.Discard), Now: time.Now}
	event := gatewayEvent("POST", "/sync", "", `{"cursor":0,"changes":[]}`, map[string]string{"sub": "user-1"})
	// As API Gateway passes headers on: in lower case.
	event.Headers["accept-encoding"] = "gzip, deflate, br"
	res, err := adapter(server.Handler())(context.Background(), event)
	if err != nil || res.StatusCode != 200 || !res.IsBase64Encoded || res.Headers["Content-Encoding"] != "gzip" || res.Headers["Vary"] != "Accept-Encoding" {
		t.Fatalf("%+v %v", res, err)
	}
	raw, _ := base64.StdEncoding.DecodeString(res.Body)
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	var got sync.Response
	if err := json.NewDecoder(zr).Decode(&got); err != nil || got.Cursor != 50 || len(got.Changes) != 50 {
		t.Fatalf("%+v %v", got, err)
	}

	delete(event.Headers, "accept-encoding")
	res, err = adapter(server.Handler())(context.Background(), event)
	if err != nil || res.IsBase64Encoded || res.Headers["Content-Encoding"] != "" || !strings.HasPrefix(res.Body, `{"cursor":50,`) {
		t.Fatalf("%+v %v", res, err)
	}
}

type fixedSync struct{ res sync.Response }

func (f fixedSync) Sync(context.Context, string, sync.Request) (sync.Response, sync.Stats, error) {
	return f.res, sync.Stats{}, nil
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

func TestAnAccountJobStartsWithoutWaitingForIt(t *testing.T) {
	invoker := &fakeInvoker{}
	if err := startJob(invoker, "the-account-function")(context.Background(), account.Job{Kind: account.JobExport, Sub: "user-1"}); err != nil {
		t.Fatal(err)
	}
	if aws.ToString(invoker.in.FunctionName) != "the-account-function" || invoker.in.InvocationType != lambdatypes.InvocationTypeEvent {
		t.Fatalf("%+v", invoker.in)
	}
	if string(invoker.in.Payload) != `{"job":"export","sub":"user-1"}` {
		t.Fatalf("payload %s", invoker.in.Payload)
	}
}
