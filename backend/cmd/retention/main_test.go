package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

func TestMarksComeOnlyFromTTLRemovals(t *testing.T) {
	const batch = `{"Records":[
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t1"},"seq":{"N":"7"},"fields":{"M":{}}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#time_block#b1"},"seq":{"N":"12"}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t0"},"seq":{"N":"3"}}}},
		{"eventName":"REMOVE",
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t9"},"seq":{"N":"99"}}}},
		{"eventName":"MODIFY","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t8"},"seq":{"N":"98"}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#b"},"sk":{"S":"rec#task#t1"},"seq":{"N":"5"}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#c"},"sk":{"S":"meta#counter"},"value":{"N":"40"}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"Keys":{"pk":{"S":"user#d"},"sk":{"S":"rec#task#t1"}}}}
	]}`
	var event events.DynamoDBEvent
	if err := json.Unmarshal([]byte(batch), &event); err != nil {
		t.Fatal(err)
	}
	// A user's own deletes and edits aren't expiry, and an image with no sequence number can't move a mark.
	if got := marksFrom(event.Records); !maps.Equal(got, map[string]int64{"user#a": 12, "user#b": 5}) {
		t.Fatalf("%v", got)
	}
}

// TTL's removal of an attachment's record takes its file with it. Only TTL's, as for marks: a delete from anyone else,
// staging's cleanup included, isn't expiry, and the cleanup removes the file itself.
func TestAttachmentsComeOnlyFromTTLRemovals(t *testing.T) {
	const batch = `{"Records":[
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#attachment#f1"},"seq":{"N":"7"}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t1"},"seq":{"N":"8"}}}},
		{"eventName":"REMOVE",
		 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#attachment#f2"},"seq":{"N":"9"}}}},
		{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
		 "dynamodb":{"OldImage":{"pk":{"S":"user#b"},"sk":{"S":"rec#attachment#f3"},"seq":{"N":"2"}}}}
	]}`
	var event events.DynamoDBEvent
	if err := json.Unmarshal([]byte(batch), &event); err != nil {
		t.Fatal(err)
	}
	got := attachmentsFrom(event.Records)
	if want := [][2]string{{"user#a", "rec#attachment#f1"}, {"user#b", "rec#attachment#f3"}}; !slices.Equal(got, want) {
		t.Fatalf("%v", got)
	}
}

// work is what a handler asked of DynamoDB and S3, with an error to answer each kind with.
type work struct {
	marks                           map[string]int64
	removed                         [][2]string
	cleanups                        int
	raiseErr, removeErr, cleanupErr error
}

func (w *work) handler(logs *bytes.Buffer) handler {
	w.marks = map[string]int64{}
	return handler{
		env: "staging",
		log: obs.NewLogger(logs),
		raise: func(_ context.Context, pk string, seq int64) error {
			if w.raiseErr != nil {
				return w.raiseErr
			}
			w.marks[pk] = seq
			return nil
		},
		removing: func(_ context.Context, pk, sk string) error {
			if w.removeErr != nil {
				return w.removeErr
			}
			w.removed = append(w.removed, [2]string{pk, sk})
			return nil
		},
		cleanup: func(context.Context, string) error {
			w.cleanups++
			return w.cleanupErr
		},
	}
}

// A batch from the table's stream: TTL removed a task and an attachment of user a's, and user a deleted another
// attachment themselves, which isn't expiry.
const streamBatch = `{"Records":[
	{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
	 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t1"},"seq":{"N":"7"}}}},
	{"eventName":"REMOVE","userIdentity":{"type":"Service","principalId":"dynamodb.amazonaws.com"},
	 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#attachment#f1"},"seq":{"N":"9"}}}},
	{"eventName":"REMOVE",
	 "dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#attachment#f2"},"seq":{"N":"11"}}}}
]}`

