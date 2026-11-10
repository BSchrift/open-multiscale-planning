package main

import (
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"github.com/aws/aws-lambda-go/events"
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
