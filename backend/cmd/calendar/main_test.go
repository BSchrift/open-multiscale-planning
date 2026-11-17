package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	gosync "sync"
	"testing"
	"time"

	"github.com/aws/aws-lambda-go/events"
)

// fakeWorker records what the handler asks of the worker. A run's behaviour comes from runs, by sub.
type fakeWorker struct {
	mu         gosync.Mutex
	ran        []string
	dispatched []string
	woken      [][]string
	runs       map[string]func() error
}

func (f *fakeWorker) Run(_ context.Context, sub, trigger, _ string) error {
	f.mu.Lock()
	f.ran = append(f.ran, sub+":"+trigger)
	run := f.runs[sub]
	f.mu.Unlock()
	if run != nil {
		return run()
	}
	return nil
}

func (f *fakeWorker) Dispatch(_ context.Context, trigger, _ string) error {
	f.dispatched = append(f.dispatched, trigger)
	return nil
}

func (f *fakeWorker) Wake(_ context.Context, subs []string, _ string) error {
	f.woken = append(f.woken, subs)
	return nil
}

func TestWhatWokeTheWorkerDecidesWhatItDoes(t *testing.T) {
	for payload, want := range map[string]string{
		`{}`: "dispatch:schedule",
		`{"version":"0","source":"aws.scheduler"}`: "dispatch:schedule",
		`null`:                            "dispatch:schedule",
		`not json`:                        "dispatch:schedule",
		`{"trigger":"refresh","sub":"a"}`: "run:a:refresh",
		// An API from before per-person connections names no one: a run for everyone covers whoever it meant.
		`{"trigger":"refresh"}`: "dispatch:refresh",
	} {
		f := &fakeWorker{}
		if _, err := handle(context.Background(), f, json.RawMessage(payload), "r"); err != nil {
			t.Fatal(err)
		}
		got := ""
		if len(f.ran) > 0 {
			got = "run:" + f.ran[0]
		}
		if len(f.dispatched) > 0 {
			got = "dispatch:" + f.dispatched[0]
		}
		if got != want {
			t.Errorf("%s: %s", payload, got)
		}
	}
}

func TestStreamRecordsWakeEachPersonOnce(t *testing.T) {
	f := &fakeWorker{}
	payload := `{"Records":[
		{"eventSource":"aws:dynamodb","dynamodb":{"Keys":{"pk":{"S":"user#a"},"sk":{"S":"rec#time_block#1"}}}},
		{"eventSource":"aws:dynamodb","dynamodb":{"Keys":{"pk":{"S":"user#b"},"sk":{"S":"rec#task#1"}}}},
		{"eventSource":"aws:dynamodb","dynamodb":{"Keys":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#2"}}}},
		{"eventSource":"aws:dynamodb","dynamodb":{"Keys":{"pk":{"S":"google#connection"},"sk":{"S":"a"}}}}
	]}`
	if _, err := handle(context.Background(), f, json.RawMessage(payload), "r"); err != nil {
		t.Fatal(err)
	}
	if len(f.woken) != 1 || !slices.Equal(f.woken[0], []string{"a", "b"}) {
		t.Fatalf("%v", f.woken)
	}
}

// Each person's run in a batch from the queue is their own: they run at once, so one slow person doesn't hold up the
// others, and only a failed one is handed back to the queue to try again.
func TestQueuedRunsGoAtOnceAndOnlyFailuresGoBack(t *testing.T) {
	released := make(chan struct{})
	f := &fakeWorker{runs: map[string]func() error{
		// Waits for b, so a batch run one at a time in order would never finish.
		"a": func() error {
			select {
			case <-released:
				return nil
			case <-time.After(5 * time.Second):
				return errors.New("a ran alone")
			}
		},
		"b":   func() error { close(released); return nil },
		"bad": func() error { return errors.New("store down") },
	}}
	payload := `{"Records":[
		{"eventSource":"aws:sqs","messageId":"m1","body":"{\"sub\":\"a\",\"trigger\":\"schedule\"}"},
		{"eventSource":"aws:sqs","messageId":"m2","body":"{\"sub\":\"b\",\"trigger\":\"retry\"}"},
		{"eventSource":"aws:sqs","messageId":"m3","body":"{\"sub\":\"bad\",\"trigger\":\"stream\"}"},
		{"eventSource":"aws:sqs","messageId":"m4","body":"not json"}
	]}`
	out, err := handle(context.Background(), f, json.RawMessage(payload), "r")
	if err != nil {
		t.Fatal(err)
	}
	response := out.(events.SQSEventResponse)
	if len(response.BatchItemFailures) != 1 || response.BatchItemFailures[0].ItemIdentifier != "m3" {
		t.Fatalf("%+v", response)
	}
	slices.Sort(f.ran)
	if !slices.Equal(f.ran, []string{"a:schedule", "b:retry", "bad:stream"}) {
		t.Fatalf("%v", f.ran)
	}
}

// The same person twice in one batch, from the schedule and the stream at once, runs once.
func TestAPersonQueuedTwiceInABatchRunsOnce(t *testing.T) {
	f := &fakeWorker{}
	payload := `{"Records":[
		{"eventSource":"aws:sqs","messageId":"m1","body":"{\"sub\":\"a\",\"trigger\":\"schedule\"}"},
		{"eventSource":"aws:sqs","messageId":"m2","body":"{\"sub\":\"a\",\"trigger\":\"stream\"}"},
		{"eventSource":"aws:sqs","messageId":"m3","body":"{\"sub\":\"b\",\"trigger\":\"stream\"}"}
	]}`
	if _, err := handle(context.Background(), f, json.RawMessage(payload), "r"); err != nil {
		t.Fatal(err)
	}
	slices.Sort(f.ran)
	if !slices.Equal(f.ran, []string{"a:schedule", "b:stream"}) {
		t.Fatalf("%v", f.ran)
	}
}
