package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/BSchrift/open-multiscale-planning/backend/internal/account"
	"github.com/BSchrift/open-multiscale-planning/backend/internal/obs"
)

// queryDB answers every Query with nothing, and records which partitions were read.
type queryDB struct {
	account.DB
	read []string
}

func (d *queryDB) Query(_ context.Context, in *dynamodb.QueryInput, _ ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	pending, _ := in.ExpressionAttributeValues[":pending"].(*types.AttributeValueMemberS)
	if pending != nil {
		d.read = append(d.read, pending.Value)
	}
	return &dynamodb.QueryOutput{}, nil
}

func TestTheScheduleCarriesOnEveryDeletion(t *testing.T) {
	var logs bytes.Buffer
	for _, payload := range []string{`{}`, `{"version":"0","detail-type":"Scheduled Event"}`, `{"job":"something-else","sub":"x"}`, `not json`} {
		db := &queryDB{}
		svc := &account.Service{DB: db, Table: "t", Now: time.Now, Log: obs.NewLogger(&logs)}
		if err := handle(context.Background(), svc, json.RawMessage(payload)); err != nil {
			t.Fatal(err)
		}
		if len(db.read) != 1 || !strings.Contains(db.read[0], "account#deleting") {
			t.Fatalf("%s: read %v", payload, db.read)
		}
	}
}