func TestAStreamBatchRaisesMarksAndRemovesExpiredFilesWithoutCleaningUp(t *testing.T) {
	var w work
	var logs bytes.Buffer
	if err := w.handler(&logs).handle(context.Background(), json.RawMessage(streamBatch)); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(w.marks, map[string]int64{"user#a": 9}) {
		t.Fatalf("marks %v", w.marks)
	}
	if want := [][2]string{{"user#a", "rec#attachment#f1"}}; !slices.Equal(w.removed, want) {
		t.Fatalf("removed %v", w.removed)
	}
	// The schedule runs the cleanup, never the stream.
	if w.cleanups != 0 {
		t.Fatalf("cleanups %d", w.cleanups)
	}
	if !strings.Contains(logs.String(), `"outcome":"ok"`) || !strings.Contains(logs.String(), `"users":1`) {
		t.Fatalf("logs %s", logs.String())
	}

	// A batch with no expiry in it is still the stream's, and runs no cleanup either.
	only := `{"Records":[{"eventName":"REMOVE","dynamodb":{"OldImage":{"pk":{"S":"user#a"},"sk":{"S":"rec#task#t2"},"seq":{"N":"12"}}}}]}`
	if err := w.handler(&logs).handle(context.Background(), json.RawMessage(only)); err != nil || len(w.marks) != 0 || w.cleanups != 0 {
		t.Fatalf("err %v, marks %v, cleanups %d", err, w.marks, w.cleanups)
	}
}

// Lambda retries a batch that returns an error, which only raises marks and removes files again. A swallowed error
// would leave a device that never saw the removal holding the expired record, or the file in the bucket, for good.
func TestAFailedMarkOrFileRemovalRetriesTheBatch(t *testing.T) {
	for _, c := range []struct {
		name string
		fail func(*work)
		log  string
	}{
		{"mark", func(w *work) { w.raiseErr = errors.New("throttled") }, `"outcome":"failed"`},
		{"file", func(w *work) { w.removeErr = errors.New("throttled") }, `"error_type":"file_removal"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			var w work
			var logs bytes.Buffer
			h := w.handler(&logs)
			c.fail(&w)
			if err := h.handle(context.Background(), json.RawMessage(streamBatch)); err == nil || err.Error() != "throttled" {
				t.Fatalf("err %v", err)
			}
			if !strings.Contains(logs.String(), c.log) {
				t.Fatalf("logs %s", logs.String())
			}
		})
	}
}

func TestWhereNoFilesAreStoredABatchOnlyRaisesMarks(t *testing.T) {
	var w work
	h := w.handler(&bytes.Buffer{})
	h.removing = nil
	if err := h.handle(context.Background(), json.RawMessage(streamBatch)); err != nil || !maps.Equal(w.marks, map[string]int64{"user#a": 9}) {
		t.Fatalf("err %v, marks %v", err, w.marks)
	}
}

func TestTheScheduleRunsTheCleanupOnlyWhereTheEnvironmentHasOne(t *testing.T) {
	var w work
	h := w.handler(&bytes.Buffer{})
	// EventBridge Scheduler's payload, and a stream batch with nothing in it.
	for _, payload := range []string{`{}`, `{"Records":[]}`} {
		if err := h.handle(context.Background(), json.RawMessage(payload)); err != nil {
			t.Fatal(err)
		}
	}
	if w.cleanups != 2 || len(w.marks) != 0 {
		t.Fatalf("cleanups %d, marks %v", w.cleanups, w.marks)
	}
	w.cleanupErr = errors.New("scan failed")
	if err := h.handle(context.Background(), json.RawMessage(`{}`)); err == nil {
		t.Fatal("a failed cleanup must fail the run")
	}

	// Prod has no cleanup: TTL alone removes its records, so a run with nothing from the stream is a mistake to report.
	h.cleanup, h.env = nil, "prod"
	if err := h.handle(context.Background(), json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "prod") {
		t.Fatalf("err %v", err)
	}
}
