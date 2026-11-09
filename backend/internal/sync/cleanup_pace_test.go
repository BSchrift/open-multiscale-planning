package sync_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	msync "github.com/BSchrift/open-multiscale-planning/backend/internal/sync"
)

// pagedDB answers the cleanup's scan in pages, each costing units read units, with nothing expired, and records what it
// was asked. It needs no stand-in, unlike the rest of the cleanup's tests.
type pagedDB struct {
	pages []float64
	asked []*dynamodb.ScanInput
	fail  error
}

func (d *pagedDB) Scan(_ context.Context, in *dynamodb.ScanInput, _ ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	d.asked = append(d.asked, in)
	if d.fail != nil {
		return nil, d.fail
	}
	page := len(d.asked) - 1
	out := &dynamodb.ScanOutput{ConsumedCapacity: &types.ConsumedCapacity{CapacityUnits: aws.Float64(d.pages[page])}}
	if page+1 < len(d.pages) {
		out.LastEvaluatedKey = map[string]types.AttributeValue{"pk": &types.AttributeValueMemberS{Value: "user#a"}}
	}
	return out, nil
}

func (d *pagedDB) UpdateItem(context.Context, *dynamodb.UpdateItemInput, ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	return &dynamodb.UpdateItemOutput{}, nil
}

func (d *pagedDB) DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	return &dynamodb.DeleteItemOutput{}, nil
}

func pacedCleanup(db *pagedDB, unitsPerSecond int, waits *[]time.Duration) *msync.Cleanup {
	return &msync.Cleanup{
		DB: db, Table: "t", Now: time.Now, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Env: "test",
		ReadUnitsPerSecond: unitsPerSecond,
		Wait: func(ctx context.Context, d time.Duration) error {
			*waits = append(*waits, d)
			return ctx.Err()
		},
	}
}

func TestCleanupPagesItsScanAndSpacesThePagesToItsReadBudget(t *testing.T) {
	db := &pagedDB{pages: []float64{250, 125, 40}}
	var waits []time.Duration
	if _, err := pacedCleanup(db, 500, &waits).Run(context.Background(), "r"); err != nil {
		t.Fatal(err)
	}
	for _, in := range db.asked {
		// Each page is bounded, and says what it cost, so the next can wait for it.
		if aws.ToInt32(in.Limit) <= 0 || in.ReturnConsumedCapacity != types.ReturnConsumedCapacityTotal {
			t.Fatalf("an unbounded or unmetered page: %+v", in)
		}
	}
	// 250 units at 500 a second is half a second before the next page, and nothing is waited after the last.
	if want := []time.Duration{500 * time.Millisecond, 250 * time.Millisecond}; !equalDurations(waits, want) {
		t.Fatalf("waited %v, want %v", waits, want)
	}
}

func TestCleanupWithoutABudgetScansWithoutWaiting(t *testing.T) {
	db := &pagedDB{pages: []float64{250, 125}}
	var waits []time.Duration
	if _, err := pacedCleanup(db, 0, &waits).Run(context.Background(), "r"); err != nil {
		t.Fatal(err)
	}
	if len(db.asked) != 2 || len(waits) != 0 {
		t.Fatalf("pages %d, waits %v", len(db.asked), waits)
	}
}

func TestCleanupStopsWhenItsTimeRunsOutBetweenPages(t *testing.T) {
	db := &pagedDB{pages: []float64{250, 125}}
	var waits []time.Duration
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := pacedCleanup(db, 500, &waits).Run(ctx, "r")
	if !errors.Is(err, context.Canceled) || len(db.asked) != 1 {
		t.Fatalf("pages %d, err %v", len(db.asked), err)
	}
}

func TestACleanupScanThatFailsStillFailsTheRun(t *testing.T) {
	db := &pagedDB{fail: errors.New("ProvisionedThroughputExceededException")}
	var waits []time.Duration
	_, err := pacedCleanup(db, 500, &waits).Run(context.Background(), "r")
	if err == nil || !strings.Contains(err.Error(), "cleanup: scan") {
		t.Fatalf("got %v", err)
	}
}

func equalDurations(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
